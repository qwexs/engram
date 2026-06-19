import { existsSync, readFileSync, writeFileSync, statSync, renameSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { parseAgentIdFromSessionKey, resolveWorkspaceByAgentId } from "./workspace-resolver.js";

// Resolve TZ at call time, not module load time. This makes the hook testable:
// the test can set process.env.ENGRAM_TZ after importing the module.
// (ES `import` is hoisted, so `const TZ = process.env...` at module top would
// capture the value before the test's env setup runs.)
const NEWLINE = /\r?\n/;
function resolveTz(): string {
  return process.env.ENGRAM_TZ || process.env.TZ || "UTC";
}

/**
 * engram-topic-domain-load
 *
 * On message:received, if the message is in a Telegram topic session, look up a
 * domain bound to that topic in memory/domains/registry.json and inject TWO blocks
 * into today's daily note:
 *   1. "## Domain Context (auto)" — decisions + status + last changelog entry.
 *      Content hash from decisions.md + status.md + changelog.md.
 *   2. "## Domain AGENTS (auto)" — operational ruleset from agents.md.
 *      Content hash from agents.md only. If agents.md is missing, a built-in
 *      minimal fallback is used and a warning note is added to the block.
 *
 * Idempotency: each block has its own hash. If the latest context marker AND
 * the latest agents marker both match their respective hashes, the hook does
 * nothing. Otherwise, both existing blocks are removed and re-injected fresh.
 *
 * Block formats:
 *   <!-- domain-context:{name}:{hash} -->
 *   ## Domain Context (auto)
 *   ...
 *   <!-- /domain-context -->
 *
 *   <!-- domain-agents:{name}:{hash} -->
 *   ## Domain AGENTS (auto)
 *   ...
 *   <!-- /domain-agents -->
 */
const handler = async (event: any) => {
  const TZ = resolveTz();
  if (event.type !== "message" || event.action !== "received") {
    return;
  }

  // OpenClaw puts sessionKey on the top-level event, not in `context` —
  // fall back to context for any legacy callers that still set it there.
  const sessionKey: string = event.sessionKey || event.context?.sessionKey || "";

  // Derive agentId from sessionKey (format: "agent:<id>:<channel>:<rest>").
  // Used as a third fallback for workspaceDir resolution and as the primary
  // agent id when building the sessionDir path on disk.
  const resolvedAgentId = parseAgentIdFromSessionKey(sessionKey);

  // TEMP DEBUG — remove after we know the runtime shape.
  try {
    process.stderr.write(
      `[engram-topic-domain-load:debug] sessionKey=${JSON.stringify(sessionKey)} ` +
      `resolvedAgentId=${JSON.stringify(resolvedAgentId)} ` +
      `event.context=${JSON.stringify(event.context)}\n`,
    );
  } catch {}

  const workspaceDir =
    event.context?.workspaceDir ||
    process.env.OPENCLAW_WORKSPACE ||
    (resolvedAgentId ? resolveWorkspaceByAgentId(resolvedAgentId) : null);
  if (!workspaceDir) {
    try {
      process.stderr.write(
        `[engram-topic-domain-load:debug] no workspaceDir — returning early. ` +
        `sessionKey=${JSON.stringify(sessionKey)} resolvedAgentId=${JSON.stringify(resolvedAgentId)}\n`,
      );
    } catch {}
    return;
  }

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
  //   - topicId: legacy context.topicId already handled above; for OC66 the
  //     value lands in context.metadata.threadId (internal event) or as a
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
  if (!topicId || !chatId) {
    return;
  }

  const absChatId = chatId.replace(/^-/, "");
  const sessionSegment = `telegram-group--${absChatId}-topic-${topicId}`;

  const registryPath = join(workspaceDir, "memory", "domains", "registry.json");
  if (!existsSync(registryPath)) {
    return;
  }

  let registry: any;
  try {
    registry = JSON.parse(readFileSync(registryPath, "utf-8"));
  } catch { return; }
  if (!registry.domains || typeof registry.domains !== "object") {
    return;
  }

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
  if (!domainName || !domainEntry) {
    return;
  }

  // Unarchive-on-message: if the domain is archived, restore it before injection.
  if (domainEntry.archived === true) {
    delete domainEntry.archived;
    const archivesDir = join(workspaceDir, "memory", "domains", "archives", domainName);
    const liveDir = join(workspaceDir, "memory", "domains", domainName);
    if (existsSync(archivesDir)) {
      // Best-effort: just clear the archived flag and let ops re-link files later.
      console.log(`[engram-topic-domain-load] Reactivating archived domain "${domainName}"`);
    }
    registry.domains[domainName] = domainEntry;
    try {
      writeFileSync(registryPath, JSON.stringify(registry, null, 2) + "\n");
    } catch {}
  }

  const domainDir = join(workspaceDir, "memory", "domains", domainName);
  const decisionsPath = join(domainDir, "decisions.md");
  const statusPath = join(domainDir, "status.md");
  const changelogPath = join(domainDir, "changelog.md");
  const agentsPath = join(domainDir, "agents.md");

  // --- Hash 1: context (decisions + status + changelog) ---
  const contextHasher = createHash("sha256");
  for (const p of [decisionsPath, statusPath, changelogPath]) {
    if (existsSync(p)) {
      const st = statSync(p);
      contextHasher.update(`${p}:${st.mtimeMs}:${st.size};`);
      contextHasher.update(readFileSync(p, "utf-8"));
    } else {
      contextHasher.update(`${p}:missing;`);
    }
  }
  const contentHash = contextHasher.digest("hex").slice(0, 12);

  // --- Resolve workspace-agnostic identifiers for the fallback body ---
  // The fallback is rendered when agents.md is missing, so it must not
  // hardcode apriotech-specific values like qmd index, agent id, or KG
  // collection. Read them from the workspace's engram.json when available.
  // Prefer the agentId we just resolved from sessionKey; fall back to
  // event.context.agentId (legacy) and finally "main" (last-resort).
  const agentId = resolvedAgentId || event.context?.agentId || "main";
  const engramConfigPath = join(workspaceDir, "engram.json");
  // Default values for the fallback body. They are only used if the
  // workspace's engram.json is missing or malformed; in that case we
  // render a minimal placeholder rather than failing the injection.
  // These are NOT agentIds or workspace identifiers — they are the
  // generic qmd index and KG collection names that an OpenClaw
  // installation might use by default. They are also workspace-agnostic
  // by design, so we strip them from the personal-data linter's reserved
  // set (the linter is configured to ignore this file via the
  // scripts/lint-no-personal-data.ts allowlist).
  let qmdIndex = "default";
  let kgCollection = "kg";
  if (existsSync(engramConfigPath)) {
    try {
      const cfg = JSON.parse(readFileSync(engramConfigPath, "utf-8"));
      qmdIndex = cfg.qmd?.index || qmdIndex;
      kgCollection = cfg.qmd?.workspaceKgCollection || kgCollection;
    } catch {
      // engram.json exists but is malformed — keep defaults. Better to inject
      // a slightly off-config fallback than to skip injection entirely.
    }
  }

  // --- Hash 2: agents (agents.md, or built-in fallback) ---
  let agentsBody: string;
  let agentsSource: "file" | "fallback";
  if (existsSync(agentsPath)) {
    agentsBody = readFileSync(agentsPath, "utf-8");
    agentsSource = "file";
  } else {
    agentsBody = buildFallbackAgentsMd(
      domainName,
      sessionSegment,
      qmdIndex,
      agentId,
      kgCollection,
      domainEntry.kgEntity,
    );
    agentsSource = "fallback";
  }
  // Stable hash: domain + source (file/fallback) + body. Prevents hash churn
  // when fallback body is rebuilt every call (since buildFallbackAgentsMd is
  // deterministic for a given input, this is also stable across calls).
  const agentsHashInput = `${domainName}|${agentsSource}|${agentsBody}`;
  const agentsHash = createHash("sha256").update(agentsHashInput).digest("hex").slice(0, 12);

  function head(p: string, maxLines: number): string {
    if (!existsSync(p)) return "";
    // CRLF-safe: split on either \n or \r\n, join with \n for output consistency.
    return readFileSync(p, "utf-8").split(NEWLINE).slice(0, maxLines).join("\n");
  }
  function countDecisions(p: string): number {
    if (!existsSync(p)) return 0;
    // match() with /m flag treats \r as part of line; strip CR defensively before counting.
    const normalized = readFileSync(p, "utf-8").replace(/\r/g, "");
    return (normalized.match(/^###\s+/gm) || []).length;
  }
  function lastChangelogEntry(p: string): string {
    if (!existsSync(p)) return "";
    const content = readFileSync(p, "utf-8");
    // CRLF-safe split — no trailing \r in lines[i] after this.
    const lines = content.split(NEWLINE);
    const entryStarts: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (/^##\s+\d{4}-\d{2}-\d{2}/.test(lines[i])) entryStarts.push(i);
    }
    if (entryStarts.length === 0) return "";
    const start = entryStarts[entryStarts.length - 1];
    return lines.slice(start).join("\n").trim();
  }

  const decisionsCount = countDecisions(decisionsPath);
  const statusBody = head(statusPath, 40);
  const changelogLast = lastChangelogEntry(changelogPath);

  // --- Build context block (decisions + status + last changelog) ---
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

  // --- Build agents block (operational ruleset) ---
  const fallbackNote = agentsSource === "fallback"
    ? `\n\n> ⚠️ \`memory/domains/${domainName}/agents.md\` не найден — используется встроенный fallback. Создай файл из шаблона \`templates/domain/topic-thread/agents.md\` или запусти \`bun skills/engram/scripts/backfill-domain-agents.js\`.\n`
    : "";

  const agentsBlock = `<!-- domain-agents:${domainName}:${agentsHash} -->
## Domain AGENTS (auto)${fallbackNote}
${agentsBody.trim()}
<!-- /domain-agents -->
`;

  const sessionDir = join(workspaceDir, "memory", `agent-${agentId}`, sessionSegment);
  if (!existsSync(sessionDir)) {
    return;
  }

  const today = new Date().toLocaleDateString("sv-SE", { timeZone: TZ });
  const notePath = join(sessionDir, `${today}.md`);
  if (!existsSync(notePath)) {
    return;
  }

  const noteContent = readFileSync(notePath, "utf-8");

  // Idempotency: each block checked independently. If both latest markers match
  // their hashes, skip the write entirely.
  function findLatestHash(content: string, marker: "context" | "agents"): string | null {
    const re = new RegExp(`<!-- domain-${marker}:[\\w-]+:([a-f0-9]+) -->`, "g");
    let last: string | null = null;
    let mm: RegExpExecArray | null;
    while ((mm = re.exec(content)) !== null) {
      last = mm[1];
    }
    return last;
  }
  const lastContextHash = findLatestHash(noteContent, "context");
  const lastAgentsHash = findLatestHash(noteContent, "agents");
  if (lastContextHash === contentHash && lastAgentsHash === agentsHash) return;

  // Remove all existing domain-* blocks (context + agents) using sentinels.
  const blockRe = /<!-- domain-(?:context|agents):[\w-]+:[a-f0-9]+ -->[\s\S]*?<!-- \/domain-(?:context|agents) -->\n?/g;
  let cleaned = noteContent.replace(blockRe, "").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";

  // Inject both blocks at the top, right after the "# YYYY-MM-DD" line.
  // Order: Domain Context first (state), then Domain AGENTS (rules).
  const combinedBlock = `${contextBlock.trimEnd()}\n\n${agentsBlock.trimEnd()}`;
  const lines = cleaned.split(NEWLINE);
  const dateLineIdx = lines.findIndex(l => /^# \d{4}-\d{2}-\d{2}/.test(l));
  if (dateLineIdx < 0) {
    cleaned = cleaned + "\n" + combinedBlock;
  } else {
    lines.splice(dateLineIdx + 1, 0, "", combinedBlock);
    cleaned = lines.join("\n");
  }

  // Atomic write: temp file + rename, to avoid races with engram-session-start
  // (which also writes to the same daily note via append).
  const tmpDir = mkdtempSync(join(tmpdir(), "engram-topic-"));
  const tmpPath = join(tmpDir, "note.md");
  try {
    writeFileSync(tmpPath, cleaned);
    renameSync(tmpPath, notePath);
  } finally {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
  console.log(`[engram-topic-domain-load] Injected domain context + agents for "${domainName}" → ${notePath} (context ${contentHash}, agents ${agentsHash}${agentsSource === "fallback" ? ", fallback" : ""})`);
};

/**
 * Build a minimal inline fallback for the agents block when `memory/domains/{slug}/agents.md`
 * is missing. The full template lives at `templates/domain/topic-thread/agents.md`.
 * Used to keep topic-agents functional even before backfill runs.
 */
function buildFallbackAgentsMd(
  domainName: string,
  sessionKey: string,
  qmdIndex: string,
  agentId: string,
  kgCollection: string,
  kgEntity?: string,
): string {
  const kgLine = kgEntity
    ? `- **Свой KG entity**: \`${kgEntity}\` → \`qmd --index ${qmdIndex} query "<topic>" -c life-projects-${domainName}\` или \`read life/${kgEntity}/summary.md\``
    : `- **KG entity не задан** — QMD для KG не использовать`;
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

export default handler;
