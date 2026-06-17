// hooks/engram-topic-domain-load/handler.ts
import { existsSync as existsSync2, readFileSync as readFileSync2, writeFileSync, statSync, renameSync, mkdtempSync, rmSync } from "node:fs";
import { join as join2 } from "node:path";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";

// hooks/engram-topic-domain-load/workspace-resolver.ts
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
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
function parseAgentIdFromSessionKey(sessionKey) {
  if (!sessionKey)
    return null;
  const m = sessionKey.match(/^agent:([^:]+):/);
  return m ? m[1] : null;
}

// hooks/engram-topic-domain-load/handler.ts
var NEWLINE = /\r?\n/;
function resolveTz() {
  return process.env.ENGRAM_TZ || process.env.TZ || "UTC";
}
var handler = async (event) => {
  const TZ = resolveTz();
  if (event.type !== "message" || event.action !== "received") {
    return;
  }
  const sessionKey = event.sessionKey || event.context?.sessionKey || "";
  const resolvedAgentId = parseAgentIdFromSessionKey(sessionKey);
  const workspaceDir = event.context?.workspaceDir || process.env.OPENCLAW_WORKSPACE || (resolvedAgentId ? resolveWorkspaceByAgentId(resolvedAgentId) : null);
  if (!workspaceDir) {
    return;
  }
  const conversationId = event.context?.conversationId || "";
  let topicId = null;
  let chatId = null;
  if (event.context?.topicId && event.context?.chatId) {
    topicId = String(event.context.topicId);
    chatId = String(event.context.chatId);
  }
  if (!topicId || !chatId) {
    const m = conversationId.match(/^telegram:(-?\d+)(?::topic:(\d+))?$/);
    if (m) {
      if (!chatId)
        chatId = m[1];
      if (!topicId)
        topicId = m[2] || null;
    }
  }
  if (!topicId || !chatId) {
    return;
  }
  const absChatId = chatId.replace(/^-/, "");
  const sessionSegment = `telegram-group--${absChatId}-topic-${topicId}`;
  const registryPath = join2(workspaceDir, "memory", "domains", "registry.json");
  if (!existsSync2(registryPath)) {
    return;
  }
  let registry;
  try {
    registry = JSON.parse(readFileSync2(registryPath, "utf-8"));
  } catch {
    return;
  }
  if (!registry.domains || typeof registry.domains !== "object") {
    return;
  }
  let domainName = null;
  let domainEntry = null;
  for (const [name, entry] of Object.entries(registry.domains)) {
    if (entry.topic && entry.topic.topicId === topicId && String(entry.topic.chatId).replace(/^-/, "") === absChatId) {
      domainName = name;
      domainEntry = entry;
      break;
    }
  }
  if (!domainName || !domainEntry) {
    return;
  }
  if (domainEntry.archived === true) {
    delete domainEntry.archived;
    const archivesDir = join2(workspaceDir, "memory", "domains", "archives", domainName);
    const liveDir = join2(workspaceDir, "memory", "domains", domainName);
    if (existsSync2(archivesDir)) {
      console.log(`[engram-topic-domain-load] Reactivating archived domain "${domainName}"`);
    }
    registry.domains[domainName] = domainEntry;
    try {
      writeFileSync(registryPath, JSON.stringify(registry, null, 2) + `
`);
    } catch {}
  }
  const domainDir = join2(workspaceDir, "memory", "domains", domainName);
  const decisionsPath = join2(domainDir, "decisions.md");
  const statusPath = join2(domainDir, "status.md");
  const changelogPath = join2(domainDir, "changelog.md");
  const agentsPath = join2(domainDir, "agents.md");
  const contextHasher = createHash("sha256");
  for (const p of [decisionsPath, statusPath, changelogPath]) {
    if (existsSync2(p)) {
      const st = statSync(p);
      contextHasher.update(`${p}:${st.mtimeMs}:${st.size};`);
      contextHasher.update(readFileSync2(p, "utf-8"));
    } else {
      contextHasher.update(`${p}:missing;`);
    }
  }
  const contentHash = contextHasher.digest("hex").slice(0, 12);
  const agentId = resolvedAgentId || event.context?.agentId || "main";
  const engramConfigPath = join2(workspaceDir, "engram.json");
  let qmdIndex = "default";
  let kgCollection = "kg";
  if (existsSync2(engramConfigPath)) {
    try {
      const cfg = JSON.parse(readFileSync2(engramConfigPath, "utf-8"));
      qmdIndex = cfg.qmd?.index || qmdIndex;
      kgCollection = cfg.qmd?.workspaceKgCollection || kgCollection;
    } catch {}
  }
  let agentsBody;
  let agentsSource;
  if (existsSync2(agentsPath)) {
    agentsBody = readFileSync2(agentsPath, "utf-8");
    agentsSource = "file";
  } else {
    agentsBody = buildFallbackAgentsMd(domainName, sessionSegment, qmdIndex, agentId, kgCollection, domainEntry.kgEntity);
    agentsSource = "fallback";
  }
  const agentsHashInput = `${domainName}|${agentsSource}|${agentsBody}`;
  const agentsHash = createHash("sha256").update(agentsHashInput).digest("hex").slice(0, 12);
  function head(p, maxLines) {
    if (!existsSync2(p))
      return "";
    return readFileSync2(p, "utf-8").split(NEWLINE).slice(0, maxLines).join(`
`);
  }
  function countDecisions(p) {
    if (!existsSync2(p))
      return 0;
    const normalized = readFileSync2(p, "utf-8").replace(/\r/g, "");
    return (normalized.match(/^###\s+/gm) || []).length;
  }
  function lastChangelogEntry(p) {
    if (!existsSync2(p))
      return "";
    const content = readFileSync2(p, "utf-8");
    const lines2 = content.split(NEWLINE);
    const entryStarts = [];
    for (let i = 0;i < lines2.length; i++) {
      if (/^##\s+\d{4}-\d{2}-\d{2}/.test(lines2[i]))
        entryStarts.push(i);
    }
    if (entryStarts.length === 0)
      return "";
    const start = entryStarts[entryStarts.length - 1];
    return lines2.slice(start).join(`
`).trim();
  }
  const decisionsCount = countDecisions(decisionsPath);
  const statusBody = head(statusPath, 40);
  const changelogLast = lastChangelogEntry(changelogPath);
  const contextBlock = `<!-- domain-context:${domainName}:${contentHash} -->
## Domain Context (auto)

**Domain**: \`${domainName}\` (${domainEntry.type})
**Topic**: chat \`${chatId}\`, topic \`${topicId}\`
**KG entity**: ${domainEntry.kgEntity ? `\`${domainEntry.kgEntity}\`` : "—"}

<details>
<summary><b>Status</b> (${decisionsCount} принятых решений в decisions.md)</summary>

${statusBody.trim() || "_status.md пуст_"}

</details>

<details>
<summary><b>Последняя запись changelog.md</b></summary>

${changelogLast || "_changelog.md пуст_"}

</details>
<!-- /domain-context -->
`;
  const fallbackNote = agentsSource === "fallback" ? `

> ⚠️ \`memory/domains/${domainName}/agents.md\` не найден — используется встроенный fallback. Создай файл из шаблона \`templates/domain/topic-thread/agents.md\` или запусти \`bun skills/engram/scripts/backfill-domain-agents.js\`.
` : "";
  const agentsBlock = `<!-- domain-agents:${domainName}:${agentsHash} -->
## Domain AGENTS (auto)${fallbackNote}
${agentsBody.trim()}
<!-- /domain-agents -->
`;
  const sessionDir = join2(workspaceDir, "memory", `agent-${agentId}`, sessionSegment);
  if (!existsSync2(sessionDir)) {
    return;
  }
  const today = new Date().toLocaleDateString("sv-SE", { timeZone: TZ });
  const notePath = join2(sessionDir, `${today}.md`);
  if (!existsSync2(notePath)) {
    return;
  }
  const noteContent = readFileSync2(notePath, "utf-8");
  function findLatestHash(content, marker) {
    const re = new RegExp(`<!-- domain-${marker}:[\\w-]+:([a-f0-9]+) -->`, "g");
    let last = null;
    let mm;
    while ((mm = re.exec(content)) !== null) {
      last = mm[1];
    }
    return last;
  }
  const lastContextHash = findLatestHash(noteContent, "context");
  const lastAgentsHash = findLatestHash(noteContent, "agents");
  if (lastContextHash === contentHash && lastAgentsHash === agentsHash)
    return;
  const blockRe = /<!-- domain-(?:context|agents):[\w-]+:[a-f0-9]+ -->[\s\S]*?<!-- \/domain-(?:context|agents) -->\n?/g;
  let cleaned = noteContent.replace(blockRe, "").replace(/\n{3,}/g, `

`).trimEnd() + `
`;
  const combinedBlock = `${contextBlock.trimEnd()}

${agentsBlock.trimEnd()}`;
  const lines = cleaned.split(NEWLINE);
  const dateLineIdx = lines.findIndex((l) => /^# \d{4}-\d{2}-\d{2}/.test(l));
  if (dateLineIdx < 0) {
    cleaned = cleaned + `
` + combinedBlock;
  } else {
    lines.splice(dateLineIdx + 1, 0, "", combinedBlock);
    cleaned = lines.join(`
`);
  }
  const tmpDir = mkdtempSync(join2(tmpdir(), "engram-topic-"));
  const tmpPath = join2(tmpDir, "note.md");
  try {
    writeFileSync(tmpPath, cleaned);
    renameSync(tmpPath, notePath);
  } finally {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }
  console.log(`[engram-topic-domain-load] Injected domain context + agents for "${domainName}" → ${notePath} (context ${contentHash}, agents ${agentsHash}${agentsSource === "fallback" ? ", fallback" : ""})`);
};
function buildFallbackAgentsMd(domainName, sessionKey, qmdIndex, agentId, kgCollection, kgEntity) {
  const kgLine = kgEntity ? `- **Свой KG entity**: \`${kgEntity}\` → \`qmd --index ${qmdIndex} query "<topic>" -c life-projects-${domainName}\` или \`read life/${kgEntity}/summary.md\`` : `- **KG entity не задан** — QMD для KG не использовать`;
  return `# Domain AGENTS — ${domainName} (fallback)

⚠️ Это встроенный fallback. Полная версия: \`memory/domains/${domainName}/agents.md\`.
Создай из шаблона: \`bun skills/engram/scripts/backfill-domain-agents.js\`.

## Ты в роли
Topic-agent домена \`${domainName}\`. Session: \`${sessionKey}\`.

## QMD default
\`\`\`bash
qmd --index ${qmdIndex} query "<topic>" \\
  -c domain-${domainName} \\
  -c openclaw-memory-agent-${agentId}-${sessionKey}
\`\`\`
${kgLine}
- ❌ Без явного OK Сергея НЕ использовать: \`-c domains\` (cross-topic), \`-c ${kgCollection}\` (cross-KG)

## Write rules (минимум)
- ✅ Своя daily note, decisions.md (на маркерах), status.md (handover), changelog.md (curated)
- ❌ \`life/\`, ❌ чужие домены, ❌ workspace MEMORY.md/AGENTS.md
- ❌ Telegram-сообщения, посты в Сетку, Хабр — только по явному «да» Сергея

## Когда выходить за пределы
- Cross-topic: \`-c domains\`
- Cross-KG: \`-c ${kgCollection}\` (лучше делегировать main-агенту)
`;
}
var handler_default = handler;
export {
  handler_default as default
};
