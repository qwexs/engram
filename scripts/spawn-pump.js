#!/usr/bin/env bun
/**
 * spawn-pump.js
 *
 * Phase 5.5 of the heartbeat cron pipeline: scans the queued subagent spawn
 * directory and prints one JSON object per queued request to stdout, followed
 * by a single summary line. Deterministic, no side effects, no LLM calls.
 *
 * The cron wrapper invokes this script and reads stdout line-by-line,
 * dispatching each `action:"spawn"` record to a fresh subagent.
 *
 * Usage:
 *   bun skills/engram/scripts/spawn-pump.js \
 *     --workspace <path> --agent-id <id> [--spawns-dir <path>]
 *
 * Required:
 *   --workspace <path>   Workspace root (used to resolve default --spawns-dir).
 *   --agent-id <id>      Agent id; embedded in error logs only.
 *
 * Optional:
 *   --spawns-dir <path>  Override the spawn queue directory.
 *                        Default: <workspace>/workspace/ops/heartbeat-spawns
 *
 * Output (one JSON object per line, written to stdout):
 *   {"action":"spawn","runId":...,"phase":...,"label":...,
 *    "runtimeLabel":...,"model":...,
 *    "task":...,"requestPath":...,"requestFile":...}
 *   ...
 *   {"action":"summary","scanned":N,"queued":M,"errors":E}
 *
 * Exit codes:
 *   0  Runner completed cleanly (even if 0 queued).
 *   1  Critical failure: missing/invalid args or directory unreadable.
 *
 * Notes:
 *   - Files whose `status` is not "queued" are skipped silently
 *     (covers "spawned" / "done" / "failed" lifecycle states).
 *   - Malformed JSON or missing required fields emit a WARN to stderr
 *     and increment the `errors` counter; the file is not retried.
 *   - Filename sort is lexicographic and deterministic. New run IDs are full
 *     UUIDs; semantic ordering comes from durable coordinator state, not names.
 *   - Non-`.json` files in the directory (e.g. *.task.md, *.txt) are
 *     ignored entirely and do not count toward `scanned`.
 */

import { join } from "node:path";
import { readdirSync, readFileSync } from "node:fs";
import { isLegacyOllAdmissionEnabled, isLegacyOllPhase } from "./config.js";

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
    `[spawn-pump] ERROR: --workspace and --agent-id are required (got workspace=${JSON.stringify(workspace)}, agentId=${JSON.stringify(agentId)})`,
  );
  process.exit(1);
}

const spawnsDir =
  opts["spawns-dir"] || join(workspace, "workspace", "ops", "heartbeat-spawns");

let entries;
try {
  entries = readdirSync(spawnsDir);
} catch (err) {
  if (err && err.code === "ENOENT") {
    // Directory does not exist → not an error. Emit zero summary, exit cleanly.
    console.log(
      JSON.stringify({ action: "summary", scanned: 0, queued: 0, errors: 0 }),
    );
    process.exit(0);
  }
  console.error(
    `[spawn-pump] ERROR (agent=${agentId}): cannot read spawns directory ${spawnsDir}: ${err && err.message}`,
  );
  process.exit(1);
}

const files = entries.filter((name) => name.endsWith(".json")).sort();

let scanned = 0;
let queued = 0;
let errors = 0;

for (const name of files) {
  scanned++;
  const absPath = join(spawnsDir, name);

  let payload;
  try {
    const raw = readFileSync(absPath, "utf8");
    payload = JSON.parse(raw);
  } catch (err) {
    console.error(
      `[spawn-pump] WARN (agent=${agentId}): malformed JSON in ${name}: ${err && err.message}`,
    );
    errors++;
    continue;
  }

  if (!payload || typeof payload !== "object" || payload.status !== "queued") {
    // Lifecycle states other than "queued" (spawned / done / failed) → silent skip.
    continue;
  }

  if (isLegacyOllPhase(payload.phase) && !isLegacyOllAdmissionEnabled(workspace)) {
    console.error(
      `[spawn-pump] WARN (agent=${agentId}): ${name} blocked by nightly cutover (${payload.phase})`,
    );
    errors++;
    continue;
  }

  const missing = REQUIRED_FIELDS.filter(
    (field) => payload[field] === undefined || payload[field] === null,
  );
  if (missing.length > 0) {
    console.error(
      `[spawn-pump] WARN (agent=${agentId}): ${name} missing ${missing.join(", ")}`,
    );
    errors++;
    continue;
  }

  console.log(
    JSON.stringify({
      action: "spawn",
      ...(payload.workspaceId ? { workspaceId: payload.workspaceId } : {}),
      runId: payload.runId,
      phase: payload.phase,
      label: payload.label,
      ...(payload.runtimeLabel ? { runtimeLabel: payload.runtimeLabel } : {}),
      model: payload.model,
      task: payload.task,
      requestPath: absPath,
      requestFile: name,
    }),
  );
  queued++;
}

console.log(JSON.stringify({ action: "summary", scanned, queued, errors }));
process.exit(0);
