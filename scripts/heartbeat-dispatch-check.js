#!/usr/bin/env bun
/**
 * Read-only admission check for the thin Engram heartbeat dispatcher.
 *
 * A command cron job runs heartbeat-runner.js deterministically. That runner
 * may enqueue work which still needs OpenClaw's sessions_spawn capability.
 * This check is suitable for an OpenClaw cron trigger: it returns fire=true
 * only when an agent turn is actually needed to claim and dispatch queued
 * subagents. It never changes queue files or heartbeat state.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REQUIRED_FIELDS = ["runId", "phase", "label", "model", "task"];

function parseArgs(argv) {
  const values = {};
  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      values[key] = next;
      index += 1;
    } else {
      values[key] = true;
    }
  }
  return values;
}

function result(payload) {
  process.stdout.write(JSON.stringify(payload) + "\n");
}

const opts = parseArgs(process.argv);
const workspace = typeof opts.workspace === "string" ? resolve(opts.workspace) : null;

if (!workspace) {
  result({ fire: false, state: { reason: "missing-workspace", queued: 0 } });
  process.exit(2);
}

const spawnsDir = typeof opts["spawns-dir"] === "string"
  ? resolve(opts["spawns-dir"])
  : join(workspace, "workspace", "ops", "heartbeat-spawns");

let names;
try {
  names = readdirSync(spawnsDir).filter((name) => name.endsWith(".json")).sort();
} catch (error) {
  if (error && error.code === "ENOENT") {
    result({ fire: false, state: { reason: "queue-missing", queued: 0 } });
    process.exit(0);
  }
  result({ fire: false, state: { reason: "queue-unreadable", queued: 0 } });
  process.exit(1);
}

const queued = [];
const malformed = [];
for (const name of names) {
  try {
    const entry = JSON.parse(readFileSync(join(spawnsDir, name), "utf8"));
    if (!entry || typeof entry !== "object" || entry.status !== "queued") continue;
    const missing = REQUIRED_FIELDS.filter((field) => entry[field] === undefined || entry[field] === null);
    if (missing.length > 0) {
      malformed.push({ name, missing });
      continue;
    }
    queued.push({ runId: entry.runId, phase: entry.phase, requestFile: name });
  } catch {
    malformed.push({ name, missing: ["valid-json"] });
  }
}

result({
  fire: queued.length > 0,
  message: queued.length > 0
    ? `Engram heartbeat dispatcher: claim and dispatch ${queued.length} queued subagent request(s) for ${workspace}.`
    : undefined,
  state: {
    queued: queued.length,
    queuedRuns: queued,
    malformed: malformed.length,
  },
});
