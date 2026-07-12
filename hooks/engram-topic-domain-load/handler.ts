import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { resolveDomainFromEvent } from "../_lib/domain-resolve.js";
import {
  computeContextHash,
  resolveAgentsBody,
  buildDomainPayload,
  type DomainSourceFiles,
} from "../_lib/domain-inject.js";

/**
 * engram-topic-domain-load (v4 — bootstrap delivery)
 *
 * On `agent:bootstrap`, if the session is a Telegram topic bound to a
 * domain, inject Domain Context + AGENTS into the bootstrap event's
 * `messages` array. This makes the context part of the agent's initial
 * system prompt — no separate system event, no extra agent turn, no spam.
 *
 * Only `topic-thread` sessions are handled here; peer-direct and
 * group-direct are handled by `engram-peer-domain-load`.
 */
const handler = async (event: any) => {
  const resolved = resolveDomainFromEvent(event, {
    kinds: ["topic-thread"],
  });
  if (!resolved) return;

  const {
    domainName,
    domainEntry,
    sessionKind,
    sessionSegment,
    sessionLocation,
    absChatId,
    topicId,
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

  // --- Hash + agents ---
  const contentHash = computeContextHash(files);
  const agents = resolveAgentsBody(files, {
    qmdIndex,
    kgCollection,
    agentId,
    domainName,
    sessionSegment,
    kgEntity: domainEntry.kgEntity,
  });

  // --- Build payload ---
  const payload = buildDomainPayload({
    domainName,
    domainEntry,
    sessionKind,
    sessionLocation,
    contentHash,
    agents,
    files,
  });

  // --- Inject via event.messages (becomes part of bootstrap context) ---
  if (Array.isArray(event.messages)) {
    event.messages.push(payload);
  }

  console.log(
    `[engram-topic-domain-load] Injected domain context + agents for "${domainName}" → chat ${absChatId}/topic ${topicId} via bootstrap (hash ${contentHash}, agents ${agents.source}, ${Buffer.byteLength(payload, "utf-8")} bytes)`,
  );
};

export default handler;