import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { transitionAdaptationRule } from "./adaptation-store";
import { atomicWriteJson } from "./legacy-migration";

type JsonObject = Record<string, any>;
type TargetMode = "observe-only" | "active";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const WORKSPACE_ID_RE = /^[a-z][a-z0-9_-]{0,63}$/;

export interface RolloutWorkspaceV1 {
  workspaceId: string;
  workspacePath: string;
}

export interface RolloutReadinessV1 {
  syntheticSuitePassed: boolean;
  legacyCutoverVerified: boolean;
  noLegacyDispatcherOrApplicator: boolean;
  hookSourceVerified: boolean;
  schedulerCandidateVerified: boolean;
  nonPrivilegedCanary: boolean;
  observeOnlyCanaryPassed: boolean;
}

export interface RolloutSchedulerEvidenceV1 {
  jobId: string;
  payloadRevision: `sha256:${string}`;
  evidencePath: string;
}

export interface OllRolloutOptionsV1 {
  stateRoot: string;
  releaseId: string;
  rolloutBatchId: string;
  targetMode: TargetMode;
  workspaces: RolloutWorkspaceV1[];
  scheduler: RolloutSchedulerEvidenceV1;
  readiness: RolloutReadinessV1;
  now?: string;
}

export interface OllRolloutPlanV1 {
  schema: "oll.rollout-plan.v1";
  releaseId: string;
  rolloutBatchId: string;
  targetMode: TargetMode;
  workspaces: RolloutWorkspaceV1[];
  actions: Array<{ workspaceId: string; workspacePath: string; targetMode: TargetMode; nightlyEnabled: true }>;
  scheduler: RolloutSchedulerEvidenceV1;
  readiness: RolloutReadinessV1;
  releaseMarkerPath: string;
  backupManifestPath: string;
  createdAt: string;
}

export class OllRolloutError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "OllRolloutError";
    this.code = code;
  }
}

function digest(value: string | Buffer): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function readJson(path: string): JsonObject {
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new OllRolloutError("invalid_json", `${path} must contain an object`);
  return value;
}

function assertInside(root: string, path: string): void {
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  if (path !== root && !path.startsWith(prefix)) throw new OllRolloutError("path_escape", `path escapes rollout root: ${path}`);
}

function validateTimestamp(now: string): void {
  if (!Number.isFinite(Date.parse(now))) throw new OllRolloutError("invalid_timestamp", "rollout timestamp is invalid");
}

function validateWorkspaces(entries: RolloutWorkspaceV1[]): RolloutWorkspaceV1[] {
  if (!Array.isArray(entries) || entries.length === 0) throw new OllRolloutError("empty_fleet", "at least one rollout workspace is required");
  const ids = new Set<string>();
  const paths = new Set<string>();
  return entries.map((entry) => {
    const workspaceId = String(entry.workspaceId || "");
    const workspacePath = resolve(String(entry.workspacePath || ""));
    if (!WORKSPACE_ID_RE.test(workspaceId)) throw new OllRolloutError("invalid_workspace", `invalid workspaceId: ${workspaceId}`);
    if (ids.has(workspaceId) || paths.has(workspacePath)) throw new OllRolloutError("duplicate_workspace", `duplicate rollout workspace: ${workspaceId}`);
    const configPath = join(workspacePath, "engram.json");
    if (!existsSync(configPath)) throw new OllRolloutError("missing_config", `engram.json is unavailable: ${workspacePath}`);
    const config = readJson(configPath);
    if (config?.workspace?.id !== workspaceId) throw new OllRolloutError("workspace_drift", `workspace.id mismatch: ${workspaceId}`);
    if (config?.oll?.scheduleOwner !== "nightly") throw new OllRolloutError("cutover_incomplete", `nightly ownership is not declared: ${workspaceId}`);
    const statePath = join(workspacePath, "memory-state", "oll", "state.json");
    if (!existsSync(statePath)) throw new OllRolloutError("cutover_incomplete", `nightly state is unavailable: ${workspaceId}`);
    const state = readJson(statePath);
    if (
      state.schema !== "oll-nightly-state.v1"
      || state.workspaceId !== workspaceId
      || state.scheduleOwner !== "nightly"
      || state.legacyHeartbeat?.admission !== "disabled"
      || state.legacyHeartbeat?.application !== "disabled"
    ) {
      throw new OllRolloutError("cutover_incomplete", `nightly cutover state is invalid: ${workspaceId}`);
    }
    ids.add(workspaceId);
    paths.add(workspacePath);
    return { workspaceId, workspacePath };
  }).sort((left, right) => left.workspaceId.localeCompare(right.workspaceId));
}

function rolloutPaths(stateRoot: string, releaseId: string) {
  const root = resolve(stateRoot);
  const rollouts = join(root, "oll-rollouts");
  const releaseMarkerPath = join(rollouts, "releases", `${releaseId}.json`);
  const backupRoot = join(rollouts, "backups", releaseId);
  const backupManifestPath = join(backupRoot, "manifest.json");
  const events = join(rollouts, "events");
  const lock = join(rollouts, ".rollout.lock");
  for (const path of [releaseMarkerPath, backupRoot, backupManifestPath, events, lock]) assertInside(root, path);
  return { root, rollouts, releaseMarkerPath, backupRoot, backupManifestPath, events, lock };
}

function assertReadiness(mode: TargetMode, readiness: RolloutReadinessV1): void {
  const common: Array<keyof RolloutReadinessV1> = [
    "syntheticSuitePassed",
    "legacyCutoverVerified",
    "noLegacyDispatcherOrApplicator",
    "hookSourceVerified",
    "schedulerCandidateVerified",
    "nonPrivilegedCanary",
  ];
  const required = mode === "active" ? [...common, "observeOnlyCanaryPassed" as const] : common;
  const missing = required.filter((key) => readiness[key] !== true);
  if (missing.length) throw new OllRolloutError("readiness_failed", `readiness gate failed: ${missing.join(", ")}`);
}

function assertSchedulerEvidence(stateRoot: string, scheduler: RolloutSchedulerEvidenceV1): void {
  const root = resolve(stateRoot);
  const evidenceRoot = join(root, "oll-rollouts", "scheduler-releases");
  const evidencePath = resolve(String(scheduler.evidencePath || ""));
  assertInside(evidenceRoot, evidencePath);
  if (!existsSync(evidencePath)) throw new OllRolloutError("scheduler_evidence_missing", "scheduler release evidence is unavailable");
  const evidence = readJson(evidencePath);
  if (
    evidence.schema !== "oll.scheduler-release-evidence.v1"
    || evidence.jobId !== scheduler.jobId
    || evidence.payloadRevision !== scheduler.payloadRevision
    || evidence.enabled !== true
    || evidence?.schedule?.kind !== "cron"
    || evidence?.schedule?.expr !== "40 0 * * *"
    || evidence?.schedule?.tz !== "UTC"
    || evidence?.schedule?.staggerMs !== 0
  ) throw new OllRolloutError("scheduler_evidence_drift", "scheduler release evidence does not match the rollout request");
}

function withRolloutLock<T>(path: string, fn: () => T): T {
  mkdirSync(dirname(path), { recursive: true });
  try {
    mkdirSync(path);
  } catch (error: any) {
    if (error?.code === "EEXIST") throw new OllRolloutError("rollout_locked", "another rollout or rollback holds the global lock");
    throw error;
  }
  try {
    return fn();
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
}

function writeEvent(eventsRoot: string, event: JsonObject): string {
  mkdirSync(eventsRoot, { recursive: true });
  const eventId = randomUUID();
  const path = join(eventsRoot, `${event.createdAt.replace(/[:.]/g, "-")}-${eventId}.json`);
  atomicWriteJson(path, { schema: "oll.rollout-event.v1", eventId, ...event });
  return path;
}

function createBackups(plan: OllRolloutPlanV1, paths: ReturnType<typeof rolloutPaths>): JsonObject {
  if (existsSync(paths.backupManifestPath)) return readJson(paths.backupManifestPath);
  const entries = plan.workspaces.flatMap((workspace) => ([
    {
      source: join(workspace.workspacePath, "engram.json"),
      backup: join(paths.backupRoot, "workspaces", workspace.workspaceId, "engram.json"),
    },
    {
      source: join(workspace.workspacePath, "memory-state", "oll", "state.json"),
      backup: join(paths.backupRoot, "workspaces", workspace.workspaceId, "memory-state", "oll", "state.json"),
    },
  ].map(({ source, backup }) => {
    mkdirSync(dirname(backup), { recursive: true });
    copyFileSync(source, backup);
    const body = readFileSync(source);
    return {
      workspaceId: workspace.workspaceId,
      sourcePath: source,
      backupPath: backup,
      sourceDigest: digest(body),
    };
  })));
  const manifest = {
    schema: "oll.rollout-backup-manifest.v1",
    releaseId: plan.releaseId,
    rolloutBatchId: plan.rolloutBatchId,
    createdAt: plan.createdAt,
    entries,
  };
  atomicWriteJson(paths.backupManifestPath, manifest);
  return manifest;
}

function activeBatchRuleIds(workspaces: RolloutWorkspaceV1[], rolloutBatchId: string): string[] {
  const ids: string[] = [];
  for (const workspace of workspaces) {
    const root = join(workspace.workspacePath, "memory-state", "oll", "rules");
    if (!existsSync(root)) continue;
    for (const name of readdirSync(root).filter((entry) => entry.endsWith(".json")).sort()) {
      try {
        const rule = readJson(join(root, name));
        if (rule.status === "active" && rule.rolloutBatchId === rolloutBatchId) ids.push(rule.id);
      } catch {}
    }
  }
  return [...new Set(ids)].sort();
}

function existingRollback(rolloutsRoot: string, releaseId: string): { report: JsonObject; reportPath: string } | null {
  const root = join(rolloutsRoot, "rollbacks");
  if (!existsSync(root)) return null;
  for (const name of readdirSync(root).filter((entry) => entry.endsWith(".json")).sort()) {
    const reportPath = join(root, name);
    try {
      const report = readJson(reportPath);
      if (report.schema === "oll.rollback-report.v1" && report.releaseId === releaseId) return { report, reportPath };
    } catch { /* malformed evidence remains visible to watchdog */ }
  }
  return null;
}

export function planOllRollout(options: OllRolloutOptionsV1): OllRolloutPlanV1 {
  if (!UUID_RE.test(options.releaseId)) throw new OllRolloutError("invalid_release", "releaseId must be a UUID");
  const rolloutBatchId = String(options.rolloutBatchId || "").trim();
  if (!rolloutBatchId || rolloutBatchId.length > 300) throw new OllRolloutError("invalid_batch", "rolloutBatchId is required");
  if (!["observe-only", "active"].includes(options.targetMode)) throw new OllRolloutError("invalid_mode", "targetMode is invalid");
  if (!options.scheduler?.jobId || !DIGEST_RE.test(String(options.scheduler.payloadRevision || "")) || !options.scheduler?.evidencePath) {
    throw new OllRolloutError("invalid_scheduler", "exact scheduler jobId, payloadRevision, and evidencePath are required");
  }
  assertSchedulerEvidence(options.stateRoot, options.scheduler);
  const createdAt = options.now || new Date().toISOString();
  validateTimestamp(createdAt);
  const workspaces = validateWorkspaces(options.workspaces);
  const paths = rolloutPaths(options.stateRoot, options.releaseId);
  return {
    schema: "oll.rollout-plan.v1",
    releaseId: options.releaseId,
    rolloutBatchId,
    targetMode: options.targetMode,
    workspaces,
    actions: workspaces.map((workspace) => ({ ...workspace, targetMode: options.targetMode, nightlyEnabled: true })),
    scheduler: options.scheduler,
    readiness: options.readiness,
    releaseMarkerPath: paths.releaseMarkerPath,
    backupManifestPath: paths.backupManifestPath,
    createdAt,
  };
}

export function applyOllRollout(options: OllRolloutOptionsV1 & { acknowledge: boolean }) {
  if (options.acknowledge !== true) throw new OllRolloutError("ack_required", "explicit rollout acknowledgement is required");
  assertReadiness(options.targetMode, options.readiness);
  const plan = planOllRollout(options);
  const paths = rolloutPaths(options.stateRoot, options.releaseId);
  return withRolloutLock(paths.lock, () => {
    if (existsSync(paths.releaseMarkerPath)) {
      const marker = readJson(paths.releaseMarkerPath);
      if (marker.rolloutBatchId !== plan.rolloutBatchId || marker.targetMode !== plan.targetMode) {
        throw new OllRolloutError("release_conflict", "releaseId already identifies a different rollout");
      }
      if (existingRollback(paths.rollouts, plan.releaseId)) {
        throw new OllRolloutError("release_rolled_back", "releaseId has already been rolled back and cannot be re-applied");
      }
      return { status: "idempotent", plan, marker, releaseMarkerPath: paths.releaseMarkerPath };
    }
    createBackups(plan, paths);
    writeEvent(paths.events, {
      type: "rollout_started",
      releaseId: plan.releaseId,
      rolloutBatchId: plan.rolloutBatchId,
      targetMode: plan.targetMode,
      createdAt: plan.createdAt,
    });
    for (const workspace of plan.workspaces) {
      const configPath = join(workspace.workspacePath, "engram.json");
      const statePath = join(workspace.workspacePath, "memory-state", "oll", "state.json");
      const rolloutStatePath = join(workspace.workspacePath, "memory-state", "oll", "rollout.json");
      const config = readJson(configPath);
      const state = readJson(statePath);
      state.nightlyEnabled = true;
      atomicWriteJson(statePath, state);
      atomicWriteJson(rolloutStatePath, {
        schema: "oll.workspace-rollout-state.v1",
        workspaceId: workspace.workspaceId,
        releaseId: plan.releaseId,
        rolloutBatchId: plan.rolloutBatchId,
        targetMode: plan.targetMode,
        status: plan.targetMode === "active" ? "active" : "observe_only_canary",
        schedulerJobId: plan.scheduler.jobId,
        schedulerPayloadRevision: plan.scheduler.payloadRevision,
        updatedAt: plan.createdAt,
        revision: 1,
      });
      // Publish the discoverable activation bit last. A crash before this
      // write leaves either state or rollout evidence incomplete, and
      // discovery quarantines the workspace instead of admitting it.
      config.oll.nightly.enabled = true;
      config.oll.adaptation.mode = plan.targetMode;
      atomicWriteJson(configPath, config);
      writeEvent(paths.events, {
        type: "workspace_rollout_applied",
        releaseId: plan.releaseId,
        rolloutBatchId: plan.rolloutBatchId,
        workspaceId: workspace.workspaceId,
        targetMode: plan.targetMode,
        createdAt: plan.createdAt,
      });
    }
    const marker = {
      schema: "oll.rollout-release.v1",
      compatibilityVersion: 1,
      releaseId: plan.releaseId,
      rolloutBatchId: plan.rolloutBatchId,
      targetMode: plan.targetMode,
      status: plan.targetMode === "active" ? "active" : "observe_only_canary",
      upgradedWorkspaceIds: plan.workspaces.map((workspace) => workspace.workspaceId),
      workspaces: plan.workspaces,
      activatedRuleIds: activeBatchRuleIds(plan.workspaces, plan.rolloutBatchId),
      scheduler: plan.scheduler,
      readiness: plan.readiness,
      backupManifestPath: plan.backupManifestPath,
      backupManifestDigest: digest(readFileSync(plan.backupManifestPath)),
      createdAt: plan.createdAt,
    };
    mkdirSync(dirname(paths.releaseMarkerPath), { recursive: true });
    atomicWriteJson(paths.releaseMarkerPath, marker);
    writeEvent(paths.events, {
      type: "rollout_completed",
      releaseId: plan.releaseId,
      rolloutBatchId: plan.rolloutBatchId,
      targetMode: plan.targetMode,
      createdAt: plan.createdAt,
    });
    return { status: "applied", plan, marker, releaseMarkerPath: paths.releaseMarkerPath };
  });
}

function companyRulesRoot(config: JsonObject, stateRoot: string): string {
  const setting = String(config?.oll?.adaptation?.companyRuleStore || "${ENGRAM_STATE_ROOT}/oll/company-rules");
  const root = resolve(stateRoot);
  const path = resolve(setting.replaceAll("${ENGRAM_STATE_ROOT}", root));
  assertInside(root, path);
  return join(path, "rules");
}

function batchRules(workspace: RolloutWorkspaceV1, stateRoot: string, rolloutBatchId: string): JsonObject[] {
  const config = readJson(join(workspace.workspacePath, "engram.json"));
  const roots = [
    join(workspace.workspacePath, "memory-state", "oll", "rules"),
    companyRulesRoot(config, stateRoot),
  ];
  const rules: JsonObject[] = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const name of readdirSync(root).filter((entry) => entry.endsWith(".json")).sort()) {
      try {
        const rule = readJson(join(root, name));
        if (rule.workspaceId === workspace.workspaceId && rule.status === "active" && rule.rolloutBatchId === rolloutBatchId) rules.push(rule);
      } catch {}
    }
  }
  return rules;
}

export function rollbackOllRollout(options: {
  stateRoot: string;
  releaseMarkerPath: string;
  acknowledge: boolean;
  reason: string;
  now?: string;
}) {
  if (options.acknowledge !== true) throw new OllRolloutError("ack_required", "explicit rollback acknowledgement is required");
  const stateRoot = resolve(options.stateRoot);
  const markerPath = resolve(options.releaseMarkerPath);
  assertInside(join(stateRoot, "oll-rollouts", "releases"), markerPath);
  if (!existsSync(markerPath)) throw new OllRolloutError("release_missing", "release marker is unavailable");
  const marker = readJson(markerPath);
  if (marker.schema !== "oll.rollout-release.v1") throw new OllRolloutError("invalid_release", "unsupported release marker schema");
  const reason = String(options.reason || "").trim();
  if (!reason) throw new OllRolloutError("reason_required", "rollback reason is required");
  const now = options.now || new Date().toISOString();
  validateTimestamp(now);
  const paths = rolloutPaths(stateRoot, marker.releaseId);
  return withRolloutLock(paths.lock, () => {
    const prior = existingRollback(paths.rollouts, marker.releaseId);
    if (prior) return { status: "idempotent", ...prior.report, reportPath: prior.reportPath };
    const workspaces = validateWorkspaces(marker.workspaces);
    const suspendedRuleIds: string[] = [];
    const rollbackRunId = randomUUID();
    for (const workspace of workspaces) {
      const configPath = join(workspace.workspacePath, "engram.json");
      const statePath = join(workspace.workspacePath, "memory-state", "oll", "state.json");
      const rolloutStatePath = join(workspace.workspacePath, "memory-state", "oll", "rollout.json");
      const config = readJson(configPath);
      const state = readJson(statePath);
      config.oll.adaptation.mode = "observe-only";
      config.oll.nightly.enabled = false;
      state.nightlyEnabled = false;
      atomicWriteJson(configPath, config);
      atomicWriteJson(statePath, state);
      const rolloutState = existsSync(rolloutStatePath) ? readJson(rolloutStatePath) : null;
      atomicWriteJson(rolloutStatePath, {
        schema: "oll.workspace-rollout-state.v1",
        workspaceId: workspace.workspaceId,
        releaseId: marker.releaseId,
        rolloutBatchId: marker.rolloutBatchId,
        targetMode: "observe-only",
        status: "rolled_back",
        schedulerJobId: marker.scheduler.jobId,
        schedulerPayloadRevision: marker.scheduler.payloadRevision,
        updatedAt: now,
        revision: Number(rolloutState?.revision || 0) + 1,
      });
      for (const rule of batchRules(workspace, stateRoot, marker.rolloutBatchId)) {
        const actionId = digest(`rollback:${marker.releaseId}:${rule.id}`);
        transitionAdaptationRule({
          workspace: workspace.workspacePath,
          stateRoot,
          ruleId: rule.id,
          expectedRevision: rule.revision,
          status: "suspended",
          operationId: digest(`rollback-operation:${marker.releaseId}:${rule.id}`),
          decision: {
            action: "suspend_rule",
            runId: rollbackRunId,
            actionId,
            reason,
          },
          now,
        });
        suspendedRuleIds.push(rule.id);
      }
      writeEvent(paths.events, {
        type: "workspace_rollback_applied",
        releaseId: marker.releaseId,
        rolloutBatchId: marker.rolloutBatchId,
        workspaceId: workspace.workspaceId,
        createdAt: now,
      });
    }
    const report = {
      schema: "oll.rollback-report.v1",
      rollbackId: randomUUID(),
      releaseId: marker.releaseId,
      rolloutBatchId: marker.rolloutBatchId,
      workspaceIds: workspaces.map((workspace) => workspace.workspaceId),
      suspendedRuleIds: [...new Set(suspendedRuleIds)].sort(),
      adaptationMode: "observe-only",
      nightlyRethinkEnabled: false,
      deterministicReconciliationRetained: true,
      legacyHeartbeatRestored: false,
      evidencePreserved: true,
      reason,
      createdAt: now,
    };
    writeEvent(paths.events, { type: "rollback_completed", ...report });
    const reportPath = join(paths.rollouts, "rollbacks", `${report.rollbackId}.json`);
    atomicWriteJson(reportPath, report);
    return { ...report, reportPath };
  });
}
