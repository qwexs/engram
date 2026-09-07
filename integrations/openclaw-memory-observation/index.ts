import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { definePluginEntry } from "openclaw/plugin-sdk/core";
import {
  resolveObservationAgentRunIdentity,
  resolveObservationMessageReceivedIdentity,
  resolveObservationMessageSentIdentity,
  resolveObservationPersistedUserIdentity,
} from "../../src/memory-observation/hook-identity.ts";
import { EpisodicShadowEvaluator } from "../../src/memory-observation/episodic-evaluator.ts";
import { AutonomousEpisodicRunner } from "../../src/memory-observation/evaluator-runner.ts";
import { assertResolvedInferenceModel } from "../../src/memory-observation/inference-boundary.ts";
import { AdmissionStore } from "../../src/memory-observation/admission-store.ts";
import { configuredMemoryAgentIds } from "../../src/memory-observation/configured-agents.ts";
import {
  buildDailyNoteCanaryPolicy,
  DailyNoteCanaryApplicator,
  type DailyNoteCanaryPolicy,
} from "../../src/memory-observation/daily-note-applicator.ts";
import { AutonomousDailyNoteCanaryRunner } from "../../src/memory-observation/daily-note-runner.ts";
import { MemoryObservationLedger, purgeMemoryObservationLifecycle, type ProducerRef } from "../../src/memory-observation/ledger.ts";
import {
  OpenClawObservationRuntimeAdapter,
  observationRuntimeAdapterError,
  type RuntimeObservationBinding,
} from "../../src/memory-observation/runtime-adapter.ts";
import { ReplyContextStore } from "../../src/memory-observation/reply-context.ts";
import {
  memoryObservationBinding,
  memoryObservationDailyNoteCanary,
  memoryObservationEvaluationMode,
  resolveMemoryObservationProjection,
  type MemoryObservationProjectionV1,
} from "../../src/memory-observation/projection.ts";

const ENTRY_PATH = fileURLToPath(import.meta.url);
const PLUGIN_DIGEST = `sha256:${createHash("sha256").update(readFileSync(ENTRY_PATH)).digest("hex")}` as const;
const RUNTIME_AUTHORITY: ProducerRef = {
  id: "openclaw-runtime",
  version: "v1",
  digest: "sha256:41580b56cf8dc83fea5f78568092308214f851833a5c6cae537bf1a21b3626bd",
};
const EVALUATOR_AUTHORITY: ProducerRef = {
  id: "post-turn-observer",
  version: "v1",
  digest: "sha256:d4f0bf349ea08594fbd3a72f1e6f05ea5dda32800422c1e2cefbc434552cd406",
};
const RUNTIME_REGISTRY = {
  schema: "engram.memory-producer-registry.v1",
  producers: [
    {
      ...RUNTIME_AUTHORITY,
      authorityClass: "runtime",
      artifactSchemas: ["engram.memory-observation-job.v1", "engram.memory-admission-gap-receipt.v1", "engram.memory-trace-event.v1"],
      observationClasses: [],
    },
    {
      ...EVALUATOR_AUTHORITY,
      authorityClass: "evaluator",
      artifactSchemas: ["engram.memory-observation.v1"],
      observationClasses: ["episodic.event", "episodic.decision"],
    },
  ],
};
const RUNTIME_POLICY = {
  schema: "engram.memory-authority-policy.v1",
  policyVersion: "memory-observation-authority-v1",
  rules: [
    {
      artifactSchema: "engram.memory-observation-job.v1",
      stage: "source-admission",
      allowedAuthorityClasses: ["runtime"],
      allowedProducerIds: ["openclaw-runtime"],
      requiredTrustedInputs: ["completed-source-turn", "runtime-session-key", "workspace-binding", "source-completion-time"],
    },
    {
      artifactSchema: "engram.memory-observation.v1",
      stage: "advisory-evaluation",
      allowedAuthorityClasses: ["evaluator"],
      allowedProducerIds: ["post-turn-observer"],
      requiredTrustedInputs: ["observation-job", "ttl-evidence-store", "producer-registry"],
    },
  ],
  defaultDecision: "deny",
};

type ActiveWorkspace = {
  workspace: string;
  workspaceId: string;
  projection: MemoryObservationProjectionV1;
};

const adapters = new Map<string, OpenClawObservationRuntimeAdapter>();
const evaluatorRunners = new Map<string, AutonomousEpisodicRunner>();
const dailyNoteRunners = new Map<string, AutonomousDailyNoteCanaryRunner>();
let lifecycleTimer: ReturnType<typeof setInterval> | null = null;
const LIFECYCLE_INTERVAL_MS = 60 * 60 * 1_000;

function readJson(path: string): any { return JSON.parse(readFileSync(path, "utf8")); }

function agentIdFromSessionKey(sessionKey: string): string | null {
  return sessionKey.match(/^agent:([^:]+):/)?.[1] ?? null;
}

function currentConfig(api: any): any {
  return api.runtime.config?.current?.() ?? api.config;
}

function defaultAgentId(config: any): string {
  const entries = config?.agents?.entries;
  if (Array.isArray(entries)) return entries.find((entry) => entry?.default === true)?.id || "main";
  if (entries && typeof entries === "object") {
    return Object.entries(entries).find(([, entry]: [string, any]) => entry?.default === true)?.[0] || "main";
  }
  return "main";
}

function assertInferenceBoundary(api: any, runtimeSessionKey: string, projection: MemoryObservationProjectionV1): void {
  const config = currentConfig(api);
  const agentId = agentIdFromSessionKey(runtimeSessionKey);
  if (!agentId || agentId !== defaultAgentId(config)) {
    throw new Error("episodic evaluator is restricted to the configured default agent");
  }
  if (!projection.inference.model.startsWith(`${projection.inference.provider}/`)) {
    throw new Error("episodic evaluator projection has an invalid model/provider boundary");
  }
}

function resolveAgentWorkspace(config: any, agentId: string): string | null {
  const entries = config?.agents?.entries;
  let entry: any;
  if (Array.isArray(entries)) entry = entries.find((candidate) => candidate?.id === agentId);
  else if (entries && typeof entries === "object") entry = entries[agentId];
  const value = entry?.workspace || (agentId === "main" ? config?.agents?.defaults?.workspace : null);
  return typeof value === "string" && value.trim() ? resolve(value) : null;
}

function activeWorkspace(api: any, runtimeSessionKey: string): ActiveWorkspace | null {
  const agentId = agentIdFromSessionKey(runtimeSessionKey);
  const config = currentConfig(api);
  if (!agentId || !config) return null;
  const workspace = resolveAgentWorkspace(config, agentId);
  if (!workspace) return null;
  let workspaceId: string;
  try { workspaceId = readJson(join(workspace, "engram.json"))?.workspace?.id; }
  catch { return null; }
  if (typeof workspaceId !== "string" || !workspaceId.trim()) return null;
  try {
    const projection = resolveMemoryObservationProjection({ workspace, workspaceId, expectedPluginDigest: PLUGIN_DIGEST });
    return memoryObservationBinding(projection, runtimeSessionKey) ? { workspace, workspaceId, projection } : null;
  } catch { return null; }
}

function classifyMissingBinding(api: any, runtimeSessionKey: string): "revoked" | "unavailable" {
  const agentId = agentIdFromSessionKey(runtimeSessionKey);
  const config = currentConfig(api);
  if (!agentId || !config) return "unavailable";
  const workspace = resolveAgentWorkspace(config, agentId);
  if (!workspace) return "unavailable";
  let workspaceId: string;
  try { workspaceId = readJson(join(workspace, "engram.json"))?.workspace?.id; }
  catch { return "unavailable"; }
  if (typeof workspaceId !== "string" || !workspaceId.trim()) return "unavailable";
  const projectionPath = join(workspace, "memory-state", "memory-observation", "projection.json");
  if (!existsSync(projectionPath)) return "revoked";
  let raw: any;
  try { raw = readJson(projectionPath); }
  catch { return "unavailable"; }
  if (raw?.enabled === false) return "revoked";
  try {
    const projection = resolveMemoryObservationProjection({ workspace, workspaceId, expectedPluginDigest: PLUGIN_DIGEST });
    return memoryObservationBinding(projection, runtimeSessionKey) ? "unavailable" : "revoked";
  } catch { return "unavailable"; }
}

function ledgerFor(
  active: ActiveWorkspace,
  projection: MemoryObservationProjectionV1,
  runtimeSessionKey: string,
): MemoryObservationLedger {
  return new MemoryObservationLedger({
    workspace: active.workspace,
    workspaceId: active.workspaceId,
    exactSessionKeys: [runtimeSessionKey],
    producerRegistry: RUNTIME_REGISTRY,
    authorityPolicy: RUNTIME_POLICY,
    limits: {
      evidenceTtlMs: projection.limits.evidenceTtlHours * 60 * 60 * 1_000,
      maxJobs: projection.limits.maxJobs,
      maxBytes: projection.limits.maxBytes,
      maxQueueAgeMs: projection.limits.maxQueueAgeHours * 60 * 60 * 1_000,
      maxAttempts: projection.limits.maxAttempts,
      claimTtlMs: projection.limits.claimTtlSeconds * 1_000,
      maxInferenceCalls: projection.limits.maxInferenceCalls,
    },
    evaluatorEnabled: projection.limits.maxInferenceCalls === 1,
    ...(projection.limits.maxInferenceCalls === 1
      ? { evaluationStartedAt: projection.inference.evaluateAfter }
      : {}),
  });
}

function bindingFor(api: any, active: ActiveWorkspace, runtimeSessionKey: string): RuntimeObservationBinding | null {
  let projection: MemoryObservationProjectionV1;
  try {
    projection = resolveMemoryObservationProjection({
      workspace: active.workspace,
      workspaceId: active.workspaceId,
      expectedPluginDigest: PLUGIN_DIGEST,
    });
  } catch { return null; }
  const binding = memoryObservationBinding(projection, runtimeSessionKey);
  if (!binding) return null;
  const ledger = ledgerFor(active, projection, runtimeSessionKey);
  const replyContext = new ReplyContextStore({
    workspace: active.workspace,
    workspaceId: active.workspaceId,
    exactSessionKeys: [runtimeSessionKey],
  });
  const scope = {
    workspaceId: active.workspaceId,
    runtimeSessionKey,
    scopeClass: binding.scopeClass,
    scopeId: binding.scopeId,
  } as const;
  return {
    workspaceId: active.workspaceId,
    scopeClass: binding.scopeClass,
    scopeId: binding.scopeId,
    requireOwner: binding.requireOwner,
    allowedChannels: binding.allowedChannels,
    resolveReplyContext: (params) => replyContext.resolve(params),
    recordTransportLink: (params) => replyContext.record({
      scope: params.scope,
      channel: params.channel,
      transportMessageId: params.messageId,
      messageRole: params.messageRole,
      sourceTurnId: params.sourceTurnId,
      ...(params.parentMessageId ? { parentTransportMessageId: params.parentMessageId } : {}),
    }),
    admit: (source, completedAt, transport) => {
      ledger.purgeExpiredEvidence(completedAt);
      replyContext.purgeExpired(completedAt);
      const result = ledger.admit(source, completedAt);
      try {
        replyContext.record({
          scope,
          channel: transport.channel,
          transportMessageId: transport.inboundMessageId,
          messageRole: "user",
          sourceTurnId: source.sourceTurnId,
          ...(transport.parentMessageId ? { parentTransportMessageId: transport.parentMessageId } : {}),
        });
        if (transport.deliveryMessageId) {
          replyContext.record({
            scope,
            channel: transport.channel,
            transportMessageId: transport.deliveryMessageId,
            messageRole: "assistant",
            sourceTurnId: source.sourceTurnId,
            ...(transport.parentMessageId ? { parentTransportMessageId: transport.parentMessageId } : {}),
          });
        }
        if (memoryObservationEvaluationMode(projection) === "immediate"
          && projection.limits.maxInferenceCalls === 1) {
          wakeEpisodicEvaluation(api, runtimeSessionKey);
        }
      } catch {
        api.logger.warn?.("engram-memory-observation: post-admission side effect failed; durable admission retained");
      }
      return result;
    },
  };
}

function adapterFor(api: any, runtimeSessionKey: string): OpenClawObservationRuntimeAdapter | null {
  const active = activeWorkspace(api, runtimeSessionKey);
  if (!active) return null;
  const key = `${active.workspaceId}\0${active.workspace}`;
  let adapter = adapters.get(key);
  if (!adapter) {
    adapter = new OpenClawObservationRuntimeAdapter({
      authority: RUNTIME_AUTHORITY,
      resolveBinding: (key) => bindingFor(api, active, key),
      classifyMissingBinding: (key) => classifyMissingBinding(api, key),
      spoolRoot: join(active.workspace, "memory-state", "memory-observation", "v1", "pre-admission"),
      workspace: active.workspace,
    });
    adapters.set(key, adapter);
  }
  return adapter;
}

function reconcileConfiguredSpools(api: any, mode: "startup" | "periodic"): void {
  const runtimeSessionKeys = new Set<string>();
  for (const workspace of configuredWorkspaces(api)) {
    const checkpointScan = new AdmissionStore(workspace, RUNTIME_AUTHORITY).scanCheckpoints();
    for (const checkpoint of checkpointScan.records) runtimeSessionKeys.add(checkpoint.scope.runtimeSessionKey);
    if (checkpointScan.corrupt.length > 0) {
      api.logger.warn?.(`engram-memory-observation: ${checkpointScan.corrupt.length} admission checkpoint record(s) failed validation`);
    }
    const directory = join(workspace, "memory-state", "memory-observation", "v1", "pre-admission");
    if (!existsSync(directory)) continue;
    for (const name of readdirSync(directory).filter((entry) => /^[a-f0-9]{64}\.json$/.test(entry))) {
      try {
        const runtimeSessionKey = readJson(join(directory, name))?.runtimeSessionKey;
        if (typeof runtimeSessionKey === "string" && runtimeSessionKey) runtimeSessionKeys.add(runtimeSessionKey);
      } catch (error) {
        api.logger.warn?.(`engram-memory-observation: admission spool scan failed ${String(error)}`);
      }
    }
  }
  for (const runtimeSessionKey of runtimeSessionKeys) {
    try {
      const active = activeWorkspace(api, runtimeSessionKey);
      const adapter = adapterFor(api, runtimeSessionKey) ?? (active ? null : (() => {
        const agentId = agentIdFromSessionKey(runtimeSessionKey);
        const workspace = agentId ? resolveAgentWorkspace(currentConfig(api), agentId) : null;
        return workspace ? new OpenClawObservationRuntimeAdapter({
          authority: RUNTIME_AUTHORITY,
          resolveBinding: (key) => {
            const candidate = activeWorkspace(api, key);
            return candidate ? bindingFor(api, candidate, key) : null;
          },
          classifyMissingBinding: (key) => classifyMissingBinding(api, key),
          spoolRoot: join(workspace, "memory-state", "memory-observation", "v1", "pre-admission"),
          workspace,
        }) : null;
      })());
      if (!adapter) continue;
      const corruptSpoolCount = adapter.scanSpool().corrupt.length;
      if (corruptSpoolCount > 0) {
        api.logger.warn?.(`engram-memory-observation: ${corruptSpoolCount} admission spool record(s) failed validation`);
      }
      const completed = adapter.reconcileCompleted();
      const checkpoints = adapter.reconcileOrphanedCheckpoints(new Date(), mode);
      if (Object.values(completed).some((count) => count > 0) || Object.values(checkpoints).some((count) => count > 0)) {
        api.logger.info?.(`engram-memory-observation: admission reconciliation ${JSON.stringify({ completed, checkpoints })}`);
      }
    } catch (error) {
      api.logger.warn?.(`engram-memory-observation: admission reconciliation failed ${String(error)}`);
    }
  }
}

function runLifecycleMaintenance(api: any, mode: "startup" | "periodic"): void {
  reconcileConfiguredSpools(api, mode);
  purgeConfiguredWorkspaces(api);
}

function supportedChannel(event: any, context: any): "telegram" | "openclaw" | null {
  for (const value of [event?.channel, context?.channel, context?.messageProvider, context?.channelId]) {
    if (value === "telegram" || value === "openclaw") return value;
  }
  return null;
}

function safe(api: any, stage: string, operation: () => unknown): void {
  try {
    const result = operation() as any;
    if (result?.status === "admitted") api.logger.info?.(`engram-memory-observation: admitted ${result.sourceTurnId}`);
    else api.logger.debug?.(`engram-memory-observation: ${stage} ${result?.status ?? "ignored"}`);
  } catch (error) {
    const diagnostic = observationRuntimeAdapterError(error);
    api.logger.debug?.(`engram-memory-observation: ${stage} fail-closed ${diagnostic.code}: ${diagnostic.message}`);
  }
}

function evaluatorRunnerKey(active: ActiveWorkspace, runtimeSessionKey: string): string {
  return `${active.workspaceId}\0${active.workspace}\0${runtimeSessionKey}`;
}

function currentEvaluatorState(api: any, runtimeSessionKey: string): {
  active: ActiveWorkspace;
  projection: MemoryObservationProjectionV1;
  ledger: MemoryObservationLedger;
} | null {
  const active = activeWorkspace(api, runtimeSessionKey);
  if (!active || memoryObservationEvaluationMode(active.projection) !== "immediate"
    || active.projection.limits.maxInferenceCalls !== 1) return null;
  assertInferenceBoundary(api, runtimeSessionKey, active.projection);
  return { active, projection: active.projection, ledger: ledgerFor(active, active.projection, runtimeSessionKey) };
}

function currentDailyNotePolicy(api: any, runtimeSessionKey: string): {
  active: ActiveWorkspace;
  policy: DailyNoteCanaryPolicy;
} | null {
  const active = activeWorkspace(api, runtimeSessionKey);
  if (!active) return null;
  const dailyNote = memoryObservationDailyNoteCanary(active.projection);
  const binding = memoryObservationBinding(active.projection, runtimeSessionKey);
  if (!dailyNote || !binding || active.projection.bindings.length !== 1) return null;
  const exactScope = {
    workspaceId: active.workspaceId,
    runtimeSessionKey,
    scopeClass: binding.scopeClass,
    scopeId: binding.scopeId,
  } as const;
  return {
    active,
    policy: buildDailyNoteCanaryPolicy({
      workspaceId: active.workspaceId,
      exactScope,
      applyAfter: dailyNote.applyAfter,
      timezone: dailyNote.timezone,
      allowedObservationClasses: dailyNote.allowedObservationClasses,
      maxAppliesPerWake: dailyNote.maxAppliesPerWake,
      ...(active.projection.evaluation?.mode === "batch-cron"
        ? { allowedBatchEvaluationPolicyDigest: active.projection.evaluation.policyDigest }
        : {}),
      ...(dailyNote.qmdBinding ? { qmdBinding: dailyNote.qmdBinding } : {}),
    }),
  };
}

function runnerFor(api: any, runtimeSessionKey: string): AutonomousEpisodicRunner | null {
  const initial = currentEvaluatorState(api, runtimeSessionKey);
  if (!initial) return null;
  const key = evaluatorRunnerKey(initial.active, runtimeSessionKey);
  let runner = evaluatorRunners.get(key);
  if (runner) return runner;
  runner = new AutonomousEpisodicRunner({
    isActive: () => {
      try { return currentEvaluatorState(api, runtimeSessionKey) !== null; }
      catch { return false; }
    },
    processOne: async () => {
      const current = currentEvaluatorState(api, runtimeSessionKey);
      if (!current) return { status: "idle" };
      const evaluator = new EpisodicShadowEvaluator({
        ledger: current.ledger,
        producer: EVALUATOR_AUTHORITY,
        leaseTtlMs: current.projection.limits.claimTtlSeconds * 1_000,
        complete: async (request) => {
          assertInferenceBoundary(api, runtimeSessionKey, current.projection);
          const result = await api.runtime.llm.complete({
            messages: [
              { role: "system", content: request.system },
              { role: "user", content: request.prompt },
            ],
            model: current.projection.inference.model,
            maxTokens: request.maxTokens,
            temperature: request.temperature,
            purpose: "engram-memory-observation-episodic-shadow",
          });
          assertResolvedInferenceModel(current.projection.inference.model, result);
          return result.text;
        },
      });
      const result = await evaluator.processOne();
      if (result.status === "written" || result.status === "resumed") wakeDailyNoteCanary(api, runtimeSessionKey);
      return result;
    },
    nextDueAt: () => currentEvaluatorState(api, runtimeSessionKey)?.ledger.nextEvaluationAt() ?? null,
    onResult: (result) => api.logger.info?.(`engram-memory-observation: evaluator ${result.status}`),
    onError: (error) => api.logger.warn?.(`engram-memory-observation: evaluator failed ${String(error)}`),
  });
  evaluatorRunners.set(key, runner);
  return runner;
}

function dailyNoteRunnerFor(api: any, runtimeSessionKey: string): AutonomousDailyNoteCanaryRunner | null {
  const initial = currentDailyNotePolicy(api, runtimeSessionKey);
  if (!initial) return null;
  const key = evaluatorRunnerKey(initial.active, runtimeSessionKey);
  let runner = dailyNoteRunners.get(key);
  if (runner) return runner;
  const applicator = new DailyNoteCanaryApplicator({
    workspace: initial.active.workspace,
    resolveActivePolicy: () => currentDailyNotePolicy(api, runtimeSessionKey)?.policy ?? null,
  });
  runner = new AutonomousDailyNoteCanaryRunner({
    isActive: () => currentDailyNotePolicy(api, runtimeSessionKey) !== null,
    processOne: async () => applicator.processOne(),
    nextDueAt: () => applicator.nextDueAt(),
    batchLimit: initial.policy.maxAppliesPerWake,
    onResult: (result) => api.logger.info?.(`engram-memory-observation: daily-note canary ${result.status}`),
    onError: (error) => api.logger.warn?.(`engram-memory-observation: daily-note canary failed ${String(error)}`),
  });
  dailyNoteRunners.set(key, runner);
  return runner;
}

function wakeEpisodicEvaluation(api: any, runtimeSessionKey: string): void {
  try { runnerFor(api, runtimeSessionKey)?.wake(); }
  catch (error) { api.logger.warn?.(`engram-memory-observation: evaluator boundary failed ${String(error)}`); }
}

function wakeDailyNoteCanary(api: any, runtimeSessionKey: string): void {
  try { dailyNoteRunnerFor(api, runtimeSessionKey)?.wake(); }
  catch (error) { api.logger.warn?.(`engram-memory-observation: daily-note boundary failed ${String(error)}`); }
}

function activeSessionKeys(api: any): string[] {
  const config = currentConfig(api);
  const agentIds = configuredMemoryAgentIds(config);
  const sessionKeys = new Set<string>();
  for (const agentId of agentIds) {
    const workspace = resolveAgentWorkspace(config, agentId);
    if (!workspace) continue;
    let workspaceId: string;
    try { workspaceId = readJson(join(workspace, "engram.json"))?.workspace?.id; }
    catch { continue; }
    if (typeof workspaceId !== "string" || !workspaceId.trim()) continue;
    try {
      const projection = resolveMemoryObservationProjection({ workspace, workspaceId, expectedPluginDigest: PLUGIN_DIGEST });
      for (const binding of projection.bindings) {
        if (!binding.runtimeSessionKey.endsWith(":*")) sessionKeys.add(binding.runtimeSessionKey);
      }
    } catch { /* disabled, stale, or unrelated workspace */ }
  }
  return [...sessionKeys];
}

function configuredWorkspaces(api: any): string[] {
  const config = currentConfig(api);
  const agentIds = configuredMemoryAgentIds(config);
  const workspaces = new Set<string>();
  for (const agentId of agentIds) {
    const workspace = resolveAgentWorkspace(config, agentId);
    if (workspace) workspaces.add(workspace);
  }
  return [...workspaces];
}

function purgeConfiguredWorkspaces(api: any): void {
  for (const workspace of configuredWorkspaces(api)) {
    try {
      const result = purgeMemoryObservationLifecycle(workspace);
      if (Object.values(result).some((count) => count > 0)) api.logger.info?.(`engram-memory-observation: lifecycle purge ${JSON.stringify(result)}`);
    } catch (error) {
      api.logger.warn?.(`engram-memory-observation: lifecycle purge failed ${String(error)}`);
    }
  }
}

export default definePluginEntry({
  id: "engram-memory-observation",
  name: "Engram memory observation",
  description: "Captures trusted turns, evaluates strict episodic candidates, and supports exact-session or bounded agent-family daily-note canaries.",
  register(api: any) {
    api.registerService({
      id: "engram-memory-observation-evaluator",
      start: () => {
        runLifecycleMaintenance(api, "startup");
        if (lifecycleTimer) clearInterval(lifecycleTimer);
        lifecycleTimer = setInterval(() => runLifecycleMaintenance(api, "periodic"), LIFECYCLE_INTERVAL_MS);
        lifecycleTimer.unref?.();
        for (const runtimeSessionKey of activeSessionKeys(api)) {
          wakeEpisodicEvaluation(api, runtimeSessionKey);
          wakeDailyNoteCanary(api, runtimeSessionKey);
        }
      },
      stop: () => {
        if (lifecycleTimer) clearInterval(lifecycleTimer);
        lifecycleTimer = null;
        adapters.clear();
        for (const runner of evaluatorRunners.values()) runner.stop();
        evaluatorRunners.clear();
        for (const runner of dailyNoteRunners.values()) runner.stop();
        dailyNoteRunners.clear();
      },
    });

    api.on("message_received", (event: any, context: any) => {
      safe(api, "message_received", () => {
        const identity = resolveObservationMessageReceivedIdentity(event || {}, context || {});
        const channel = supportedChannel(event, context);
        if (!channel) return { status: "ignored", reason: "unsupported_transport" };
        const adapter = adapterFor(api, identity.runtimeSessionKey);
        if (!adapter) return { status: "ignored", reason: "scope_disabled" };
        return adapter.captureMessageReceived(
          { ...event, sessionKey: identity.runtimeSessionKey, messageId: identity.messageId, senderId: identity.actorId, channel },
          { ...context, sessionKey: identity.runtimeSessionKey, messageId: identity.messageId, senderId: identity.actorId, channelId: channel },
        );
      });
    });

    api.on("before_message_write", (event: any, context: any) => {
      safe(api, "before_message_write", () => {
        const identity = resolveObservationPersistedUserIdentity(event || {}, context || {});
        const adapter = adapterFor(api, identity.runtimeSessionKey);
        if (!adapter) return { status: "ignored", reason: "scope_disabled" };
        return adapter.adoptPersistedUser(
          { ...event, sessionKey: identity.runtimeSessionKey },
          { ...context, sessionKey: identity.runtimeSessionKey },
        );
      });
    });

    const attach = (event: any, context: any) => {
      safe(api, "run_attach", () => {
        const identity = resolveObservationAgentRunIdentity(event || {}, context || {});
        const adapter = adapterFor(api, identity.runtimeSessionKey);
        if (!adapter) return { status: "ignored", reason: "scope_disabled" };
        return adapter.attachRun(event, {
          ...context,
          runId: identity.runId,
          sessionKey: identity.runtimeSessionKey,
        });
      });
    };
    api.on("agent_turn_prepare", attach);
    api.on("before_prompt_build", attach);

    api.on("agent_end", (event: any, context: any) => {
      safe(api, "agent_end", () => {
        const identity = resolveObservationAgentRunIdentity(event || {}, context || {});
        const adapter = adapterFor(api, identity.runtimeSessionKey);
        if (!adapter) return { status: "ignored", reason: "scope_disabled" };
        return adapter.completeAgentEnd(
          { ...event, runId: identity.runId },
          { ...context, runId: identity.runId, sessionKey: identity.runtimeSessionKey },
        );
      });
    });

    api.on("message_sent", (event: any, context: any) => {
      safe(api, "message_sent", () => {
        if (event?.sourceReply?.final !== true) {
          const runtimeSessionKey = typeof event?.sessionKey === "string"
            ? event.sessionKey
            : context?.sessionKey;
          if (typeof runtimeSessionKey !== "string" || !runtimeSessionKey) {
            return { status: "ignored", reason: "session_key_missing" };
          }
          const adapter = adapterFor(api, runtimeSessionKey);
          if (!adapter) return { status: "ignored", reason: "scope_disabled" };
          return adapter.recordMessageSent(event, context);
        }
        const identity = resolveObservationMessageSentIdentity(event || {}, context || {});
        const adapter = adapterFor(api, identity.runtimeSessionKey);
        if (!adapter) return { status: "ignored", reason: "scope_disabled" };
        return adapter.completeMessageSent(
          {
            ...event,
            sessionKey: identity.runtimeSessionKey,
            runId: identity.runId,
            sourceReply: {
              ...event.sourceReply,
              sourceTurnId: identity.sourceTurnId,
              toolCallId: identity.toolCallId,
            },
          },
          {
            ...context,
            sessionKey: identity.runtimeSessionKey,
            runId: identity.runId,
          },
        );
      });
    });
  },
});
