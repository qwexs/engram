#!/usr/bin/env bun
// Sequential fleet-wide reconciliation of Engram summary.md projections.
// It first flushes queued access events. It intentionally does not run QMD
// maintenance or invoke an LLM.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

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

Sequentially flushes buffered fact access, then rebuilds decay-aware summary.md
files for explicit Engram workspaces.

Usage:
  bun skills/engram/scripts/daily-summary-coordinator.js \\
    --workspace /workspace/main --workspace /workspace/elena --json

Options:
  --workspace <path>       Engram workspace to process; repeat in desired order.
  --timeout-ms <n>         Per-workspace timeout (default: 120000).
  --lock-dir <path>        Coordinator lock directory (default: <first>/ops/daily-summary.lock).
  --dry-run                Calculate/report changes without writing access or summaries.
  --json                   Emit one JSON report.
`);
  process.exit(0);
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
      const flushArgs = ["bun", join(import.meta.dir, "flush-access-buffer.js"), "--workspace", workspace, "--json"];
      if (opts["dry-run"]) flushArgs.push("--dry-run");
      const flush = Bun.spawn(flushArgs, {
        cwd: workspace,
        env: { ...process.env, ENGRAM_WORKSPACE: workspace },
        stdout: "pipe",
        stderr: "pipe",
      });
      const flushTimer = setTimeout(() => flush.kill(), timeoutMs);
      const flushStdout = await new Response(flush.stdout).text();
      const flushStderr = await new Response(flush.stderr).text();
      clearTimeout(flushTimer);
      await flush.exited;
      try { item.accessFlush = JSON.parse(flushStdout.trim()); } catch { item.accessFlushStdout = flushStdout.slice(0, 1000); }
      if (flush.exitCode !== 0) {
        item.status = "error";
        item.error = `access flush: ${flushStderr.slice(0, 900) || `exit ${flush.exitCode}`}`;
        report.errors++;
        continue;
      }

      const rebuildArgs = ["bun", join(import.meta.dir, "rebuild-summaries.js"), "--apply-decay", "--json"];
      if (opts["dry-run"]) rebuildArgs.push("--dry-run");
      const rebuild = Bun.spawn(rebuildArgs, {
        cwd: workspace,
        env: { ...process.env, ENGRAM_WORKSPACE: workspace },
        stdout: "pipe",
        stderr: "pipe",
      });
      const rebuildTimer = setTimeout(() => rebuild.kill(), timeoutMs);
      const rebuildStdout = await new Response(rebuild.stdout).text();
      const rebuildStderr = await new Response(rebuild.stderr).text();
      clearTimeout(rebuildTimer);
      await rebuild.exited;
      try { item.stats = JSON.parse(rebuildStdout.trim()); } catch { item.stdout = rebuildStdout.slice(0, 1000); }
      if (rebuild.exitCode !== 0) {
        item.status = "error";
        item.error = rebuildStderr.slice(0, 1000) || `exit ${rebuild.exitCode}`;
        report.errors++;
      }
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
