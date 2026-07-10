import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseAgentIdFromSessionKey, resolveWorkspaceByAgentId } from "./workspace-resolver.js";
import {
  computeContextHash,
  resolveAgentsBody,
  buildDomainPayload,
  readLatestHashFromNote,
  type DomainSourceFiles,
} from "../_lib/domain-inject.js";
import { enqueueSystemEventToSession } from "../_lib/system-event.js";

function resolveTz(): string {
  return process.env.ENGRAM_TZ || process.env.TZ || "UTC";
}

/**
 * engram-topic-domain-load (v3.5 — system-event delivery)
 *
 * On `message:received`, if the inbound message is in a Telegram topic
 * session, look up the domain bound to that topic in
 * `memory/domains/registry.json` and inject a Domain Context + AGENTS payload
 * via the OpenClaw gateway `system event` channel — *not* into the daily note.
 *
 * Refactored in ISS-15 from "write blocks to daily note" to system-event
 * delivery. The old approach (v3.3) was the canonical write-then-hope
 * anti-pattern: the hook wrote `<!-- domain-context:{slug}:{hash} -->` blocks
 * to today's daily note and relied on the LLM to read the file and call
 * `message`. Production repeatedly showed agents finishing on filesystem
 * state and forgetting to call `message` — symptom "обновлял engram, но в тред
 * не отправил". v3.5 hands the payload directly to the gateway so the
 * injection cannot be missed.
 *
 * Shares `_lib/domain-inject.ts` and `_lib/system-event.ts` with the peer
 * hook (`apriori-peer-domain-load`). Idempotency: the marker
 * `<!-- engram-system-event-hash:<8-hex> -->` is written by the receiver
 * (the agent) via the system event itself, so the hook can read the last
 * marker from the daily note and short-circuit on match.
 *
 * No file writes. No Telegram API. No daily-note mutation. Pure hook that
 * builds a payload and asks the gateway to deliver it.
 */
const handler = async (event: any) => {
  const TZ = resolveTz();
  if (event.type !== "message" || event.action !== "received") return;

  // OpenClaw puts sessionKey on the top-level event, not in `context` —
  // fall back to context for any legacy callers that still set it there.
  const sessionKey: string = event.sessionKey || event.context?.sessionKey || "";

  const resolvedAgentId = parseAgentIdFromSessionKey(sessionKey);

  const workspaceDir =
    event.context?.workspaceDir ||
    process.env.OPENCLAW_WORKSPACE ||
    (resolvedAgentId ? resolveWorkspaceByAgentId(resolvedAgentId) : null);
  if (!workspaceDir) return;

  // --- Resolve chatId + topicId ---
  // OpenClaw's `message:received` event has them in different places across
  //   versions (top-level vs context vs metadata). Cover all known shapes
  //   and bail if either is missing or empty.
  const conversationId: string = event.context?.conversationId || "";
  let topicId: string | null = null;
  let chatId: string | null = null;

  if (event.context?.topicId && event.context?.chatId) {
    topicId = String(event.context.topicId);
    chatId = String(event.context.chatId);
  }
  if (!topicId || !chatId) {
    const m = conversationId.match(/^telegram:(-?\d+)(?::topic:(\d+))?$/);
    if (m) {
      if (!chatId) chatId = m[1];
      if (!topicId) topicId = m[2] || null;
    }
  }
  // OpenClaw 2026.6.6 fallback chain.
  //   - topicId: legacy context.topicId handled above; for OC66 the value
  //     lands in context.metadata.threadId (internal event) or as a
  //     top-level event.threadId (plugin event).
  //   - chatId: in OC66 conversationId arrives as "telegram:{chatId}" (no
  //     :topic: suffix), so the regex above only catches chatId. When
  //     conversationId is empty/absent, try context.metadata.to /
  //     context.metadata.originatingTo.
  if (!topicId) {
    const fromMeta = event.context?.metadata?.threadId;
    const fromTop = event.threadId;
    if (typeof fromMeta === "string" && fromMeta.length > 0) {
      topicId = fromMeta;
    } else if (typeof fromTop === "string" && fromTop.length > 0) {
      topicId = fromTop;
    }
  }
  if (!chatId) {
    const fromConv = conversationId.match(/^telegram:(-?\d+)/);
    if (fromConv) {
      chatId = fromConv[1];
    } else {
      const fromMeta = event.context?.metadata?.to || event.context?.metadata?.originatingTo;
      if (typeof fromMeta === "string" && fromMeta.length > 0) {
        chatId = fromMeta;
      }
    }
  }
  if (!topicId || !chatId) return;

  // Symmetric unsigned chatId: registry may store -100xxx and the event may
  // ship +100xxx (or vice versa). Strip the leading dash for comparison.
  const absChatId = chatId.replace(/^-/, "");
  const sessionSegment = `telegram-group--${absChatId}-topic-${topicId}`;

  // --- Domain registry lookup ---
  const registryPath = join(workspaceDir, "memory", "domains", "registry.json");
  if (!existsSync(registryPath)) return;
  let registry: any;
  try {
    registry = JSON.parse(readFileSync(registryPath, "utf-8"));
  } catch {
    return;
  }
  if (!registry.domains || typeof registry.domains !== "object") return;

  let domainName: string | null = null;
  let domainEntry: any = null;
  for (const [name, entry] of Object.entries<any>(registry.domains)) {
    if (
      entry.topic &&
      entry.topic.topicId === topicId &&
      // Symmetric unsigned chatId comparison: handles all three edge cases
      //   (registry-/event-, registry-/event+, registry+/event-) and stays
      //   robust if a registry entry is hand-edited with the wrong sign.
      String(entry.topic.chatId).replace(/^-/, "") === absChatId
    ) {
      domainName = name;
      domainEntry = entry;
      break;
    }
  }
  if (!domainName || !domainEntry) return;

  // Unarchive-on-message: if the domain is archived, restore it before injection.
  if (domainEntry.archived === true) {
    delete domainEntry.archived;
    const archivesDir = join(workspaceDir, "memory", "domains", "archives", domainName);
    if (existsSync(archivesDir)) {
      console.log(`[engram-topic-domain-load] Reactivating archived domain "${domainName}"`);
    }
    registry.domains[domainName] = domainEntry;
    try {
      writeFileSync(registryPath, JSON.stringify(registry, null, 2) + "\n");
    } catch {}
  }

  // --- Source files & workspace config ---
  // Prefer the agentId we just resolved from sessionKey; fall back to
  // event.context.agentId (legacy) and finally "main" (last-resort).
  const agentId = resolvedAgentId || event.context?.agentId || "main";
  const domainDir = join(workspaceDir, "memory", "domains", domainName);
  const files: DomainSourceFiles = {
    decisionsPath: join(domainDir, "decisions.md"),
    statusPath: join(domainDir, "status.md"),
    changelogPath: join(domainDir, "changelog.md"),
    agentsPath: join(domainDir, "agents.md"),
  };

  // Workspace-agnostic identifiers for the agents fallback body. Read from
  // the workspace's engram.json when available; fall back to OpenClaw
  // defaults ("default" for qmdIndex, "life" for kgCollection).
  let qmdIndex = "default";
  let kgCollection = "life";
  const engramConfigPath = join(workspaceDir, "engram.json");
  if (existsSync(engramConfigPath)) {
    try {
      const cfg = JSON.parse(readFileSync(engramConfigPath, "utf-8"));
      qmdIndex = cfg.qmd?.index || qmdIndex;
      kgCollection = cfg.qmd?.workspaceKgCollection || kgCollection;
    } catch {
      // Keep defaults — better to inject slightly-off-config fallback than
      // to skip injection entirely.
    }
  }

  // --- Hash + agents + idempotency ---
  const contentHash = computeContextHash(files);
  const agents = resolveAgentsBody(files, {
    qmdIndex, kgCollection, agentId, domainName, sessionSegment,
    kgEntity: domainEntry.kgEntity,
  });

  // Idempotency: read the latest `engram-system-event-hash` from today's
  // daily note (if it exists). Missing note → null → always inject. This is
  // intentional — system-event delivery doesn't require the daily note to
  // exist (this is the whole point of v3.5 vs the v3.3 write-then-hope).
  const today = new Date().toLocaleDateString("sv-SE", { timeZone: TZ });
  const sessionDir = join(workspaceDir, "memory", `agent-${agentId}`, sessionSegment);
  const notePath = join(sessionDir, `${today}.md`);
  const lastHash = readLatestHashFromNote(notePath);
  if (lastHash === contentHash) return;

  // --- Build payload + inject via system event ---
  const payload = buildDomainPayload({
    domainName,
    domainEntry,
    sessionKind: "topic-thread",
    sessionLocation: `${absChatId}:${topicId}`, // canonical; chatId minus sign
    contentHash,
    agents,
    files,
  });

  const result = enqueueSystemEventToSession({
    sessionKey,
    text: payload,
    spawnFn: (globalThis as any).__ENGRAM_TEST_SPAWN_FN__,
  });

  if (!result.ok) {
    console.warn(
      `[engram-topic-domain-load] system-event injection failed for "${domainName}" (chat=${absChatId}, topic=${topicId}): ${result.error}; next message will retry`,
    );
    return;
  }

  console.log(
    `[engram-topic-domain-load] Injected domain context + agents for "${domainName}" → chat ${absChatId}/topic ${topicId} via system-event (hash ${contentHash}, agents ${agents.source}, ${result.bytesSent} bytes)`,
  );
};

export default handler;
