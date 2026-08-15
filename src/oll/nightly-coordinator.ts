import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { atomicWriteJson } from "./legacy-migration";
import type { NightlyRuntimeAdapter, NightlySpawnRequestV1, WorkspaceRegistryAdapter } from "./contracts";
import { applyRethinkHandoffFile, ApplicatorResult } from "./handoff-applicator";
import { buildRethinkProposalPrompt, canonicalizeJcs, type ExpectedHandoffV2, sha256Digest } from "./handoff-v2";
import { buildRethinkProposalPromptV3, parseRethinkHandoffV3, type ExpectedHandoffV3 } from "./handoff-v3";
import { buildCandidateAwareNightlyContext, buildNightlyContext, determineNightlyWindow, type NightlyContext, type NightlyContextV2, preflightNightlyContext } from "./nightly-context";
import { discoverNightlyWorkspaces, DiscoveredWorkspaceV1, FrozenRegistrySnapshotV1 } from "./nightly-discovery";
import { NightlyBatchStateV1, NightlyLeaseV1, NightlyStateStore } from "./nightly-state-store";
import { reconcileWorkspaceMemory, WorkspaceReconciliationResult } from "./reconciliation";
import type { TrustedActorContext } from "./authorization";
import { compileMemoryCandidateReportV2 } from "./memory-candidate-compiler-v2";
import type { CandidateScope, CandidateScopeRegistryV1, CandidateSourcePolicyV2 } from "./memory-candidate-contracts-v2";
import { inspectCandidateCompilerProjectionV1 } from "./memory-candidate-rollout-v1";
import { assessCandidateSelectionV1, materializeCandidateReportV2, readCandidateProjectionV1 } from "./memory-candidate-store-v2";
import { applyCandidateHandoffV3 } from "./memory-candidate-runtime-v2";

type BatchTransition =
  | "pending" | "reconciling" | "compiling" | "preflight" | "skipped" | "dispatching"
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
  candidateShadow?: { attempted: number; succeeded: number; failed: number };
}

const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  pending: ["reconciling", "completed", "cancelled"],
  reconciling: ["compiling", "failed", "cancelled"],
  compiling: ["preflight", "failed", "cancelled"],
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

function resolveCandidateNotificationSession(
  scope: CandidateScope,
  policy: CandidateSourcePolicyV2,
  registry: CandidateScopeRegistryV1,
): string {
  const admitted = new Set(policy.daily.map((entry) => entry.session));
  const matches = Object.entries(registry.sourceAuthorities.daily)
    .filter(([session, authorizedScope]) => admitted.has(session) && canonicalizeJcs(authorizedScope) === canonicalizeJcs(scope))
    .map(([session]) => session)
    .sort();
  if (matches.length !== 1) throw new Error(`candidate notification session did not resolve uniquely for ${scope.level}:${scope.subject}`);
  return matches[0];
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

function handoffExpected(batch: NightlyBatchStateV1, context: NightlyContext): ExpectedHandoffV2 | ExpectedHandoffV3 {
  if (!batch.activeWorkspace || !batch.activeRunId || !batch.activeEvaluationId || !batch.activeAttempt || !batch.activeContextDigest || !batch.activeHandoffPath) {
    throw new Error("active batch correlation is incomplete");
  }
  const base = {
    batchId: batch.batchId,
    workspaceId: batch.activeWorkspace,
    evaluationId: batch.activeEvaluationId,
    runId: batch.activeRunId,
    phase: "hb-rethink" as const,
    attempt: batch.activeAttempt,
    policyVersion: 1 as const,
    contextDigest: batch.activeContextDigest as `sha256:${string}`,
    expectedHandoffPath: batch.activeHandoffPath,
    signalRevisions: context.signalRevisions,
  };
  return context.schema === "oll.nightly-context.v2" && context.candidateCompiler?.mode === "materialize"
    ? { ...base, candidateRevisions: context.candidateRevisions }
    : base;
}

function candidateShadowErrorClass(error: unknown): "policy_invalid" | "scope_registry_invalid" | "compiler_failed" | "artifact_failed" {
  const message = error instanceof Error ? error.message : String(error);
  if (/scope registry/i.test(message)) return "scope_registry_invalid";
  if (/policy|candidate compiler|forwardOnlySince|workspaceTimezone|sensitive text/i.test(message)) return "policy_invalid";
  if (/immutable artifact|EEXIST|ENOENT|permission|read-only/i.test(message)) return "artifact_failed";
  return "compiler_failed";
}

function updateWorkspaceWatermark(workspace: string, context: NightlyContext, score: number): void {
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
  const candidateShadow = { attempted: 0, succeeded: 0, failed: 0 };
  const candidateShadowReport = () => candidateShadow.attempted ? { candidateShadow: { ...candidateShadow } } : {};

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
    activeSnapshotAt: null,
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
        activeSnapshotAt: null,
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
        ...candidateShadowReport(),
      };
    }

    for (const workspaceId of batch.workspaceQueue) {
      if (batch.completed.includes(workspaceId) || batch.failed.includes(workspaceId)) continue;
      const workspace = snapshot.entries.find((entry) => entry.workspaceId === workspaceId);
      if (!workspace) throw new Error(`workspace ${workspaceId} missing from frozen snapshot`);
      if (!processingOrder.includes(workspaceId)) processingOrder.push(workspaceId);
      const config = workspace.config.oll.nightly;
      const candidatePolicy = workspace.config?.oll?.candidateCompiler as CandidateSourcePolicyV2 | undefined;
      const scopeRegistry = workspace.config?.oll?.candidateScopeRegistry as CandidateScopeRegistryV1 | undefined;
      const contextPath = join(coordinatorRoot, "batches", batch.batchId, "contexts", `${workspaceId}.json`);
      let context: NightlyContext;

      if (batch.activeWorkspace === workspaceId && batch.activeRunId) {
        context = readObject<NightlyContext>(contextPath);
      } else if (batch.activeWorkspace === workspaceId && existsSync(contextPath) && ["preflight", "skipped"].includes(batch.status)) {
        context = readObject<NightlyContext>(contextPath);
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
        if (!(batch.activeWorkspace === workspaceId && ["reconciling", "compiling"].includes(batch.status))) {
          transition("reconciling", {
            activeWorkspace: workspaceId,
            activeSnapshotAt: null,
            activeRunId: null,
            activeEvaluationId: null,
            activeAttempt: null,
            activeContextDigest: null,
            activeHandoffPath: null,
          });
        }
        const reconciliation = batch.status === "compiling"
          ? { workspace: workspace.workspacePath, status: "ok" as const }
          : options.reconciliationCompletedExternally
            ? { workspace: workspace.workspacePath, status: "ok" as const }
            : options.reconcile
              ? await options.reconcile(workspace)
              : await reconcileWorkspaceMemory({ workspace: workspace.workspacePath, scriptsDir: options.scriptsDir });
        if (reconciliation.status !== "ok") {
          transition("failed", { failed: [...batch.failed, workspaceId], ...clearedActive() }, "reconciliation_failed", { error: reconciliation.error || "unknown" });
          continue;
        }
        const snapshotAt = batch.status === "compiling" && batch.activeSnapshotAt ? batch.activeSnapshotAt : now();
        const window = determineNightlyWindow({
          now: snapshotAt,
          timezone: config.timezone,
          weeklyEnabled: workspace.config?.oll?.weeklyMode?.enabled === true,
          weekStart: "monday",
        });
        if (batch.status === "reconciling") transition("compiling", { activeSnapshotAt: snapshotAt }, null, { snapshotAt });
        let shadowObservation: Record<string, unknown> | null = null;
        if (candidatePolicy?.mode === "shadow") {
          candidateShadow.attempted += 1;
          const policyDigest = sha256Digest(canonicalizeJcs(candidatePolicy));
          const scopeRegistryDigest = sha256Digest(canonicalizeJcs(scopeRegistry || null));
          const attemptId = sha256Digest(canonicalizeJcs({
            schema: "oll.memory-candidate-shadow-attempt.v1",
            batchId: batch.batchId,
            workspaceId,
            snapshotAt,
            policyDigest,
            scopeRegistryDigest,
          }));
          const attemptRoot = join(coordinatorRoot, "batches", batch.batchId, "candidate-compilation-attempts");
          try {
            const rolloutProjection = inspectCandidateCompilerProjectionV1({ workspace: workspace.workspacePath, workspaceId });
            if (!rolloutProjection.consistent || rolloutProjection.mode !== "shadow") {
              throw new Error(rolloutProjection.reason || "candidate shadow rollout projection is not active");
            }
            writeImmutable(join(attemptRoot, `${workspaceId}.started.json`), {
              schema: "oll.memory-candidate-shadow-attempt.v1",
              attemptId,
              batchId: batch.batchId,
              workspaceId,
              snapshotAt,
              mode: "shadow",
              policyDigest,
              scopeRegistryDigest,
              status: "started",
            });
            if (!scopeRegistry) throw new Error("candidate scope registry is required");
            const report = compileMemoryCandidateReportV2({
              workspace: workspace.workspacePath,
              workspaceId,
              snapshotAt,
              batchId: batch.batchId,
              policy: candidatePolicy,
              scopeRegistry,
              executionMode: "shadow",
            });
            writeImmutable(join(coordinatorRoot, "batches", batch.batchId, "candidate-reports", `${workspaceId}.json`), report);
            const metrics = {
              schema: "oll.memory-candidate-shadow-result.v1",
              attemptId,
              workspaceId,
              status: "report_persisted",
              reportDigest: report.reportDigest,
              considered: report.considered,
              eligible: report.eligible,
              selected: report.selected,
              selectedBytes: report.selectedBytes,
              projectedModelSpawns: report.projectedModelSpawns,
              projectedReviews: report.projectedReviews,
              sourceCounts: report.sourceCounts,
              rejectionCounts: report.rejectionCounts,
            } as const;
            writeImmutable(join(attemptRoot, `${workspaceId}.terminal.json`), metrics);
            candidateShadow.succeeded += 1;
            shadowObservation = metrics;
          } catch (error) {
            candidateShadow.failed += 1;
            const errorClass = candidateShadowErrorClass(error);
            const diagnostic = {
              schema: "oll.memory-candidate-shadow-result.v1",
              attemptId,
              workspaceId,
              status: "failed",
              errorClass,
            } as const;
            shadowObservation = diagnostic;
            try { writeImmutable(join(attemptRoot, `${workspaceId}.terminal.json`), diagnostic); } catch { /* shadow artifacts never block legacy rethink */ }
          }
        }
        const legacyContext = buildNightlyContext({
          workspace: workspace.workspacePath,
          workspaceId,
          snapshotAt,
          window,
        });
        if (candidatePolicy?.mode === "materialize") {
          try {
            const rolloutProjection = inspectCandidateCompilerProjectionV1({ workspace: workspace.workspacePath, workspaceId });
            if (!rolloutProjection.consistent || rolloutProjection.mode !== "materialize") {
              throw new Error(rolloutProjection.reason || "candidate materialize rollout projection is not active");
            }
            if (!scopeRegistry) throw new Error("candidate scope registry is required");
            const report = compileMemoryCandidateReportV2({
              workspace: workspace.workspacePath,
              workspaceId,
              snapshotAt,
              batchId: batch.batchId,
              policy: candidatePolicy,
              scopeRegistry,
              executionMode: "materialize",
            });
            writeImmutable(join(coordinatorRoot, "batches", batch.batchId, "candidate-reports", `${workspaceId}.json`), report);
            const materialized = materializeCandidateReportV2({
              workspace: workspace.workspacePath,
              workspaceId,
              report,
              policy: candidatePolicy,
              scopeRegistry,
            });
            const memoryCandidates: NightlyContextV2["memoryCandidates"] = [];
            for (const item of materialized.candidates) {
              let projection = readCandidateProjectionV1({ workspace: workspace.workspacePath, workspaceId, candidateId: item.candidateId });
              if (!projection || !["pending", "deferred"].includes(projection.cluster.lifecycle.status) || projection.reservation) continue;
              const assessment = assessCandidateSelectionV1({
                workspace: workspace.workspacePath,
                workspaceId,
                candidateId: item.candidateId,
                expectedCandidateRevision: projection.highestContiguousRevision,
                frozenReport: report,
                frozenPolicy: candidatePolicy,
                frozenScopeRegistry: scopeRegistry,
                currentReport: report,
                currentPolicy: candidatePolicy,
                currentScopeRegistry: scopeRegistry,
              });
              if (assessment.outcome !== "selected") continue;
              projection = readCandidateProjectionV1({ workspace: workspace.workspacePath, workspaceId, candidateId: item.candidateId });
              const cluster = report.candidates.find((candidate) => candidate.candidateId === item.candidateId);
              if (!projection || projection.cluster.lifecycle.status !== "pending" || projection.reservation || !cluster) continue;
              memoryCandidates.push({
                candidateId: cluster.candidateId,
                revision: projection.highestContiguousRevision,
                evidenceSetDigest: cluster.evidenceSetDigest,
                semanticKey: cluster.semanticKey,
                effectiveScope: cluster.effectiveScope,
                canonicalStatement: cluster.canonicalStatement,
                ranking: cluster.ranking,
              });
            }
            context = buildCandidateAwareNightlyContext({
              legacy: legacyContext,
              candidateCompiler: {
                mode: "materialize",
                reportDigest: report.reportDigest,
                considered: report.considered,
                eligible: report.eligible,
                selected: report.selected,
                selectedBytes: report.selectedBytes,
                sourceCounts: report.sourceCounts,
                rejectionCounts: report.rejectionCounts,
              },
              memoryCandidates,
            });
          } catch (error) {
            transition("failed", { failed: [...batch.failed, workspaceId], ...clearedActive() }, candidateShadowErrorClass(error), {
              error: error instanceof Error ? error.message : String(error),
            });
            continue;
          }
        } else {
          context = legacyContext;
        }
        writeImmutable(contextPath, context);
        const preflight = preflightNightlyContext(context);
        transition("preflight", { activeContextDigest: context.contextDigest }, null, { preflight, ...(shadowObservation ? { candidateShadow: shadowObservation } : {}) });
        if (!preflight.actionable) {
          transition("skipped", {}, null, { preflight });
          updateWorkspaceWatermark(workspace.workspacePath, context, preflight.score);
          skipped.push(workspaceId);
          transition("completed", {
            completed: [...batch.completed, workspaceId],
            activeWorkspace: null,
            activeSnapshotAt: null,
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
        let expected: ExpectedHandoffV2 | ExpectedHandoffV3;
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
          prompt: "candidateRevisions" in expected
            ? buildRethinkProposalPromptV3({
                contextSnapshot: context,
                expected,
                emptyHandoffWriterPath: join(options.scriptsDir, "oll-write-empty-handoff.ts"),
              })
            : buildRethinkProposalPrompt({
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
        let result: ApplicatorResult;
        try {
          if ("candidateRevisions" in expected) {
            if (!scopeRegistry || candidatePolicy?.mode !== "materialize") throw new Error("materialize runtime lost its frozen candidate policy");
            const appliedRoot = join(workspace.workspacePath, "memory-state", "oll", "handoffs", "applied");
            const appliedPath = join(appliedRoot, `${expected.runId}.json`);
            const handoffPath = existsSync(expected.expectedHandoffPath) ? expected.expectedHandoffPath : appliedPath;
            if (!existsSync(handoffPath)) throw new Error("expected candidate handoff file is unavailable");
            const handoff = parseRethinkHandoffV3(readFileSync(handoffPath), expected, expected.expectedHandoffPath);
            const candidateActions = handoff.actions.filter((action) => action.payload.sourceCandidates.length > 0);
            if (candidateActions.length === 0) {
              applyCandidateHandoffV3({
                workspace: workspace.workspacePath,
                workspaceId,
                handoff,
                scopeRegistry,
                now: now(),
                liveRevalidate: () => { throw new Error("signal-only handoff unexpectedly requested candidate effects"); },
              });
              const applicator = options.applyHandoff || applyRethinkHandoffFile;
              result = applicator({
                workspace: workspace.workspacePath,
                stateRoot: options.stateRoot,
                expected,
                trustedActorContexts: options.trustedActorContexts,
                skipCandidateDispositions: true,
                now: now(),
              });
            } else {
              const optimisticApply = workspace.config?.oll?.adaptation?.mode === "active";
              const candidateAction = candidateActions[0];
              const notificationScope: CandidateScope | null = candidateAction.payload.scope.level === "person"
                ? { level: "self", subject: candidateAction.payload.scope.subject }
                : candidateAction.payload.scope.level === "company"
                  ? null
                  : { level: candidateAction.payload.scope.level, subject: candidateAction.payload.scope.subject };
              const notificationSession = optimisticApply && notificationScope
                ? resolveCandidateNotificationSession(notificationScope, candidatePolicy, scopeRegistry)
                : undefined;
              const plan = applyCandidateHandoffV3({
                workspace: workspace.workspacePath,
                workspaceId,
                handoff,
                scopeRegistry,
                now: now(),
                optimisticApply,
                stateRoot: options.stateRoot,
                notificationSession,
                liveRevalidate: ({ candidateScopes }) => {
                  const liveConfig = readObject<Record<string, any>>(join(workspace.workspacePath, "engram.json"));
                  const livePolicy = liveConfig?.oll?.candidateCompiler as CandidateSourcePolicyV2 | undefined;
                  const liveRegistry = liveConfig?.oll?.candidateScopeRegistry as CandidateScopeRegistryV1 | undefined;
                  if (!livePolicy || !liveRegistry
                    || sha256Digest(canonicalizeJcs(livePolicy)) !== sha256Digest(canonicalizeJcs(candidatePolicy))
                    || sha256Digest(canonicalizeJcs(liveRegistry)) !== sha256Digest(canonicalizeJcs(scopeRegistry))) {
                    throw new Error("candidate policy or scope registry drifted before effect commit");
                  }
                  const current = compileMemoryCandidateReportV2({
                    workspace: workspace.workspacePath,
                    workspaceId,
                    snapshotAt: now(),
                    batchId: batch.batchId,
                    policy: livePolicy,
                    scopeRegistry: liveRegistry,
                    executionMode: "materialize",
                  });
                  for (const [candidateId, candidateScope] of Object.entries(candidateScopes)) {
                    const currentCluster = current.candidates.find((candidate) => candidate.candidateId === candidateId);
                    if (!currentCluster || canonicalizeJcs(currentCluster.effectiveScope) !== canonicalizeJcs(candidateScope)) {
                      throw new Error(`candidate source or scope drifted before effect commit: ${candidateId}`);
                    }
                  }
                },
              });
              mkdirSync(appliedRoot, { recursive: true });
              if (existsSync(expected.expectedHandoffPath) && !existsSync(appliedPath)) renameSync(expected.expectedHandoffPath, appliedPath);
              const reviewEffects = plan?.effects.filter((effect) => effect.type === "mandatory_review") || [];
              const appliedEffects = plan?.effects.filter((effect) => effect.type === "rule_proposal" && effect.payload.reviewRequired === false) || [];
              result = {
                status: "terminal",
                workspaceId,
                runId: expected.runId,
                handoffDigest: handoff.handoffDigest,
                dispositions: [...reviewEffects.map((effect) => ({
                  actionId: effect.actionId,
                  operationId: plan!.planId,
                  disposition: "review_pending",
                  artifactRef: null,
                })), ...appliedEffects.map((effect) => ({
                  actionId: effect.actionId,
                  operationId: plan!.planId,
                  disposition: "verified",
                  artifactRef: `memory-state/oll/rules`,
                }))],
                projectionDigest: plan ? sha256Digest(canonicalizeJcs(plan)) : handoff.handoffDigest,
                appliedPath,
              };
            }
          } else {
            const applicator = options.applyHandoff || applyRethinkHandoffFile;
            result = applicator({
              workspace: workspace.workspacePath,
              stateRoot: options.stateRoot,
              expected,
              trustedActorContexts: options.trustedActorContexts,
              now: now(),
            });
          }
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
          activeSnapshotAt: null,
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
      ...candidateShadowReport(),
    };
  } finally {
    if (renewalTimer) clearInterval(renewalTimer);
    try { store.releaseLease(lease); } catch { /* a takeover already fenced this invocation */ }
  }
}
