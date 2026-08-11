/**
 * Executable contracts for the accepted OLL Nightly Adaptation target.
 *
 * PR 0 deliberately does not wire these contracts into the production
 * heartbeat or nightly runtime. Later rollout phases must implement these
 * interfaces without changing their versioned identity.
 */

export const OLL_CONTRACT_VERSION = 1 as const;
export const OLL_RETHINK_PHASE = "hb-rethink" as const;
export const OLL_HANDOFF_SCHEMA = "oll.rethink-handoff.v2" as const;

export type NightlyBatchMode = "daily" | "weekly";
export type HandoffWaitStatus = "file" | "timeout" | "watcher_error";

export interface RegistryWorkspaceEntryV1 {
  workspaceId: string;
  workspacePath: string;
  registryRevision: number;
  registryDigest: `sha256:${string}`;
  configDigest: `sha256:${string}`;
}

export interface RegistrySnapshotV1 {
  schema: "oll.workspace-registry-snapshot.v1";
  capturedAt: string;
  entries: readonly RegistryWorkspaceEntryV1[];
}

export interface WorkspaceRegistryAdapter {
  snapshot(): Promise<RegistrySnapshotV1>;
}

export interface NightlySpawnRequestV1 {
  schema: "oll.nightly-spawn-request.v1";
  batchId: string;
  workspaceId: string;
  workspacePath: string;
  evaluationId: string;
  runId: string;
  phase: typeof OLL_RETHINK_PHASE;
  label: string;
  runtimeLabel: string;
  model: string;
  attempt: number;
  policyVersion: number;
  contextDigest: `sha256:${string}`;
  contextSnapshotPath: string;
  expectedHandoffPath: string;
  fencingGeneration: number;
  prompt: string;
}

export interface DispatchAcknowledgementV1 {
  schema: "oll.dispatch-ack.v1";
  runId: string;
  accepted: boolean;
  acknowledgedAt: string;
  runtimeLabel: string;
  resolvedModel: string;
  dispatchRef: string;
}

export interface HandoffWaitResultV1 {
  schema: "oll.handoff-wait-result.v1";
  runId: string;
  expectedPath: string;
  status: HandoffWaitStatus;
  observedPath: string | null;
  observedAt: string;
  errorClass: "handoff_timeout" | "watcher_error" | null;
}

export interface ResumeResultV1 {
  schema: "oll.resume-result.v1";
  batchId: string;
  resumed: boolean;
  resumedAt: string;
}

/** Fixed runtime boundary from target design section 5.5. */
export interface NightlyRuntimeAdapter {
  spawn(request: NightlySpawnRequestV1): Promise<DispatchAcknowledgementV1>;
  awaitHandoff(expectedPath: string, timeoutMs?: number): Promise<HandoffWaitResultV1>;
  resume(batchId: string): Promise<ResumeResultV1>;
}

export interface NightlyOrchestrationDeclarationV1 {
  schema: "oll.nightly-orchestration-declaration.v1";
  kind: "script";
  schedulerCount: number;
  capabilities: readonly string[];
  helpers: readonly string[];
  durableState: boolean;
  resumePolicy: "durable-batch";
  usesIntervalPolling: boolean;
  maxActiveRethinkRuns: number;
  handoffTimeoutSeconds: number;
  batchTimeoutSeconds: number;
}

export interface ContractValidationResult {
  ok: boolean;
  errors: string[];
}

/**
 * Architecture gate for the future trusted cron script declaration.
 * It validates capabilities and recovery semantics, not prose markers.
 */
export function validateNightlyOrchestrationDeclaration(
  input: unknown,
): ContractValidationResult {
  const errors: string[] = [];
  const value = input as Partial<NightlyOrchestrationDeclarationV1> | null;

  if (!value || typeof value !== "object") {
    return { ok: false, errors: ["declaration must be an object"] };
  }
  if (value.schema !== "oll.nightly-orchestration-declaration.v1") {
    errors.push("schema must be oll.nightly-orchestration-declaration.v1");
  }
  if (value.kind !== "script") errors.push("kind must be script");
  if (value.schedulerCount !== 1) errors.push("schedulerCount must equal 1");
  if (!Array.isArray(value.capabilities) || !value.capabilities.includes("sessions_spawn")) {
    errors.push("capabilities must include sessions_spawn");
  }
  if (!Array.isArray(value.helpers) || !value.helpers.includes("oll-await-handoff")) {
    errors.push("helpers must include oll-await-handoff");
  }
  if (value.durableState !== true) errors.push("durableState must be true");
  if (value.resumePolicy !== "durable-batch") {
    errors.push("resumePolicy must be durable-batch");
  }
  if (value.usesIntervalPolling !== false) {
    errors.push("usesIntervalPolling must be false");
  }
  if (value.maxActiveRethinkRuns !== 1) {
    errors.push("maxActiveRethinkRuns must equal 1");
  }
  if (!Number.isInteger(value.handoffTimeoutSeconds) || Number(value.handoffTimeoutSeconds) <= 0) {
    errors.push("handoffTimeoutSeconds must be a positive integer");
  }
  if (!Number.isInteger(value.batchTimeoutSeconds) || Number(value.batchTimeoutSeconds) <= 0) {
    errors.push("batchTimeoutSeconds must be a positive integer");
  }
  if (
    Number.isInteger(value.handoffTimeoutSeconds)
    && Number.isInteger(value.batchTimeoutSeconds)
    && Number(value.handoffTimeoutSeconds) >= Number(value.batchTimeoutSeconds)
  ) {
    errors.push("handoffTimeoutSeconds must be less than batchTimeoutSeconds");
  }

  return { ok: errors.length === 0, errors };
}
