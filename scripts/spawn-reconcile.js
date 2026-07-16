#!/usr/bin/env bun

import { join, resolve } from "node:path";
import { reconcileStrandedSpawnRecords } from "./spawn-lifecycle.js";

function args(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) { out[key] = next; i++; }
    else out[key] = true;
  }
  return out;
}

const opts = args(process.argv);
if (!opts.workspace) {
  console.error("[spawn-reconcile] --workspace is required");
  process.exit(2);
}
const workspace = resolve(String(opts.workspace));
const hours = Number(opts["older-than-hours"] ?? 2);
if (!Number.isFinite(hours) || hours < 0) {
  console.error("[spawn-reconcile] --older-than-hours must be >= 0");
  process.exit(2);
}
const spawnsDir = join(workspace, "workspace", "ops", "heartbeat-spawns");
const summary = await reconcileStrandedSpawnRecords({
  spawnsDir,
  olderThanMs: hours * 60 * 60 * 1000,
  apply: Boolean(opts.apply),
});
console.log(JSON.stringify({ workspace, apply: Boolean(opts.apply), ...summary }));
process.exit(summary.errors.length ? 1 : 0);
