#!/usr/bin/env bun
/**
 * spawn-claim.js
 *
 * Phase 5.5 companion to spawn-pump.js. Reads the spawn queue, atomically
 * moves each queued file to <spawnsDir>/done/, mutates its status to
 * "spawned", and patches heartbeat-state.json to reflect the claim.
 * The cron agent then calls sessions_spawn for each claimed record.
 *
 * Why split from spawn-pump.js:
 *   - spawn-pump.js is pure-read (used for inspection / dry-runs / tests).
 *   - spawn-claim.js is the destructive counterpart (the actual queue
 *     consumption). Keeping them separate makes each independently testable.
 *
 * Usage:
 *   bun skills/engram/scripts/spawn-claim.js \
 *     --workspace <path> --agent-id <id> [--spawns-dir <path>]
 *
 * Output (stdout, one JSON object per line, identical schema to spawn-pump.js):
 *   {"action":"spawn", "runId":..., "phase":..., "label":..., "model":...,
 *    "task":..., "requestPath":..., "requestFile":...}
 *   ...
 *   {"action":"summary", "scanned":N, "claimed":M, "errors":E}
 *
 * Exit codes:
 *   0  Claim complete (0 or more files claimed).
 *   1  Critical failure: missing args or directory unreadable.
 *
 * Lifecycle:
 *   queued  → spawned  (file moved to done/; heartbeat-state.json patched)
 *   spawned → done     (set later by process-handoff.js when handoff arrives)
 *   spawned → failed   (set later by process-handoff.js on handoff error)
 *
 * Atomicity notes:
 *   - File move is write-then-unlink, not rename. Both are inside the same
 *     filesystem so this is effectively atomic on Windows/NTFS. If the
 *     process dies between write and unlink, the next tick will re-claim
 *     and produce a duplicate — accept this risk for simplicity; in practice
 *     the spawn itself will fail or produce a duplicate handoff that the
 *     operator can reconcile.
 *   - heartbeat-state.json is patched AFTER all files are moved. A crash
 *     between move and patch leaves a "ghost" file in done/ that won't be
 *     tracked. Acceptable for the MVP.
 */

import { join } from "node:path";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";

const REQUIRED_FIELDS = ["runId", "phase", "label", "model", "task"];

function parseArgs(argv) {
  const opts = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      opts[key] = next;
      i++;
    } else {
      opts[key] = true;
    }
  }
  return opts;
}

const opts = parseArgs(process.argv);

const workspace = opts.workspace;
const agentId = opts["agent-id"];

if (!workspace || !agentId) {
  console.error(
    `[spawn-claim] ERROR: --workspace and --agent-id are required (got workspace=${JSON.stringify(workspace)}, agentId=${JSON.stringify(agentId)})`,
  );
  process.exit(1);
}

const spawnsDir =
  opts["spawns-dir"] || join(workspace, "workspace", "ops", "heartbeat-spawns");
const statePath = join(workspace, "memory", "heartbeat-state.json");

let entries;
try {
  entries = readdirSync(spawnsDir);
} catch (err) {
  if (err && err.code === "ENOENT") {
    console.log(
      JSON.stringify({ action: "summary", scanned: 0, claimed: 0, errors: 0 }),
    );
    process.exit(0);
  }
  console.error(
    `[spawn-claim] ERROR (agent=${agentId}): cannot read ${spawnsDir}: ${err && err.message}`,
  );
  process.exit(1);
}

const files = entries.filter((name) => name.endsWith(".json")).sort();

let scanned = 0;
let claimed = 0;
let errors = 0;
const claimedRecords = [];

for (const name of files) {
  scanned++;
  const absPath = join(spawnsDir, name);

  let payload;
  try {
    payload = JSON.parse(readFileSync(absPath, "utf8"));
  } catch (err) {
    console.error(
      `[spawn-claim] WARN (agent=${agentId}): malformed JSON in ${name}: ${err && err.message}`,
    );
    errors++;
    continue;
  }

  if (!payload || typeof payload !== "object" || payload.status !== "queued") {
    // Lifecycle states other than "queued" (spawned / done / failed) → silent skip.
    continue;
  }

  const missing = REQUIRED_FIELDS.filter(
    (f) => payload[f] === undefined || payload[f] === null,
  );
  if (missing.length > 0) {
    console.error(
      `[spawn-claim] WARN (agent=${agentId}): ${name} missing ${missing.join(", ")}`,
    );
    errors++;
    continue;
  }

  // Atomic claim: move to done/ with status=spawned.
  const now = new Date().toISOString();
  const doneDir = join(spawnsDir, "done");
  try {
    mkdirSync(doneDir, { recursive: true });
  } catch (err) {
    console.error(
      `[spawn-claim] ERROR (agent=${agentId}): cannot create ${doneDir}: ${err && err.message}`,
    );
    errors++;
    continue;
  }

  payload.status = "spawned";
  payload.spawnedAt = now;

  const destPath = join(doneDir, name);
  try {
    writeFileSync(destPath, JSON.stringify(payload, null, 2) + "\n", "utf8");
    unlinkSync(absPath);
  } catch (err) {
    console.error(
      `[spawn-claim] ERROR (agent=${agentId}): cannot move ${name} to done/: ${err && err.message}`,
    );
    errors++;
    continue;
  }

  // Normalize to forward slashes for cross-platform JSON portability.
  // See audits/engram-path-audit-2026-06-15.md (Finding C).
  const posixDestPath = destPath.replace(/\\/g, "/");

  claimedRecords.push({
    runId: payload.runId,
    phase: payload.phase,
    label: payload.label,
    model: payload.model,
    task: payload.task,
    requestPath: posixDestPath,
    requestFile: name,
  });
  claimed++;
}

// Patch heartbeat-state.json with claimed records (single atomic write).
if (claimedRecords.length > 0) {
  try {
    const stateRaw = readFileSync(statePath, "utf8");
    const state = JSON.parse(stateRaw);
    state.subagentRuns = state.subagentRuns || {};
    const now = new Date().toISOString();
    for (const rec of claimedRecords) {
      state.subagentRuns[rec.phase] = {
        ...(state.subagentRuns[rec.phase] || {}),
        status: "spawned",
        label: rec.label,
        runId: rec.runId,
        requestPath: rec.requestPath,
        spawnedAt: now,
      };
    }
    writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n", "utf8");
  } catch (err) {
    console.error(
      `[spawn-claim] WARN (agent=${agentId}): could not patch heartbeat-state.json: ${err && err.message}`,
    );
    // Non-fatal: files are claimed, state may be stale. The process-handoff
    // path will eventually correct subagentRuns.<phase>.status.
  }
}

// Emit spawn records (so the cron agent can call sessions_spawn per line).
for (const rec of claimedRecords) {
  console.log(
    JSON.stringify({
      action: "spawn",
      runId: rec.runId,
      phase: rec.phase,
      label: rec.label,
      model: rec.model,
      task: rec.task,
      requestPath: rec.requestPath,
      requestFile: rec.requestFile,
    }),
  );
}

console.log(JSON.stringify({ action: "summary", scanned, claimed, errors }));
process.exit(0);
