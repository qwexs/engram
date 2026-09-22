import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";
import { normalizeSessionSegment } from "../session-key.ts";
import type { CanonicalDeliveryScope, DeliveryReason, DeliverySourceOutcome } from "./contracts.ts";
import { completeMarkdownRecords, extractUniqueH2Section } from "./markdown-records.ts";

const DAILY_NOTE = /^\d{4}-\d{2}-\d{2}\.md$/;
const MAX_NOTES = 3;
const MAX_SOURCE_BYTES = 7 * 1024;
const MAX_RECORD_BYTES = 2 * 1024;
const MAX_RAW_NOTE_BYTES = 256 * 1024;

type DatedRecord = { date: string; text: string };
type DailySnapshot = { date: string; content: string; digest: `sha256:${string}` };

class SessionSourceError extends Error {
  constructor(readonly reason: DeliveryReason, message: string) {
    super(message);
  }
}

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function inside(root: string, path: string): boolean {
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return path.startsWith(prefix);
}

function stableRead(path: string): { content: string; digest: `sha256:${string}` } {
  const before = statSync(path);
  if (!before.isFile()) throw new SessionSourceError("SOURCE_INVALID", "session context source is not a regular file");
  if (before.size > MAX_RAW_NOTE_BYTES) throw new SessionSourceError("BUDGET_SOURCE_CAP", "session note exceeds raw file cap");
  const content = readFileSync(path, "utf8");
  const after = statSync(path);
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
    throw new SessionSourceError("SNAPSHOT_UNAVAILABLE", "session context source changed during snapshot read");
  }
  const normalized = content.replace(/\r/g, "");
  return { content: normalized, digest: sha256(normalized) };
}

function acceptable(record: string): boolean {
  return Boolean(record.trim()) && Buffer.byteLength(record, "utf8") <= MAX_RECORD_BYTES;
}

function sectionRecords(note: DailySnapshot, heading: string, state: { oversized: boolean }): string[] {
  const records = completeMarkdownRecords(extractUniqueH2Section(note.content, heading));
  if (records.some((record) => !acceptable(record))) state.oversized = true;
  return records.filter(acceptable);
}

function recentRecords(notes: DailySnapshot[], heading: string, limit: number, state: { oversized: boolean }): DatedRecord[] {
  const selected: DatedRecord[] = [];
  const seen = new Set<string>();
  for (const note of notes) {
    const records = sectionRecords(note, heading, state).reverse();
    for (const record of records) {
      const key = sha256(record);
      if (seen.has(key)) continue;
      seen.add(key);
      selected.push({ date: note.date, text: record });
      if (selected.length === limit) return selected;
    }
  }
  return selected;
}

function latestRecords(notes: DailySnapshot[], heading: string, limit: number, state: { oversized: boolean }): DatedRecord[] {
  for (const note of notes) {
    const seen = new Set<string>();
    const records = sectionRecords(note, heading, state).reverse().filter((record) => {
      const key = sha256(record);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, limit);
    if (records.length) return records.map((text) => ({ date: note.date, text }));
  }
  return [];
}

function renderSection(heading: string, records: DatedRecord[]): string[] {
  if (!records.length) return [];
  return [
    `## ${heading}`,
    ...records.flatMap((record, index) => [`### ${record.date} · ${index + 1}`, record.text, ""]),
  ];
}

function renderCapsule(scope: CanonicalDeliveryScope, selected: Record<string, DatedRecord[]>): string {
  return [
    "# Engram Session Context",
    `Session kind: ${scope.kind}`,
    "",
    ...renderSection("Active Threads", selected.threads ?? []),
    ...renderSection("Next", selected.next ?? []),
    ...renderSection("Recent Summary", selected.summary ?? []),
    ...renderSection("Recent Decisions", selected.decisions ?? []),
    ...renderSection("Recent Events", selected.events ?? []),
  ].join("\n").trim();
}

function boundedSelection(scope: CanonicalDeliveryScope, candidates: Record<string, DatedRecord[]>): Record<string, DatedRecord[]> {
  const selected: Record<string, DatedRecord[]> = { threads: [], next: [], summary: [], decisions: [], events: [] };
  for (const key of ["threads", "next", "summary", "decisions", "events"] as const) {
    for (const candidate of candidates[key] ?? []) {
      const trial = { ...selected, [key]: [...selected[key]!, candidate] };
      if (Buffer.byteLength(renderCapsule(scope, trial), "utf8") <= MAX_SOURCE_BYTES) selected[key]!.push(candidate);
    }
  }
  return selected;
}

function validDailyName(name: string, now: string): boolean {
  if (!DAILY_NOTE.test(name)) return false;
  const date = name.slice(0, 10);
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== date) return false;
  const ceiling = new Date(new Date(now).valueOf() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return date <= ceiling;
}

function dailySnapshots(workspace: string, scope: CanonicalDeliveryScope, now: string): DailySnapshot[] | null {
  const segment = normalizeSessionSegment(scope.sessionKey);
  if (!segment) throw new SessionSourceError("SOURCE_INVALID", "canonical session key has no safe note segment");
  const root = realpathSync(resolve(workspace));
  const candidate = resolve(join(root, "memory", `agent-${scope.agentId}`, segment));
  if (!existsSync(candidate)) return null;
  const directory = realpathSync(candidate);
  if (!inside(root, directory)) throw new SessionSourceError("SOURCE_INVALID", "session note directory escapes workspace");
  const list = () => readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && validDailyName(entry.name, now))
    .map((entry) => entry.name)
    .sort();
  const before = list();
  const names = before.slice(-MAX_NOTES).reverse();
  const notes = names.map((name) => ({ date: name.slice(0, 10), ...stableRead(realpathSync(join(directory, name))) }));
  const after = list();
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    throw new SessionSourceError("SNAPSHOT_UNAVAILABLE", "session note set changed during snapshot read");
  }
  return notes;
}

export function resolveSessionContextSource(options: {
  workspace: string;
  scope: CanonicalDeliveryScope;
  now?: string;
}): DeliverySourceOutcome {
  try {
    const notes = dailySnapshots(options.workspace, options.scope, options.now ?? new Date().toISOString());
    if (!notes?.length) return { source: "session", status: "omitted", reason: "SOURCE_MISSING" };
    const state = { oversized: false };
    const candidates = {
      threads: latestRecords(notes, "Active Threads", 2, state),
      next: latestRecords(notes, "Next", 2, state),
      summary: [] as DatedRecord[],
      decisions: recentRecords(notes, "Decisions", 3, state),
      events: recentRecords(notes, "Events", 5, state),
    };
    if (![...candidates.threads, ...candidates.next, ...candidates.decisions, ...candidates.events].length) {
      candidates.summary = latestRecords(notes, "Summary", 1, state);
    }
    const selected = boundedSelection(options.scope, candidates);
    if (!Object.values(selected).some((records) => records.length)) {
      return { source: "session", status: "omitted", reason: state.oversized ? "BUDGET_SOURCE_CAP" : "SOURCE_MISSING" };
    }
    const content = renderCapsule(options.scope, selected);
    const artifactDigest = sha256(JSON.stringify({
      schema: "engram.session-context-snapshot.v1",
      notes: notes.map((note) => ({ date: note.date, digest: note.digest })),
      selected,
    }));
    return {
      source: "session",
      status: "selected",
      block: { source: "session", artifactDigest, content },
    };
  } catch (error) {
    return {
      source: "session",
      status: "omitted",
      reason: error instanceof SessionSourceError ? error.reason : "SOURCE_INVALID",
    };
  }
}
