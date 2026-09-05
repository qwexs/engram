import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

export const MEMORY_OBSERVATION_PROJECTION_SCHEMA = "engram.memory-observation-rollout.v1" as const;
export const MEMORY_OBSERVATION_PROJECTION_SCHEMA_V2 = "engram.memory-observation-rollout.v2" as const;
export const MEMORY_OBSERVATION_PROJECTION_SCHEMA_V3 = "engram.memory-observation-rollout.v3" as const;

export type MemoryObservationQmdBindingV1 = {
  collection: string;
};

export type MemoryObservationQmdResolverV1 = {
  resolver: "exact-session-registry";
  manifestPath: string;
  workspaceRegistryDigest: `sha256:${string}`;
};

export type MemoryObservationBindingV1 = {
  runtimeSessionKey: string;
  scopeClass: "self" | "managers" | "company" | "project";
  scopeId: string;
  requireOwner: boolean;
  allowedChannels: ("telegram" | "openclaw")[];
};

export type MemoryObservationProjectionV1 = {
  schema: typeof MEMORY_OBSERVATION_PROJECTION_SCHEMA
    | typeof MEMORY_OBSERVATION_PROJECTION_SCHEMA_V2
    | typeof MEMORY_OBSERVATION_PROJECTION_SCHEMA_V3;
  workspaceId: string;
  enabled: boolean;
  mode: "shadow" | "canary";
  bindings: MemoryObservationBindingV1[];
  pluginDigest: `sha256:${string}`;
  inference: {
    provider: string;
    model: string;
    evaluateAfter: string;
  };
  evaluation?: {
    mode: "immediate" | "batch-cron";
    policyDigest: `sha256:${string}`;
    batch?: {
      sourcePolicyDigest: `sha256:${string}`;
      inactivityGapSeconds: number;
      maxTurns: number;
      maxEvidenceBytes: number;
      maxAgeSeconds: number;
      maxInferenceCallsPerRun: 1;
      schedulerId: string;
    };
  };
  limits: {
    evidenceTtlHours: number;
    maxJobs: number;
    maxBytes: number;
    maxQueueAgeHours: number;
    maxAttempts: number;
    claimTtlSeconds: number;
    maxInferenceCalls: 0 | 1;
  };
  consumers?: {
    dailyNote: {
      mode: "canary";
      applyAfter: string;
      timezone: string;
      allowedObservationClasses: ["episodic.event"] | ["episodic.event", "episodic.decision"];
      maxAppliesPerWake: 1;
      qmdBinding?: MemoryObservationQmdBindingV1 | MemoryObservationQmdResolverV1;
    };
  };
  captureOwnership?: {
    owner: "observer";
    effectiveAfter: string;
    foregroundDailyNoteCapture: "disabled";
  };
  approvedBy: string;
  approvedAt: string;
  disabledBy?: string;
  disabledAt?: string;
};

export class MemoryObservationProjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryObservationProjectionError";
  }
}

const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;

function token(value: unknown, max = 2_048): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= max;
}

function instant(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function integer(value: unknown, min: number, max: number): value is number {
  return Number.isInteger(value) && Number(value) >= min && Number(value) <= max;
}

function validBinding(
  value: unknown,
  schema: MemoryObservationProjectionV1["schema"],
): value is MemoryObservationBindingV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const binding = value as MemoryObservationBindingV1;
  const exactSession = token(binding.runtimeSessionKey)
    && /^agent:[A-Za-z0-9._-]+:.+$/.test(binding.runtimeSessionKey)
    && !binding.runtimeSessionKey.includes("*");
  const agentFamily = schema === MEMORY_OBSERVATION_PROJECTION_SCHEMA_V3
    && /^agent:[A-Za-z0-9._-]+:\*$/.test(binding.runtimeSessionKey);
  return (exactSession || agentFamily)
    && ["self", "managers", "company", "project"].includes(binding.scopeClass)
    && token(binding.scopeId, 512)
    && typeof binding.requireOwner === "boolean"
    && Array.isArray(binding.allowedChannels)
    && binding.allowedChannels.length >= 1
    && binding.allowedChannels.length <= 2
    && binding.allowedChannels.every((channel) => channel === "telegram" || channel === "openclaw")
    && new Set(binding.allowedChannels).size === binding.allowedChannels.length;
}

function validDailyNoteCanary(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const dailyNote = value as NonNullable<MemoryObservationProjectionV1["consumers"]>["dailyNote"];
  return dailyNote.mode === "canary"
    && instant(dailyNote.applyAfter)
    && token(dailyNote.timezone, 100)
    && Array.isArray(dailyNote.allowedObservationClasses)
    && (dailyNote.allowedObservationClasses.length === 1
      ? dailyNote.allowedObservationClasses[0] === "episodic.event"
      : dailyNote.allowedObservationClasses.length === 2
        && dailyNote.allowedObservationClasses[0] === "episodic.event"
        && dailyNote.allowedObservationClasses[1] === "episodic.decision")
    && dailyNote.maxAppliesPerWake === 1
    && (dailyNote.qmdBinding === undefined || validQmdBinding(dailyNote.qmdBinding));
}

function validQmdBinding(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const binding = value as Partial<MemoryObservationQmdBindingV1 & MemoryObservationQmdResolverV1>;
  const keys = Object.keys(binding).sort();
  if (keys.length === 1 && keys[0] === "collection") return token(binding.collection, 300);
  return keys.length === 3
    && keys[0] === "manifestPath"
    && keys[1] === "resolver"
    && keys[2] === "workspaceRegistryDigest"
    && binding.resolver === "exact-session-registry"
    && typeof binding.manifestPath === "string"
    && binding.manifestPath.trim() === binding.manifestPath
    && isAbsolute(binding.manifestPath)
    && DIGEST_RE.test(binding.workspaceRegistryDigest ?? "");
}

function validCaptureOwnership(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const ownership = value as NonNullable<MemoryObservationProjectionV1["captureOwnership"]>;
  return ownership.owner === "observer"
    && instant(ownership.effectiveAfter)
    && ownership.foregroundDailyNoteCapture === "disabled";
}

function validEvaluation(value: unknown, schema: MemoryObservationProjectionV1["schema"]): boolean {
  if (schema === MEMORY_OBSERVATION_PROJECTION_SCHEMA) return value === undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const evaluation = value as NonNullable<MemoryObservationProjectionV1["evaluation"]>;
  if ((evaluation.mode !== "immediate" && evaluation.mode !== "batch-cron")
    || !DIGEST_RE.test(evaluation.policyDigest)) return false;
  if (evaluation.mode === "immediate") return evaluation.batch === undefined;
  const batch = evaluation.batch;
  return Boolean(batch
    && DIGEST_RE.test(batch.sourcePolicyDigest)
    && integer(batch.inactivityGapSeconds, 1, 3_600)
    && integer(batch.maxTurns, 2, 100)
    && integer(batch.maxEvidenceBytes, 1_024, 1_073_741_824)
    && integer(batch.maxAgeSeconds, batch.inactivityGapSeconds, 86_400)
    && batch.maxInferenceCallsPerRun === 1
    && token(batch.schedulerId, 300));
}

export function memoryObservationProjectionPath(workspace: string): string {
  return join(resolve(workspace), "memory-state", "memory-observation", "projection.json");
}

export function resolveMemoryObservationProjection(options: {
  workspace: string;
  workspaceId: string;
  expectedPluginDigest?: `sha256:${string}`;
}): MemoryObservationProjectionV1 {
  const path = memoryObservationProjectionPath(options.workspace);
  if (!existsSync(path)) throw new MemoryObservationProjectionError("memory observation has no local projection");
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, "utf8")); }
  catch { throw new MemoryObservationProjectionError("memory observation projection is unreadable"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MemoryObservationProjectionError("memory observation projection is invalid");
  }
  const projection = value as MemoryObservationProjectionV1;
  const limits = projection.limits;
  const inference = projection.inference;
  if (![MEMORY_OBSERVATION_PROJECTION_SCHEMA, MEMORY_OBSERVATION_PROJECTION_SCHEMA_V2, MEMORY_OBSERVATION_PROJECTION_SCHEMA_V3].includes(projection.schema as any)
    || projection.workspaceId !== options.workspaceId
    || projection.enabled !== true
    || !["shadow", "canary"].includes(projection.mode)
    || !Array.isArray(projection.bindings)
    || projection.bindings.length < 1
    || projection.bindings.length > 20
    || projection.bindings.some((binding) => !validBinding(binding, projection.schema))
    || new Set(projection.bindings.map((binding) => binding.runtimeSessionKey)).size !== projection.bindings.length
    || !DIGEST_RE.test(projection.pluginDigest)
    || !inference
    || !token(inference.provider, 100)
    || !token(inference.model, 300)
    || !inference.model.startsWith(`${inference.provider}/`)
    || !instant(inference.evaluateAfter)
    || !validEvaluation(projection.evaluation, projection.schema)
    || !limits
    || !integer(limits.evidenceTtlHours, 1, 72)
    || !integer(limits.maxJobs, 1, 100_000)
    || !integer(limits.maxBytes, 1_024, 1_073_741_824)
    || !integer(limits.maxQueueAgeHours, 1, 720)
    || !integer(limits.maxAttempts, 1, 5)
    || !integer(limits.claimTtlSeconds, 1, 3_600)
    || !integer(limits.maxInferenceCalls, 0, 1)
    || !token(projection.approvedBy, 300)
    || !instant(projection.approvedAt)
    || (projection.mode === "shadow" && projection.consumers !== undefined)
    || (projection.mode === "shadow" && projection.captureOwnership !== undefined)
    || (projection.evaluation?.mode === "batch-cron" && limits.maxInferenceCalls !== 1)
    || (projection.bindings.some((binding) => binding.runtimeSessionKey.endsWith(":*"))
      && (projection.consumers?.dailyNote.qmdBinding === undefined
        || "collection" in projection.consumers.dailyNote.qmdBinding))
    || (projection.mode === "canary"
      && (!projection.consumers
        || projection.bindings.length !== 1
        || Object.keys(projection.consumers).length !== 1
        || !validDailyNoteCanary(projection.consumers.dailyNote)
        || (projection.captureOwnership !== undefined
          && (!validCaptureOwnership(projection.captureOwnership)
            || projection.captureOwnership.effectiveAfter !== projection.consumers.dailyNote.applyAfter
            || projection.consumers.dailyNote.allowedObservationClasses.length !== 2))))) {
    throw new MemoryObservationProjectionError("memory observation projection is invalid");
  }
  if (options.expectedPluginDigest && projection.pluginDigest !== options.expectedPluginDigest) {
    throw new MemoryObservationProjectionError("memory observation plugin digest mismatch");
  }
  return projection;
}

export function memoryObservationEvaluationMode(
  projection: MemoryObservationProjectionV1,
): "immediate" | "batch-cron" {
  return projection.evaluation?.mode ?? "immediate";
}

export function memoryObservationBinding(
  projection: MemoryObservationProjectionV1,
  runtimeSessionKey: string,
): MemoryObservationBindingV1 | null {
  if (!projection.enabled || !["shadow", "canary"].includes(projection.mode)) return null;
  const binding = projection.bindings.find((candidate) => candidate.runtimeSessionKey === runtimeSessionKey
    || (projection.schema === MEMORY_OBSERVATION_PROJECTION_SCHEMA_V3
      && candidate.runtimeSessionKey.endsWith(":*")
      && runtimeSessionKey.startsWith(candidate.runtimeSessionKey.slice(0, -1)))) ?? null;
  return binding ? { ...binding, runtimeSessionKey } : null;
}

export function memoryObservationDailyNoteCanary(
  projection: MemoryObservationProjectionV1,
): NonNullable<MemoryObservationProjectionV1["consumers"]>["dailyNote"] | null {
  if (!projection.enabled || projection.mode !== "canary") return null;
  return projection.consumers?.dailyNote ?? null;
}

export function memoryObservationCaptureOwner(
  projection: MemoryObservationProjectionV1,
  runtimeSessionKey: string,
  now = new Date(),
): "observer" | "foreground" {
  const ownership = projection.captureOwnership;
  if (!projection.enabled || projection.mode !== "canary" || !ownership) return "foreground";
  if (projection.bindings.length !== 1 || !memoryObservationBinding(projection, runtimeSessionKey)) return "foreground";
  return Date.parse(ownership.effectiveAfter) <= now.getTime() ? "observer" : "foreground";
}
