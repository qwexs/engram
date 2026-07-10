/**
 * Domain-injection helpers shared by all v2+ engram `*-domain-load` hooks.
 *
 * Provides the canonical pipeline for building and idempotently delivering
 * a domain context payload (decisions + status + last changelog entry +
 * agents body) into a session. Used by:
 *
 *   - `engram-topic-domain-load` (Telegram topic-thread bindings)
 *   - `engram-peer-domain-load` (Telegram DM + group-without-topics bindings)
 *   - `apriori-peer-domain-load` (Telegram direct-peer bindings, apriori-tech)
 *   - any future `*-domain-load` hook matching the system-event pattern
 *
 * Pipeline:
 *   1. `computeContextHash(files)`     → 8-hex content hash for the *context*
 *                                        (decisions + status + changelog)
 *   2. `resolveAgentsBody(files, cfg)` → `{body, source: "file"|"fallback"}`
 *                                        for the *agents* ruleset
 *   3. `readLatestHashFromNote(note)`  → last delivered hash on the receiver
 *                                        side (idempotency gate)
 *   4. `buildDomainPayload(opts)`      → the actual HTML+markdown body to send,
 *                                        stamped with `<!-- engram-system-event-hash:... -->`
 *
 * Both hooks then hand the payload off to `_lib/system-event.enqueueSystemEventToSession`
 * for delivery. The marker doubles as the idempotency key: same hash → no-op.
 *
 * @module _lib/domain-inject
 */

import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { readLatestSystemEventHash } from "./system-event.js";

const NEWLINE = /\r?\n/;

/** Absolute paths to the four domain files. */
export type DomainSourceFiles = {
  decisionsPath: string;   // <workspace>/memory/domains/<slug>/decisions.md
  statusPath: string;      // <workspace>/memory/domains/<slug>/status.md
  changelogPath: string;   // <workspace>/memory/domains/<slug>/changelog.md
  agentsPath: string;      // <workspace>/memory/domains/<slug>/agents.md
};

export type AgentsSource = "file" | "fallback";

export type AgentsBody = {
  body: string;
  source: AgentsSource;
};

/** Workspace-agnostic identifiers used to build the agents fallback body. */
export type ResolveAgentsCfg = {
  qmdIndex: string;             // cfg.qmd?.index ("default")
  kgCollection: string;         // cfg.qmd?.workspaceKgCollection ("life" / "kg")
  agentId: string;              // workspace agent id (e.g. "apriori-tech")
  domainName: string;           // domain slug
  sessionSegment: string;       // e.g. "telegram-group--100xxx-topic-60"
  kgEntity?: string | null;     // optional KG entity pointer from registry.json
};

/** Inputs to `buildDomainPayload`. */
export type BuildDomainPayloadOpts = {
  domainName: string;
  domainEntry: { type: string; kgEntity?: string | null; [k: string]: unknown };
  sessionKind: "topic-thread" | "peer-direct" | "group-direct";
  /** For topic-thread: "<chatId>:<topicId>". For peer-direct: "<userId>". For group-direct: "<chatId>". */
  sessionLocation: string;
  /** 8-hex hash from `computeContextHash`. Also stamped into the marker. */
  contentHash: string;
  agents: AgentsBody;
  files: DomainSourceFiles;
};

/**
 * SHA-256 over `{path}:{body.length};` + body for decisions/status/changelog.
 * Missing files contribute `{path}:missing;`. Returns the first 8 hex chars.
 *
 * 8 hex chars (32 bits) is plenty for collision-free idempotency at the
 * single-domain single-day scale this hook operates at (≈4 billion hashes
 * before 50% collision via birthday paradox — orders of magnitude more
 * than the realistic keyspace). The brief's §6 R6 standardizes on 8 hex
 * to match the peer hook's prod impl and to make the regex marker tighter.
 */
export function computeContextHash(files: DomainSourceFiles): string {
  const h = createHash("sha256");
  for (const p of [files.decisionsPath, files.statusPath, files.changelogPath]) {
    if (existsSync(p)) {
      const body = readFileSync(p, "utf-8");
      h.update(`${p}:${body.length};`);
      h.update(body);
    } else {
      h.update(`${p}:missing;`);
    }
  }
  return h.digest("hex").slice(0, 8);
}

/** Read agents.md from disk or render the inline fallback. Pure of side effects
 *  apart from the read. Throws only if `agentsPath` exists and is unreadable;
 *  callers wrap with try/catch when they prefer skip-on-error semantics. */
export function resolveAgentsBody(files: DomainSourceFiles, cfg: ResolveAgentsCfg): AgentsBody {
  if (existsSync(files.agentsPath)) {
    return {
      body: readFileSync(files.agentsPath, "utf-8"),
      source: "file",
    };
  }
  return {
    body: buildFallbackAgentsMd(cfg),
    source: "fallback",
  };
}

/**
 * Build the unified HTML+markdown payload. The second line carries the
 * `<!-- engram-system-event-hash:<hash> -->` marker, which `readLatestSystemEventHash`
 * scans for on the receiver side.
 *
 * Caller is expected to have already deduplicated against the latest marker
 * via `readLatestHashFromNote` — this function does not check idempotency
 * itself, it just stamps the hash it was given.
 */
export function buildDomainPayload(params: BuildDomainPayloadOpts): string {
  const {
    domainName,
    domainEntry,
    sessionKind,
    sessionLocation,
    contentHash,
    agents,
    files,
  } = params;

  const decisionsCount = countDecisions(files.decisionsPath);
  const statusBody = head(files.statusPath, 40);
  const changelogLast = lastChangelogEntry(files.changelogPath);

  const fallbackNote =
    agents.source === "fallback"
      ? `

> ⚠️ \`memory/domains/${domainName}/agents.md\` не найден — используется встроенный fallback. Создай файл из шаблона \`templates/domain/topic-thread/agents.md\` или запусти \`bun skills/engram/scripts/backfill-domain-agents.js\`.`
      : "";

  // For topic-thread the sessionLocation is "<chatId>:<topicId>"; split on
  // the first ":" only (chat ids are always "-<digits>"). For peer-direct
  // it is just the userId. For group-direct it is the chatId.
  const sessionLabel =
    sessionKind === "topic-thread"
      ? `chat \`${sessionLocation.split(":")[0]}\`, topic \`${sessionLocation.split(":")[1]}\``
      : sessionKind === "peer-direct"
        ? `DM \`${sessionLocation}\``
        : `group \`${sessionLocation}\``;

  return `🧠 <b>Engram Domain Context (auto)</b> · <code>${sessionKind}</code>
<!-- engram-system-event-hash:${contentHash} -->

<b>Domain</b>: \`${domainName}\` (${domainEntry.type})
<b>Session</b>: ${sessionLabel}
<b>KG entity</b>: ${domainEntry.kgEntity ? `\`${domainEntry.kgEntity}\`` : "—"}

<details><summary><b>Status</b> (${decisionsCount} принятых решений в decisions.md)</summary>

${statusBody.trim() || "_status.md пуст_"}

</details>

<details><summary><b>Последняя запись changelog.md</b></summary>

${changelogLast || "_changelog.md пуст_"}

</details>

---

🧭 <b>Domain AGENTS (auto)</b>${fallbackNote}

${agents.body.trim()}

---

<i>auto-injected by engram v2 (system-event delivery) · hash=${contentHash} · source=${agents.source} · session=${sessionKind}</i>`;
}

/**
 * Read the latest `<!-- engram-system-event-hash:... -->` marker from a
 * daily note. Returns the 8-hex hash or null if the note is missing,
 * unreadable, or has no prior marker.
 *
 * Behaviour note: the note may also carry legacy `<!-- domain-context:* -->`
 * blocks from older writes (v3.3 era). Those markers intentionally do NOT
 * match the system-event regex — they are treated as inert cruft and
 * naturally rotated out via the existing three-layer rotation pipeline.
 */
export function readLatestHashFromNote(notePath: string): string | null {
  if (!existsSync(notePath)) return null;
  try {
    return readLatestSystemEventHash(readFileSync(notePath, "utf-8"));
  } catch {
    return null;
  }
}

/**
 * Build a minimal fallback for the Domain AGENTS block when the real
 * `memory/domains/<slug>/agents.md` is missing. Rendered only on the
 * "fallback" source path; an ⚠️ note is added in the payload so the
 * receiving agent knows to backfill the full template eventually.
 *
 * The full canonical template lives at
 * `templates/domain/topic-thread/agents.md`. This helper exists so the
 * hook can stay functional even before the backfill runs.
 */
export function buildFallbackAgentsMd(cfg: ResolveAgentsCfg): string {
  const { domainName, sessionSegment, qmdIndex, agentId, kgCollection, kgEntity } = cfg;
  const kgLine = kgEntity
    ? `- **Свой KG entity**: \`${kgEntity}\` → \`qmd --index ${qmdIndex} query "<topic>" -c life-projects-${domainName}\` или \`read life/${kgEntity}/summary.md\``
    : `- **KG entity не задан** — QMD для KG не использовать`;

  return `# Domain AGENTS — ${domainName} (fallback)

⚠️ Это встроенный fallback. Полная версия: \`memory/domains/${domainName}/agents.md\`.
Создай из шаблона: \`bun skills/engram/scripts/backfill-domain-agents.js\`.

## Ты в роли
Agent домена \`${domainName}\`. Session: \`${sessionSegment}\`.

## QMD default
\`\`\`bash
qmd --index ${qmdIndex} query "<topic>" \\
  -c domain-${domainName} \\
  -c openclaw-memory-agent-${agentId}-${sessionSegment}
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

/** Read the first `maxLines` lines of a file as a CRLF-safe string. Returns ""
 *  if the file is missing. */
export function head(p: string, maxLines: number): string {
  if (!existsSync(p)) return "";
  return readFileSync(p, "utf-8").split(NEWLINE).slice(0, maxLines).join("\n");
}

/** Count "### " headings in a decisions.md file. Used to surface "<N> принятых
 *  решений" in the payload status block. Returns 0 if the file is missing. */
export function countDecisions(p: string): number {
  if (!existsSync(p)) return 0;
  const normalized = readFileSync(p, "utf-8").replace(/\r/g, "");
  return (normalized.match(/^###\s+/gm) || []).length;
}

/** Return the last `## YYYY-MM-DD`-headed entry from a changelog.md, or ""
 *  if there are no entries. */
export function lastChangelogEntry(p: string): string {
  if (!existsSync(p)) return "";
  const content = readFileSync(p, "utf-8");
  const lines = content.split(NEWLINE);
  const entryStarts: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+\d{4}-\d{2}-\d{2}/.test(lines[i])) entryStarts.push(i);
  }
  if (entryStarts.length === 0) return "";
  const start = entryStarts[entryStarts.length - 1];
  return lines.slice(start).join("\n").trim();
}
