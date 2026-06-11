import { existsSync, readFileSync, writeFileSync, statSync, renameSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";

const TZ = process.env.ENGRAM_TZ || process.env.TZ || "UTC";
const NEWLINE = /\r?\n/;

/**
 * engram-topic-domain-load
 *
 * On message:received, if the message is in a Telegram topic session, look up a
 * domain bound to that topic in memory/domains/registry.json and inject a
 * "## Domain Context" block into today's daily note. Idempotent: only re-writes
 * when domain files change (content hash).
 *
 * Block format:
 *   <!-- domain-context:{name}:{hash} -->
 *   ## Domain Context (auto)
 *   ...
 *   <!-- /domain-context -->
 */
const handler = async (event: any) => {
  if (event.type !== "message" || event.action !== "received") return;

  const workspaceDir =
    event.context?.workspaceDir ||
    process.env.OPENCLAW_WORKSPACE;
  if (!workspaceDir) return;

  const conversationId: string = event.context?.conversationId || "";
  const sessionKey: string = event.context?.sessionKey || "";

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
  if (!topicId || !chatId) return;

  const absChatId = chatId.replace(/^-/, "");
  const sessionSegment = `telegram-group--${absChatId}-topic-${topicId}`;

  const registryPath = join(workspaceDir, "memory", "domains", "registry.json");
  if (!existsSync(registryPath)) return;

  let registry: any;
  try {
    registry = JSON.parse(readFileSync(registryPath, "utf-8"));
  } catch { return; }
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

  const hash = createHash("sha256");
  for (const p of [decisionsPath, statusPath, changelogPath]) {
    if (existsSync(p)) {
      const st = statSync(p);
      hash.update(`${p}:${st.mtimeMs}:${st.size};`);
      hash.update(readFileSync(p, "utf-8"));
    } else {
      hash.update(`${p}:missing;`);
    }
  }
  const contentHash = hash.digest("hex").slice(0, 12);

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

  const block = `<!-- domain-context:${domainName}:${contentHash} -->
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

  const agentId = event.context?.agentId || "main";
  const sessionDir = join(workspaceDir, "memory", `agent-${agentId}`, sessionSegment);
  if (!existsSync(sessionDir)) return;

  const today = new Date().toLocaleDateString("sv-SE", { timeZone: TZ });
  const notePath = join(sessionDir, `${today}.md`);
  if (!existsSync(notePath)) return;

  const noteContent = readFileSync(notePath, "utf-8");

  // Idempotency: if the latest block has the same hash, skip
  const existingMarkerRe = /<!-- domain-context:([\w-]+):([a-f0-9]+) -->/g;
  let lastMarkerHash: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = existingMarkerRe.exec(noteContent)) !== null) {
    lastMarkerHash = m[2];
  }
  if (lastMarkerHash === contentHash) return;

  // Remove all existing domain-context blocks (using sentinels)
  const blockRe = /<!-- domain-context:[\w-]+:[a-f0-9]+ -->[\s\S]*?<!-- \/domain-context -->\n?/g;
  let cleaned = noteContent.replace(blockRe, "").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";

  // Inject at the top, right after the "# YYYY-MM-DD" line
  const lines = cleaned.split(NEWLINE);
  const dateLineIdx = lines.findIndex(l => /^# \d{4}-\d{2}-\d{2}/.test(l));
  if (dateLineIdx < 0) {
    cleaned = cleaned + "\n" + block;
  } else {
    lines.splice(dateLineIdx + 1, 0, "", block.trimEnd());
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
  console.log(`[engram-topic-domain-load] Injected domain context for "${domainName}" → ${notePath} (hash ${contentHash})`);
};

export default handler;
