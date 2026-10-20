#!/usr/bin/env bun
import { isGroupProjectionSchema } from "../src/memory-observation/group-bindings.ts";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { acquireProcessLease } from "../src/memory-observation/process-lease.ts";
import { resolveMemoryObservationProjection } from "../src/memory-observation/projection.ts";
import { classifyFleetWorkerOutput, notifyFleetOperator, parseFleetIsolation, reportFleetResults, runFleetCommand, runFleetEntries } from "../src/memory-observation/fleet-isolation.ts";
import {sourceDebtSnapshot} from "../src/memory-observation/source-debt.ts";
import {reportFleetCompleteness} from "../src/memory-observation/fleet-completeness.ts";

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
const completenessOwners: string[] = manifest.memoryCompletenessWorkspaceIds ?? [];
if(!Array.isArray(completenessOwners)||new Set(completenessOwners).size!==completenessOwners.length
 ||completenessOwners.some(id=>!manifest.workspaces.some((w:any)=>w.id===id))||completenessOwners.length&&!isolation)throw Error("invalid explicit memory completeness owners");
const release = acquireProcessLease(join(tmpdir(), "engram-topic-fleet-" + (process.getuid?.() ?? "user")));
if (!release) { console.log(JSON.stringify({ status: "busy", reason: "group-fleet-running" })); process.exit(0); }
try {
  const results = await runFleetEntries(manifest.workspaces, async (entry: any) => {
      if (typeof entry.path !== "string" || realpathSync(entry.path) !== entry.path || typeof entry.id !== "string") throw new Error("noncanonical fleet workspace");
      const projection = resolveMemoryObservationProjection({ workspace: entry.path, workspaceId: entry.id });
      if (!isGroupProjectionSchema(projection.schema) || projection.evaluation?.batch?.schedulerId !== manifest.schedulerId) throw new Error("group fleet projection/scheduler mismatch");
      const result = classifyFleetWorkerOutput(entry.id, await runFleetCommand([process.execPath, join(import.meta.dir, "memory-observation-batch-worker.ts"), "--workspace", entry.path, "--summary"], entry.path, 300_000));
      // Keep long sequential passes alive under the scheduler's no-output timeout.
      console.error(JSON.stringify({ workspaceId: entry.id, exitCode: result.exitCode, timedOut: result.timedOut }));
      return result;
  });
  const report = isolation ? await reportFleetResults({ schedulerId: manifest.schedulerId, results, config: isolation, notify: notifyFleetOperator }) : undefined;
  const completeness = isolation && completenessOwners.length ? await reportFleetCompleteness({config:isolation,
    results:completenessOwners.map(workspaceId=>{
      const entry=manifest.workspaces.find((w:any)=>w.id===workspaceId);
      try{return {workspaceId,snapshot:sourceDebtSnapshot(entry.path)};}catch{return {workspaceId};}
    }),notify:notifyFleetOperator}) : undefined;
  process.exitCode = report?.exitCode ?? (results.some(r => r.exitCode !== 0 || r.timedOut || r.semanticStatus !== 'ok') ? 1 : 0);
  const summaries=results.map(({output,error,...result})=>{
    let worker:any;try{worker=JSON.parse(output??'');}catch{}
    return {...result,...(worker?.schema==='engram.memory-batch-live-run.v1'?{
      evaluatedSources:(worker.evaluations??[]).filter((e:any)=>['completed','duplicate'].includes(e.result.status)).reduce((n:number,e:any)=>n+(e.result.sourceCount??0),0),
      pendingSources:worker.health?.pending,openDebt:worker.health?.sourceDebtOpen,
      executionErrors:worker.execution?.errors??[]}: {})};
  });
  console.log(JSON.stringify({ schema: "engram.memory-topic-fleet-result.v1", schedulerId: manifest.schedulerId, reportMode:"compact-status-counts",results:summaries,
    ...(report ? { status: report.status, notification: report.notification } : {}),...(completeness?{completeness}: {}) }));
} catch {
  console.error(JSON.stringify({ status: "error", reason: "fleet execution, reporting or operator notification failed" }));
  process.exitCode = 1;
} finally { release(); }
