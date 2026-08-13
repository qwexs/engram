import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { computeKgCanaryReleaseDigest } from "./canary.ts";
import { KG_V3_SCHEMA_DIGEST } from "./core.ts";
import { resolveKgLiveIngressProjection } from "./live-ingress.ts";
import { activateKgLiveIngress, planKgLiveIngress, rollbackKgLiveIngress } from "./live-rollout.ts";
import { KG_V3_AUTHORITY_SCHEMA } from "./types.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function json(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function fixture() {
  const workspace = mkdtempSync(join(tmpdir(), "kg-live-rollout-"));
  roots.push(workspace);
  const repository = resolve(import.meta.dir, "..", "..");
  const releaseDigest = computeKgCanaryReleaseDigest(repository);
  const pluginDigest = `sha256:${"9".repeat(64)}` as const;
  const state = join(workspace, "memory-state", "kg-v3");
  const release = join(state, "canary", releaseDigest.slice(7));
  json(join(state, "authority.json"), {
    schema: KG_V3_AUTHORITY_SCHEMA,
    workspaceId: "main",
    releaseDigest,
    schemaDigest: KG_V3_SCHEMA_DIGEST,
    mode: "canary",
    enabledSessionCapabilities: [{ sessionKey: "main", capabilities: ["kg:v3:write", "kg:v3:retract"] }],
    currentProjectionVersion: 1,
    approvedBy: "operator",
    approvedAt: "2026-08-13T00:00:00.000Z",
  });
  json(join(state, "default-context.json"), {
    schema: "engram.kg-v3-default-context.v1",
    workspaceId: "main",
    releaseDigest,
    mode: "v3-current",
    sources: ["life/v3/current-summary.md"],
    archiveIncludedInDefault: false,
    switchedAt: "2026-08-13T00:00:00.000Z",
  });
  mkdirSync(join(workspace, "life", "v3"), { recursive: true });
  writeFileSync(join(workspace, "life", "v3", "current-summary.md"), "# current\n");
  json(join(state, "runtime-grants.json"), {
    schema: "engram.kg-v3-runtime-grants.v1",
    workspaceId: "main",
    revision: 1,
    principals: [{ principalId: "operator", bindings: [{ transport: "telegram", actorId: "1" }], grants: [{ sessionKey: "main", capabilities: ["kg:v3:write"] }] }],
  });
  json(join(release, "state.json"), { status: "finalized", releaseDigest });
  json(join(release, "read-back-report.json"), { status: "passed", releaseDigest, benchmark: { gates: { passed: true } } });
  json(join(release, "rollback-report.json"), { status: "rolled_back", releaseDigest, readBack: true });
  return { workspace, repository, releaseDigest, pluginDigest };
}

describe("KG v3 live ingress rollout", () => {
  test("plans read-only, activates only with acknowledgement, and rolls back without deleting evidence", () => {
    const value = fixture();
    const plan = planKgLiveIngress({ ...value, workspaceId: "main", grantSessionKey: "main" });
    expect(plan).toMatchObject({ ready: true, currentProjection: "absent", mutatesWorkspace: false, rollbackDrillPassed: true });
    expect(() => activateKgLiveIngress({ ...value, workspaceId: "main", grantSessionKey: "main", approvedBy: "operator" })).toThrow("requires --ack-live-ingress");
    const active = activateKgLiveIngress({ ...value, workspaceId: "main", grantSessionKey: "main", approvedBy: "operator", approvedAt: "2026-08-13T01:00:00.000Z", acknowledge: true });
    expect(resolveKgLiveIngressProjection({ workspace: value.workspace, workspaceId: "main", expectedPluginDigest: value.pluginDigest })).toEqual(active);
    expect(planKgLiveIngress({ ...value, workspaceId: "main", grantSessionKey: "main" }).currentProjection).toBe("enabled");
    expect(() => rollbackKgLiveIngress({ workspace: value.workspace, workspaceId: "main", disabledBy: "operator" })).toThrow("requires --ack-live-ingress-rollback");
    expect(rollbackKgLiveIngress({ workspace: value.workspace, workspaceId: "main", disabledBy: "operator", disabledAt: "2026-08-13T02:00:00.000Z", acknowledge: true })).toMatchObject({ status: "disabled", readBack: true });
    expect(() => resolveKgLiveIngressProjection({ workspace: value.workspace, workspaceId: "main", expectedPluginDigest: value.pluginDigest })).toThrow("projection is invalid");
    expect(planKgLiveIngress({ ...value, workspaceId: "main", grantSessionKey: "main" }).currentProjection).toBe("disabled");
  });

  test("blocks activation when the canary evidence is incomplete", () => {
    const value = fixture();
    json(join(value.workspace, "memory-state", "kg-v3", "canary", value.releaseDigest.slice(7), "read-back-report.json"), { status: "failed", releaseDigest: value.releaseDigest });
    expect(planKgLiveIngress({ ...value, workspaceId: "main", grantSessionKey: "main" }).ready).toBe(false);
    expect(() => activateKgLiveIngress({ ...value, workspaceId: "main", grantSessionKey: "main", approvedBy: "operator", acknowledge: true })).toThrow("readiness gates are not green");
  });
});
