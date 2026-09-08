#!/usr/bin/env bun
import { isGroupProjectionSchema } from "../src/memory-observation/group-bindings.ts";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { acquireProcessLease } from "../src/memory-observation/process-lease.ts";
import { resolveMemoryObservationProjection } from "../src/memory-observation/projection.ts";
import { notifyFleetOperator, parseFleetIsolation, reportFleetResults, runFleetCommand, runFleetEntries } from "../src/memory-observation/fleet-isolation.ts";

if (process.argv.length !== 4 || process.argv[2] !== "--manifest") throw new Error("usage: --manifest <approved-group-fleet.json>");
const manifest = JSON.parse(readFileSync(process.argv[3]!, "utf8"));
if (manifest.schema !== "engram.memory-topic-fleet.v1" || typeof manifest.schedulerId !== "string"
  || !Array.isArray(manifest.workspaces) || !manifest.workspaces.length || manifest.workspaces.length > 20
  || new Set(manifest.workspaces.map((w: any) => w.path)).size !== manifest.workspaces.length) throw new Error("invalid group fleet manifest");
if (!/^[a-zA-Z0-9_-]+$/.test(manifest.schedulerId)
  || manifest.workspaces.some((w: any) => !/^[a-zA-Z0-9_-]+$/.test(w.id ?? ""))
  || new Set(manifest.workspaces.map((w: any) => w.id)).size !== manifest.workspaces.length) throw new Error("invalid fleet identities");
// Explicit opt-in: existing manifests retain fail-closed exit semantics until an operator route is configured.
const isolation = manifest.failureIsolation === undefined ? undefined : parseFleetIsolation(manifest.failureIsolation);
const release = acquireProcessLease(join(tmpdir(), "engram-topic-fleet-" + (process.getuid?.() ?? "user")));
if (!release) { console.log(JSON.stringify({ status: "busy", reason: "group-fleet-running" })); process.exit(0); }
try {
  const results = await runFleetEntries(manifest.workspaces, async (entry: any) => {
      if (typeof entry.path !== "string" || realpathSync(entry.path) !== entry.path || typeof entry.id !== "string") throw new Error("noncanonical fleet workspace");
      const projection = resolveMemoryObservationProjection({ workspace: entry.path, workspaceId: entry.id });
      if (!isGroupProjectionSchema(projection.schema) || projection.evaluation?.batch?.schedulerId !== manifest.schedulerId) throw new Error("group fleet projection/scheduler mismatch");
      const result = await runFleetCommand([process.execPath, join(import.meta.dir, "memory-observation-batch-worker.ts"), "--workspace", entry.path], entry.path, 300_000);
      // Keep long sequential passes alive under the scheduler's no-output timeout.
      console.error(JSON.stringify({ workspaceId: entry.id, exitCode: result.exitCode, timedOut: result.timedOut }));
      return result;
  });
  const report = isolation ? await reportFleetResults({ schedulerId: manifest.schedulerId, results, config: isolation, notify: notifyFleetOperator }) : undefined;
  process.exitCode = report?.exitCode ?? (results.some(r => r.exitCode !== 0 || r.timedOut) ? 1 : 0);
  console.log(JSON.stringify({ schema: "engram.memory-topic-fleet-result.v1", schedulerId: manifest.schedulerId, results,
    ...(report ? { status: report.status, notification: report.notification } : {}) }));
} catch {
  console.error(JSON.stringify({ status: "error", reason: "fleet execution, reporting or operator notification failed" }));
  process.exitCode = 1;
} finally { release(); }
