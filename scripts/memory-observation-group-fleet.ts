#!/usr/bin/env bun
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { acquireProcessLease } from "../src/memory-observation/process-lease.ts";
import { resolveMemoryObservationProjection } from "../src/memory-observation/projection.ts";

if (process.argv.length !== 4 || process.argv[2] !== "--manifest") throw new Error("usage: --manifest <approved-group-fleet.json>");
const manifest = JSON.parse(readFileSync(process.argv[3]!, "utf8"));
if (manifest.schema !== "engram.memory-topic-fleet.v1" || typeof manifest.schedulerId !== "string"
  || !Array.isArray(manifest.workspaces) || !manifest.workspaces.length || manifest.workspaces.length > 20
  || new Set(manifest.workspaces.map((w: any) => w.path)).size !== manifest.workspaces.length) throw new Error("invalid group fleet manifest");
const release = acquireProcessLease(join(tmpdir(), "engram-topic-fleet-" + (process.getuid?.() ?? "user")));
if (!release) { console.log(JSON.stringify({ status: "busy", reason: "group-fleet-running" })); process.exit(0); }
try {
  const results = [];
  for (const entry of manifest.workspaces) {
    try {
      if (typeof entry.path !== "string" || realpathSync(entry.path) !== entry.path || typeof entry.id !== "string") throw new Error("noncanonical fleet workspace");
      const projection = resolveMemoryObservationProjection({ workspace: entry.path, workspaceId: entry.id });
      if (projection.schema !== "engram.memory-observation-rollout.v4" || projection.evaluation?.batch?.schedulerId !== manifest.schedulerId) throw new Error("group fleet projection/scheduler mismatch");
      const child = Bun.spawn([process.execPath, join(import.meta.dir, "memory-observation-batch-worker.ts"), "--workspace", entry.path],
        { cwd: entry.path, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
      const timeout = setTimeout(() => child.kill(), 300_000);
      const stdout = new Response(child.stdout).text(), stderr = new Response(child.stderr).text();
      const code = await child.exited; clearTimeout(timeout);
      const out = await stdout, err = await stderr;
      results.push({ workspaceId: entry.id, exitCode: code, output: out.slice(-12000), ...(code ? { error: err.slice(-2000) } : {}) });
      if (code) process.exitCode = 1;
    } catch (error) {
      results.push({ workspaceId: entry.id, error: String(error) }); process.exitCode = 1;
    }
  }
  console.log(JSON.stringify({ schema: "engram.memory-topic-fleet-result.v1", schedulerId: manifest.schedulerId, results }));
} finally { release(); }
