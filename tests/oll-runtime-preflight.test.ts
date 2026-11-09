import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { preflightOllRuntime } from "../src/oll/runtime-preflight";
import { authorizeAdaptationAction, loadActorRegistry } from "../src/oll/authorization";
import { planOllRollout } from "../src/oll/rollout";
import { discoverNightlyWorkspaces } from "../src/oll/nightly-discovery";
import { sha256Digest } from "../src/oll/handoff-v2";
import { auditWorkspace } from "../scripts/_lib/workspace-watchdog.js";

const roots: string[] = [];
const write = (path: string, value: unknown) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value)); };
const actors = { schema: "oll.actor-registry.v1", revision: 1, principals: [{ principalId: "person:owner", transportBindings: [{ channel: "telegram", accountId: "default", actorId: "42" }], grants: [{ workspaceId: "project", scope: "domain:project-design", actions: ["rule:auto-activate"], maxRisk: "low" }] }] };
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "engram-oll-preflight-")); roots.push(root);
  const stateRoot = join(root, "state"), workspace = join(root, "project");
  const actorPath = join(stateRoot, "oll/workspace-actors/project/actors.v1.json");
  write(actorPath, actors);
  const config = { schemaVersion: 1, workspace: { id: "project" },
    oll: { scheduleOwner: "nightly", adaptation: { enabled: true, mode: "active", actorRegistry: actorPath },
      nightly: { enabled: true, timezone: "UTC", weekStart: "monday", leaseTtlSeconds: 600, leaseRenewSeconds: 60, handoffTimeoutSeconds: 900, batchTimeoutSeconds: 21600, maxSpawnAttempts: 2, retryBackoffSeconds: [0, 0] } },
    models: { heartbeat: { subagents: { "hb-rethink": "synthetic/model" } } } };
  write(join(workspace, "engram.json"), config);
  write(join(workspace, "memory-state/oll/state.json"), { schema: "oll-nightly-state.v1", workspaceId: "project", scheduleOwner: "nightly", nightlyEnabled: true, legacyHeartbeat: { admission: "disabled", application: "disabled" } });
  write(join(workspace, "memory-state/oll/rollout.json"), { schema: "oll.workspace-rollout-state.v1", workspaceId: "project", targetMode: "active", status: "active" });
  return { root, stateRoot, workspace, actorPath, config };
}
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

test("project-scoped registry inside state root is read-only and does not widen grants", () => {
  const f = fixture(), before = readFileSync(f.actorPath);
  f.config.oll.adaptation.actorRegistry = "${ENGRAM_STATE_ROOT}/oll/workspace-actors/project/actors.v1.json";
  expect(preflightOllRuntime(f.config, f.stateRoot).actorRegistryPath).toBe(f.actorPath);
  expect(readFileSync(f.actorPath)).toEqual(before);
  expect(existsSync(join(f.stateRoot, "oll/company-rules"))).toBe(false);
  const registry = loadActorRegistry(f.actorPath);
  const actorContext = { trusted: true as const, channel: "telegram", accountId: "default", actorId: "42", contextKind: "topic" as const };
  expect(authorizeAdaptationAction({ registry, actorContext, workspaceId: "project", scope: { level: "domain", subject: "project-design" }, action: "rule:auto-activate", risk: "low", sourceType: "message" }).status).toBe("authorized");
  expect(authorizeAdaptationAction({ registry, actorContext, workspaceId: "foreign", scope: { level: "domain", subject: "project-design" }, action: "rule:auto-activate", risk: "low", sourceType: "message" }).status).not.toBe("authorized");
});

test("valid readable project-ops registry is rejected, including sibling-prefix and company-store escapes", () => {
  const f = fixture();
  for (const path of [join(f.workspace, "ops/actors.v1.json"), join(f.root, "state-other/actors.v1.json")]) {
    write(path, actors); expect(loadActorRegistry(path).registry.revision).toBe(1);
    expect(() => preflightOllRuntime({ ...f.config, oll: { ...f.config.oll, adaptation: { ...f.config.oll.adaptation, actorRegistry: path } } }, f.stateRoot)).toThrow("actorRegistry escapes its managed root");
  }
  expect(() => preflightOllRuntime({ ...f.config, oll: { ...f.config.oll, adaptation: { ...f.config.oll.adaptation, companyRuleStore: f.workspace } } }, f.stateRoot)).toThrow("companyRuleStore escapes its managed root");
});

test("symlink escapes and unavailable or malformed registries fail closed", () => {
  const f = fixture(), outside = join(f.root, "outside"); mkdirSync(outside);
  symlinkSync(outside, join(f.stateRoot, "escape"), process.platform === "win32" ? "junction" : "dir");
  expect(() => preflightOllRuntime({ ...f.config, oll: { ...f.config.oll, adaptation: { ...f.config.oll.adaptation, companyRuleStore: join(f.stateRoot, "escape/new-store") } } }, f.stateRoot)).toThrow("companyRuleStore escapes");
  rmSync(f.actorPath);
  expect(() => preflightOllRuntime(f.config, f.stateRoot)).toThrow("readable regular file");
  write(f.actorPath, { schema: "wrong" });
  expect(() => preflightOllRuntime(f.config, f.stateRoot)).toThrow("unreadable or invalid");
});

test("rollout refuses invalid consumer paths before any publication", () => {
  const f = fixture(), bad = join(f.workspace, "ops/actors.v1.json"); write(bad, actors);
  f.config.oll.adaptation.actorRegistry = bad; write(join(f.workspace, "engram.json"), f.config);
  const revision = sha256Digest("scheduler"), evidencePath = join(f.stateRoot, "oll-rollouts/scheduler-releases", `${revision.slice(7)}.json`);
  write(evidencePath, { schema: "oll.scheduler-release-evidence.v1", jobId: "nightly", payloadRevision: revision, enabled: true, schedule: { kind: "cron", expr: "40 0 * * *", tz: "UTC", staggerMs: 0 }, readBackAt: new Date().toISOString() });
  const before = readFileSync(join(f.workspace, "engram.json"));
  expect(() => planOllRollout({ stateRoot: f.stateRoot, releaseId: randomUUID(), rolloutBatchId: "synthetic", targetMode: "active", workspaces: [{ workspaceId: "project", workspacePath: f.workspace }], scheduler: { jobId: "nightly", payloadRevision: revision, evidencePath }, readiness: {} as any })).toThrow("actorRegistry escapes");
  expect(readFileSync(join(f.workspace, "engram.json"))).toEqual(before);
  expect(readdirSync(join(f.stateRoot, "oll-rollouts"))).toEqual(["scheduler-releases"]);
});

test("discovery quarantines the same bad path and watchdog reports it even without heartbeat state", async () => {
  const f = fixture(); f.config.oll.adaptation.actorRegistry = join(f.workspace, "actors.json"); write(f.config.oll.adaptation.actorRegistry, actors); write(join(f.workspace, "engram.json"), f.config);
  const snapshot = await discoverNightlyWorkspaces({ stateRoot: f.stateRoot, allowedRoots: [f.root], adapter: { snapshot: async () => ({ schema: "oll.workspace-registry-snapshot.v1", capturedAt: new Date().toISOString(), entries: [{ workspaceId: "project", workspacePath: f.workspace, registryRevision: 1, registryDigest: sha256Digest("registry"), configDigest: sha256Digest("config") }] }) } });
  expect(snapshot.entries).toHaveLength(0);
  expect(snapshot.quarantined[0]?.reason).toContain("actorRegistry escapes");
  const report = auditWorkspace(f.workspace, { core: false, qmd: false, hooks: false, routing: false, ollStateRoot: f.stateRoot });
  expect(report.findings.find((finding: any) => finding.code === "WD-OLL-024")?.level).toBe("error");
});

test("operator CLI requires the exact state root and rejects unknown flags without writes", () => {
  const f = fixture(), script = join(import.meta.dir, "../scripts/oll-runtime-preflight.ts");
  const ok = spawnSync("bun", [script, "--workspace", f.workspace, "--state-root", f.stateRoot, "--json"], { encoding: "utf8" });
  expect(ok.status).toBe(0); expect(JSON.parse(ok.stdout).status).toBe("ok");
  for (const args of [[], ["--state-root", f.stateRoot, "--typo"]]) {
    expect(spawnSync("bun", [script, "--workspace", f.workspace, ...args], { encoding: "utf8" }).status).toBe(1);
  }
  expect(existsSync(join(f.stateRoot, "oll/company-rules"))).toBe(false);
});
