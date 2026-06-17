// hooks/engram-topic-auto-domain-suggest/handler.ts
import { existsSync, readFileSync, writeFileSync, readdirSync, renameSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
var TZ = process.env.ENGRAM_TZ || process.env.TZ || "UTC";
var NEWLINE = /\r?\n/;
var SUGGEST_THRESHOLD = 2;
var handler = async (event) => {
  if (event.type !== "message" || event.action !== "received")
    return;
  const workspaceDir = event.context?.workspaceDir || process.env.OPENCLAW_WORKSPACE;
  if (!workspaceDir)
    return;
  const rawChatId = event.context?.chatId;
  const rawTopicId = event.context?.topicId;
  if (!rawChatId || !rawTopicId)
    return;
  const chatId = String(rawChatId);
  const topicId = String(rawTopicId);
  const content = String(event.context?.content || "");
  if (!content.trim())
    return;
  if (event.context?.fromBot === true)
    return;
  const registryPath = join(workspaceDir, "memory", "domains", "registry.json");
  if (!existsSync(registryPath))
    return;
  let registry;
  try {
    registry = JSON.parse(readFileSync(registryPath, "utf-8"));
  } catch {
    return;
  }
  if (!registry.domains || typeof registry.domains !== "object")
    return;
  const absChatId = chatId.replace(/^-/, "");
  for (const [, entry] of Object.entries(registry.domains)) {
    if (entry.topic && String(entry.topic.topicId) === topicId) {
      const regChatId = String(entry.topic.chatId).replace(/^-/, "");
      if (regChatId === absChatId)
        return;
    }
  }
  const agentId = event.context?.agentId || "main";
  const sessionSegment = `telegram-group--${absChatId}-topic-${topicId}`;
  const sessionDir = join(workspaceDir, "memory", `agent-${agentId}`, sessionSegment);
  if (!existsSync(sessionDir))
    return;
  const today = new Date().toLocaleDateString("sv-SE", { timeZone: TZ });
  const notePath = join(sessionDir, `${today}.md`);
  if (!existsSync(notePath))
    return;
  const noteContent = readFileSync(notePath, "utf-8");
  const todayShort = today.replace(/-/g, "");
  const daySentinel = `<!-- engram:auto-suggest-shown:${todayShort} -->`;
  if (noteContent.includes(daySentinel))
    return;
  let cleaned = noteContent;
  cleaned = cleaned.replace(/<!-- domain-context:[\w-]+:[a-f0-9]+ -->[\s\S]*?<!-- \/domain-context -->\n?/g, "");
  cleaned = cleaned.replace(/<!-- engram:auto-suggest:[a-f0-9]+ -->[\s\S]*?<!-- \/engram:auto-suggest -->\n?/g, "");
  cleaned = cleaned.replace(/<!-- session:[a-z]+:[^>]+-->\n?/g, "");
  const messageCount = (cleaned.match(/^- /gm) || []).length;
  if (messageCount < SUGGEST_THRESHOLD)
    return;
  const hashInput = `chatId=${absChatId};topicId=${topicId};msgs=${messageCount};day=${today}`;
  const contentHash = createHash("sha256").update(hashInput).digest("hex").slice(0, 8);
  const existingRe = /<!-- engram:auto-suggest:([a-f0-9]+) -->/;
  const m = noteContent.match(existingRe);
  if (m && m[1] === contentHash)
    return;
  const shortChatId = absChatId.replace(/^100/, "");
  const suggestedSlug = `topic-${shortChatId}-${topicId}`;
  const kgHint = detectKgEntity(workspaceDir);
  const block = `<!-- engram:auto-suggest:${contentHash} -->
## engram:auto-suggest (auto)

Этот топик накопил **${messageCount} сообщений** без привязанного домена. По контракту в
\`workspace/topic-domain-conventions.md\` (C.a) рекомендуется создать домен для
curated memory, если тема устойчивая.

- **chatId**: \`${chatId}\`
- **topicId**: \`${topicId}\`
- **Предлагаемый slug**: \`${suggestedSlug}\` (можно переименовать, например в тему топика)
- **KG auto-match**: ${kgHint}

**Агенту**: используй \`message\` tool чтобы спросить пользователя одним сообщением
с inline-buttons (или свободным текстом). На ответ:
- «да» / «создай» / \`/domain new <slug>\` → запусти:

\`\`\`bash
bun skills/engram/scripts/add-domain.js \\
  --domain <slug> \\
  --type topic-thread \\
  --topic ${chatId}:${topicId} \\
  --kg-entity <если выбрали> \\
  --description "<из контекста топика>"
\`\`\`

- «нет» / «не сейчас» → удали этот блок и добавь
  \`<!-- engram:auto-suggest-declined:${todayShort} -->\` чтобы не спрашивать снова
  до конца дня.

${daySentinel}
<!-- /engram:auto-suggest -->
`;
  const blockRe = /<!-- engram:auto-suggest:[a-f0-9]+ -->[\s\S]*?<!-- \/engram:auto-suggest -->\n?/g;
  const daySentinelRe = new RegExp(`<!-- engram:auto-suggest-shown:${todayShort} -->\\n?`, "g");
  let newContent = noteContent.replace(blockRe, "").replace(daySentinelRe, "");
  newContent = newContent.replace(/\n{3,}/g, `

`).trimEnd() + `
`;
  const lines = newContent.split(NEWLINE);
  const dateLineIdx = lines.findIndex((l) => /^# \d{4}-\d{2}-\d{2}/.test(l));
  if (dateLineIdx < 0) {
    newContent = newContent + `
` + block;
  } else {
    lines.splice(dateLineIdx + 1, 0, "", block.trimEnd());
    newContent = lines.join(`
`);
  }
  const tmpDir = mkdtempSync(join(tmpdir(), "engram-auto-suggest-"));
  const tmpPath = join(tmpDir, "note.md");
  try {
    writeFileSync(tmpPath, newContent);
    renameSync(tmpPath, notePath);
  } finally {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }
  console.log(`[engram-topic-auto-domain-suggest] Injected auto-suggest for topic ${absChatId}:${topicId} (${messageCount} msgs) → ${notePath} (hash ${contentHash})`);
};
function detectKgEntity(workspaceDir) {
  try {
    const lifeProjects = join(workspaceDir, "life", "projects");
    if (!existsSync(lifeProjects))
      return "— (нет `life/projects/`)";
    const projects = readdirSync(lifeProjects, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    if (projects.length === 0)
      return "— (нет проектов в KG)";
    return "доступные: " + projects.map((p) => `\`projects/${p}\``).join(", ");
  } catch {
    return "—";
  }
}
var handler_default = handler;
export {
  handler_default as default
};
