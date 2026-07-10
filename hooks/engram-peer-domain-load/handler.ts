import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { resolveDomainFromEvent } from "../_lib/domain-resolve.js";
import {
  computeContextHash,
  resolveAgentsBody,
  buildDomainPayload,
  readLatestHashFromNote,
  type DomainSourceFiles,
} from "../_lib/domain-inject.js";
import { enqueueSystemEventToSession } from "../_lib/system-event.js";

/**
 * engram-peer-domain-load (v3.5 — system-event delivery)
 *
 * On `message:received`, if the message is in a Telegram direct (DM) chat
 * or a group without topics, look up the domain bound to that chat and
 * inject Domain Context + AGENTS via the OpenClaw gateway `system event`
 * channel.
 *
 * Handles two session kinds:
 *   - `peer-direct`  — DM chats (positive chatId = user id)
 *   - `group-direct` — groups without topic structure (negative chatId, no topicId)
 *
 * Topic-thread sessions (groups with topics) are handled by the sibling
 * `engram-topic-domain-load` hook.
 *
 * Registry bindings:
 *   - peer-direct:  `entry.peer  = { chatId }`
 *   - group-direct: `entry.group = { chatId }`
 *
 * See HOOK.md for full documentation.
 */
const handler = async (event: any) => {
  // Only handle peer-direct and group-direct sessions
  const resolved = resolveDomainFromEvent(event, {
    kinds: ["peer-direct", "group-direct"],
  });
  if (!resolved) return;

  const {
    domainName,
    domainEntry,
    sessionKind,
    sessionSegment,
    sessionLocation,
    absChatId,
    chatId,
    agentId,
    workspaceDir,
    sessionKey,
  } = resolved;

  // --- Source files ---
  const domainDir = join(workspaceDir, "memory", "domains", domainName);
  const files: DomainSourceFiles = {
    decisionsPath: join(domainDir, "decisions.md"),
    statusPath: join(domainDir, "status.md"),
    changelogPath: join(domainDir, "changelog.md"),
    agentsPath: join(domainDir, "agents.md"),
  };

  // --- Workspace config for agents fallback ---
  let qmdIndex = "default";
  let kgCollection = "life";
  const engramConfigPath = join(workspaceDir, "engram.json");
  if (existsSync(engramConfigPath)) {
    try {
      const cfg = JSON.parse(readFileSync(engramConfigPath, "utf-8"));
      qmdIndex = cfg.qmd?.index || qmdIndex;
      kgCollection = cfg.qmd?.workspaceKgCollection || kgCollection;
    } catch {}
  }

  // --- Hash + agents + idempotency ---
  const contentHash = computeContextHash(files);
  const agents = resolveAgentsBody(files, {
    qmdIndex,
    kgCollection,
    agentId,
    domainName,
    sessionSegment,
    kgEntity: domainEntry.kgEntity,
  });

  const today = new Date().toLocaleDateString("sv-SE", {
    timeZone: process.env.ENGRAM_TZ || process.env.TZ || "UTC",
  });
  const sessionDir = join(
    workspaceDir,
    "memory",
    `agent-${agentId}`,
    sessionSegment,
  );
  const notePath = join(sessionDir, `${today}.md`);
  const lastHash = readLatestHashFromNote(notePath);
  if (lastHash === contentHash) return;

  // --- Build payload + inject ---
  const payload = buildDomainPayload({
    domainName,
    domainEntry,
    sessionKind,
    sessionLocation,
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
      `[engram-peer-domain-load] system-event injection failed for "${domainName}" (chat=${chatId}, kind=${sessionKind}): ${result.error}; next message will retry`,
    );
    return;
  }

  console.log(
    `[engram-peer-domain-load] Injected domain context + agents for "${domainName}" → ${sessionKind} ${absChatId} via system-event (hash ${contentHash}, agents ${agents.source}, ${result.bytesSent} bytes)`,
  );
};

export default handler;