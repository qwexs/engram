// @bun
// hooks/engram-topic-domain-load/handler.ts
import { join as join3 } from "path";
import { existsSync as existsSync4, readFileSync as readFileSync4 } from "fs";

// hooks/_lib/domain-resolve.ts
import { existsSync as existsSync2, readFileSync as readFileSync2, writeFileSync } from "fs";
import { join as join2 } from "path";

// hooks/engram-topic-domain-load/workspace-resolver.ts
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// hooks/_lib/parse-agent-id.ts
function parseAgentIdFromSessionKey(sessionKey) {
  if (!sessionKey)
    return null;
  const m = sessionKey.match(/^agent:([^:]+):/);
  return m ? m[1] : null;
}

// hooks/engram-topic-domain-load/workspace-resolver.ts
function resolveWorkspaceByAgentId(agentId, home = process.env.HOME || process.env.USERPROFILE || homedir()) {
  if (!agentId)
    return null;
  const configPath = join(home, ".openclaw", "openclaw.json");
  if (!existsSync(configPath))
    return null;
  try {
    const cfg = JSON.parse(readFileSync(configPath, "utf-8"));
    const list = cfg?.agents?.list;
    if (!Array.isArray(list))
      return null;
    const agent = list.find((a) => a?.id === agentId);
    return typeof agent?.workspace === "string" ? agent.workspace : null;
  } catch {
    return null;
  }
}

// hooks/_lib/domain-resolve.ts
var ALL_KINDS = ["topic-thread", "peer-direct", "group-direct"];
function parseSessionKeyForChatTopic(sessionKey) {
  const seg = sessionKey.replace(/^agent:[^:]+:/, "");
  const topicM = seg.match(/^telegram-group--(-?\d+)-topic-(\d+)$/);
  if (topicM)
    return { chatId: topicM[1], topicId: topicM[2] };
  const peerM = seg.match(/^telegram-direct-(-?\d+)$/);
  if (peerM)
    return { chatId: peerM[1], topicId: null };
  const groupM = seg.match(/^telegram-group--(-?\d+)$/);
  if (groupM)
    return { chatId: groupM[1], topicId: null };
  return null;
}
function resolveDomainFromEvent(event, opts) {
  const isMessage = event.type === "message" && event.action === "received";
  const isBootstrap = event.type === "agent" && event.action === "bootstrap";
  if (!isMessage && !isBootstrap)
    return null;
  const allowedKinds = opts?.kinds || ALL_KINDS;
  const sessionKey = event.sessionKey || event.context?.sessionKey || "";
  const resolvedAgentId = parseAgentIdFromSessionKey(sessionKey);
  const workspaceDir = event.context?.workspaceDir || process.env.OPENCLAW_WORKSPACE || (resolvedAgentId ? resolveWorkspaceByAgentId(resolvedAgentId) : null);
  if (!workspaceDir)
    return null;
  if (isBootstrap) {
    const parsed = parseSessionKeyForChatTopic(sessionKey);
    if (!parsed)
      return null;
    return resolveDomainFromRegistry({
      chatId: parsed.chatId,
      topicId: parsed.topicId,
      allowedKinds,
      workspaceDir,
      sessionKey,
      resolvedAgentId
    });
  }
  const conversationId = event.context?.conversationId || "";
  let topicId = null;
  let chatId = null;
  if (event.context?.chatId) {
    chatId = String(event.context.chatId);
  }
  if (event.context?.topicId) {
    topicId = String(event.context.topicId);
  }
  if (!chatId || !topicId) {
    const m = conversationId.match(/^telegram:(-?\d+)(?::topic:(\d+))?$/);
    if (m) {
      if (!chatId)
        chatId = m[1];
      if (!topicId)
        topicId = m[2] || null;
    }
  }
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
  if (!chatId)
    return null;
  let sessionKind;
  if (topicId) {
    sessionKind = "topic-thread";
  } else if (!chatId.startsWith("-")) {
    sessionKind = "peer-direct";
  } else {
    sessionKind = "group-direct";
  }
  if (!allowedKinds.includes(sessionKind))
    return null;
  const absChatId = chatId.replace(/^-/, "");
  const sessionSegment = sessionKind === "topic-thread" ? `telegram-group--${absChatId}-topic-${topicId}` : sessionKind === "peer-direct" ? `telegram-direct--${chatId}` : `telegram-group--${absChatId}`;
  const registryPath = join2(workspaceDir, "memory", "domains", "registry.json");
  if (!existsSync2(registryPath))
    return null;
  let registry;
  try {
    registry = JSON.parse(readFileSync2(registryPath, "utf-8"));
  } catch {
    return null;
  }
  if (!registry.domains || typeof registry.domains !== "object")
    return null;
  const bindingKey = sessionKind === "topic-thread" ? "topic" : sessionKind === "peer-direct" ? "peer" : "group";
  let domainName = null;
  let domainEntry = null;
  for (const [name, entry] of Object.entries(registry.domains)) {
    if (!entry || typeof entry !== "object")
      continue;
    const binding = entry[bindingKey];
    if (!binding)
      continue;
    if (sessionKind === "topic-thread") {
      if (binding.topicId === topicId && String(binding.chatId).replace(/^-/, "") === absChatId) {
        domainName = name;
        domainEntry = entry;
        break;
      }
    } else {
      if (String(binding.chatId).replace(/^-/, "") === absChatId) {
        domainName = name;
        domainEntry = entry;
        break;
      }
    }
  }
  if (!domainName || !domainEntry)
    return null;
  if (domainEntry.archived === true) {
    delete domainEntry.archived;
    const archivesDir = join2(workspaceDir, "memory", "domains", "archives", domainName);
    if (existsSync2(archivesDir)) {
      console.log(`[domain-resolve] Reactivating archived domain "${domainName}"`);
    }
    registry.domains[domainName] = domainEntry;
    try {
      writeFileSync(registryPath, JSON.stringify(registry, null, 2) + `
`);
    } catch {}
  }
  const sessionLocation = sessionKind === "topic-thread" ? `${absChatId}:${topicId}` : sessionKind === "peer-direct" ? chatId : absChatId;
  const agentId = resolvedAgentId || event.context?.agentId || "main";
  return {
    domainName,
    domainEntry,
    sessionKind,
    sessionSegment,
    sessionLocation,
    chatId,
    absChatId,
    topicId,
    agentId,
    workspaceDir,
    sessionKey
  };
}
function resolveDomainFromRegistry(input) {
  const { chatId, topicId, allowedKinds, workspaceDir, sessionKey } = input;
  let sessionKind;
  if (topicId) {
    sessionKind = "topic-thread";
  } else if (!chatId.startsWith("-")) {
    sessionKind = "peer-direct";
  } else {
    sessionKind = "group-direct";
  }
  if (!allowedKinds.includes(sessionKind))
    return null;
  const absChatId = chatId.replace(/^-/, "");
  const sessionSegment = sessionKind === "topic-thread" ? `telegram-group--${absChatId}-topic-${topicId}` : sessionKind === "peer-direct" ? `telegram-direct--${chatId}` : `telegram-group--${absChatId}`;
  const registryPath = join2(workspaceDir, "memory", "domains", "registry.json");
  if (!existsSync2(registryPath))
    return null;
  let registry;
  try {
    registry = JSON.parse(readFileSync2(registryPath, "utf-8"));
  } catch {
    return null;
  }
  if (!registry.domains || typeof registry.domains !== "object")
    return null;
  const bindingKey = sessionKind === "topic-thread" ? "topic" : sessionKind === "peer-direct" ? "peer" : "group";
  let domainName = null;
  let domainEntry = null;
  for (const [name, entry] of Object.entries(registry.domains)) {
    if (!entry || typeof entry !== "object")
      continue;
    const binding = entry[bindingKey];
    if (!binding)
      continue;
    if (sessionKind === "topic-thread") {
      if (binding.topicId === topicId && String(binding.chatId).replace(/^-/, "") === absChatId) {
        domainName = name;
        domainEntry = entry;
        break;
      }
    } else {
      if (String(binding.chatId).replace(/^-/, "") === absChatId) {
        domainName = name;
        domainEntry = entry;
        break;
      }
    }
  }
  if (!domainName || !domainEntry)
    return null;
  if (domainEntry.archived === true) {
    delete domainEntry.archived;
    registry.domains[domainName] = domainEntry;
    try {
      writeFileSync(registryPath, JSON.stringify(registry, null, 2) + `
`);
    } catch {}
  }
  const sessionLocation = sessionKind === "topic-thread" ? `${absChatId}:${topicId}` : sessionKind === "peer-direct" ? chatId : absChatId;
  const agentId = input.resolvedAgentId || "main";
  return {
    domainName,
    domainEntry,
    sessionKind,
    sessionSegment,
    sessionLocation,
    chatId,
    absChatId,
    topicId,
    agentId,
    workspaceDir,
    sessionKey
  };
}

// hooks/_lib/domain-inject.ts
import { existsSync as existsSync3, readFileSync as readFileSync3 } from "fs";
import { createHash } from "crypto";
var NEWLINE = /\r?\n/;
function computeContextHash(files) {
  const h = createHash("sha256");
  for (const p of [files.decisionsPath, files.statusPath, files.changelogPath]) {
    if (existsSync3(p)) {
      const body = readFileSync3(p, "utf-8");
      h.update(`${p}:${body.length};`);
      h.update(body);
    } else {
      h.update(`${p}:missing;`);
    }
  }
  return h.digest("hex").slice(0, 8);
}
function resolveAgentsBody(files, cfg) {
  if (existsSync3(files.agentsPath)) {
    return {
      body: readFileSync3(files.agentsPath, "utf-8"),
      source: "file"
    };
  }
  return {
    body: buildFallbackAgentsMd(cfg),
    source: "fallback"
  };
}
function buildDomainPayload(params) {
  const {
    domainName,
    domainEntry,
    sessionKind,
    sessionLocation,
    contentHash,
    agents,
    files
  } = params;
  const decisionsCount = countDecisions(files.decisionsPath);
  const statusBody = head(files.statusPath, 40);
  const changelogLast = lastChangelogEntry(files.changelogPath);
  const fallbackNote = agents.source === "fallback" ? `

> \u26A0\uFE0F \`memory/domains/${domainName}/agents.md\` \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D \u2014 \u0438\u0441\u043F\u043E\u043B\u044C\u0437\u0443\u0435\u0442\u0441\u044F \u0432\u0441\u0442\u0440\u043E\u0435\u043D\u043D\u044B\u0439 fallback. \u0421\u043E\u0437\u0434\u0430\u0439 \u0444\u0430\u0439\u043B \u0438\u0437 \u0448\u0430\u0431\u043B\u043E\u043D\u0430 \`templates/domain/topic-thread/agents.md\` \u0438\u043B\u0438 \u0437\u0430\u043F\u0443\u0441\u0442\u0438 \`bun skills/engram/scripts/backfill-domain-agents.js\`.` : "";
  const sessionLabel = sessionKind === "topic-thread" ? `chat \`${sessionLocation.split(":")[0]}\`, topic \`${sessionLocation.split(":")[1]}\`` : sessionKind === "peer-direct" ? `DM \`${sessionLocation}\`` : `group \`${sessionLocation}\``;
  return `\uD83E\uDDE0 <b>Engram Domain Context (auto)</b> \xB7 <code>${sessionKind}</code>
<!-- engram-system-event-hash:${contentHash} -->

<b>Domain</b>: \`${domainName}\` (${domainEntry.type})
<b>Session</b>: ${sessionLabel}
<b>KG entity</b>: ${domainEntry.kgEntity ? `\`${domainEntry.kgEntity}\`` : "\u2014"}

<details><summary><b>Status</b> (${decisionsCount} \u043F\u0440\u0438\u043D\u044F\u0442\u044B\u0445 \u0440\u0435\u0448\u0435\u043D\u0438\u0439 \u0432 decisions.md)</summary>

${statusBody.trim() || "_status.md \u043F\u0443\u0441\u0442_"}

</details>

<details><summary><b>\u041F\u043E\u0441\u043B\u0435\u0434\u043D\u044F\u044F \u0437\u0430\u043F\u0438\u0441\u044C changelog.md</b></summary>

${changelogLast || "_changelog.md \u043F\u0443\u0441\u0442_"}

</details>

---

\uD83E\uDDED <b>Domain AGENTS (auto)</b>${fallbackNote}

${agents.body.trim()}

---

<i>auto-injected by engram v2 (system-event delivery) \xB7 hash=${contentHash} \xB7 source=${agents.source} \xB7 session=${sessionKind}</i>`;
}
function buildFallbackAgentsMd(cfg) {
  const { domainName, sessionSegment, qmdIndex, agentId, kgCollection, kgEntity } = cfg;
  const kgLine = kgEntity ? `- **\u0421\u0432\u043E\u0439 KG entity**: \`${kgEntity}\` \u2192 \`qmd --index ${qmdIndex} query "<topic>" -c life-projects-${domainName}\` \u0438\u043B\u0438 \`read life/${kgEntity}/summary.md\`` : `- **KG entity \u043D\u0435 \u0437\u0430\u0434\u0430\u043D** \u2014 QMD \u0434\u043B\u044F KG \u043D\u0435 \u0438\u0441\u043F\u043E\u043B\u044C\u0437\u043E\u0432\u0430\u0442\u044C`;
  return `# Domain AGENTS \u2014 ${domainName} (fallback)

\u26A0\uFE0F \u042D\u0442\u043E \u0432\u0441\u0442\u0440\u043E\u0435\u043D\u043D\u044B\u0439 fallback. \u041F\u043E\u043B\u043D\u0430\u044F \u0432\u0435\u0440\u0441\u0438\u044F: \`memory/domains/${domainName}/agents.md\`.
\u0421\u043E\u0437\u0434\u0430\u0439 \u0438\u0437 \u0448\u0430\u0431\u043B\u043E\u043D\u0430: \`bun skills/engram/scripts/backfill-domain-agents.js\`.

## \u0422\u044B \u0432 \u0440\u043E\u043B\u0438
Agent \u0434\u043E\u043C\u0435\u043D\u0430 \`${domainName}\`. Session: \`${sessionSegment}\`.

## QMD default
\`\`\`bash
qmd --index ${qmdIndex} query "<topic>" \\
  -c domain-${domainName} \\
  -c openclaw-memory-agent-${agentId}-${sessionSegment}
\`\`\`
${kgLine}
- \u274C \u0411\u0435\u0437 \u044F\u0432\u043D\u043E\u0433\u043E OK \u0421\u0435\u0440\u0433\u0435\u044F \u041D\u0415 \u0438\u0441\u043F\u043E\u043B\u044C\u0437\u043E\u0432\u0430\u0442\u044C: \`-c domains\` (cross-topic), \`-c ${kgCollection}\` (cross-KG)

## Write rules (\u043C\u0438\u043D\u0438\u043C\u0443\u043C)
- \u2705 \u0421\u0432\u043E\u044F daily note, decisions.md (\u043D\u0430 \u043C\u0430\u0440\u043A\u0435\u0440\u0430\u0445), status.md (handover), changelog.md (curated)
- \u274C \`life/\`, \u274C \u0447\u0443\u0436\u0438\u0435 \u0434\u043E\u043C\u0435\u043D\u044B, \u274C workspace MEMORY.md/AGENTS.md
- \u274C Telegram-\u0441\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u044F, \u043F\u043E\u0441\u0442\u044B \u0432 \u0421\u0435\u0442\u043A\u0443, \u0425\u0430\u0431\u0440 \u2014 \u0442\u043E\u043B\u044C\u043A\u043E \u043F\u043E \u044F\u0432\u043D\u043E\u043C\u0443 \xAB\u0434\u0430\xBB \u0421\u0435\u0440\u0433\u0435\u044F

## \u041A\u043E\u0433\u0434\u0430 \u0432\u044B\u0445\u043E\u0434\u0438\u0442\u044C \u0437\u0430 \u043F\u0440\u0435\u0434\u0435\u043B\u044B
- Cross-topic: \`-c domains\`
- Cross-KG: \`-c ${kgCollection}\` (\u043B\u0443\u0447\u0448\u0435 \u0434\u0435\u043B\u0435\u0433\u0438\u0440\u043E\u0432\u0430\u0442\u044C main-\u0430\u0433\u0435\u043D\u0442\u0443)
`;
}
function head(p, maxLines) {
  if (!existsSync3(p))
    return "";
  return readFileSync3(p, "utf-8").split(NEWLINE).slice(0, maxLines).join(`
`);
}
function countDecisions(p) {
  if (!existsSync3(p))
    return 0;
  const normalized = readFileSync3(p, "utf-8").replace(/\r/g, "");
  return (normalized.match(/^###\s+/gm) || []).length;
}
function lastChangelogEntry(p) {
  if (!existsSync3(p))
    return "";
  const content = readFileSync3(p, "utf-8");
  const lines = content.split(NEWLINE);
  const entryStarts = [];
  for (let i = 0;i < lines.length; i++) {
    if (/^##\s+\d{4}-\d{2}-\d{2}/.test(lines[i]))
      entryStarts.push(i);
  }
  if (entryStarts.length === 0)
    return "";
  const start = entryStarts[entryStarts.length - 1];
  return lines.slice(start).join(`
`).trim();
}

// hooks/engram-topic-domain-load/handler.ts
var handler = async (event) => {
  const resolved = resolveDomainFromEvent(event, {
    kinds: ["topic-thread"]
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
    topicId,
    agentId,
    workspaceDir,
    sessionKey
  } = resolved;
  const domainDir = join3(workspaceDir, "memory", "domains", domainName);
  const files = {
    decisionsPath: join3(domainDir, "decisions.md"),
    statusPath: join3(domainDir, "status.md"),
    changelogPath: join3(domainDir, "changelog.md"),
    agentsPath: join3(domainDir, "agents.md")
  };
  let qmdIndex = "default";
  let kgCollection = "life";
  const engramConfigPath = join3(workspaceDir, "engram.json");
  if (existsSync4(engramConfigPath)) {
    try {
      const cfg = JSON.parse(readFileSync4(engramConfigPath, "utf-8"));
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
  const payload = buildDomainPayload({
    domainName,
    domainEntry,
    sessionKind,
    sessionLocation,
    contentHash,
    agents,
    files
  });
  if (Array.isArray(event.messages)) {
    event.messages.push(payload);
  }
  console.log(`[engram-topic-domain-load] Injected domain context + agents for "${domainName}" \u2192 chat ${absChatId}/topic ${topicId} via bootstrap (hash ${contentHash}, agents ${agents.source}, ${Buffer.byteLength(payload, "utf-8")} bytes)`);
};
var handler_default = handler;
export {
  handler_default as default
};
