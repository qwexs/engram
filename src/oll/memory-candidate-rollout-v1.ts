import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { atomicWriteJson } from "./legacy-migration";
import { canonicalizeJcs, sha256Digest, type Digest } from "./handoff-v2";
import {
  candidatePolicyDigestV2,
  candidateScopeRegistryDigestV1,
  validateCandidateScopeRegistryV1,
  type CandidateScopeRegistryV1,
  type CandidateSourcePolicyV2,
} from "./memory-candidate-contracts-v2";
import {
  containCandidatePlansForRollbackV1,
  inspectCandidateRollbackPlansV1,
  type CandidateRollbackPlanInventoryV1,
} from "./memory-candidate-runtime-v2";

type JsonObject = Record<string, any>;
export type CandidateRolloutModeV1 = "disabled" | "shadow" | "materialize";

const RELEASE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WORKSPACE_RE = /^[a-z][a-z0-9_-]{0,63}$/;

export interface CandidateRolloutEvidenceV1 {
  schema: "oll.memory-candidate-rollout-evidence.v1";
  workspaceId: string;
  phase4: {
    targetedPassed: number;
    fullPassed: number;
    typecheckPassed: boolean;
    privacyPassed: boolean;
    openHighFindings: number;
  };
  shadow: {
    dailyCycles: number;
    weeklyCycles: number;
    scopeOrPrivacyEscapes: number;
    replayDrift: number;
    payloadConflicts: number;
    unexpectedEffects: number;
    sourceStarvation: number;
    projectedLoadBounded: boolean;
    crashRecoveryPassed: boolean;
    rollbackDrillPassed: boolean;
  };
  capturedAt: string;
}

export interface CandidateCompilerRolloutOptionsV1 {
  stateRoot: string;
  workspace: string;
  workspaceId: string;
  releaseId: string;
  targetMode: Exclude<CandidateRolloutModeV1, "disabled">;
  policy: CandidateSourcePolicyV2;
  scopeRegistry: CandidateScopeRegistryV1;
  evidencePath: string;
  evidenceDigest: Digest;
  approvedBy: string;
  now?: string;
}

export interface CandidateCompilerRolloutPlanV1 {
  schema: "oll.memory-candidate-rollout-plan.v1";
  planId: Digest;
  releaseId: string;
  workspaceId: string;
  workspace: string;
  currentMode: CandidateRolloutModeV1;
  targetMode: Exclude<CandidateRolloutModeV1, "disabled">;
  policyDigest: Digest;
  scopeRegistryDigest: Digest;
  evidencePath: string;
  evidenceDigest: Digest;
  projectionPath: string;
  backupManifestPath: string;
  approvedBy: string;
  createdAt: string;
  mutatesLiveState: false;
}

export interface CandidateCompilerProjectionV1 {
  schema: "oll.memory-candidate-rollout-projection.v1";
  workspaceId: string;
  releaseId: string;
  planId: Digest;
  previousMode: CandidateRolloutModeV1;
  mode: CandidateRolloutModeV1;
  status: "applying" | "shadow_canary" | "materialize_review_only" | "rolling_back" | "disabled";
  policyDigest: Digest;
  scopeRegistryDigest: Digest;
  evidenceDigest: Digest;
  approvedBy: string;
  revision: number;
  updatedAt: string;
}

export type CandidateRolloutFaultPointV1 =
  | "after_applying_projection"
  | "after_config_publication"
  | "after_active_projection";

export interface CandidateRollbackBarrierV1 {
  schema: "oll.memory-candidate-rollback-barrier.v1";
  workspaceId: string;
  configuredMode: CandidateRolloutModeV1;
  coordinator: null | {
    batchId: string;
    status: string;
    phase: "pre_dispatch" | "acknowledged" | "handoff_received" | "applying" | "review_pending" | "terminal";
    activeRunId: string | null;
    handoffPresent: boolean;
  };
  plans: CandidateRollbackPlanInventoryV1[];
  unsupportedPhases: number;
  modeRollbackReady: boolean;
  binaryRollbackReady: boolean;
  inspectedAt: string;
  barrierDigest: Digest;
}

export class CandidateRolloutError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "CandidateRolloutError";
  }
}

function digestBytes(value: Buffer | string): Digest {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function readJson(path: string): JsonObject {
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CandidateRolloutError("invalid_json", `${path} must contain an object`);
  return value;
}

function assertInside(root: string, target: string): void {
  const canonicalRoot = resolve(root);
  const canonicalTarget = resolve(target);
  const prefix = canonicalRoot.endsWith(sep) ? canonicalRoot : `${canonicalRoot}${sep}`;
  if (canonicalTarget !== canonicalRoot && !canonicalTarget.startsWith(prefix)) throw new CandidateRolloutError("path_escape", `path escapes allowed root: ${target}`);
}

function timestamp(value: string): string {
  if (!Number.isFinite(Date.parse(value))) throw new CandidateRolloutError("invalid_timestamp", "rollout timestamp is invalid");
  return new Date(value).toISOString();
}

function rolloutRoot(stateRoot: string): string {
  return join(resolve(stateRoot), "oll-memory-candidate-rollouts");
}

function withRolloutLock<T>(stateRoot: string, fn: () => T): T {
  const lock = join(rolloutRoot(stateRoot), ".rollout.lock");
  mkdirSync(dirname(lock), { recursive: true });
  try { mkdirSync(lock); }
  catch (error: any) {
    if (error?.code === "EEXIST") throw new CandidateRolloutError("rollout_locked", "another candidate rollout or rollback is active");
    throw error;
  }
  try { return fn(); }
  finally { rmSync(lock, { recursive: true, force: true }); }
}

function paths(options: Pick<CandidateCompilerRolloutOptionsV1, "stateRoot" | "workspace" | "releaseId">) {
  const root = rolloutRoot(options.stateRoot);
  const projectionPath = join(realpathSync(resolve(options.workspace)), "memory-state", "oll", "candidate-rollout.json");
  const backupRoot = join(root, "backups", options.releaseId);
  const backupManifestPath = join(backupRoot, "manifest.json");
  const releasePath = join(root, "releases", `${options.releaseId}.json`);
  const receiptsRoot = join(root, "barrier-receipts", options.releaseId);
  for (const item of [backupRoot, backupManifestPath, releasePath, receiptsRoot]) assertInside(root, item);
  return { root, projectionPath, backupRoot, backupManifestPath, releasePath, receiptsRoot };
}

function configuredMode(config: JsonObject): CandidateRolloutModeV1 {
  const value = config?.oll?.candidateCompiler?.mode;
  return ["shadow", "materialize"].includes(value) ? value : "disabled";
}

function validateEvidence(options: CandidateCompilerRolloutOptionsV1): CandidateRolloutEvidenceV1 {
  const evidencePath = resolve(options.evidencePath);
  assertInside(rolloutRoot(options.stateRoot), evidencePath);
  if (!existsSync(evidencePath)) throw new CandidateRolloutError("evidence_missing", "candidate rollout evidence is unavailable");
  const bytes = readFileSync(evidencePath);
  if (digestBytes(bytes) !== options.evidenceDigest) throw new CandidateRolloutError("evidence_drift", "candidate rollout evidence digest mismatch");
  const evidence = JSON.parse(bytes.toString("utf8")) as CandidateRolloutEvidenceV1;
  if (evidence.schema !== "oll.memory-candidate-rollout-evidence.v1" || evidence.workspaceId !== options.workspaceId) {
    throw new CandidateRolloutError("evidence_invalid", "candidate rollout evidence correlation mismatch");
  }
  const phase4Ready = evidence.phase4.targetedPassed > 0
    && evidence.phase4.fullPassed > 0
    && evidence.phase4.typecheckPassed
    && evidence.phase4.privacyPassed
    && evidence.phase4.openHighFindings === 0;
  if (!phase4Ready) throw new CandidateRolloutError("phase4_gate_failed", "Phase 4 evidence gate is incomplete");
  return evidence;
}

function readProjection(workspace: string): CandidateCompilerProjectionV1 | null {
  const path = join(realpathSync(resolve(workspace)), "memory-state", "oll", "candidate-rollout.json");
  return existsSync(path) ? readJson(path) as CandidateCompilerProjectionV1 : null;
}

function assertWorkspace(options: Pick<CandidateCompilerRolloutOptionsV1, "workspace" | "workspaceId">): JsonObject {
  if (!WORKSPACE_RE.test(options.workspaceId)) throw new CandidateRolloutError("workspace_invalid", "workspaceId is invalid");
  const workspace = realpathSync(resolve(options.workspace));
  const configPath = join(workspace, "engram.json");
  if (!existsSync(configPath)) throw new CandidateRolloutError("workspace_invalid", "workspace engram.json is unavailable");
  const config = readJson(configPath);
  if (config?.workspace?.id !== options.workspaceId) throw new CandidateRolloutError("workspace_drift", "workspace.id mismatch");
  return config;
}

export function inspectCandidateCompilerProjectionV1(options: { workspace: string; workspaceId: string }): {
  mode: CandidateRolloutModeV1;
  projection: CandidateCompilerProjectionV1 | null;
  consistent: boolean;
  reason: string | null;
} {
  const config = assertWorkspace(options);
  const mode = configuredMode(config);
  const projection = readProjection(options.workspace);
  if (mode === "disabled") {
    const consistent = !projection || projection.mode === "disabled";
    return { mode, projection, consistent, reason: consistent ? null : "disabled config has an enabled candidate rollout projection" };
  }
  const policy = config.oll.candidateCompiler as CandidateSourcePolicyV2;
  const registry = config.oll.candidateScopeRegistry as CandidateScopeRegistryV1 | undefined;
  if (!registry) return { mode, projection, consistent: false, reason: "candidate scope registry is missing" };
  try { validateCandidateScopeRegistryV1(registry); } catch { return { mode, projection, consistent: false, reason: "candidate scope registry is invalid" }; }
  const wantedStatus = mode === "shadow" ? "shadow_canary" : "materialize_review_only";
  const consistent = Boolean(projection
    && projection.workspaceId === options.workspaceId
    && projection.mode === mode
    && projection.status === wantedStatus
    && projection.policyDigest === candidatePolicyDigestV2(policy)
    && projection.scopeRegistryDigest === registry.digest);
  return { mode, projection, consistent, reason: consistent ? null : "candidate rollout projection does not match enabled config" };
}

export function planCandidateCompilerRolloutV1(options: CandidateCompilerRolloutOptionsV1): CandidateCompilerRolloutPlanV1 {
  if (!RELEASE_RE.test(options.releaseId)) throw new CandidateRolloutError("release_invalid", "releaseId must be a UUID");
  if (options.policy.mode !== options.targetMode) throw new CandidateRolloutError("policy_invalid", "policy mode must match targetMode");
  if (options.scopeRegistry.workspaceId !== options.workspaceId) throw new CandidateRolloutError("scope_registry_invalid", "scope registry workspace mismatch");
  validateCandidateScopeRegistryV1(options.scopeRegistry);
  if (options.scopeRegistry.digest !== candidateScopeRegistryDigestV1(options.scopeRegistry)) throw new CandidateRolloutError("scope_registry_invalid", "scope registry digest mismatch");
  validateEvidence(options);
  const config = assertWorkspace(options);
  const configured = configuredMode(config);
  const existingProjection = readProjection(options.workspace);
  const resumableProjection = existingProjection
    && existingProjection.releaseId === options.releaseId
    && existingProjection.mode === options.targetMode
    && ["applying", "shadow_canary", "materialize_review_only"].includes(existingProjection.status);
  const currentMode = resumableProjection ? existingProjection.previousMode : configured;
  if (options.targetMode === "shadow" && currentMode !== "disabled") throw new CandidateRolloutError("transition_invalid", "shadow canary requires disabled current mode");
  if (options.targetMode === "materialize") {
    const projection = readProjection(options.workspace);
    if (currentMode !== "shadow" || projection?.status !== "shadow_canary") throw new CandidateRolloutError("transition_invalid", "materialize requires a matching shadow canary projection");
  }
  const createdAt = timestamp(options.now || new Date().toISOString());
  const resolvedPaths = paths(options);
  const base = {
    schema: "oll.memory-candidate-rollout-plan.v1" as const,
    releaseId: options.releaseId,
    workspaceId: options.workspaceId,
    workspace: realpathSync(resolve(options.workspace)),
    currentMode,
    targetMode: options.targetMode,
    policyDigest: candidatePolicyDigestV2(options.policy),
    scopeRegistryDigest: options.scopeRegistry.digest,
    evidencePath: resolve(options.evidencePath),
    evidenceDigest: options.evidenceDigest,
    projectionPath: resolvedPaths.projectionPath,
    backupManifestPath: resolvedPaths.backupManifestPath,
    approvedBy: String(options.approvedBy || "").trim(),
    createdAt,
    mutatesLiveState: false as const,
  };
  if (!base.approvedBy) throw new CandidateRolloutError("approval_invalid", "approvedBy is required");
  return { ...base, planId: sha256Digest(canonicalizeJcs(base)) };
}

function createBackup(plan: CandidateCompilerRolloutPlanV1, resolvedPaths: ReturnType<typeof paths>): void {
  if (existsSync(resolvedPaths.backupManifestPath)) {
    const manifest = readJson(resolvedPaths.backupManifestPath);
    if (manifest.schema !== "oll.memory-candidate-rollout-backup.v1" || manifest.releaseId !== plan.releaseId || manifest.planId !== plan.planId) {
      throw new CandidateRolloutError("backup_conflict", "existing candidate rollout backup does not match the plan");
    }
    for (const entry of manifest.entries || []) {
      if (!existsSync(entry.backupPath) || digestBytes(readFileSync(entry.backupPath)) !== entry.digest) {
        throw new CandidateRolloutError("backup_drift", "candidate rollout backup byte read-back failed");
      }
    }
    return;
  }
  const configPath = join(plan.workspace, "engram.json");
  const configBackup = join(resolvedPaths.backupRoot, "engram.json");
  mkdirSync(dirname(configBackup), { recursive: true });
  copyFileSync(configPath, configBackup);
  const entries: JsonObject[] = [{ sourcePath: configPath, backupPath: configBackup, digest: digestBytes(readFileSync(configBackup)) }];
  if (existsSync(plan.projectionPath)) {
    const projectionBackup = join(resolvedPaths.backupRoot, "candidate-rollout.json");
    copyFileSync(plan.projectionPath, projectionBackup);
    entries.push({ sourcePath: plan.projectionPath, backupPath: projectionBackup, digest: digestBytes(readFileSync(projectionBackup)) });
  }
  atomicWriteJson(resolvedPaths.backupManifestPath, {
    schema: "oll.memory-candidate-rollout-backup.v1",
    releaseId: plan.releaseId,
    planId: plan.planId,
    entries,
    createdAt: plan.createdAt,
  });
}

export function applyCandidateCompilerRolloutV1(options: CandidateCompilerRolloutOptionsV1 & {
  acknowledge: boolean;
  faultInjector?: (point: CandidateRolloutFaultPointV1) => void;
}) {
  if (options.acknowledge !== true) throw new CandidateRolloutError("ack_required", "candidate rollout requires explicit acknowledgement");
  const resolvedPaths = paths(options);
  if (existsSync(resolvedPaths.releasePath)) {
    const release = readJson(resolvedPaths.releasePath);
    const requested = {
      workspaceId: options.workspaceId,
      mode: options.targetMode,
      policyDigest: candidatePolicyDigestV2(options.policy),
      scopeRegistryDigest: options.scopeRegistry.digest,
      evidenceDigest: options.evidenceDigest,
    };
    if (Object.entries(requested).some(([key, value]) => release[key] !== value)) {
      throw new CandidateRolloutError("release_conflict", "releaseId already identifies another candidate rollout");
    }
    return { status: "idempotent", plan: release.plan as CandidateCompilerRolloutPlanV1, release, releasePath: resolvedPaths.releasePath };
  }
  const plan = planCandidateCompilerRolloutV1(options);
  return withRolloutLock(options.stateRoot, () => {
    createBackup(plan, resolvedPaths);
    const previous = readProjection(plan.workspace);
    const priorMatches = previous?.releaseId === plan.releaseId && previous.planId === plan.planId;
    const applying: CandidateCompilerProjectionV1 = priorMatches && previous.status === "applying"
      ? previous
      : {
          schema: "oll.memory-candidate-rollout-projection.v1",
          workspaceId: plan.workspaceId,
          releaseId: plan.releaseId,
          planId: plan.planId,
          previousMode: plan.currentMode,
          mode: plan.targetMode,
          status: "applying",
          policyDigest: plan.policyDigest,
          scopeRegistryDigest: plan.scopeRegistryDigest,
          evidenceDigest: plan.evidenceDigest,
          approvedBy: plan.approvedBy,
          revision: Number(previous?.revision || 0) + 1,
          updatedAt: plan.createdAt,
        };
    if (!(priorMatches && ["shadow_canary", "materialize_review_only"].includes(previous.status))) {
      atomicWriteJson(plan.projectionPath, applying);
      options.faultInjector?.("after_applying_projection");
    }
    const configPath = join(plan.workspace, "engram.json");
    const config = readJson(configPath);
    if (!config.oll || typeof config.oll !== "object" || Array.isArray(config.oll)) config.oll = {};
    config.oll.candidateCompiler = options.policy;
    config.oll.candidateScopeRegistry = options.scopeRegistry;
    atomicWriteJson(configPath, config);
    options.faultInjector?.("after_config_publication");
    const active: CandidateCompilerProjectionV1 = priorMatches && ["shadow_canary", "materialize_review_only"].includes(previous.status)
      ? previous
      : {
          ...applying,
          status: plan.targetMode === "shadow" ? "shadow_canary" : "materialize_review_only",
          revision: applying.revision + 1,
        };
    atomicWriteJson(plan.projectionPath, active);
    options.faultInjector?.("after_active_projection");
    const readBack = inspectCandidateCompilerProjectionV1({ workspace: plan.workspace, workspaceId: plan.workspaceId });
    if (!readBack.consistent) throw new CandidateRolloutError("readback_failed", readBack.reason || "candidate rollout read-back failed");
    const release = {
      schema: "oll.memory-candidate-rollout-release.v1",
      releaseId: plan.releaseId,
      planId: plan.planId,
      plan,
      workspaceId: plan.workspaceId,
      mode: plan.targetMode,
      status: active.status,
      policyDigest: plan.policyDigest,
      scopeRegistryDigest: plan.scopeRegistryDigest,
      evidenceDigest: plan.evidenceDigest,
      backupManifestPath: plan.backupManifestPath,
      backupManifestDigest: digestBytes(readFileSync(plan.backupManifestPath)),
      readBackConfigDigest: digestBytes(readFileSync(configPath)),
      readBackProjectionDigest: digestBytes(readFileSync(plan.projectionPath)),
      createdAt: plan.createdAt,
    };
    mkdirSync(dirname(resolvedPaths.releasePath), { recursive: true });
    atomicWriteJson(resolvedPaths.releasePath, release);
    return { status: "applied", plan, release, releasePath: resolvedPaths.releasePath };
  });
}

function coordinatorInventory(options: { stateRoot: string; workspace: string; workspaceId: string }):
CandidateRollbackBarrierV1["coordinator"] {
  const root = join(resolve(options.stateRoot), "oll-nightly");
  const pointerPath = join(root, "current-batch.json");
  if (!existsSync(pointerPath)) return null;
  const pointer = readJson(pointerPath);
  const batchPath = join(root, "batches", String(pointer.batchId), "batch.json");
  if (!existsSync(batchPath)) return null;
  const batch = readJson(batchPath);
  if (batch.activeWorkspace !== options.workspaceId) return null;
  const contextPath = join(root, "batches", String(pointer.batchId), "contexts", `${options.workspaceId}.json`);
  if (!existsSync(contextPath)) return null;
  const context = readJson(contextPath);
  if (context.schema !== "oll.nightly-context.v2" || context?.candidateCompiler?.mode !== "materialize") return null;
  const status = String(batch.status);
  const phase = ["completed", "failed", "cancelled", "skipped"].includes(status)
    ? "terminal"
    : status === "review_pending"
      ? "review_pending"
      : ["applying", "apply_partial"].includes(status)
        ? "applying"
        : ["handoff_received", "validating"].includes(status)
          ? "handoff_received"
          : ["spawn_acknowledged", "awaiting_handoff"].includes(status)
            ? "acknowledged"
            : "pre_dispatch";
  return {
    batchId: String(pointer.batchId),
    status,
    phase,
    activeRunId: typeof batch.activeRunId === "string" ? batch.activeRunId : null,
    handoffPresent: typeof batch.activeHandoffPath === "string" && existsSync(batch.activeHandoffPath),
  };
}

function existingRollbackReport(stateRoot: string, releaseId: string): JsonObject | null {
  const root = join(rolloutRoot(stateRoot), "rollbacks");
  if (!existsSync(root)) return null;
  for (const name of readdirSync(root).filter((entry) => entry.endsWith(".json")).sort()) {
    const report = readJson(join(root, name));
    if (report.schema === "oll.memory-candidate-rollback-report.v1" && report.releaseId === releaseId) {
      return { ...report, reportPath: join(root, name) };
    }
  }
  return null;
}

export function inspectCandidateRollbackBarrierV1(options: {
  stateRoot: string;
  workspace: string;
  workspaceId: string;
  scopeRegistry: CandidateScopeRegistryV1;
  now?: string;
}): CandidateRollbackBarrierV1 {
  const config = assertWorkspace(options);
  const coordinator = coordinatorInventory(options);
  const plans = inspectCandidateRollbackPlansV1(options);
  const unsupportedCoordinator = coordinator && !["pre_dispatch", "terminal"].includes(coordinator.phase) ? 1 : 0;
  const unsupportedPlans = plans.filter((plan) => ["partial_effect", "review_pending", "quarantined", "invalid"].includes(plan.phase)).length;
  const unsupportedPhases = unsupportedCoordinator + unsupportedPlans;
  const inspectedAt = timestamp(options.now || new Date().toISOString());
  const base = {
    schema: "oll.memory-candidate-rollback-barrier.v1" as const,
    workspaceId: options.workspaceId,
    configuredMode: configuredMode(config),
    coordinator,
    plans,
    unsupportedPhases,
    modeRollbackReady: plans.every((plan) => !["partial_effect", "invalid"].includes(plan.phase)),
    binaryRollbackReady: unsupportedPhases === 0,
    inspectedAt,
  };
  return { ...base, barrierDigest: sha256Digest(canonicalizeJcs(base)) };
}

export function rollbackCandidateCompilerV1(options: {
  stateRoot: string;
  workspace: string;
  workspaceId: string;
  releaseId: string;
  scopeRegistry: CandidateScopeRegistryV1;
  approvedBy: string;
  reason: string;
  acknowledge: boolean;
  now?: string;
}) {
  if (options.acknowledge !== true) throw new CandidateRolloutError("ack_required", "candidate rollback requires explicit acknowledgement");
  if (!RELEASE_RE.test(options.releaseId)) throw new CandidateRolloutError("release_invalid", "releaseId must be a UUID");
  const reason = String(options.reason || "").trim();
  const approvedBy = String(options.approvedBy || "").trim();
  if (!reason || !approvedBy) throw new CandidateRolloutError("approval_invalid", "rollback reason and approvedBy are required");
  const now = timestamp(options.now || new Date().toISOString());
  validateCandidateScopeRegistryV1(options.scopeRegistry);
  if (options.scopeRegistry.workspaceId !== options.workspaceId || options.scopeRegistry.digest !== candidateScopeRegistryDigestV1(options.scopeRegistry)) {
    throw new CandidateRolloutError("scope_registry_invalid", "rollback scope registry correlation mismatch");
  }
  return withRolloutLock(options.stateRoot, () => {
    const prior = existingRollbackReport(options.stateRoot, options.releaseId);
    if (prior) {
      if (prior.workspaceId !== options.workspaceId || prior.reasonDigest !== sha256Digest(reason) || prior.approvedBy !== approvedBy) {
        throw new CandidateRolloutError("rollback_conflict", "releaseId already identifies another candidate rollback");
      }
      return { status: "idempotent", ...prior };
    }
    const config = assertWorkspace(options);
    const resolvedPaths = paths({ stateRoot: options.stateRoot, workspace: options.workspace, releaseId: options.releaseId });
    mkdirSync(resolvedPaths.receiptsRoot, { recursive: true });
    const before = inspectCandidateRollbackBarrierV1(options);
    const previousProjection = readProjection(options.workspace);
    if (before.configuredMode !== "disabled" && previousProjection?.releaseId !== options.releaseId) {
      throw new CandidateRolloutError("release_conflict", "rollback releaseId does not own the enabled candidate projection");
    }
    atomicWriteJson(resolvedPaths.projectionPath, {
    schema: "oll.memory-candidate-rollout-projection.v1",
    workspaceId: options.workspaceId,
    releaseId: options.releaseId,
    planId: previousProjection?.planId || sha256Digest(`rollback:${options.releaseId}`),
    previousMode: before.configuredMode,
    mode: "disabled",
    status: "rolling_back",
    policyDigest: previousProjection?.policyDigest || sha256Digest("disabled"),
    scopeRegistryDigest: options.scopeRegistry.digest,
    evidenceDigest: previousProjection?.evidenceDigest || sha256Digest("rollback"),
    approvedBy,
    revision: Number(previousProjection?.revision || 0) + 1,
    updatedAt: now,
    } satisfies CandidateCompilerProjectionV1);
    config.oll.candidateCompiler = { ...config.oll.candidateCompiler, mode: "disabled" };
    atomicWriteJson(join(realpathSync(resolve(options.workspace)), "engram.json"), config);
    if (before.coordinator && before.coordinator.phase !== "terminal") {
      atomicWriteJson(join(resolvedPaths.receiptsRoot, `${before.coordinator.batchId}-${options.workspaceId}.json`), {
      schema: "oll.memory-candidate-rollback-receipt.v1",
      releaseId: options.releaseId,
      workspaceId: options.workspaceId,
      batchId: before.coordinator.batchId,
      runId: before.coordinator.activeRunId,
      action: before.coordinator.phase === "pre_dispatch" ? "cancelled_before_dispatch" : "quarantined_frozen_v3",
      reasonDigest: sha256Digest(reason),
      createdAt: now,
      });
    }
    const plans = containCandidatePlansForRollbackV1({ ...options, now });
    const finalProjection: CandidateCompilerProjectionV1 = {
    ...(readProjection(options.workspace) as CandidateCompilerProjectionV1),
    mode: "disabled",
    status: "disabled",
    revision: Number(readProjection(options.workspace)?.revision || 0) + 1,
    updatedAt: now,
    };
    atomicWriteJson(resolvedPaths.projectionPath, finalProjection);
    const after = inspectCandidateRollbackBarrierV1(options);
    const report = {
    schema: "oll.memory-candidate-rollback-report.v1",
    releaseId: options.releaseId,
    workspaceId: options.workspaceId,
    configuredMode: after.configuredMode,
    cancelledBeforeEffect: plans.filter((plan) => plan.status === "cancelled").length,
    quarantinedPlans: plans.filter((plan) => plan.phase === "quarantined").length,
    retainedPendingReviews: plans.filter((plan) => plan.phase === "review_pending").length,
    barrierBefore: before.barrierDigest,
    barrierAfter: after.barrierDigest,
    modeRollbackReady: after.modeRollbackReady,
    binaryRollbackReady: after.binaryRollbackReady,
    evidencePreserved: true,
    approvedBy,
    reasonDigest: sha256Digest(reason),
    createdAt: now,
    };
    const reportPath = join(rolloutRoot(options.stateRoot), "rollbacks", `${options.releaseId}-${randomUUID()}.json`);
    atomicWriteJson(reportPath, report);
    const readBack = inspectCandidateCompilerProjectionV1({ workspace: options.workspace, workspaceId: options.workspaceId });
    if (!readBack.consistent || readBack.mode !== "disabled") throw new CandidateRolloutError("readback_failed", "candidate rollback read-back failed");
    return { ...report, reportPath };
  });
}

export function candidateRollbackReceiptRootV1(stateRoot: string, releaseId: string): string {
  return join(rolloutRoot(stateRoot), "barrier-receipts", releaseId);
}

export function listCandidateRollbackReceiptsV1(stateRoot: string, releaseId: string): JsonObject[] {
  const root = candidateRollbackReceiptRootV1(stateRoot, releaseId);
  if (!existsSync(root)) return [];
  return readdirSync(root).filter((name) => name.endsWith(".json")).sort().map((name) => readJson(join(root, name)));
}
