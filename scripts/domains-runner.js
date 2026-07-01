#!/usr/bin/env bun
/**
 * domains-runner.js
 *
 * Scan domain continuity memory without mutating domain files.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { createHash } from "node:crypto";

const EXPECTED_FILES_BY_TYPE = {
  "dev-project": ["decisions.md", "workflow.md", "status.md", "changelog.md"],
  "cron-task":   ["decisions.md", "workflow.md", "status.md", "changelog.md"],
  "topic-thread":["decisions.md", "status.md", "changelog.md"],
};

// === TZ contract =============================================================
// ISS-9 fix A1+A3: every date computation in this file MUST go through
// `getTz()` for time-zone identity, and date parsing MUST NOT rely on V8's
// cached TZ (V8 reads `process.env.TZ` only once at startup, so mid-process
// mutations have no effect on `new Date(...).getTime()`).
//
// Wall-clock dates without an explicit offset (e.g. `## 2026-07-01 14:30` in
// Russian changelog) are interpreted as local time in the operator's declared
// TZ via `parseWallClockInTz()` — an `Intl.DateTimeFormat(timeZone)` based
// helper that does NOT depend on V8's TZ cache.
function getTz() {
  return process.env.ENGRAM_TZ || process.env.TZ || "Europe/Moscow";
}

// Parse {y, mo, d, h, mi, s} as wall-clock time in `tz` → ms since epoch.
// Robust against DST transitions because it uses the IANA TZ database via
// `Intl.DateTimeFormat`.
//
// Sign convention: if `tz` is AHEAD of UTC by N hours, the wall-clock-at-
// fakeUtc shows a LATER time than target. To find the actual UTC instant
// when `tz` clock matches target, we SUBTRACT the wall-clock gap from fakeUtc.
// Concretely: real_utc = fakeUtc + (targetMs - tzWallMs). This works for
// both ahead-of-UTC (negative term) and behind-UTC (positive term) zones.
function parseWallClockInTz(date, time, tz) {
  const [y, mo, d] = date.split("-").map(Number);
  let h = 0, mi = 0, s = 0;
  if (time) {
    const parts = time.split(":");
    h = Number(parts[0]) || 0;
    mi = Number(parts[1]) || 0;
    s = Number(parts[2]) || 0;
  }
  // Validate ranges explicitly. JS Date.UTC overflows silently (e.g. month
  // 13 → January next year) instead of returning NaN, so without these checks
  // an impossible date like `2026-13-01` would be picked as "newest" by the
  // freshness calc and corrupt the result.
  if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)
    || mo < 1 || mo > 12 || d < 1 || d > 31
    || h < 0 || h > 23 || mi < 0 || mi > 59 || s < 0 || s > 59) {
    return NaN;
  }
  // Build a "fake UTC" instant representing the desired wall-clock time.
  const fakeUtc = Date.UTC(y, mo - 1, d, h, mi, s);
  // What does that instant actually look like in `tz`?
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hourCycle: "h23",
  });
  const parts = fmt.formatToParts(fakeUtc);
  const tzWall = {
    y: Number(parts.find((p) => p.type === "year").value),
    mo: Number(parts.find((p) => p.type === "month").value),
    d: Number(parts.find((p) => p.type === "day").value),
    h: Number(parts.find((p) => p.type === "hour").value),
    mi: Number(parts.find((p) => p.type === "minute").value),
    s: Number(parts.find((p) => p.type === "second").value),
  };
  const targetMs = Date.UTC(y, mo - 1, d, h, mi, s);
  const tzWallMs = Date.UTC(tzWall.y, tzWall.mo - 1, tzWall.d, tzWall.h, tzWall.mi, tzWall.s);
  return fakeUtc + (targetMs - tzWallMs);
}
const EXPECTED_FILES = EXPECTED_FILES_BY_TYPE["dev-project"]; // default for legacy callers
function expectedFilesFor(config) {
  if (config && config.type && EXPECTED_FILES_BY_TYPE[config.type]) {
    return EXPECTED_FILES_BY_TYPE[config.type];
  }
  return EXPECTED_FILES;
}
const DEFAULT_STALE_DAYS = 30;
const MUTABLE_FILES = new Set(["status.md", "changelog.md"]);
const MAX_STATUS_BYTES = 64 * 1024;
const MAX_CHANGELOG_APPEND_BYTES = 64 * 1024;


function archiveTopicThreadDomain({ name, config, domainsRoot, nowMs, dryRun = true }) {
  // Archive a stale topic-thread domain: set archived: true in registry and
  // move files from memory/domains/{slug}/ to memory/domains/archives/{slug}/.
  // Returns { archived: boolean, reason: string, archivePath?: string }.
  if (!config || config.type !== "topic-thread") {
    return { archived: false, reason: "not topic-thread" };
  }
  if (config.archived === true) {
    return { archived: false, reason: "already archived" };
  }
  const domainDir = join(domainsRoot, name);
  if (!existsSync(domainDir)) {
    return { archived: false, reason: "domain dir missing" };
  }
  // Check freshness: read changelog.md content-date, fallback to status.md mtime
  const changelogPath = join(domainDir, "changelog.md");
  const statusPath = join(domainDir, "status.md");
  let lastActivityMs = 0;
  if (existsSync(changelogPath)) {
    const c = newestContentDateMs(readFileSync(changelogPath, "utf8"));
    if (c != null) lastActivityMs = Math.max(lastActivityMs, c);
    const m = statSync(changelogPath).mtimeMs;
    lastActivityMs = Math.max(lastActivityMs, m);
  }
  if (existsSync(statusPath)) {
    const m = statSync(statusPath).mtimeMs;
    lastActivityMs = Math.max(lastActivityMs, m);
  }
  if (lastActivityMs === 0) {
    return { archived: false, reason: "no activity signal (no changelog.md or status.md)" };
  }
  const staleAfterDays = numberFromConfig(config, ["staleAfterDays", "statusStaleDays"]) ?? 60;
  const age = ageDays(lastActivityMs, nowMs);
  if (age < staleAfterDays) {
    return { archived: false, reason: `not stale yet (age ${age}d < ${staleAfterDays}d)` };
  }
  // Mark for archive. If dryRun, don't actually move.
  const archiveDir = join(domainsRoot, "archives", name);
  const result = { archived: false, reason: "dry-run", archivePath: archiveDir, ageDays };
  if (dryRun) return result;
  // Move files
  mkdirSync(dirname(archiveDir), { recursive: true });
  if (existsSync(archiveDir)) {
    return { archived: false, reason: `archive dir already exists: ${archiveDir}` };
  }
  // Atomic rename of the entire domain dir to archives/{slug}/
  renameSync(domainDir, archiveDir);
  // Mutate registry
  const registryPath = join(domainsRoot, "registry.json");
  const reg = readJson(registryPath);
  if (!reg.domains) reg.domains = {};
  if (!reg.domains[name]) reg.domains[name] = {};
  reg.domains[name].archived = true;
  reg.domains[name].archivedAt = new Date(nowMs).toISOString();
  reg.domains[name].archivePath = relative(domainsRoot, archiveDir);
  writeJson(registryPath, reg);
  return { archived: true, archivePath: archiveDir, ageDays };
}


function parseArgs(argv) {
  const opts = {};
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith("--")) continue;
    const key = args[i].slice(2);
    const next = args[i + 1];
    if (next && !next.startsWith("--")) {
      opts[key] = next;
      i++;
    } else {
      opts[key] = true;
    }
  }
  return opts;
}

function readJson(path) {
  const raw = readFileSync(path, "utf8");
  return JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
}

function atomicWrite(path, content) {
  const tmp = path + ".tmp-" + process.pid + "-" + Date.now();
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, path);
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  atomicWrite(path, JSON.stringify(value, null, 2) + "\n");
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

export function hashDomainFile({ workspace, domain, file }) {
  if (!MUTABLE_FILES.has(file)) throw new Error("Domain workers cannot hash mutable guard for " + file);
  const root = resolve(workspace || process.env.ENGRAM_WORKSPACE || process.cwd());
  const path = resolve(root, "memory", "domains", domain, file);
  return existsSync(path) ? sha256(readFileSync(path, "utf8")) : null;
}

function ageDays(mtimeMs, nowMs) {
  return Math.floor((nowMs - mtimeMs) / 86400000);
}

function numberFromConfig(config, keys) {
  for (const key of keys) {
    const value = config?.[key];
    if (value != null && value !== "" && Number.isFinite(Number(value))) return Number(value);
  }
  return null;
}

function dateFromConfig(config, keys) {
  for (const key of keys) {
    const value = config?.[key];
    if (!value) continue;
    const ms = new Date(value).getTime();
    if (Number.isFinite(ms)) return ms;
  }
  return null;
}

export function newestContentDateMs(content) {
  // ISS-9 fix A1+A3: parse content dates in the operator's declared TZ rather
  // than UTC. Two passes:
  //   1. Full ISO-like with explicit Z or ±HH:MM offset → parse as-is.
  //   2. Date-only OR date+time-without-offset → parse via parseWallClockInTz()
  //      so we don't depend on V8's TZ cache (V8 reads process.env.TZ only
  //      once at process start).
  let newest = null;
  const tz = getTz();

  const fullRe = /\b(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2})?)(Z|[+-]\d{2}:?\d{2})\b/g;
  for (const m of content.matchAll(fullRe)) {
    const isoStr = m[1] + "T" + m[2] + m[3];
    const ms = new Date(isoStr).getTime();
    if (Number.isFinite(ms) && (newest == null || ms > newest)) newest = ms;
  }

  // Second pass: date-only OR date+time without explicit offset. Use
  // parseWallClockInTz() so the operator's TZ is honored regardless of when
  // the process started or what V8 cached initially.
  const localRe = /\b(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}(?::\d{2})?))?(?![+-Z0-9])/g;
  for (const m of content.matchAll(localRe)) {
    const date = m[1];
    const time = m[2];
    let ms;
    try {
      ms = parseWallClockInTz(date, time, tz);
    } catch {
      continue;
    }
    if (Number.isFinite(ms) && (newest == null || ms > newest)) newest = ms;
  }
  return newest;
}

function isEnabled(config) {
  return config?.enabled !== false && config?.disabled !== true;
}

function safeDomainName(name) {
  return typeof name === "string" && /^[a-z0-9][a-z0-9-]*$/.test(name);
}

function assertInside(parent, child) {
  const rel = relative(parent, child);
  if (rel.startsWith("..") || rel === "" && parent !== child || resolve(child) === resolve(parent)) {
    if (resolve(child) !== resolve(parent)) throw new Error("Resolved path escapes domain root");
  }
  if (rel.startsWith("..") || rel.includes("..")) throw new Error("Resolved path escapes domain root");
}

function parseJsonStrict(raw, fieldName) {
  if (raw == null || raw === "") return null;
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(fieldName + " must be valid JSON: " + err.message);
  }
}

function parseHandoffField(body, name) {
  const multi = body.match(new RegExp("^" + name + ":\\s*\\|\\n([\\s\\S]*?)(?=\\n[A-Za-z][A-Za-z-]*:|\\n===|\\Z)", "m"));
  if (multi) return multi[1].replace(/^ {2}/gm, "").replace(/\n$/, "");
  const single = body.match(new RegExp("^" + name + ":\\s*(.*)$", "m"));
  return single ? single[1].trim() : null;
}

function normalizeChangelogEntries(entries, runId) {
  if (entries == null) return [];
  if (!Array.isArray(entries)) throw new Error("Changelog-Entries must be a JSON array");
  return entries.map((entry, index) => {
    if (typeof entry === "string") {
      return { id: runId + ":" + index, runId, content: entry.trim() };
    }
    if (!entry || typeof entry !== "object") throw new Error("Changelog-Entries entries must be strings or objects");
    const id = String(entry.id || entry.entryId || entry.runId || runId + ":" + index);
    const content = String(entry.content || entry.text || "").trim();
    if (!content) throw new Error("Changelog-Entries entry has no content");
    if (entry.runId && String(entry.runId) !== runId) throw new Error("Changelog-Entries runId does not match Run-Id");
    return { id, runId, content };
  });
}

function validatePromotions(promotions) {
  if (promotions == null) return [];
  if (!Array.isArray(promotions)) throw new Error("Promotions must be a JSON array");
  return promotions.map((item, index) => {
    if (!item || typeof item !== "object") throw new Error("Promotions entries must be objects");
    for (const key of ["entity", "fact", "category", "confidence"]) {
      if (item[key] == null || item[key] === "") throw new Error("Promotions[" + index + "] missing " + key);
    }
    return item;
  });
}

function getPath(obj, dotted) {
  return dotted.split(".").reduce((cur, key) => cur && cur[key], obj);
}

function setPath(obj, dotted, value) {
  const keys = dotted.split(".");
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (cur[keys[i]] == null || typeof cur[keys[i]] !== "object") cur[keys[i]] = {};
    cur = cur[keys[i]];
  }
  cur[keys[keys.length - 1]] = value;
}

async function runPromotion(commandRunner, scriptsDir, workspace, item, source) {
  const args = ["bun", join(scriptsDir, "memory-write.js"),
    "--entity", String(item.entity),
    "--fact", String(item.fact),
    "--category", String(item.category),
    "--confidence", String(item.confidence),
    "--source", source,
  ];
  if (item.description) args.push("--description", String(item.description));
  if (item.abstraction) args.push("--abstraction", String(item.abstraction));
  if (item.tags) args.push("--tags", Array.isArray(item.tags) ? item.tags.join(",") : String(item.tags));
  if (["preference", "decision", "correction"].includes(String(item.category))) args.push("--check-contradictions");
  const res = await commandRunner(args, {
    cwd: workspace,
    env: { ...process.env, ENGRAM_WORKSPACE: workspace },
  });
  return Boolean(res?.ok);
}

export async function applyDomainWriteHandoff(handoff, {
  workspace,
  statePath,
  now = new Date().toISOString(),
  dryRun = false,
  selectedDomain = null,
  commandRunner = null,
  scriptsDir = dirname(new URL(import.meta.url).pathname),
} = {}) {
  const root = resolve(workspace || process.env.ENGRAM_WORKSPACE || process.cwd());
  const domainsRoot = resolve(root, "memory", "domains");
  const registryPath = join(domainsRoot, "registry.json");
  const stateFile = statePath || join(root, "memory", "heartbeat-state.json");
  if (!existsSync(registryPath)) throw new Error("Domain registry not found");

  const registry = readJson(registryPath);
  const domain = parseHandoffField(handoff.body, "Domain");
  const runId = parseHandoffField(handoff.body, "Run-Id");
  if (!safeDomainName(domain)) throw new Error("Domain is missing or invalid");
  if (!runId) throw new Error("Run-Id is required");
  if (selectedDomain && domain !== selectedDomain) throw new Error("Handoff domain does not match selected domain");

  const config = registry.domains?.[domain];
  if (!config) throw new Error("Domain not registered: " + domain);
  if (!isEnabled(config)) throw new Error("Domain is disabled: " + domain);
  const workerLabel = parseHandoffField(handoff.body, "Subagent-Label");
  if (workerLabel && config.subagentLabel && workerLabel !== config.subagentLabel) {
    throw new Error("Subagent-Label does not match registry");
  }

  const domainDir = resolve(domainsRoot, domain);
  assertInside(domainsRoot, domainDir);
  const statusPath = resolve(domainDir, "status.md");
  const changelogPath = resolve(domainDir, "changelog.md");
  assertInside(domainDir, statusPath);
  assertInside(domainDir, changelogPath);

  const state = existsSync(stateFile) ? readJson(stateFile) : {};
  const appliedRuns = getPath(state, "domainRuns." + domain + ".appliedRunIds") || [];
  if (appliedRuns.includes(runId)) {
    return {
      ok: true,
      status: "noop",
      domain,
      runId,
      changed: false,
      idempotent: true,
      promotedFacts: 0,
      proposedDecisionChanges: 0,
      proposedWorkflowChanges: 0,
    };
  }

  // Detect noop handoff: no Base-Hashes AND no Status-Content AND no Changelog-Entries.
  // Per HB-DOMAINS-WRITE.md Step 7, a subagent that finds nothing domain-relevant returns
  // a minimal handoff without Base-Hashes. We treat that as a valid noop: advance
  // lastCheckedAt (so the next scan suppresses this domain), but skip base-hash checks,
  // file writes, and lastRun bump.
  const rawBaseHashes = parseHandoffField(handoff.body, "Base-Hashes");
  const rawStatusContent = parseHandoffField(handoff.body, "Status-Content");
  const rawEntriesRaw = parseHandoffField(handoff.body, "Changelog-Entries") ?? "[]";
  let rawEntries;
  try { rawEntries = JSON.parse(rawEntriesRaw); } catch { rawEntries = null; }
  const isNoopHandoff = rawBaseHashes == null && rawStatusContent == null && Array.isArray(rawEntries) && rawEntries.length === 0;
  if (isNoopHandoff && !dryRun) {
    const updated = existsSync(stateFile) ? readJson(stateFile) : {};
    const existing = getPath(updated, "domainRuns." + domain + ".appliedRunIds") || [];
    setPath(updated, "domainRuns." + domain + ".lastCheckedAt", now);
    setPath(updated, "domainRuns." + domain + ".lastRunId", runId);
    setPath(updated, "domainRuns." + domain + ".appliedRunIds", [...new Set([...existing, runId])]);
    writeJson(stateFile, updated);
  }
  if (isNoopHandoff) {
    return {
      ok: true,
      status: "noop",
      domain,
      runId,
      changed: false,
      idempotent: false,
      dryRun,
      wroteStatus: false,
      appendedEntries: 0,
      promotedFacts: 0,
      proposedDecisionChanges: 0,
      proposedWorkflowChanges: 0,
    };
  }

  const baseHashes = parseJsonStrict(rawBaseHashes, "Base-Hashes");
  if (!baseHashes || typeof baseHashes !== "object") throw new Error("Base-Hashes is required");
  const currentHashes = {
    "status.md": existsSync(statusPath) ? sha256(readFileSync(statusPath, "utf8")) : null,
    "changelog.md": existsSync(changelogPath) ? sha256(readFileSync(changelogPath, "utf8")) : null,
  };

  // ISS-9 fix A2: race with agent writes.
  // The subagent's Base-Hashes become stale if a human/agent edited the
  // domain files between subagent-read and apply. Two recovery paths:
  //   (a) If any proposed Entry-Id / Run-Id is already present in the
  //       existing changelog, treat the handoff as idempotent-applied.
  //   (b) Otherwise advance lastCheckedAt (preventing per-tick re-fire storm)
  //       and return status: "stale" — the operator can re-enqueue manually.
  //
  // We need entries parsed early; the canonical parse lives below after
  // status/promotions validation. To keep things tight, parse just the
  // entry ids here for the idempotency check and re-use the canonical parse
  // for the file write below.
  let earlyEntries = [];
  try {
    const rawEntriesField = parseHandoffField(handoff.body, "Changelog-Entries") ?? "[]";
    earlyEntries = normalizeChangelogEntries(parseJsonStrict(rawEntriesField, "Changelog-Entries"), runId);
  } catch (err) {
    // Malformed Changelog-Entries fall through to the canonical parse below
    // which will re-throw with a cleaner error.
    earlyEntries = [];
  }
  const proposedEntryIds = earlyEntries.map((e) => e.id);
  const proposedRunIds = new Set([runId]);
  const existingContent = existsSync(changelogPath) ? readFileSync(changelogPath, "utf8") : "";
  const entryAlreadyApplied = proposedEntryIds.some((id) => existingContent.includes("Entry-Id: " + id))
    || Array.from(proposedRunIds).some((id) => existingContent.includes("Run-Id: " + id));
  if (entryAlreadyApplied) {
    if (!dryRun) {
      const updated = existsSync(stateFile) ? readJson(stateFile) : {};
      const appliedList = getPath(updated, "domainRuns." + domain + ".appliedRunIds") || [];
      setPath(updated, "domainRuns." + domain + ".lastCheckedAt", now);
      setPath(updated, "domainRuns." + domain + ".lastRunId", runId);
      setPath(updated, "domainRuns." + domain + ".appliedRunIds", [...new Set([...appliedList, runId])]);
      writeJson(stateFile, updated);
    }
    return {
      ok: true,
      status: "noop",
      domain,
      runId,
      idempotent: true,
      externalWrite: true,
      dryRun,
      wroteStatus: false,
      appendedEntries: 0,
      promotedFacts: 0,
      proposedDecisionChanges: 0,
      proposedWorkflowChanges: 0,
    };
  }

  const staleFiles = [];
  for (const file of MUTABLE_FILES) {
    if (baseHashes[file] == null) throw new Error("Base-Hashes missing " + file);
    if (baseHashes[file] !== currentHashes[file]) staleFiles.push(file);
  }
  if (staleFiles.length > 0) {
    // Race detected: external write changed the file. Advance lastCheckedAt
    // (prevent re-fire storm) but skip file writes.
    if (!dryRun) {
      const updated = existsSync(stateFile) ? readJson(stateFile) : {};
      const appliedList = getPath(updated, "domainRuns." + domain + ".appliedRunIds") || [];
      setPath(updated, "domainRuns." + domain + ".lastCheckedAt", now);
      setPath(updated, "domainRuns." + domain + ".lastRunId", runId);
      setPath(updated, "domainRuns." + domain + ".appliedRunIds", [...new Set([...appliedList, runId])]);
      writeJson(stateFile, updated);
    }
    return {
      ok: true,
      status: "stale",
      domain,
      runId,
      staleFiles,
      idempotent: false,
      advancedLastCheckedAt: !dryRun,
      dryRun,
      wroteStatus: false,
      appendedEntries: 0,
      promotedFacts: 0,
      proposedDecisionChanges: 0,
      proposedWorkflowChanges: 0,
    };
  }

  const blockedFields = ["Decisions-Content", "Workflow-Content", "Decisions-Patch", "Workflow-Patch"];
  for (const field of blockedFields) {
    if (parseHandoffField(handoff.body, field) != null) throw new Error(field + " is read-only for domain workers");
  }

  const statusContent = parseHandoffField(handoff.body, "Status-Content");
  const statusPatch = parseHandoffField(handoff.body, "Status-Patch");
  if (statusContent != null && statusPatch != null) throw new Error("Use Status-Content or Status-Patch, not both");
  if (statusPatch != null) throw new Error("Status-Patch is not implemented; use Status-Content");
  if (statusContent != null && Buffer.byteLength(statusContent, "utf8") > MAX_STATUS_BYTES) {
    throw new Error("Status-Content exceeds size limit");
  }

  // Re-parse entries here; the early-parse above only feeds the idempotency
  // check; the canonical re-parse runs after all field validation so any
  // structural error surfaces with a clear message here rather than being
  // swallowed as an "external write" noop.
  const entries = earlyEntries.length === 0
    ? normalizeChangelogEntries(parseJsonStrict(parseHandoffField(handoff.body, "Changelog-Entries") ?? "[]", "Changelog-Entries"), runId)
    : earlyEntries;
  const promotions = validatePromotions(parseJsonStrict(parseHandoffField(handoff.body, "Promotions") ?? "[]", "Promotions"));
  const proposedDecisions = parseJsonStrict(parseHandoffField(handoff.body, "Proposed-Decisions") ?? "[]", "Proposed-Decisions");
  const proposedWorkflow = parseJsonStrict(parseHandoffField(handoff.body, "Proposed-Workflow") ?? "[]", "Proposed-Workflow");

  const existingChangelog = existsSync(changelogPath) ? readFileSync(changelogPath, "utf8") : "";
  const newEntries = entries.filter((entry) => !existingChangelog.includes("Run-Id: " + entry.runId) && !existingChangelog.includes("Entry-Id: " + entry.id));
  const appendText = newEntries.map((entry) => {
    const content = entry.content.endsWith("\n") ? entry.content.trimEnd() : entry.content;
    return "\n\n" + content + "\n\nRun-Id: " + entry.runId + "\nEntry-Id: " + entry.id + "\n";
  }).join("");
  if (Buffer.byteLength(appendText, "utf8") > MAX_CHANGELOG_APPEND_BYTES) throw new Error("Changelog append exceeds size limit");

  let promotedFacts = 0;
  if (!dryRun && promotions.length && commandRunner) {
    for (const item of promotions) {
      if (await runPromotion(commandRunner, scriptsDir, root, item, domain + ":" + runId)) promotedFacts++;
    }
  }

  const hasRealWork = entries.length > 0 || statusContent != null;
  if (!dryRun) {
    mkdirSync(domainDir, { recursive: true });
    if (statusContent != null) atomicWrite(statusPath, statusContent.endsWith("\n") ? statusContent : statusContent + "\n");
    if (appendText) writeFileSync(changelogPath, existingChangelog + appendText, "utf8");
    const updated = existsSync(stateFile) ? readJson(stateFile) : {};
    const existing = getPath(updated, "domainRuns." + domain + ".appliedRunIds") || [];
    if (hasRealWork) {
      setPath(updated, "domainRuns." + domain + ".lastRun", now);
    }
    setPath(updated, "domainRuns." + domain + ".lastCheckedAt", now);
    setPath(updated, "domainRuns." + domain + ".lastRunId", runId);
    setPath(updated, "domainRuns." + domain + ".appliedRunIds", [...new Set([...existing, runId])]);
    if (hasRealWork) {
      setPath(updated, "domainRuns." + domain + ".lastBaseHashes", currentHashes);
    }
    writeJson(stateFile, updated);
  }

  return {
    ok: true,
    status: dryRun ? "dry-run" : "ok",
    domain,
    runId,
    changed: Boolean(statusContent != null || appendText || promotedFacts),
    idempotent: false,
    dryRun,
    wroteStatus: statusContent != null,
    appendedEntries: newEntries.length,
    promotedFacts,
    proposedDecisionChanges: Array.isArray(proposedDecisions) ? proposedDecisions.length : 0,
    proposedWorkflowChanges: Array.isArray(proposedWorkflow) ? proposedWorkflow.length : 0,
  };
}

export function scanDomains({ workspace, now = new Date(), staleDays = DEFAULT_STALE_DAYS, archiveMode = false, dryRun = true } = {}) {
  const root = resolve(workspace || process.env.ENGRAM_WORKSPACE || process.cwd());
  const domainsRoot = join(root, "memory", "domains");
  const registryPath = join(domainsRoot, "registry.json");
  const statePath = join(root, "memory", "heartbeat-state.json");
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();

  if (!existsSync(registryPath)) {
    return {
      ok: true,
      status: "skipped",
      reason: "no registry",
      domainsRoot,
      registered: 0,
      enabled: 0,
      checked: 0,
      changed: 0,
      missing: 0,
      stale: 0,
      due: 0,
      overdue: 0,
      domains: [],
      alerts: [],
    };
  }

  const registry = readJson(registryPath);
  const state = existsSync(statePath) ? readJson(statePath) : {};
  const domainEntries = Object.entries(registry.domains || {});
  const domains = [];
  const alerts = [];

  for (const [name, config] of domainEntries) {
    const domainDir = join(domainsRoot, name);
    const enabled = isEnabled(config);
    const staleAfterDays = numberFromConfig(config, ["staleAfterDays", "statusStaleDays"]) ?? staleDays;
    const cadenceDays = numberFromConfig(config, ["cadenceDays", "runEveryDays", "heartbeatCadenceDays"]);
    const runtime = state.domainRuns?.[name] || {};
    const lastRunMs =
      dateFromConfig(runtime, ["lastRun", "lastDomainRun", "lastChecked", "lastHeartbeat"]) ??
      dateFromConfig(config, ["lastRun", "lastDomainRun", "lastChecked", "lastHeartbeat"]);
    const lastCheckedAtMs = dateFromConfig(runtime, ["lastCheckedAt"]) ?? null;
    const missingFiles = [];
    const staleFiles = [];
    const files = {};

    const expectedForDomain = expectedFilesFor(config);
    for (const file of expectedForDomain) {
      const filePath = join(domainDir, file);
      if (!existsSync(filePath)) {
        missingFiles.push(file);
        files[file] = { exists: false };
        continue;
      }
      const stat = statSync(filePath);
      let freshnessMs = stat.mtimeMs;
      let freshnessSource = "mtime";
      if (file === "changelog.md") {
        const contentDateMs = newestContentDateMs(readFileSync(filePath, "utf8"));
        if (contentDateMs != null) {
          freshnessMs = contentDateMs;
          freshnessSource = "content-date";
        }
      }
      const days = ageDays(freshnessMs, nowMs);
      files[file] = {
        exists: true,
        mtime: stat.mtime.toISOString(),
        freshnessSource,
        ageDays: days,
      };
      if ((file === "status.md" || file === "changelog.md") && days > staleAfterDays) {
        staleFiles.push(file);
      }
    }

    let due = false;
    let overdue = false;
    if (enabled && cadenceDays != null) {
      if (lastRunMs == null) {
        due = true;
        overdue = true;
      } else {
        const runAgeDays = ageDays(lastRunMs, nowMs);
        due = runAgeDays >= cadenceDays;
        overdue = runAgeDays > cadenceDays * 2;
      }
    }

    let suppressedByLastCheckedAt = false;
    if (enabled && due && lastCheckedAtMs != null && cadenceDays != null) {
      const checkedAgeDays = ageDays(lastCheckedAtMs, nowMs);
      suppressedByLastCheckedAt = checkedAgeDays < cadenceDays;
    }

    const domain = {
      name,
      enabled,
      type: config?.type ?? null,
      subagentLabel: config?.subagentLabel ?? null,
      missingFiles,
      staleFiles,
      due,
      overdue,
      suppressedByLastCheckedAt,
      lastCheckedAt: lastCheckedAtMs ? new Date(lastCheckedAtMs).toISOString() : null,
      files,
    };
    // Dry-run archive check (always done; archived: false if not actually archived)
    const archiveResult = archiveTopicThreadDomain({
      name,
      config,
      domainsRoot,
      nowMs,
      dryRun: true,
    });
    domain.wouldArchive = archiveResult.archived === false && archiveResult.archivePath && archiveResult.ageDays >= (numberFromConfig(config, ["staleAfterDays", "statusStaleDays"]) ?? 60);
    domain.archiveCandidate = !config?.archived && config?.type === "topic-thread" && archiveResult.archivePath ? archiveResult.archivePath : null;
    domain.ageDays = archiveResult.ageDays ?? null;
    domains.push(domain);

    if (missingFiles.length > 0) alerts.push({ domain: name, kind: "missing", files: missingFiles });
    if (staleFiles.length > 0) alerts.push({ domain: name, kind: "stale", files: staleFiles });
    if (overdue) alerts.push({ domain: name, kind: "overdue" });
  }

  // Phase D: archive stale topic-thread domains (only if archiveMode && !dryRun)
  if (archiveMode && !dryRun) {
    for (const domain of domains) {
      if (domain.type !== "topic-thread") continue;
      if (domain.archived) continue;
      const config = registry.domains[domain.name] || {};
      const result = archiveTopicThreadDomain({
        name: domain.name,
        config,
        domainsRoot,
        nowMs,
        dryRun: false,
      });
      if (result.archived) {
        domain.archived = true;
        domain.archivePath = result.archivePath;
        alerts.push({ domain: domain.name, kind: "archived", archivePath: result.archivePath, ageDays: result.ageDays });
      } else if (result.reason && result.reason !== "already archived" && result.reason !== "not topic-thread") {
        // Don't alert on "not stale yet" — that's normal.
        if (result.reason !== "dry-run" && !result.reason.startsWith("not stale")) {
          alerts.push({ domain: domain.name, kind: "archive-skip", reason: result.reason });
        }
      }
    }
  }

  const enabledDomains = domains.filter((domain) => domain.enabled);
  return {
    ok: true,
    status: "ok",
    domainsRoot,
    registered: domains.length,
    enabled: enabledDomains.length,
    checked: domains.length,
    changed: 0,
    missing: domains.filter((domain) => domain.missingFiles.length > 0).length,
    stale: domains.filter((domain) => domain.staleFiles.length > 0).length,
    due: domains.filter((domain) => domain.due).length,
    overdue: domains.filter((domain) => domain.overdue).length,
    domains,
    alerts,
  };
}

function formatSummary(scan) {
  if (scan.status === "skipped") return "skipped (" + scan.reason + ")";
  const bits = [
    scan.checked + " checked",
    scan.enabled + " enabled",
    scan.missing + " missing",
    scan.stale + " stale",
    scan.due + " due",
    scan.overdue + " overdue",
  ];
  return "ok (" + bits.join(", ") + ")";
}

export function formatDomainScanSummary(scan) {
  return formatSummary(scan);
}

if (import.meta.main) {
  const opts = parseArgs(process.argv);
  if (opts.archive === true) opts.archive = true;
  if (opts["dry-run"] === true || opts.dryRun === true) opts.dryRun = true;
  if (opts.help || opts.h) {
    console.log([
      "domains-runner.js",
      "",
      "Usage:",
      "  bun skills/engram/scripts/domains-runner.js --workspace <path> [--stale-days 60] [--archive] [--dry-run]",
      "",
      "Scans memory/domains continuity files without mutating them.",
    ].join("\n"));
    process.exit(0);
  }

  try {
    const dryRun = opts.dryRun !== true && opts.archive !== true;
    const scan = scanDomains({
      workspace: opts.workspace || process.env.ENGRAM_WORKSPACE || process.cwd(),
      staleDays: Number(opts["stale-days"] || DEFAULT_STALE_DAYS),
      archiveMode: opts.archive === true,
      dryRun,
    });
    console.log(JSON.stringify({ ...scan, summary: formatSummary(scan) }, null, 2));
  } catch (err) {
    console.error(JSON.stringify({
      ok: false,
      status: "error",
      error: err && err.stack ? err.stack : String(err),
    }, null, 2));
    process.exit(1);
  }
}
