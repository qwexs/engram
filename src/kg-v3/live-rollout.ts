import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { computeKgCanaryReleaseDigest } from "./canary.ts";
import { resolveKgDefaultContext } from "./context.ts";
import { KG_V3_LIVE_INGRESS_SCHEMA, type KgLiveIngressProjectionV1 } from "./live-ingress.ts";
import { KG_V3_AUTHORITY_SCHEMA, type KgAuthorityMarkerV1 } from "./types.ts";
import type { KgRuntimeGrantRegistryV1 } from "./trusted-runtime.ts";

export class KgLiveRolloutError extends Error {
  constructor(readonly code: "ACK_REQUIRED" | "READINESS_FAILED" | "PROJECTION_DRIFT", message: string) {
    super(message);
    this.name = "KgLiveRolloutError";
  }
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function atomicJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  const fd = openSync(temporary, "wx", 0o600);
  try { writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf8"); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, path);
  let directory: number | undefined;
  try { directory = openSync(dirname(path), "r"); fsyncSync(directory); } catch {} finally { if (directory !== undefined) closeSync(directory); }
}

export interface KgLiveIngressReadinessReport {
  schema: "engram.kg-v3-live-ingress-readiness.v1";
  workspaceId: string;
  releaseDigest: `sha256:${string}`;
  pluginDigest: `sha256:${string}`;
  authorityMode: "canary" | "enabled";
  grantSessionKey: string;
  canaryFinalized: boolean;
  readBackPassed: boolean;
  rollbackDrillPassed: boolean;
  defaultContextV3: boolean;
  runtimeGrantPresent: boolean;
  sourceReleaseMatches: boolean;
  currentProjection: "absent" | "enabled" | "disabled";
  ready: boolean;
  mutatesWorkspace: false;
}

export function planKgLiveIngress(options: { workspace: string; workspaceId: string; repository: string; pluginDigest: `sha256:${string}`; grantSessionKey: string }): KgLiveIngressReadinessReport {
  const workspace = resolve(options.workspace);
  const stateRoot = join(workspace, "memory-state", "kg-v3");
  const authority = readJson<KgAuthorityMarkerV1>(join(stateRoot, "authority.json"));
  if (authority.schema !== KG_V3_AUTHORITY_SCHEMA || authority.workspaceId !== options.workspaceId || !["canary", "enabled"].includes(authority.mode)) {
    throw new KgLiveRolloutError("READINESS_FAILED", "KG v3 authority is not active for this workspace");
  }
  const releaseRoot = join(stateRoot, "canary", authority.releaseDigest.slice(7));
  const canary = existsSync(join(releaseRoot, "state.json")) ? readJson<any>(join(releaseRoot, "state.json")) : null;
  const readBack = existsSync(join(releaseRoot, "read-back-report.json")) ? readJson<any>(join(releaseRoot, "read-back-report.json")) : null;
  const rollback = existsSync(join(releaseRoot, "rollback-report.json")) ? readJson<any>(join(releaseRoot, "rollback-report.json")) : null;
  const grants = readJson<KgRuntimeGrantRegistryV1>(join(stateRoot, "runtime-grants.json"));
  const runtimeGrantPresent = grants.schema === "engram.kg-v3-runtime-grants.v1"
    && grants.workspaceId === options.workspaceId
    && grants.principals.some((principal) => principal.grants.some((grant) => grant.sessionKey === options.grantSessionKey && grant.capabilities.includes("kg:v3:write")));
  const sourceReleaseMatches = computeKgCanaryReleaseDigest(resolve(options.repository)) === authority.releaseDigest;
  const context = resolveKgDefaultContext({ workspace, workspaceId: options.workspaceId });
  const defaultContextV3 = context.mode === "v3-current" && context.archiveIncludedInDefault === false;
  const projectionPath = join(stateRoot, "live-ingress.json");
  let currentProjection: KgLiveIngressReadinessReport["currentProjection"] = "absent";
  if (existsSync(projectionPath)) currentProjection = readJson<any>(projectionPath)?.enabled === true ? "enabled" : "disabled";
  const canaryFinalized = canary?.status === "finalized" && canary?.releaseDigest === authority.releaseDigest;
  const readBackPassed = readBack?.status === "passed" && readBack?.releaseDigest === authority.releaseDigest && readBack?.benchmark?.gates?.passed === true;
  const rollbackDrillPassed = rollback?.status === "rolled_back" && rollback?.releaseDigest === authority.releaseDigest && rollback?.readBack === true;
  const ready = canaryFinalized && readBackPassed && rollbackDrillPassed && defaultContextV3 && runtimeGrantPresent && sourceReleaseMatches;
  return {
    schema: "engram.kg-v3-live-ingress-readiness.v1",
    workspaceId: options.workspaceId,
    releaseDigest: authority.releaseDigest,
    pluginDigest: options.pluginDigest,
    authorityMode: authority.mode as "canary" | "enabled",
    grantSessionKey: options.grantSessionKey,
    canaryFinalized,
    readBackPassed,
    rollbackDrillPassed,
    defaultContextV3,
    runtimeGrantPresent,
    sourceReleaseMatches,
    currentProjection,
    ready,
    mutatesWorkspace: false,
  };
}

export function activateKgLiveIngress(options: { workspace: string; workspaceId: string; repository: string; pluginDigest: `sha256:${string}`; grantSessionKey: string; approvedBy: string; approvedAt?: string; acknowledge?: boolean }): KgLiveIngressProjectionV1 {
  if (options.acknowledge !== true) throw new KgLiveRolloutError("ACK_REQUIRED", "live ingress activation requires --ack-live-ingress");
  const plan = planKgLiveIngress(options);
  if (!plan.ready) throw new KgLiveRolloutError("READINESS_FAILED", "live ingress readiness gates are not green");
  const projectionPath = join(resolve(options.workspace), "memory-state", "kg-v3", "live-ingress.json");
  if (existsSync(projectionPath)) {
    const current = readJson<any>(projectionPath);
    if (current?.enabled === true) {
      if (current.workspaceId !== options.workspaceId || current.releaseDigest !== plan.releaseDigest || current.pluginDigest !== options.pluginDigest || current.grantSessionKey !== options.grantSessionKey) {
        throw new KgLiveRolloutError("PROJECTION_DRIFT", "enabled live-ingress projection does not match requested activation");
      }
      return current as KgLiveIngressProjectionV1;
    }
  }
  const projection: KgLiveIngressProjectionV1 = {
    schema: KG_V3_LIVE_INGRESS_SCHEMA,
    workspaceId: options.workspaceId,
    releaseDigest: plan.releaseDigest,
    mode: plan.authorityMode,
    enabled: true,
    grantSessionKey: options.grantSessionKey,
    allowedContextKinds: ["direct"],
    requireOwner: true,
    pluginDigest: options.pluginDigest,
    approvedBy: options.approvedBy,
    approvedAt: options.approvedAt || new Date().toISOString(),
  };
  atomicJson(projectionPath, projection);
  return readJson(projectionPath);
}

export function rollbackKgLiveIngress(options: { workspace: string; workspaceId: string; disabledBy: string; disabledAt?: string; acknowledge?: boolean }) {
  if (options.acknowledge !== true) throw new KgLiveRolloutError("ACK_REQUIRED", "live ingress rollback requires --ack-live-ingress-rollback");
  const projectionPath = join(resolve(options.workspace), "memory-state", "kg-v3", "live-ingress.json");
  if (!existsSync(projectionPath)) return { schema: "engram.kg-v3-live-ingress-rollback.v1", workspaceId: options.workspaceId, status: "already_disabled", readBack: true } as const;
  const current = readJson<any>(projectionPath);
  if (current.workspaceId !== options.workspaceId) throw new KgLiveRolloutError("PROJECTION_DRIFT", "live-ingress rollback workspace mismatch");
  const disabled = { ...current, enabled: false, disabledBy: options.disabledBy, disabledAt: options.disabledAt || new Date().toISOString() };
  atomicJson(projectionPath, disabled);
  const readBack = readJson<any>(projectionPath);
  if (readBack.enabled !== false || readBack.workspaceId !== options.workspaceId) throw new KgLiveRolloutError("PROJECTION_DRIFT", "live-ingress rollback read-back failed");
  return { schema: "engram.kg-v3-live-ingress-rollback.v1", workspaceId: options.workspaceId, status: "disabled", releaseDigest: current.releaseDigest, pluginDigest: current.pluginDigest, disabledBy: disabled.disabledBy, disabledAt: disabled.disabledAt, readBack: true } as const;
}
