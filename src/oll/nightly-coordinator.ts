import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { atomicWriteJson } from "./legacy-migration";
import type { NightlyRuntimeAdapter, NightlySpawnRequestV1, WorkspaceRegistryAdapter } from "./contracts";
import { applyRethinkHandoffFile, ApplicatorResult } from "./handoff-applicator";
import { buildRethinkProposalPrompt, ExpectedHandoffV2 } from "./handoff-v2";
import { buildNightlyContext, determineNightlyWindow, NightlyContextV1, preflightNightlyContext } from "./nightly-context";
import { discoverNightlyWorkspaces, DiscoveredWorkspaceV1, FrozenRegistrySnapshotV1 } from "./nightly-discovery";
import { NightlyBatchStateV1, NightlyLeaseV1, NightlyStateStore } from "./nightly-state-store";
import { reconcileWorkspaceMemory, WorkspaceReconciliationResult } from "./reconciliation";
import type { TrustedActorContext } from "./authorization";

type BatchTransition =
  | "pending" | "reconciling" | "preflight" | "skipped" | "dispatching"
  | "spawn_acknowledged" | "awaiting_handoff" | "handoff_received" | "validating"
  | "applying" | "apply_partial" | "review_pending" | "completed" | "failed"
  | "stale" | "cancelled" | "retrying";

export interface NightlyCoordinatorOptions {
  stateRoot: string;
  registryAdapter: WorkspaceRegistryAdapter;
  allowedWorkspaceRoots: readonly string[];
  runtime: NightlyRuntimeAdapter;
  scriptsDir: string;
  resolveModel: (workspace: string, phase: "hb-rethink") => string;
  trustedActorContexts?: Readonly<Record<string, TrustedActorContext>>;
  now?: () => string;
  uuid?: () => string;
  sleep?: (ms: number) => Promise<void>;
  reconcile?: (workspace: DiscoveredWorkspaceV1) => Promise<WorkspaceReconciliationResult>;
  /**
   * Deployment wrappers may run the fleet-wide deterministic reconciliation
   * before entering the OLL-only portion of the nightly coordinator. This is
   * required during a single-workspace canary so non-opted-in workspaces keep
   * receiving their daily reconciliation without processing the canary twice.
   */
  reconciliationCompletedExternally?: boolean;
  applyHandoff?: typeof applyRethinkHandoffFile;
  faultInjector?: (transition: BatchTransition, batch: NightlyBatchStateV1) => void;
}

export interface NightlyCoordinatorReportV1 {
  schema: "oll.nightly-coordinator-report.v1";
  batchId: string;
  resumed: boolean;
  status: string;
  completed: string[];
  failed: string[];
  skipped: string[];
  processingOrder: string[];
  spawned: number;
  maxConcurrentRethinkRuns: number;
  registrySnapshotPath: string;
}

const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  pending: ["reconciling", "completed", "cancelled"],
  reconciling: ["preflight", "failed", "cancelled"],
  preflight: ["skipped", "dispatching", "failed", "cancelled"],
  skipped: ["completed", "cancelled"],
  dispatching: ["spawn_acknowledged", "failed", "cancelled"],
  spawn_acknowledged: ["awaiting_handoff", "failed", "cancelled"],
  awaiting_handoff: ["handoff_received", "retrying", "failed", "stale", "cancelled"],
  handoff_received: ["validating", "failed", "cancelled"],
  validating: ["applying", "failed", "review_pending", "cancelled"],
  applying: ["apply_partial", "review_pending", "completed", "failed", "cancelled"],
  apply_partial: ["applying", "failed", "cancelled"],
  review_pending: ["completed", "cancelled"],
  retrying: ["dispatching", "awaiting_handoff", "applying", "failed", "cancelled"],
  stale: ["retrying", "failed", "cancelled"],
  completed: ["reconciling", "completed", "cancelled"],
  failed: ["reconciling", "completed", "cancelled"],
  cancelled: [],
};

function readObject<T>(path: string): T {
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must contain an object`);
  return value as T;
}

function writeImmutable(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) {
    if (JSON.stringify(readObject(path)) !== JSON.stringify(value)) throw new Error(`immutable artifact drift: ${path}`);
    return;
  }
  atomicWriteJson(path, value);
}

function leaseProjection(lease: NightlyLeaseV1): NightlyBatchStateV1["lease"] {
  return {
    ownerToken: lease.ownerToken,
    fencingGeneration: lease.fencingGeneration,
    acquiredAt: lease.acquiredAt,
    expiresAt: lease.expiresAt,
  };
}

function handoffExpected(batch: NightlyBatchStateV1, context: NightlyContextV1): ExpectedHandoffV2 {
  if (!batch.activeWorkspace || !batch.activeRunId || !batch.activeEvaluationId || !batch.activeAttempt || !batch.activeContextDigest || !batch.activeHandoffPath) {
    throw new Error("active batch correlation is incomplete");
  }
  return {
    batchId: batch.batchId,
    workspaceId: batch.activeWorkspace,
    evaluationId: batch.activeEvaluationId,
    runId: batch.activeRunId,
    phase: "hb-rethink",
    attempt: batch.activeAttempt,
    policyVersion: 1,
    contextDigest: batch.activeContextDigest as `sha256:${string}`,
    expectedHandoffPath: batch.activeHandoffPath,
    signalRevisions: context.signalRevisions,
  };
}

function updateWorkspaceWatermark(workspace: string, context: NightlyContextV1, score: number): void {
  const path = join(workspace, "memory-state", "oll", "state.json");
  const state = readObject<Record<string, any>>(path);
  const priorRevisions = state?.evaluation?.signalRevisions || {};
  const createdAt = context.signals.map((signal) => signal.createdAt).filter((value) => Number.isFinite(Date.parse(value))).sort().at(-1) || null;
  const next = {
    ...state,
    capture: { ...(state.capture || {}), lastObservedAt: createdAt || state?.capture?.lastObservedAt || null },
    evaluation: {
      ...(state.evaluation || {}),
      lastCompletedAt: context.snapshotAt,
      lastSnapshotAt: context.snapshotAt,
      signalRevisions: { ...priorRevisions, ...context.signalRevisions },
      lastScore: score,
      completedCount: Number(state?.evaluation?.completedCount || 0) + 1,
    },
  };
  atomicWriteJson(path, next);
}

function markRuntimeTerminal(runtime: NightlyRuntimeAdapter, runId: string, succeeded: boolean): void {
  const candidate = runtime as NightlyRuntimeAdapter & { markTerminalApplied?: (id: string) => void; markTerminalFailed?: (id: string) => void };
  if (succeeded) candidate.markTerminalApplied?.(runId);
  else candidate.markTerminalFailed?.(runId);
}

export async function runNightlyCoordinator(options: NightlyCoordinatorOptions): Promise<NightlyCoordinatorReportV1> {
  const now = options.now || (() => new Date().toISOString());
  const uuid = options.uuid || randomUUID;
  const sleep = options.sleep || ((ms: number) => Bun.sleep(ms));
  const coordinatorRoot = resolve(options.stateRoot, "oll-nightly");
  const store = new NightlyStateStore(coordinatorRoot);
  const ownerToken = uuid();
  let lease = store.acquireLease({ ownerToken, now: now(), ttlSeconds: 600 });
  let renewalError: unknown = null;
  let renewalTimer: ReturnType<typeof setInterval> | null = null;
  let resumed = false;
  let batch: NightlyBatchStateV1;
  let snapshot: FrozenRegistrySnapshotV1;
  const skipped: string[] = [];
  const processingOrder: string[] = [];
  let spawned = 0;

  const checkRenewal = () => { if (renewalError) throw renewalError; };
  const renew = (ttlSeconds: number) => {
    lease = store.renewLease(lease, now(), ttlSeconds);
    renewalError = null;
  };
  const startRenewal = (ttlSeconds: number, renewSeconds: number) => {
    if (renewalTimer) clearInterval(renewalTimer);
    renewalTimer = setInterval(() => {
      try { renew(ttlSeconds); } catch (error) { renewalError = error; }
    }, renewSeconds * 1000);
    renewalTimer.unref?.();
  };
  const transition = (status: BatchTransition, patch: Partial<NightlyBatchStateV1> = {}, errorClass: string | null = null, details: Record<string, unknown> = {}) => {
    checkRenewal();
    if (!ALLOWED_TRANSITIONS[batch.status]?.includes(status)) throw new Error(`invalid nightly transition ${batch.status} -> ${status}`);
    const timestamp = now();
    const next: NightlyBatchStateV1 = {
      ...batch,
      ...patch,
      status,
      lease: leaseProjection(lease),
      updatedAt: timestamp,
      revision: batch.revision,
    };
    batch = store.writeBatch(next, batch.revision, lease);
    store.appendEvent(batch.batchId, {
      workspaceId: batch.activeWorkspace,
      runId: batch.activeRunId,
      transition: status,
      errorClass,
      details: { ...details, batchRevision: batch.revision },
      createdAt: timestamp,
    });
    options.faultInjector?.(status, batch);
  };
  const clearedActive = () => ({
    activeWorkspace: null,
    activeRunId: null,
    activeEvaluationId: null,
    activeAttempt: null,
    activeContextDigest: null,
    activeHandoffPath: null,
  });

  try {
    const currentId = store.readCurrentBatchId();
    if (currentId) {
      const current = store.readBatch(currentId);
      const batchTerminal = current.status === "cancelled"
        || (current.status === "completed" && current.activeWorkspace === null && current.workspaceQueue.every((id) => current.completed.includes(id) || current.failed.includes(id)));
      if (!batchTerminal) {
        resumed = true;
        batch = current;
        batch = store.writeBatch({ ...batch, lease: leaseProjection(lease), updatedAt: now() }, batch.revision, lease);
        snapshot = readObject(join(coordinatorRoot, "batches", batch.batchId, "registry-snapshot.json"));
        await options.runtime.resume(batch.batchId);
      } else {
        snapshot = await discoverNightlyWorkspaces({ adapter: options.registryAdapter, allowedRoots: options.allowedWorkspaceRoots, capturedAt: now() });
        batch = null as unknown as NightlyBatchStateV1;
      }
    } else {
      snapshot = await discoverNightlyWorkspaces({ adapter: options.registryAdapter, allowedRoots: options.allowedWorkspaceRoots, capturedAt: now() });
      batch = null as unknown as NightlyBatchStateV1;
    }

    if (!batch) {
      const first = snapshot.entries[0];
      const config = first?.config?.oll?.nightly || {};
      const timestamp = now();
      const window = first ? determineNightlyWindow({
        now: timestamp,
        timezone: config.timezone,
        weeklyEnabled: first.config?.oll?.weeklyMode?.enabled === true,
        weekStart: "monday",
      }) : { mode: "daily" as const, timezone: "UTC", windowStart: null, windowEnd: timestamp };
      const batchId = `nightly-${timestamp}`;
      batch = store.createBatch({
        schemaVersion: 1,
        batchId,
        mode: window.mode,
        status: "pending",
        registryDigest: snapshot.registryDigest,
        configDigest: snapshot.configDigest,
        lease: leaseProjection(lease),
        workspaceQueue: snapshot.entries.map((entry) => entry.workspaceId),
        activeWorkspace: null,
        activeRunId: null,
        activeEvaluationId: null,
        activeAttempt: null,
        activeContextDigest: null,
        activeHandoffPath: null,
        completed: [],
        failed: [],
        startedAt: timestamp,
        updatedAt: timestamp,
      }, lease);
      writeImmutable(join(coordinatorRoot, "batches", batch.batchId, "registry-snapshot.json"), snapshot);
      store.appendEvent(batch.batchId, { workspaceId: null, runId: null, transition: "batch_started", errorClass: null, details: { quarantined: snapshot.quarantined.length }, createdAt: timestamp });
    }

    const firstConfig = snapshot.entries[0]?.config?.oll?.nightly || {};
    const ttlSeconds = Number(firstConfig.leaseTtlSeconds || 600);
    const renewSeconds = Number(firstConfig.leaseRenewSeconds || 60);
    if (ttlSeconds !== 600) renew(ttlSeconds);
    startRenewal(ttlSeconds, renewSeconds);

    const batchTimeoutSeconds = Number(firstConfig.batchTimeoutSeconds || 21_600);
    if (Date.parse(now()) - Date.parse(batch.startedAt) >= batchTimeoutSeconds * 1000) {
      if (batch.activeRunId) markRuntimeTerminal(options.runtime, batch.activeRunId, false);
      transition("cancelled", clearedActive(), "batch_timeout", { batchTimeoutSeconds });
      return {
        schema: "oll.nightly-coordinator-report.v1",
        batchId: batch.batchId,
        resumed,
        status: batch.status,
        completed: batch.completed,
        failed: batch.failed,
        skipped,
        processingOrder,
        spawned,
        maxConcurrentRethinkRuns: Number((options.runtime as any).maxConcurrentRethinkRuns || 0),
        registrySnapshotPath: join(coordinatorRoot, "batches", batch.batchId, "registry-snapshot.json"),
      };
    }

    for (const workspaceId of batch.workspaceQueue) {
      if (batch.completed.includes(workspaceId) || batch.failed.includes(workspaceId)) continue;
      const workspace = snapshot.entries.find((entry) => entry.workspaceId === workspaceId);
      if (!workspace) throw new Error(`workspace ${workspaceId} missing from frozen snapshot`);
      if (!processingOrder.includes(workspaceId)) processingOrder.push(workspaceId);
      const config = workspace.config.oll.nightly;
      const contextPath = join(coordinatorRoot, "batches", batch.batchId, "contexts", `${workspaceId}.json`);
      let context: NightlyContextV1;

      if (batch.activeWorkspace === workspaceId && batch.activeRunId) {
        context = readObject<NightlyContextV1>(contextPath);
      } else if (batch.activeWorkspace === workspaceId && existsSync(contextPath) && ["preflight", "skipped"].includes(batch.status)) {
        context = readObject<NightlyContextV1>(contextPath);
        const recoveredPreflight = preflightNightlyContext(context);
        if (batch.status === "skipped" || !recoveredPreflight.actionable) {
          if (batch.status === "preflight") transition("skipped", {}, null, { preflight: recoveredPreflight });
          updateWorkspaceWatermark(workspace.workspacePath, context, recoveredPreflight.score);
          if (!skipped.includes(workspaceId)) skipped.push(workspaceId);
          transition("completed", {
            completed: [...batch.completed, workspaceId],
            ...clearedActive(),
          });
          continue;
        }
      } else {
        if (!(batch.activeWorkspace === workspaceId && batch.status === "reconciling")) {
          transition("reconciling", {
            activeWorkspace: workspaceId,
            activeRunId: null,
            activeEvaluationId: null,
            activeAttempt: null,
            activeContextDigest: null,
            activeHandoffPath: null,
          });
        }
        const reconciliation = options.reconciliationCompletedExternally
          ? { workspace: workspace.workspacePath, status: "ok" as const }
          : options.reconcile
            ? await options.reconcile(workspace)
            : await reconcileWorkspaceMemory({ workspace: workspace.workspacePath, scriptsDir: options.scriptsDir });
        if (reconciliation.status !== "ok") {
          transition("failed", { failed: [...batch.failed, workspaceId], ...clearedActive() }, "reconciliation_failed", { error: reconciliation.error || "unknown" });
          continue;
        }
        const snapshotAt = now();
        const window = determineNightlyWindow({
          now: snapshotAt,
          timezone: config.timezone,
          weeklyEnabled: workspace.config?.oll?.weeklyMode?.enabled === true,
          weekStart: "monday",
        });
        context = buildNightlyContext({ workspace: workspace.workspacePath, workspaceId, snapshotAt, window });
        writeImmutable(contextPath, context);
        const preflight = preflightNightlyContext(context);
        transition("preflight", { activeContextDigest: context.contextDigest }, null, { preflight });
        if (!preflight.actionable) {
          transition("skipped", {}, null, { preflight });
          updateWorkspaceWatermark(workspace.workspacePath, context, preflight.score);
          skipped.push(workspaceId);
          transition("completed", {
            completed: [...batch.completed, workspaceId],
            activeWorkspace: null,
            activeContextDigest: null,
          });
          continue;
        }
      }

      const preflight = preflightNightlyContext(context);
      const evaluationId = batch.activeEvaluationId || uuid();
      let attempt = batch.activeAttempt || 1;
      let terminal = false;
      while (!terminal && attempt <= Number(config.maxSpawnAttempts || 2)) {
        checkRenewal();
        let expected: ExpectedHandoffV2;
        let request: NightlySpawnRequestV1;
        if (batch.activeRunId && batch.activeEvaluationId === evaluationId && batch.activeAttempt === attempt && batch.activeHandoffPath) {
          expected = handoffExpected(batch, context);
        } else {
          const runId = uuid();
          const expectedHandoffPath = join(workspace.workspacePath, "memory-state", "oll", "handoffs", "incoming", `${runId}.json`);
          transition("dispatching", {
            activeWorkspace: workspaceId,
            activeRunId: runId,
            activeEvaluationId: evaluationId,
            activeAttempt: attempt,
            activeContextDigest: context.contextDigest,
            activeHandoffPath: expectedHandoffPath,
          });
          expected = handoffExpected(batch, context);
        }
        request = {
          schema: "oll.nightly-spawn-request.v1",
          batchId: batch.batchId,
          workspaceId,
          workspacePath: workspace.workspacePath,
          evaluationId,
          runId: expected.runId,
          phase: "hb-rethink",
          label: `${workspaceId}-hb-rethink`,
          runtimeLabel: `${workspaceId}-hb-rethink-${expected.runId}`,
          model: options.resolveModel(workspace.workspacePath, "hb-rethink"),
          attempt,
          policyVersion: 1,
          contextDigest: context.contextDigest,
          contextSnapshotPath: contextPath,
          expectedHandoffPath: expected.expectedHandoffPath,
          fencingGeneration: lease.fencingGeneration,
          prompt: buildRethinkProposalPrompt({
            contextSnapshot: context,
            expected,
            emptyHandoffWriterPath: join(options.scriptsDir, "oll-write-empty-handoff.ts"),
          }),
        };
        if (batch.status === "dispatching") {
          const acknowledgement = await options.runtime.spawn(request);
          spawned += 1;
          if (!acknowledgement.accepted || acknowledgement.runId !== expected.runId || acknowledgement.runtimeLabel !== request.runtimeLabel || acknowledgement.resolvedModel !== request.model) {
            markRuntimeTerminal(options.runtime, expected.runId, false);
            transition("failed", { failed: [...batch.failed, workspaceId], ...clearedActive() }, "dispatch_error", { acknowledgement });
            terminal = true;
            break;
          }
          transition("spawn_acknowledged", {}, null, { acknowledgement });
        }
        if (batch.status === "spawn_acknowledged") {
          transition("awaiting_handoff");
        }

        const appliedPath = join(workspace.workspacePath, "memory-state", "oll", "handoffs", "applied", `${expected.runId}.json`);
        const hasAppliedResult = existsSync(appliedPath);
        if (batch.status === "awaiting_handoff") {
          const wait = hasAppliedResult
            ? { status: "file" as const, errorClass: null }
            : await options.runtime.awaitHandoff(expected.expectedHandoffPath, Number(config.handoffTimeoutSeconds || 900) * 1000);
          checkRenewal();
          if (wait.status !== "file") {
            markRuntimeTerminal(options.runtime, expected.runId, false);
            if (attempt < Number(config.maxSpawnAttempts || 2)) {
              transition("retrying", { activeRunId: null, activeAttempt: attempt + 1, activeHandoffPath: null }, wait.errorClass || "handoff_timeout");
              const backoff = Number(config.retryBackoffSeconds?.[attempt - 1] || 0) * 1000;
              if (backoff) await sleep(backoff);
              attempt += 1;
              continue;
            }
            transition("failed", { failed: [...batch.failed, workspaceId], ...clearedActive() }, wait.errorClass || "handoff_timeout");
            terminal = true;
            break;
          }
          transition("handoff_received");
        }
        if (batch.status === "handoff_received") transition("validating");
        if (batch.status === "validating") transition("applying");
        const applicator = options.applyHandoff || applyRethinkHandoffFile;
        let result: ApplicatorResult;
        try {
          result = applicator({
            workspace: workspace.workspacePath,
            stateRoot: options.stateRoot,
            expected,
            trustedActorContexts: options.trustedActorContexts,
            now: now(),
          });
        } catch (error: any) {
          markRuntimeTerminal(options.runtime, expected.runId, false);
          transition("failed", { failed: [...batch.failed, workspaceId], ...clearedActive() }, error?.code || "apply_failed", { error: error?.message || String(error) });
          terminal = true;
          break;
        }
        if (result.status === "rejected") {
          markRuntimeTerminal(options.runtime, expected.runId, false);
          transition("failed", { failed: [...batch.failed, workspaceId], ...clearedActive() }, result.errorClass || "schema_invalid", { reason: result.reason || null });
          terminal = true;
          break;
        }
        markRuntimeTerminal(options.runtime, expected.runId, true);
        const hasReview = result.dispositions.some((item) => item.disposition === "review_pending");
        if (hasReview) transition("review_pending", {}, null, { projectionDigest: result.projectionDigest });
        updateWorkspaceWatermark(workspace.workspacePath, context, preflight.score);
        transition("completed", {
          completed: [...batch.completed, workspaceId],
          activeWorkspace: null,
          activeRunId: null,
          activeEvaluationId: null,
          activeAttempt: null,
          activeContextDigest: null,
          activeHandoffPath: null,
        }, null, { projectionDigest: result.projectionDigest });
        terminal = true;
      }
    }

    if (batch.activeWorkspace === null && batch.workspaceQueue.every((id) => batch.completed.includes(id) || batch.failed.includes(id)) && batch.status !== "completed") {
      transition("completed");
    } else if (batch.workspaceQueue.length === 0 && batch.status === "pending") {
      transition("completed");
    }
    return {
      schema: "oll.nightly-coordinator-report.v1",
      batchId: batch.batchId,
      resumed,
      status: batch.status,
      completed: batch.completed,
      failed: batch.failed,
      skipped,
      processingOrder,
      spawned,
      maxConcurrentRethinkRuns: Number((options.runtime as any).maxConcurrentRethinkRuns || (spawned ? 1 : 0)),
      registrySnapshotPath: join(coordinatorRoot, "batches", batch.batchId, "registry-snapshot.json"),
    };
  } finally {
    if (renewalTimer) clearInterval(renewalTimer);
    try { store.releaseLease(lease); } catch { /* a takeover already fenced this invocation */ }
  }
}
