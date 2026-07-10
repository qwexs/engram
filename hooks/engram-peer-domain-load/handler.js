import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { resolveDomainFromEvent } from "../_lib/domain-resolve.js";
import {
  computeContextHash,
  resolveAgentsBody,
  buildDomainPayload,
  readLatestHashFromNote
} from "../_lib/domain-inject.js";
import { enqueueSystemEventToSession } from "../_lib/system-event.js";
const handler = async (event) => {
  const resolved = resolveDomainFromEvent(event, {
    kinds: ["peer-direct", "group-direct"]
  });
  if (!resolved)
    return;
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
    sessionKey
  } = resolved;
  const domainDir = join(workspaceDir, "memory", "domains", domainName);
  const files = {
    decisionsPath: join(domainDir, "decisions.md"),
    statusPath: join(domainDir, "status.md"),
    changelogPath: join(domainDir, "changelog.md"),
    agentsPath: join(domainDir, "agents.md")
  };
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
  const contentHash = computeContextHash(files);
  const agents = resolveAgentsBody(files, {
    qmdIndex,
    kgCollection,
    agentId,
    domainName,
    sessionSegment,
    kgEntity: domainEntry.kgEntity
  });
  const today = new Date().toLocaleDateString("sv-SE", {
    timeZone: process.env.ENGRAM_TZ || process.env.TZ || "UTC"
  });
  const sessionDir = join(workspaceDir, "memory", `agent-${agentId}`, sessionSegment);
  const notePath = join(sessionDir, `${today}.md`);
  const lastHash = readLatestHashFromNote(notePath);
  if (lastHash === contentHash)
    return;
  const payload = buildDomainPayload({
    domainName,
    domainEntry,
    sessionKind,
    sessionLocation,
    contentHash,
    agents,
    files
  });
  const result = enqueueSystemEventToSession({
    sessionKey,
    text: payload,
    spawnFn: globalThis.__ENGRAM_TEST_SPAWN_FN__
  });
  if (!result.ok) {
    console.warn(`[engram-peer-domain-load] system-event injection failed for "${domainName}" (chat=${chatId}, kind=${sessionKind}): ${result.error}; next message will retry`);
    return;
  }
  console.log(`[engram-peer-domain-load] Injected domain context + agents for "${domainName}" \u2192 ${sessionKind} ${absChatId} via system-event (hash ${contentHash}, agents ${agents.source}, ${result.bytesSent} bytes)`);
};
export default handler;
