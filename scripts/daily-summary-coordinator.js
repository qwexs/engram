#!/usr/bin/env bun
// Fleet-cutover compatibility coordinator. Legacy v2 summary/access mutation
// is permanently retired; the scheduled command now records deterministic skips.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { reconcileWorkspaceMemory } from "../src/oll/reconciliation.ts";

function parseArgs(argv) {
  const opts = { workspaces: [] };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      if (key === "workspace") opts.workspaces.push(next);
      else opts[key] = next;
      i++;
    } else opts[key] = true;
  }
  return opts;
}

const opts = parseArgs(process.argv);
if (opts.help || opts.h) {
  console.log(`daily-summary-coordinator.js

Sequentially reports the permanent retirement of legacy v2 reconciliation for
explicit Engram workspaces. It never mutates items.json or summary.md.

Usage:
  bun skills/engram/scripts/daily-summary-coordinator.js \\
    --workspace /workspace/main --workspace /workspace/elena --json

Options:
  --workspace <path>       Engram workspace to process; repeat in desired order.
  --workspaces-uri <value> Percent-encoded JSON array of workspace paths (transport-safe).
  --scheduler-declaration <path>
                           Read ordered workspaces from a scheduler declaration.
  --timeout-ms <n>         Per-workspace timeout (default: 120000).
  --lock-dir <path>        Coordinator lock directory (default: <first>/ops/daily-summary.lock).
  --dry-run                Report the same retired state without mutation.
  --json                   Emit one JSON report.
`);
  process.exit(0);
}

if (opts["workspaces-uri"]) {
  try {
    const decoded = JSON.parse(decodeURIComponent(String(opts["workspaces-uri"])));
    if (!Array.isArray(decoded) || decoded.some((entry) => typeof entry !== "string" || !entry)) {
      throw new Error("workspace list must be a non-empty string array");
    }
    opts.workspaces.push(...decoded);
  } catch (error) {
    console.error(`❌ --workspaces-uri is invalid: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
}

if (opts["scheduler-declaration"]) {
  try {
    const declaration = JSON.parse(readFileSync(resolve(String(opts["scheduler-declaration"])), "utf8"));
    const argv = declaration?.payload?.argv;
    if (declaration?.schema !== "engram.daily-summary-scheduler.v1" || !Array.isArray(argv)) {
      throw new Error("unsupported scheduler declaration");
    }
    for (let index = 0; index < argv.length; index += 1) {
      if (argv[index] !== "--workspace") continue;
      const workspace = argv[index + 1];
      if (typeof workspace !== "string" || !workspace) throw new Error("invalid scheduler workspace argument");
      opts.workspaces.push(workspace);
      index += 1;
    }
  } catch (error) {
    console.error(`❌ --scheduler-declaration is invalid: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
}

const workspaces = [...new Set(opts.workspaces.map((p) => resolve(p)))];
if (workspaces.length === 0) {
  console.error("❌ At least one --workspace is required");
  process.exit(2);
}
const timeoutMs = Number(opts["timeout-ms"] || 120000);
if (!Number.isFinite(timeoutMs) || timeoutMs < 1000) {
  console.error("❌ --timeout-ms must be at least 1000");
  process.exit(2);
}

const lockDir = resolve(opts["lock-dir"] || join(workspaces[0], "ops", "daily-summary.lock"));
const startedAt = new Date().toISOString();
const report = {
  schema: "engram.daily-summary-coordinator.v1",
  startedAt,
  finishedAt: null,
  mode: opts["dry-run"] ? "dry-run" : "write",
  sequential: true,
  workspaces: [],
  errors: 0,
};

function emitAndExit(code) {
  report.finishedAt = new Date().toISOString();
  console.log(opts.json ? JSON.stringify(report) : JSON.stringify(report, null, 2));
  process.exit(code);
}

if (existsSync(lockDir)) {
  let holder = null;
  try { holder = JSON.parse(readFileSync(join(lockDir, "holder.json"), "utf8")); } catch {}
  report.errors = 1;
  report.lock = { status: "held", path: lockDir, holder };
  emitAndExit(3);
}

mkdirSync(lockDir, { recursive: true });
writeFileSync(join(lockDir, "holder.json"), JSON.stringify({ pid: process.pid, startedAt, workspaces }, null, 2) + "\n");

try {
  for (const workspace of workspaces) {
    const item = { workspace, status: "ok", stats: null };
    report.workspaces.push(item);
    if (!existsSync(join(workspace, "engram.json"))) {
      item.status = "error";
      item.error = "engram.json is missing";
      report.errors++;
      continue;
    }

    try {
      const reconciled = await reconcileWorkspaceMemory({
        workspace,
        scriptsDir: import.meta.dir,
        timeoutMs,
        dryRun: Boolean(opts["dry-run"]),
      });
      Object.assign(item, reconciled);
      if (reconciled.status === "error") report.errors++;
    } catch (error) {
      item.status = "error";
      item.error = error instanceof Error ? error.message : String(error);
      report.errors++;
    }
  }
} finally {
  rmSync(lockDir, { recursive: true, force: true });
}

emitAndExit(report.errors ? 1 : 0);
