import { existsSync, readFileSync, writeFileSync, readdirSync, renameSync, mkdtempSync, rmSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { slugifyTopicName } from "../_lib/slugify.js";

const TZ = process.env.ENGRAM_TZ || process.env.TZ || "UTC";
const NEWLINE = /\r?\n/;
const SUGGEST_THRESHOLD = 2; // ≥2 user messages before suggesting

/**
 * Service-message detection: Telegram sends a "X created the topic Y"
 * service message when a user creates a forum topic. The text format is
 * locale-dependent (English "created the topic", Russian "создал тему" etc.)
 * and openclaw's hook context does NOT expose a programmatic flag — only
 * the rendered text in `event.context.content`. We also require
 * `metadata.topicName` to be set, which openclaw populates from its
 * internal topic-name cache when the raw message has `forum_topic_created`.
 *
 * This is a heuristic. False positives are extremely rare in practice
 * (would require a user to literally type "I created the topic Y" while
 * being in a topic named Y). False negatives are caught by the slow path
 * (counter-based) below.
 */
const TOPIC_CREATION_PATTERNS: RegExp[] = [
  /created (?:a |the )?topic ["«]?/i,
  /created topic ["«]?/i,
  // Russian: matches "создал тему", "создала тему", "создал(а) тему", "создал (а) тему"
  // (Telegram appends gender-marker in parens, e.g. "создал(а)").
  /создал[^"«\n]{0,8}?тему/i,
  /создана тема ["«]?/i,
];
function isTopicCreationServiceMessage(event: any): boolean {
  const content = String(event?.context?.content || "");
  const topicName = event?.context?.metadata?.topicName;
  if (!topicName) return false;
  if (!content.trim()) return false;
  return TOPIC_CREATION_PATTERNS.some((re) => re.test(content));
}

/**
 * engram-topic-auto-domain-suggest
 *
 * On message:received, if the topic is NOT bound to any domain and either:
 *   (a) a service-message "topic was just created" was just seen (fast path), or
 *   (b) the current daily note has accumulated N+ user messages (slow path),
 * inject a `## engram:auto-suggest` block. The agent reading the daily note
 * on its next iteration will see this and offer the user to create a domain
 * via a `message` tool call with inline buttons (the OpenClaw hook layer
 * can't call the Telegram bot API directly; the agent mediates).
 *
 * Fast path (service-message): on `isTopicCreationServiceMessage`, write a
 * hint file in sessionDir and exit. The NEXT message:received for this
 * topic (the first user message) will consume the hint and trigger the
 * suggest block immediately instead of waiting for the counter to reach
 * the threshold. The daily note may not exist yet on the service message
 * itself (engram-daily-note / engram-session-start create it on the first
 * user message), which is why we defer injection until that next event.
 *
 * Idempotency:
 * - One suggestion per UTC day, gated by `<!-- engram:auto-suggest-shown:YYYYMMDD -->`.
 * - Block hash = sha256(chatId|topicId|messageCount|today). Re-injects only when the
 *   hash changes (i.e. message count grows or trigger is "fast-path").
 * - Bound topics are no-op (skip the whole check).
 * - Hint file is one-shot: consumed (deleted) on first consumption.
 *
 * This hook is a sibling to `engram-topic-domain-load`. It does NOT inject
 * the `## Domain Context (auto)` block (no domain yet) — it asks the agent
 * to offer creating one.
 */
const handler = async (event: any) => {
  if (event.type !== "message" || event.action !== "received") return;

  const workspaceDir =
    event.context?.workspaceDir || process.env.OPENCLAW_WORKSPACE;
  if (!workspaceDir) return;

  const rawChatId = event.context?.chatId;
  const rawTopicId = event.context?.topicId;
  if (!rawChatId || !rawTopicId) return;
  const chatId = String(rawChatId);
  const topicId = String(rawTopicId);
  const absChatId = chatId.replace(/^-/, "");
  const agentId = event.context?.agentId || "main";
  const sessionSegment = `telegram-group--${absChatId}-topic-${topicId}`;
  const sessionDir = join(workspaceDir, "memory", `agent-${agentId}`, sessionSegment);

  // Skip empty / command-only events
  const content: string = String(event.context?.content || "");
  if (!content.trim()) return;

  // Skip if the message is from a bot (defensive; message:received should be user-only)
  if (event.context?.fromBot === true) return;

  // Look up registry to see if topic is already bound
  const registryPath = join(workspaceDir, "memory", "domains", "registry.json");
  if (!existsSync(registryPath)) return;
  let registry: any;
  try {
    registry = JSON.parse(readFileSync(registryPath, "utf-8"));
  } catch { return; }
  if (!registry.domains || typeof registry.domains !== "object") return;

  for (const [, entry] of Object.entries<any>(registry.domains)) {
    if (entry.topic && String(entry.topic.topicId) === topicId) {
      const regChatId = String(entry.topic.chatId).replace(/^-/, "");
      if (regChatId === absChatId) return; // already bound → no-op
    }
  }

  // Fast path: Telegram "topic created" service message. Defer to the next
  // user message (when the daily note exists) by writing a hint file.
  if (isTopicCreationServiceMessage(event)) {
    const today = new Date().toLocaleDateString("sv-SE", { timeZone: TZ });
    const todayShort = today.replace(/-/g, "");
    const hintPath = join(sessionDir, `.engram-topic-created-${todayShort}`);
    try {
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(hintPath, String(Date.now()));
    } catch { /* best-effort: slow path still works */ }
    return;
  }

  if (!existsSync(sessionDir)) return;

  const today = new Date().toLocaleDateString("sv-SE", { timeZone: TZ });
  const todayShort = today.replace(/-/g, "");
  const notePath = join(sessionDir, `${today}.md`);
  if (!existsSync(notePath)) return;

  // Fast-path consumption: if the service-message hint file exists, this is
  // the first user message after a topic was just created. Treat the message
  // count as already at threshold (skip the slow wait) and consume the hint.
  const hintPath = join(sessionDir, `.engram-topic-created-${todayShort}`);
  let fastPathActive = false;
  if (existsSync(hintPath)) {
    fastPathActive = true;
    try { unlinkSync(hintPath); } catch { /* best-effort: idempotency still works via daySentinel */ }
  }

  const noteContent = readFileSync(notePath, "utf-8");

  // Day-level idempotency: if we already showed a suggestion today, skip
  const daySentinel = `<!-- engram:auto-suggest-shown:${todayShort} -->`;
  if (noteContent.includes(daySentinel)) return;

  // Count inbound user messages via a per-session counter file. We can't use
  // "- " lines in the daily note (those are agent-written events, and for an
  // unbound topic there is no agent to write them — see the self-suppressing
  // cycle bug this hook had pre-fix). The counter file lives in sessionDir,
  // rotates naturally with daily notes, and is incremented before the
  // threshold check so the *current* message counts.
  const counterPath = join(sessionDir, `.engram-msg-count-${todayShort}`);
  let messageCount = 1;
  try {
    if (existsSync(counterPath)) {
      const raw = readFileSync(counterPath, "utf-8").trim();
      const parsed = parseInt(raw, 10);
      if (Number.isFinite(parsed) && parsed >= 1) messageCount = parsed + 1;
    }
  } catch { /* read best-effort, count this message as 1 */ }
  try {
    writeFileSync(counterPath, String(messageCount));
  } catch { /* write best-effort, in-memory value still used */ }

  // Fast-path overrides the counter check: if the topic was just created
  // (service-message hint consumed above), suggest on the FIRST user message
  // instead of waiting for the second. Counter is still written for audit.
  if (!fastPathActive && messageCount < SUGGEST_THRESHOLD) return;

  // Compute content hash (so block is replaced only when state changes).
  // Include fastPathActive so the slow path's later inject (if message count
  // keeps growing past the fast-path day) doesn't collide on hash.
  const triggerKind = fastPathActive ? "fast" : "slow";
  const hashInput = `chatId=${absChatId};topicId=${topicId};msgs=${messageCount};day=${today};trigger=${triggerKind}`;
  const contentHash = createHash("sha256").update(hashInput).digest("hex").slice(0, 8);

  const existingRe = /<!-- engram:auto-suggest:([a-f0-9]+) -->/;
  const m = noteContent.match(existingRe);
  if (m && m[1] === contentHash) return; // no change since last inject

  // Suggest a default slug (user can override). For Latin topic names the
  // slug is the slugified name; for Cyrillic / empty / non-[a-z] starts we
  // fall back to a stable ID-based name. Suffix keeps it unique across groups.
  const topicNameFromCtx = String(event.context?.metadata?.topicName || "");
  const suggestedSlug = slugifyTopicName(topicNameFromCtx, absChatId, topicId);

  // KG auto-match: list available life/projects/* so the user can pick
  const kgHint = detectKgEntity(workspaceDir);

  // Build the block
  const block = `<!-- engram:auto-suggest:${contentHash} -->
## engram:auto-suggest (auto)

${fastPathActive
  ? `**Топик только что создан в форуме** и не привязан к домену Энграма. Рекомендуется спросить пользователя, нужно ли создать домен (auto-bind flow).`
  : `Этот топик накопил **${messageCount} сообщений** без привязанного домена. По контракту в \`workspace/topic-domain-conventions.md\` (C.a) рекомендуется создать домен для curated memory, если тема устойчивая.`}

- **chatId**: \`${chatId}\`
- **topicId**: \`${topicId}\`
- **Тема топика**: ${topicNameFromCtx ? `\`${topicNameFromCtx}\`` : "—"}
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
  --description "<из контекста топика>" \\
  --pending
\`\`\`

- «нет» / «не сейчас» → удали этот блок и добавь
  \`<!-- engram:auto-suggest-declined:${todayShort} -->\` чтобы не спрашивать снова
  до конца дня.

${daySentinel}
<!-- /engram:auto-suggest -->
`;

  // Remove any prior auto-suggest block + daySentinel, then re-insert
  const blockRe = /<!-- engram:auto-suggest:[a-f0-9]+ -->[\s\S]*?<!-- \/engram:auto-suggest -->\n?/g;
  const daySentinelRe = new RegExp(`<!-- engram:auto-suggest-shown:${todayShort} -->\\n?`, "g");
  let newContent = noteContent.replace(blockRe, "").replace(daySentinelRe, "");
  newContent = newContent.replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";

  const lines = newContent.split(NEWLINE);
  const dateLineIdx = lines.findIndex(l => /^# \d{4}-\d{2}-\d{2}/.test(l));
  if (dateLineIdx < 0) {
    newContent = newContent + "\n" + block;
  } else {
    lines.splice(dateLineIdx + 1, 0, "", block.trimEnd());
    newContent = lines.join("\n");
  }

  // Atomic write (same pattern as engram-topic-domain-load)
  const tmpDir = mkdtempSync(join(tmpdir(), "engram-auto-suggest-"));
  const tmpPath = join(tmpDir, "note.md");
  try {
    writeFileSync(tmpPath, newContent);
    renameSync(tmpPath, notePath);
  } finally {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
  console.log(`[engram-topic-auto-domain-suggest] Injected auto-suggest for topic ${absChatId}:${topicId} (${messageCount} msgs, ${triggerKind}-path) → ${notePath} (hash ${contentHash})`);
};

function detectKgEntity(workspaceDir: string): string {
  try {
    const lifeProjects = join(workspaceDir, "life", "projects");
    if (!existsSync(lifeProjects)) return "— (нет `life/projects/`)";
    const projects = readdirSync(lifeProjects, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name);
    if (projects.length === 0) return "— (нет проектов в KG)";
    return "доступные: " + projects.map(p => `\`projects/${p}\``).join(", ");
  } catch {
    return "—";
  }
}

export default handler;
