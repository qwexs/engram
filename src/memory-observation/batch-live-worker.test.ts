import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BatchLiveWorker, type BatchLiveFaultPoint, type BatchLivePolicyV1 } from "./batch-live-worker.ts";
import { BATCH_EVALUATOR_AUTHORITY } from "./batch-observation.ts";
import { buildDailyNoteCanaryPolicy, DailyNoteCanaryApplicator } from "./daily-note-applicator.ts";
import {
  MemoryObservationLedger,
  sha256,
  type JsonValue,
  type ObservationScope,
  type ProducerRef,
  type TrustedCompletedTurn,
} from "./ledger.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const RUNTIME: ProducerRef = {
  id: "openclaw-runtime",
  version: "v1",
  digest: `sha256:${"1".repeat(64)}`,
};
const SINGLE: ProducerRef = {
  id: "post-turn-observer",
  version: "v1",
  digest: "sha256:d4f0bf349ea08594fbd3a72f1e6f05ea5dda32800422c1e2cefbc434552cd406",
};
const REGISTRY = {
  schema: "engram.memory-producer-registry.v1",
  producers: [
    { ...RUNTIME, authorityClass: "runtime", artifactSchemas: ["engram.memory-observation-job.v1"], observationClasses: [] },
    { ...SINGLE, authorityClass: "evaluator", artifactSchemas: ["engram.memory-observation.v1"], observationClasses: ["episodic.event", "episodic.decision"] },
  ],
};
const AUTHORITY = {
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
const SCOPE: ObservationScope = {
  workspaceId: "main",
  runtimeSessionKey: "agent:main:telegram:direct:100000001",
  scopeClass: "self",
  scopeId: "telegram:100000001",
};

function batchAuthorityContracts() {
  return {
    producerRegistry: {
      schema: "engram.memory-producer-registry.v1",
      registryVersion: 1,
      producers: [{
        ...BATCH_EVALUATOR_AUTHORITY,
        authorityClass: "evaluator",
        artifactSchemas: ["engram.memory-batch-observation.v1", "engram.memory-trace-event.v1"],
        observationClasses: ["episodic.event", "episodic.decision"],
      }],
    },
    authorityPolicy: {
      schema: "engram.memory-authority-policy.v1",
      policyVersion: "memory-observation-authority-v1",
      defaultDecision: "deny",
      replayReauthorizationRequired: true,
      rules: [{
        artifactSchema: "engram.memory-batch-observation.v1",
        stage: "advisory-batch-evaluation",
        allowedAuthorityClasses: ["evaluator"],
        allowedProducerIds: ["batch-post-turn-observer"],
        requiredTrustedInputs: ["immutable-batch-bundle", "full-source-coverage", "exact-scoped-citations", "batch-evaluation-policy"],
      }, {
        artifactSchema: "engram.memory-trace-event.v1",
        stage: "trace-append",
        allowedAuthorityClasses: ["evaluator"],
        allowedProducerIds: ["batch-post-turn-observer"],
        requiredTrustedInputs: ["stage-specific-authority", "trace-id", "policy-digest"],
      }],
    },
  };
}

function setup() {
  const workspace = mkdtempSync(join(tmpdir(), "batch-live-worker-"));
  roots.push(workspace);
  const ledger = new MemoryObservationLedger({
    workspace,
    workspaceId: "main",
    exactSessionKeys: [SCOPE.runtimeSessionKey],
    producerRegistry: REGISTRY,
    authorityPolicy: AUTHORITY,
    limits: {
      evidenceTtlMs: 72 * 60 * 60 * 1_000,
      maxJobs: 100,
      maxBytes: 10_000_000,
      maxQueueAgeMs: 7 * 24 * 60 * 60 * 1_000,
      maxAttempts: 2,
      claimTtlMs: 300_000,
      maxInferenceCalls: 1,
    },
    evaluatorEnabled: true,
    evaluationStartedAt: "2026-08-31T20:00:00.000Z",
  });
  const policy: BatchLivePolicyV1 = {
    workspaceId: "main",
    exactScope: SCOPE,
    producerEpoch: "v1",
    sourcePolicyDigest: sha256(AUTHORITY as unknown as JsonValue),
    evaluationPolicyDigest: `sha256:${"9".repeat(64)}`,
    inactivityGapMs: 300_000,
    maxTurns: 8,
    maxEvidenceBytes: 262_144,
    flushMaxAgeMs: 900_000,
    evidenceTtlMs: 72 * 60 * 60 * 1_000,
    deferDelayMs: 300_000,
    maxInferenceCallsPerRun: 1,
    runner: {
      schema: "engram.memory-batch-shadow-runner-config.v2",
      requestedModel: "openai/gpt-5.6-terra",
      maxTokens: 8_192,
      temperature: 0,
      messageMode: "single-user",
    },
  };
  return { workspace, ledger, policy };
}

function admit(ledger: MemoryObservationLedger, index: number, completedAt: string): void {
  const sourceTurnId = `channel-user:v1:${index.toString(16).padStart(64, "0")}`;
  const source: TrustedCompletedTurn = {
    sourceTurnId,
    scope: SCOPE,
    sourceCompletedAt: completedAt,
    authority: RUNTIME,
    evidenceRefs: [{ kind: "source-turn", ref: sourceTurnId, digest: sha256(`evidence-${index}`) }],
    redactedEvidence: {
      source: { role: "user", text: `request-${index}` },
      outcome: { role: "assistant", text: `completed-${index}` },
    },
    trustedInputs: ["completed-source-turn", "runtime-session-key", "workspace-binding", "source-completion-time"],
  };
  ledger.admit(source, new Date(completedAt));
}

describe("durable live micro-batch worker", () => {
  test("re-authorizes pending jobs against current observation and terminal-trace policy", async () => {
    for (const artifactSchema of ["engram.memory-batch-observation.v1", "engram.memory-trace-event.v1"]) {
      const { workspace, ledger, policy } = setup();
      admit(ledger, roots.length + 50, "2026-08-31T20:01:00.000Z");
      let contracts: any = batchAuthorityContracts();
      let calls = 0;
      const complete = async () => { calls++; throw new Error("provider must not run after revoke"); };
      let injected = false;
      const failing = new BatchLiveWorker({
        workspace, ledger, policy, storeRoot: join(workspace, "state"), complete,
        now: () => new Date("2026-08-31T20:20:00.000Z"), resolveAuthorityContracts: () => contracts,
        fault: (point) => { if (!injected && point === "after_job") { injected = true; throw new Error("fault:after_job"); } },
      });
      await expect(failing.processOne()).rejects.toThrow("fault:after_job");
      contracts = structuredClone(contracts);
      contracts.authorityPolicy.rules.find((rule: any) => rule.artifactSchema === artifactSchema).allowedProducerIds = [];
      const resumed = new BatchLiveWorker({
        workspace, ledger, policy, storeRoot: join(workspace, "state"), complete,
        now: () => new Date("2026-08-31T20:20:00.000Z"), resolveAuthorityContracts: () => contracts,
      });
      await expect(resumed.processOne()).rejects.toMatchObject({ code: "AUTHORITY_DENIED" });
      expect(calls).toBe(0);
      expect(existsSync(join(workspace, "memory-state", "memory-observation", "v1", "observations", "batch"))).toBe(false);
    }
  });
  test("evaluates two turns once, applies one multi-source observation, and resumes without another model call", async () => {
    const { workspace, ledger, policy } = setup();
    admit(ledger, 1, "2026-08-31T20:01:00.000Z");
    admit(ledger, 2, "2026-08-31T20:02:00.000Z");
    let calls = 0;
    let current = new Date("2026-08-31T20:20:00.000Z");
    const now = () => current;
    const complete = async (request: any) => {
      calls++;
      const prompt = JSON.parse(request.prompt);
      const sources = prompt.task.sources;
      return {
        resolvedModel: "openai/gpt-5.6-terra",
        output: JSON.stringify({
          schema: "engram.memory-batch-shadow-output.v1",
          groups: [{
            groupId: "case-1",
            decision: "write",
            sourceRefs: sources.map((entry: any) => entry.sourceRef.traceId),
            assertions: [{
              section: "events",
              text: "Пакетная работа завершена.",
              actorRef: "assistant",
              outcomeStatus: "completed",
              confidence: 0.99,
              reasonCodes: ["verified_outcome"],
              citations: sources.map((entry: any) => ({
                traceId: entry.sourceRef.traceId,
                evidenceRef: entry.evidenceRefs[0],
              })),
            }],
          }],
        }),
      };
    };
    const worker = new BatchLiveWorker({ workspace, ledger, policy, storeRoot: join(workspace, "state"), complete, now });
    const first = await worker.processOne();
    expect(first.status).toBe("completed");
    expect(calls).toBe(1);
    expect(ledger.peekDueEvaluationEvidence(now())).toHaveLength(0);
    const observations = readdirSync(join(workspace, "memory-state", "memory-observation", "v1", "observations", "batch"));
    expect(observations).toHaveLength(1);

    const applicator = new DailyNoteCanaryApplicator({
      workspace,
      resolveActivePolicy: () => buildDailyNoteCanaryPolicy({
        workspaceId: "main",
        exactScope: SCOPE,
        applyAfter: "2026-08-31T20:00:00.000Z",
        timezone: "UTC",
        allowedObservationClasses: ["episodic.event", "episodic.decision"],
        maxAppliesPerWake: 1,
        allowedBatchEvaluationPolicyDigest: policy.evaluationPolicyDigest,
      }),
    });
    expect((await applicator.processOne(now())).status).toBe("applied");
    const note = join(workspace, "memory", "agent-main", "telegram-direct-100000001", "2026-08-31.md");
    expect(readFileSync(note, "utf8")).toContain("Пакетная работа завершена.");

    const done = join(workspace, "state", "memory-batch-live", "v1", "done");
    rmSync(join(done, readdirSync(done)[0]!));
    const resumed = await worker.processOne();
    expect(resumed.status).toBe("duplicate");
    expect(calls).toBe(1);
    expect(readFileSync(note, "utf8").match(/Пакетная работа завершена\./g)).toHaveLength(1);
  });

  test("materializes each distinct assertion from one bounded write group exactly once", async () => {
    const { workspace, ledger, policy } = setup();
    admit(ledger, 30, "2026-08-31T20:01:00.000Z");
    const now = () => new Date("2026-08-31T20:20:00.000Z");
    let calls = 0;
    const complete = async (request: any) => {
      calls++;
      const source = JSON.parse(request.prompt).task.sources[0];
      const citation = [{ traceId: source.sourceRef.traceId, evidenceRef: source.evidenceRefs[0] }];
      return {
        resolvedModel: "openai/gpt-5.6-terra",
        output: JSON.stringify({
          schema: "engram.memory-batch-shadow-output.v1",
          groups: [{
            groupId: "multi-assertion-case",
            decision: "write",
            sourceRefs: [source.sourceRef.traceId],
            assertions: [{
              section: "decisions",
              text: "Bounded multi-assertion contract approved.",
              actorRef: "user",
              outcomeStatus: "decided",
              confidence: 1,
              reasonCodes: ["explicit_decision"],
              citations: citation,
            }, {
              section: "events",
              text: "Rollback verification passed.",
              actorRef: "assistant",
              outcomeStatus: "completed",
              confidence: 0.99,
              reasonCodes: ["verified_outcome"],
              citations: citation,
            }, {
              section: "events",
              text: "Canary was restored.",
              actorRef: "assistant",
              outcomeStatus: "completed",
              confidence: 0.99,
              reasonCodes: ["verified_outcome"],
              citations: citation,
            }],
          }],
        }),
      };
    };
    const worker = new BatchLiveWorker({ workspace, ledger, policy, storeRoot: join(workspace, "state"), complete, now });
    const first = await worker.processOne();
    expect(first).toMatchObject({ status: "completed", observationCount: 3, sourceCount: 1 });
    expect(calls).toBe(1);

    const observationDirectory = join(workspace, "memory-state", "memory-observation", "v1", "observations", "batch");
    expect(readdirSync(observationDirectory)).toHaveLength(3);
    const applicator = new DailyNoteCanaryApplicator({
      workspace,
      resolveActivePolicy: () => buildDailyNoteCanaryPolicy({
        workspaceId: "main",
        exactScope: SCOPE,
        applyAfter: "2026-08-31T20:00:00.000Z",
        timezone: "UTC",
        allowedObservationClasses: ["episodic.event", "episodic.decision"],
        maxAppliesPerWake: 1,
        allowedBatchEvaluationPolicyDigest: policy.evaluationPolicyDigest,
      }),
    });
    expect([(await applicator.processOne(now())).status, (await applicator.processOne(now())).status, (await applicator.processOne(now())).status]).toEqual([
      "applied", "applied", "applied",
    ]);
    expect((await applicator.processOne(now())).status).toBe("idle");
    const note = join(workspace, "memory", "agent-main", "telegram-direct-100000001", "2026-08-31.md");
    for (const text of [
      "Bounded multi-assertion contract approved.",
      "Rollback verification passed.",
      "Canary was restored.",
    ]) {
      expect(readFileSync(note, "utf8").match(new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))).toHaveLength(1);
    }

    const done = join(workspace, "state", "memory-batch-live", "v1", "done");
    rmSync(join(done, readdirSync(done)[0]!));
    expect((await worker.processOne()).status).toBe("duplicate");
    expect(calls).toBe(1);
    expect(readdirSync(observationDirectory)).toHaveLength(3);
  });

  test("keeps semantic defer ordered, retry-neutral, and terminal on unchanged reconsideration", async () => {
    const { workspace, ledger, policy } = setup();
    admit(ledger, 3, "2026-08-31T20:01:00.000Z");
    admit(ledger, 4, "2026-08-31T20:02:00.000Z");
    let current = new Date("2026-08-31T20:20:00.000Z");
    const now = () => current;
    const worker = new BatchLiveWorker({
      workspace,
      ledger,
      policy,
      storeRoot: join(workspace, "state"),
      now,
      complete: async (request: any) => {
        const prompt = JSON.parse(request.prompt);
        return {
          resolvedModel: "openai/gpt-5.6-terra",
          output: JSON.stringify({
            schema: "engram.memory-batch-shadow-output.v1",
            groups: [{
              groupId: "case-defer",
              decision: "defer",
              sourceRefs: prompt.task.sources.map((entry: any) => entry.sourceRef.traceId),
              reason: "awaiting_continuation",
            }],
          }),
        };
      },
    });
    const result = await worker.processOne();
    expect(result.status).toBe("completed");
    expect(result.deferredCount).toBe(2);
    expect(ledger.peekDueEvaluationEvidence(now())).toHaveLength(0);
    expect(existsSync(join(workspace, "memory-state", "memory-observation", "v1", "observations", "batch"))).toBe(false);
    current = new Date("2026-08-31T20:26:00.000Z");
    expect((await worker.processOne()).status).toBe("duplicate");
    const queueDirectory = join(ledger.root, "queues", "evaluator");
    const queue = readdirSync(queueDirectory).map((name) => JSON.parse(readFileSync(join(queueDirectory, name), "utf8")));
    expect(queue.map((record) => [record.status, record.attempt, record.reasonCode])).toEqual([
      ["terminal", 1, "semantic_batch_defer"],
      ["terminal", 1, "semantic_batch_defer"],
    ]);
    expect(ledger.peekDueEvaluationEvidence(now())).toHaveLength(0);
    expect(queue.flatMap((record) => ledger.readTrace(record.traceId))
      .filter((entry) => entry.stage === "batch_evaluation_terminal")).toHaveLength(2);
  });

  test("drains a fresh successor cohort after one bounded deferred replay", async () => {
    const { workspace, ledger, policy } = setup();
    admit(ledger, 40, "2026-08-31T20:01:00.000Z");
    admit(ledger, 41, "2026-08-31T20:02:00.000Z");
    let current = new Date("2026-08-31T20:20:00.000Z");
    const now = () => current;
    let calls = 0;
    const worker = new BatchLiveWorker({
      workspace,
      ledger,
      policy,
      storeRoot: join(workspace, "state"),
      now,
      complete: async (request: any) => {
        calls++;
        const sources = JSON.parse(request.prompt).task.sources;
        if (calls === 1) {
          return {
            resolvedModel: "openai/gpt-5.6-terra",
            output: JSON.stringify({
              schema: "engram.memory-batch-shadow-output.v1",
              groups: [{
                groupId: "deferred-case",
                decision: "defer",
                sourceRefs: sources.map((entry: any) => entry.sourceRef.traceId),
                reason: "awaiting_continuation",
              }],
            }),
          };
        }
        return {
          resolvedModel: "openai/gpt-5.6-terra",
          output: JSON.stringify({
            schema: "engram.memory-batch-shadow-output.v1",
            groups: [{
              groupId: "successor-case",
              decision: "skip",
              sourceRefs: sources.map((entry: any) => entry.sourceRef.traceId),
              reason: "social_noise",
            }],
          }),
        };
      },
    });
    expect((await worker.processOne()).status).toBe("completed");
    admit(ledger, 42, "2026-08-31T20:21:00.000Z");

    current = new Date("2026-08-31T20:26:00.000Z");
    expect((await worker.processOne()).status).toBe("duplicate");
    expect(calls).toBe(1);

    current = new Date("2026-08-31T20:40:00.000Z");
    expect((await worker.processOne()).status).toBe("completed");
    expect(calls).toBe(2);
    expect(ledger.peekDueEvaluationEvidence(now())).toHaveLength(0);
  });

  test("does not consume the defer window when resuming before its queue effect", async () => {
    const { workspace, ledger, policy } = setup();
    admit(ledger, 43, "2026-08-31T20:01:00.000Z");
    let current = new Date("2026-08-31T20:20:00.000Z");
    const now = () => current;
    let calls = 0;
    const complete = async (request: any) => {
      calls++;
      const sources = JSON.parse(request.prompt).task.sources;
      return {
        resolvedModel: "openai/gpt-5.6-terra",
        output: JSON.stringify({
          schema: "engram.memory-batch-shadow-output.v1",
          groups: [{
            groupId: "defer-crash-case",
            decision: "defer",
            sourceRefs: sources.map((entry: any) => entry.sourceRef.traceId),
            reason: "awaiting_continuation",
          }],
        }),
      };
    };
    let injected = false;
    const failing = new BatchLiveWorker({
      workspace, ledger, policy, storeRoot: join(workspace, "state"), complete, now,
      fault: (point) => { if (!injected && point === "after_terminal") { injected = true; throw new Error("fault:after_terminal"); } },
    });
    await expect(failing.processOne()).rejects.toThrow("fault:after_terminal");

    const resumed = new BatchLiveWorker({ workspace, ledger, policy, storeRoot: join(workspace, "state"), complete, now });
    expect((await resumed.processOne()).status).toBe("duplicate");
    expect(ledger.listQueue()[0]).toMatchObject({ status: "queued", attempt: 0, reasonCode: "semantic_batch_defer" });
    expect(calls).toBe(1);

    current = new Date("2026-08-31T20:26:00.000Z");
    expect((await resumed.processOne()).status).toBe("duplicate");
    expect(ledger.listQueue()[0]).toMatchObject({ status: "terminal", attempt: 1, reasonCode: "semantic_batch_defer" });
    expect(calls).toBe(1);
  });

  test("names a replayed deferred bundle by the active evaluation policy", async () => {
    const { workspace, ledger, policy } = setup();
    admit(ledger, 31, "2026-08-31T20:01:00.000Z");
    admit(ledger, 32, "2026-08-31T20:02:00.000Z");
    let current = new Date("2026-08-31T20:20:00.000Z");
    const now = () => current;
    const complete = async (request: any) => ({
      resolvedModel: "openai/gpt-5.6-terra",
      output: JSON.stringify({
        schema: "engram.memory-batch-shadow-output.v1",
        groups: [{
          groupId: "policy-bound-defer",
          decision: "defer",
          sourceRefs: JSON.parse(request.prompt).task.sources.map((entry: any) => entry.sourceRef.traceId),
          reason: "awaiting_continuation",
        }],
      }),
    });
    const first = new BatchLiveWorker({ workspace, ledger, policy, storeRoot: join(workspace, "state"), complete, now });
    expect((await first.processOne()).status).toBe("completed");

    current = new Date("2026-08-31T20:26:00.000Z");
    const nextPolicy = { ...policy, evaluationPolicyDigest: `sha256:${"8".repeat(64)}` as const };
    const replay = new BatchLiveWorker({ workspace, ledger, policy: nextPolicy, storeRoot: join(workspace, "state"), complete, now });
    expect((await replay.processOne()).status).toBe("duplicate");
    expect(readdirSync(join(workspace, "state", "memory-batch-live", "v1", "jobs"))).toHaveLength(2);
    expect(readdirSync(join(workspace, "state", "memory-batch-live", "v1", "terminals"))).toHaveLength(2);
    expect(readdirSync(join(workspace, "state", "memory-batch-live", "v1", "done"))).toHaveLength(2);
  });

  test("counts invalid model output as a bounded attempt and seals terminal failure", async () => {
    const { workspace, ledger, policy } = setup();
    admit(ledger, 5, "2026-08-31T20:01:00.000Z");
    admit(ledger, 6, "2026-08-31T20:02:00.000Z");
    let current = new Date("2026-08-31T20:20:00.000Z");
    let calls = 0;
    const worker = new BatchLiveWorker({
      workspace,
      ledger,
      policy,
      storeRoot: join(workspace, "state"),
      now: () => current,
      complete: async () => {
        calls++;
        return {
          resolvedModel: "openai/gpt-5.6-terra",
          output: JSON.stringify({
            schema: "engram.memory-batch-shadow-output.v1",
            groups: { write: [], defer: [], skip: [] },
          }),
        };
      },
    });

    await expect(worker.processOne()).rejects.toMatchObject({ code: "INVALID_OUTPUT" });
    const queueDirectory = join(ledger.root, "queues", "evaluator");
    const firstAttempt = readdirSync(queueDirectory).map((name) => readFileSync(join(queueDirectory, name), "utf8"))
      .map((value) => JSON.parse(value));
    expect(firstAttempt.map((record) => [record.status, record.attempt, record.reasonCode])).toEqual([
      ["queued", 1, "batch_invalid_output"],
      ["queued", 1, "batch_invalid_output"],
    ]);

    current = new Date("2026-08-31T20:21:00.000Z");
    expect(await worker.processOne()).toEqual({ status: "idle", reason: "pending_retry_not_due" });
    expect(calls).toBe(1);

    current = new Date("2026-08-31T20:26:00.000Z");
    await expect(worker.processOne()).rejects.toMatchObject({ code: "INVALID_OUTPUT" });
    const terminal = readdirSync(queueDirectory).map((name) => readFileSync(join(queueDirectory, name), "utf8"))
      .map((value) => JSON.parse(value));
    expect(terminal.map((record) => [record.status, record.attempt, record.reasonCode])).toEqual([
      ["terminal", 2, "batch_invalid_output"],
      ["terminal", 2, "batch_invalid_output"],
    ]);
    expect(calls).toBe(2);
    expect(readdirSync(join(workspace, "state", "memory-batch-live", "v1", "failures"))).toHaveLength(1);
    expect(readdirSync(join(workspace, "state", "memory-batch-live", "v1", "done"))).toHaveLength(1);
    expect((await worker.processOne()).status).toBe("idle");
    expect(calls).toBe(2);
  });

  test("recovers after every durable effect with one model call and terminal source coverage", async () => {
    const points: BatchLiveFaultPoint[] = [
      "after_job", "after_result", "after_observation", "after_terminal", "after_source", "after_done",
    ];
    for (const point of points) {
      const { workspace, ledger, policy } = setup();
      admit(ledger, 10 + roots.length, "2026-08-31T20:01:00.000Z");
      admit(ledger, 20 + roots.length, "2026-08-31T20:02:00.000Z");
      const now = () => new Date("2026-08-31T20:20:00.000Z");
      let calls = 0;
      const complete = async (request: any) => {
        calls++;
        const sources = JSON.parse(request.prompt).task.sources;
        return {
          resolvedModel: "openai/gpt-5.6-terra",
          output: JSON.stringify({
            schema: "engram.memory-batch-shadow-output.v1",
            groups: [{
              groupId: "crash-case",
              decision: "write",
              sourceRefs: sources.map((entry: any) => entry.sourceRef.traceId),
              assertions: [{
                section: "events",
                text: "Crash-safe batch result.",
                actorRef: "assistant",
                outcomeStatus: "completed",
                confidence: 1,
                reasonCodes: ["crash_recovered"],
                citations: sources.map((entry: any) => ({ traceId: entry.sourceRef.traceId, evidenceRef: entry.evidenceRefs[0] })),
              }],
            }],
          }),
        };
      };
      let injected = false;
      const failing = new BatchLiveWorker({
        workspace,
        ledger,
        policy,
        storeRoot: join(workspace, "state"),
        complete,
        now,
        fault: (current) => {
          if (!injected && current === point) { injected = true; throw new Error(`fault:${point}`); }
        },
      });
      await expect(failing.processOne()).rejects.toThrow(`fault:${point}`);
      const resumed = new BatchLiveWorker({ workspace, ledger, policy, storeRoot: join(workspace, "state"), complete, now });
      await resumed.processOne();
      expect(calls).toBe(1);
      expect(ledger.peekDueEvaluationEvidence(now())).toHaveLength(0);
      expect(readdirSync(join(workspace, "memory-state", "memory-observation", "v1", "observations", "batch"))).toHaveLength(1);
    }
  });
});
