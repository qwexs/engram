import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { normalizeCronInventory, auditHeartbeatScheduler, auditMemoryWorkerRuntime, auditMissingWorkerProjection, schedulerCadenceSeconds } from "./_lib/watchdog-runtime.js";

let workspace;
beforeEach(() => { workspace = mkdtempSync(join(tmpdir(), "watchdog-runtime-")); });
afterEach(() => { rmSync(workspace, { recursive: true, force: true }); });
const now = new Date("2026-09-08T20:00:00Z");
const digest = "sha256:" + "a".repeat(64);
function fixture() {
  const projection = { enabled: true, mode: "canary", schema: "engram.memory-observation-rollout.v3", workspaceId: "main",
    pluginDigest: digest, bindings: [], evaluation: { batch: { schedulerId: "worker-main" } },
    captureOwnership: { effectiveAfter: "2026-09-08T19:00:00Z" } };
  const job = { id: "job-1", declarationKey: "worker-main", enabled: true,
    schedule: { kind: "cron", expr: "2,12,22,32,42,52 * * * *", tz: "UTC", staggerMs: 0 },
    state: { lastRunAtMs: now.getTime() - 120000, lastRunStatus: "ok" },
    payload: { kind: "command", argv: ["bun", "/engram/scripts/memory-observation-batch-worker.ts", "--workspace", workspace], timeoutSeconds: 300 } };
  const runtime = { cron: normalizeCronInventory({ jobs: [job] }), config: { agents: { entries: [{ id: "main", workspace }] } },
    plugin: { enabled: true, status: "loaded", installedDigest: digest, loadedDigest: digest, diagnosticCount: 0 } };
  return { projection, job, runtime };
}
const codes = entries => entries.map(e => e.code);

test("array and object cron responses enforce identical heartbeat legacy guard", () => {
  const config = { cron: { expectedJobName: "heartbeat" }, oll: { scheduleOwner: "nightly" } };
  const job = { name: "heartbeat", enabled: true, payload: { kind: "script", script: "--spawn-rethink" } };
  for (const envelope of [[job], { jobs: [job] }])
    expect(codes(auditHeartbeatScheduler(config, normalizeCronInventory(envelope)))).toContain("WD-CRON-007");
});
test("command heartbeat supported; disabled and malformed inventory visible", () => {
  const config = { cron: { expectedJobName: "heartbeat" }, oll: { scheduleOwner: "nightly" } };
  const job = { name: "heartbeat", enabled: false, payload: { kind: "command", argv: ["bun", "/engram/scripts/heartbeat-runner.js"] } };
  const findings = auditHeartbeatScheduler(config, normalizeCronInventory({ jobs: [job] }));
  expect(codes(findings)).toContain("WD-CRON-DISABLED");
  expect(codes(findings)).not.toContain("WD-CRON-007");
  expect(codes(auditHeartbeatScheduler(config, normalizeCronInventory({ something: [] })))).toContain("WD-CRON-UNVERIFIED");
});
test("partial inventory cannot authorize a missing scheduler claim", () => {
  const { projection, runtime } = fixture();
  runtime.cron = normalizeCronInventory({ jobs: [], hasMore: true, total: 50 }, { authoritative: true });
  const findings = auditMemoryWorkerRuntime(workspace, projection, runtime, { now });
  expect(runtime.cron.authoritative).toBe(false);
  expect(codes(findings)).toContain("WD-MW-SCHEDULER-UNVERIFIED");
  expect(codes(findings)).not.toContain("WD-MW-SCHEDULER-MISSING");
});
test("healthy known direct worker matches identity, payload, cadence and digest", () => {
  const { projection, runtime } = fixture();
  expect(auditMemoryWorkerRuntime(workspace, projection, runtime, { now })).toEqual([]);
});
test("future ownership does not claim an active capture outage", () => {
  const { projection } = fixture();
  projection.captureOwnership.effectiveAfter = "2026-09-09T00:00:00Z";
  const findings = auditMemoryWorkerRuntime(workspace, projection, null, { now });
  expect(findings.every(f => f.level === "info")).toBe(true);
  expect(codes(findings)).toContain("WD-MW-RUNTIME-PREACTIVATION");
});
test("missing projection cannot hide behind empty state when a scheduler targets the workspace", () => {
  const { runtime } = fixture();
  expect(codes(auditMissingWorkerProjection(workspace, runtime))).toContain("WD-MW-PROJECTION-MISSING");
  expect(auditMissingWorkerProjection(workspace + "-other", runtime)).toEqual([]);
});
test("legacy logical scheduler alias is not reported as a missing physical worker", () => {
  const { runtime, projection, job } = fixture();
  job.declarationKey = "worker-main-direct";
  const findings = codes(auditMemoryWorkerRuntime(workspace, projection, runtime, { now }));
  expect(findings).toContain("WD-MW-SCHEDULER-IDENTITY-UNVERIFIED");
  expect(findings).not.toContain("WD-MW-SCHEDULER-MISSING");
  expect(findings).not.toContain("WD-MW-SCHEDULER-UNVERIFIED");
});
test("disabled scheduler and stale last run remain visible with process ok", () => {
  const { projection, runtime, job } = fixture();
  job.enabled = false;
  job.state.lastRunAtMs = now.getTime() - 7200000;
  const findings = codes(auditMemoryWorkerRuntime(workspace, projection, runtime, { now }));
  expect(findings).toContain("WD-MW-SCHEDULER-DISABLED");
  expect(findings).toContain("WD-MW-SCHEDULER-STALE");
});
test("resident identity not inferred from installed byte hash", () => {
  const { projection, runtime } = fixture();
  delete runtime.plugin.loadedDigest;
  expect(codes(auditMemoryWorkerRuntime(workspace, projection, runtime, { now }))).toContain("WD-MW-LOADED-BYTES-UNVERIFIED");
  runtime.plugin.installedDigest = "sha256:" + "b".repeat(64);
  expect(codes(auditMemoryWorkerRuntime(workspace, projection, runtime, { now }))).toContain("WD-MW-PLUGIN-DIGEST");
});
test("group fleet missing member and insufficient timeout detected without execution", () => {
  const { projection, runtime, job } = fixture();
  projection.schema = "engram.memory-observation-rollout.v5";
  projection.workspaceId = "target";
  const manifest = join(workspace, "fleet.json");
  writeFileSync(manifest, JSON.stringify({ schema: "engram.memory-topic-fleet.v1", schedulerId: "worker-main",
    workspaces: [{ id: "another", path: "/another" }, { id: "second", path: "/second" }] }));
  job.payload.argv = ["bun", "/engram/scripts/memory-observation-group-fleet.ts", "--manifest", manifest];
  const findings = codes(auditMemoryWorkerRuntime(workspace, projection, runtime, { now }));
  expect(findings).toContain("WD-MW-FLEET-MEMBERSHIP");
  expect(findings).toContain("WD-MW-TIMEOUT");
});
test("exact workspace target, not substring, required", () => {
  const { projection, runtime, job } = fixture();
  job.payload.argv[3] = "--workspace";
  job.payload.argv[4] = workspace + "-other";
  // Use canonical argument array rather than a shell-like text search.
  job.payload.argv = ["bun", "/engram/scripts/memory-observation-batch-worker.ts", "--workspace", workspace + "-other"];
  expect(codes(auditMemoryWorkerRuntime(workspace, projection, runtime, { now }))).toContain("WD-MW-PAYLOAD-WORKSPACE");
});
test("cadence recognizes supported expressions, declines unknown schedules", () => {
  expect(schedulerCadenceSeconds({ kind: "cron", expr: "2,12,22,32,42,52 * * * *" })).toBe(600);
  expect(schedulerCadenceSeconds({ kind: "cron", expr: "*/15 * * * *" })).toBe(900);
  expect(schedulerCadenceSeconds({ kind: "cron", expr: "0 * * * *" })).toBe(3600);
  expect(schedulerCadenceSeconds({ kind: "cron", expr: "0 2 * * *" })).toBe(null);
});
