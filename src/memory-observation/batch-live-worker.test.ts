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

function admit(ledger: MemoryObservationLedger, index: number, completedAt: string, sourceScope: ObservationScope = SCOPE): void {
  const sourceTurnId = `channel-user:v1:${index.toString(16).padStart(64, "0")}`;
  const source: TrustedCompletedTurn = {
    sourceTurnId,
    scope: sourceScope,
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
  test("group batch materializes separately attributed decisions from two participants into only its topic", async () => {
    const { workspace, policy } = setup();
    const scope: ObservationScope = { workspaceId: "project", runtimeSessionKey: "agent:project:telegram:group:-100123:topic:2",
      scopeClass: "project", scopeId: "domain:project:smm" };
    const groupLedger = new MemoryObservationLedger({ workspace, workspaceId: "project", exactSessionKeys: [scope.runtimeSessionKey],
      producerRegistry: REGISTRY, authorityPolicy: AUTHORITY,
      limits: { evidenceTtlMs: 72 * 3600000, maxJobs: 100, maxBytes: 10000000, maxQueueAgeMs: 7 * 86400000,
        maxAttempts: 2, claimTtlMs: 300000, maxInferenceCalls: 1 }, evaluatorEnabled: true, evaluationStartedAt: "2026-08-31T20:00:00.000Z" });
    for (const [index, actorId] of ["111", "222"].entries()) {
      const sourceTurnId = "channel-user:v1:" + String(index + 1).repeat(64);
      groupLedger.admit({ sourceTurnId, scope, sourceCompletedAt: "2026-08-31T20:0" + (index + 1) + ":00.000Z", authority: RUNTIME,
        evidenceRefs: [{ kind: "source-turn", ref: sourceTurnId, digest: sha256("speaker-" + actorId) }],
        redactedEvidence: { source: { role: "user", actorId, attribution: "speaker-only", text: "Согласовал свой срок." },
          outcome: { role: "assistant", text: "Принято как решение участника." } },
        trustedInputs: ["completed-source-turn", "runtime-session-key", "workspace-binding", "source-completion-time"],
      }, new Date("2026-08-31T20:03:00.000Z"));
    }
    const now = () => new Date("2026-08-31T20:20:00.000Z");
    const groupPolicy = { ...policy, workspaceId: "project", exactScope: scope };
    const worker = new BatchLiveWorker({ workspace, ledger: groupLedger, policy: groupPolicy, storeRoot: join(workspace, "group-state"), now,
      complete: async request => {
        const prompt = JSON.parse(request.prompt);
        expect(prompt.instructions).toContain("exactly ONE actorId");
        return { resolvedModel: "openai/gpt-5.6-terra", output: JSON.stringify({
          schema: "engram.memory-batch-shadow-output.v1",
          groups: prompt.task.sources.map((source: any, index: number) => ({ groupId: "speaker-" + index, decision: "write",
            sourceRefs: [source.sourceRef.traceId], assertions: [{ section: "decisions", text: "Согласовал свой срок.", actorRef: "user",
              outcomeStatus: "decided", confidence: 1, reasonCodes: ["explicit_decision"],
              citations: [{ traceId: source.sourceRef.traceId, evidenceRef: source.evidenceRefs[0] }] }] })),
        }) };
      } });
    expect((await worker.processOne()).status).toBe("completed");
    const applicator = new DailyNoteCanaryApplicator({ workspace, resolveActivePolicy: () => buildDailyNoteCanaryPolicy({
      workspaceId: "project", exactScope: scope, applyAfter: "2026-08-31T20:00:00.000Z", timezone: "UTC",
      allowedObservationClasses: ["episodic.event", "episodic.decision"], maxAppliesPerWake: 1,
      allowedBatchEvaluationPolicyDigest: groupPolicy.evaluationPolicyDigest,
    }) });
    expect((await applicator.processOne(now())).status).toBe("applied");
    expect((await applicator.processOne(now())).status).toBe("applied");
    expect((await applicator.processOne(now())).status).toBe("idle");
    const topicRoot = join(workspace, "memory/agent-project");
    expect(readdirSync(topicRoot)).toEqual(["telegram-group--100123-topic-2"]);
    const text = readFileSync(join(topicRoot, "telegram-group--100123-topic-2/2026-08-31.md"), "utf8");
    expect(text).toContain("Участник Telegram 111 (собственное высказывание)");
    expect(text).toContain("Участник Telegram 222 (собственное высказывание)");
  });
  test("selects pending jobs by exact scope instead of blocking another family session", async () => {
    const { workspace, ledger, policy } = setup();
    const topicScope: ObservationScope = {
      workspaceId: "main",
      runtimeSessionKey: "agent:main:telegram:group:-100123:topic:7",
      scopeClass: "self",
      scopeId: "workspace:main",
    };
    const topicLedger = new MemoryObservationLedger({
      workspace,
      workspaceId: "main",
      exactSessionKeys: [topicScope.runtimeSessionKey],
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
    const topicPolicy = { ...policy, exactScope: topicScope };
    const storeRoot = join(workspace, "state");
    const now = () => new Date("2026-08-31T20:20:00.000Z");
    const complete = async (request: any) => {
      const sources = JSON.parse(request.prompt).task.sources;
      return {
        resolvedModel: "openai/gpt-5.6-terra",
        output: JSON.stringify({
          schema: "engram.memory-batch-shadow-output.v1",
          groups: [{
            groupId: "skip-case",
            decision: "skip",
            sourceRefs: sources.map((entry: any) => entry.sourceRef.traceId),
            reason: "not_durable",
          }],
        }),
      };
    };

    admit(topicLedger, 70, "2026-08-31T20:01:00.000Z", topicScope);
    let stopped = false;
    const topicCreator = new BatchLiveWorker({
      workspace, ledger: topicLedger, policy: topicPolicy, storeRoot, complete, now,
      fault: (point) => { if (!stopped && point === "after_job") { stopped = true; throw new Error("fault:topic-job"); } },
    });
    await expect(topicCreator.processOne()).rejects.toThrow("fault:topic-job");

    admit(ledger, 71, "2026-08-31T20:02:00.000Z");
    const directWorker = new BatchLiveWorker({ workspace, ledger, policy, storeRoot, complete, now });
    expect((await directWorker.processOne()).status).toBe("completed");
    expect((await new BatchLiveWorker({ workspace, ledger: topicLedger, policy: topicPolicy, storeRoot, complete, now }).processOne()).status)
      .toBe("completed");
  });

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
      "request-30",
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

  test("keeps semantic defer queued without repeated inference on unchanged evidence", async () => {
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
    expect(await worker.processOne()).toEqual({ status: "idle", reason: "waiting_context" });
    expect(ledger.listQueue().map(record => [record.status, record.attempt, record.reasonCode])).toEqual([
      ["queued", 0, "semantic_batch_defer"], ["queued", 0, "semantic_batch_defer"],
    ]);
    expect(ledger.peekDueEvaluationEvidence(now())).toHaveLength(2);
  });

  test("reconsiders deferred evidence only with a fresh successor even across inactivity gaps", async () => {
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
    expect(await worker.processOne()).toMatchObject({ status: "completed", sourceCount: 3 });
    expect(calls).toBe(2);
    expect(ledger.peekDueEvaluationEvidence(now())).toHaveLength(0);
    expect((await worker.processOne()).status).toBe("idle");
    expect(calls).toBe(2);
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
    expect(await resumed.processOne()).toEqual({ status: "idle", reason: "waiting_context" });
    expect(ledger.listQueue()[0]).toMatchObject({ status: "queued", attempt: 0, reasonCode: "semantic_batch_defer" });
    expect(calls).toBe(1);
  });

  test("does not wake an unchanged deferred bundle merely because policy changed", async () => {
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
    expect(await replay.processOne()).toEqual({ status: "idle", reason: "waiting_context" });
    expect(readdirSync(join(workspace, "state", "memory-batch-live", "v1", "jobs"))).toHaveLength(1);
    expect(ledger.listQueue().every(record => record.status === "queued")).toBe(true);
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

    expect(await worker.processOne()).toMatchObject({
      status: "retry",
      sourceCount: 2,
      reason: "batch_invalid_output",
      attempt: 1,
      maxAttempts: 2,
    });
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
    expect(await worker.processOne()).toMatchObject({
      status: "terminal_failure",
      sourceCount: 2,
      reason: "batch_invalid_output",
      attempt: 2,
      maxAttempts: 2,
    });
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

// Unequal budgets arise after invalid output, successful defer, and fresh evidence.
async function mixedAttemptScenario(options: { legacy?: boolean; crash?: boolean; write?: boolean } = {}) {
  const { workspace, ledger, policy } = setup();
  admit(ledger, 901, "2026-08-31T20:01:00.000Z");
  admit(ledger, 902, "2026-08-31T20:02:00.000Z");
  let current = new Date("2026-08-31T20:20:00.000Z"), calls = 0, crash = options.crash;
  const worker = new BatchLiveWorker({ workspace, ledger, policy, storeRoot: join(workspace, "state"), now: () => current,
    fault: point => { if (crash && point === "after_reconciliation") { crash = false; throw new Error("reconciliation crash"); } },
    complete: async request => {
      calls++;
      const sources = JSON.parse(request.prompt).task.sources;
      const refs = sources.map((source: any) => source.sourceRef.traceId);
      const group = calls === 1 || calls === 3
        ? { groupId: "incomplete", decision: "skip", sourceRefs: refs.slice(0, 1), reason: "social_noise" }
        : calls === 2
          ? { groupId: "deferred", decision: "defer", sourceRefs: refs, reason: "awaiting_continuation" }
          : options.write
            ? { groupId: "written", decision: "write", sourceRefs: refs, assertions: [{ section: "events", text: "Completed the synthetic request.",
                actorRef: "assistant", outcomeStatus: "completed", confidence: 1, reasonCodes: ["explicit_outcome"],
                citations: [{ traceId: refs[0], evidenceRef: sources[0].evidenceRefs[0] }] }] }
            : { groupId: "skipped", decision: "skip", sourceRefs: refs, reason: "social_noise" };
      return { resolvedModel: "openai/gpt-5.6-terra", output: JSON.stringify({ schema: "engram.memory-batch-shadow-output.v1", groups: [group] }) };
    },
  });
  expect(await worker.processOne()).toMatchObject({ status: "retry", reason: "batch_source_coverage" });
  current = new Date("2026-08-31T20:26:00.000Z");
  expect(await worker.processOne()).toMatchObject({ status: "completed", deferredCount: 2 });
  expect(ledger.listQueue().map(record => record.attempt)).toEqual([1, 1]);
  admit(ledger, 903, "2026-08-31T20:27:00.000Z");
  current = new Date("2026-08-31T20:47:00.000Z");
  // Simulate the old failure/result path, not hand-edited queue records.
  const reconcile = (worker as any).reconcileExhaustedJob;
  if (options.legacy) (worker as any).reconcileExhaustedJob = () => null;
  return { workspace, ledger, worker, policy, calls: () => calls,
    advance: () => { current = new Date(current.getTime() + 360_000); },
    restore: () => { (worker as any).reconcileExhaustedJob = reconcile; } };
}

test("mixed exhaustion seals only the batch and lets eligible sources progress", async () => {
  const s = await mixedAttemptScenario();
  expect(await s.worker.processOne()).toMatchObject({ status: "terminal_failure", reason: "batch_source_coverage" });
  const exhausted = s.ledger.listQueue().filter(record => record.status === "terminal");
  expect(exhausted).toHaveLength(2);
  expect(s.ledger.listQueue().filter(record => record.status === "queued")).toHaveLength(1);
  s.advance();
  expect(await s.worker.processOne()).toMatchObject({ status: "completed", sourceCount: 1 });
  expect(s.ledger.listQueue().filter(record => exhausted.some(source => source.traceId === record.traceId))).toEqual(exhausted);
  expect((await s.worker.processOne()).status).toBe("idle");
  expect(s.calls()).toBe(4);
});

test("legacy mixed batch with cached valid result is reconciled without another model call", async () => {
  const s = await mixedAttemptScenario({ legacy: true });
  await s.worker.processOne(); s.advance();
  await expect(s.worker.processOne()).rejects.toMatchObject({ code: "BATCH_CLAIM_CONFLICT" });
  const before = s.ledger.listQueue(); s.restore();
  expect(await s.worker.processOne()).toMatchObject({ status: "reconciled", sourceCount: 3, exhaustedCount: 2 });
  expect(s.ledger.listQueue()).toEqual(before);
  expect(s.calls()).toBe(4);
  expect(await s.worker.processOne()).toMatchObject({ status: "completed", sourceCount: 1 });
  expect(s.calls()).toBe(5);
});

test("mixed reconciliation resumes after receipt persistence without rewriting source states", async () => {
  const s = await mixedAttemptScenario({ crash: true });
  await expect(s.worker.processOne()).rejects.toThrow("reconciliation crash");
  const before = s.ledger.listQueue(); s.advance();
  expect(await s.worker.processOne()).toMatchObject({ status: "reconciled", exhaustedCount: 2 });
  expect(s.ledger.listQueue()).toEqual(before);
  expect(s.calls()).toBe(3);
  expect(await s.worker.processOne()).toMatchObject({ status: "completed", sourceCount: 1 });
});

test("legacy recovery refuses to abandon persisted assertions", async () => {
  const s = await mixedAttemptScenario({ legacy: true, write: true });
  await s.worker.processOne(); s.advance();
  await expect(s.worker.processOne()).rejects.toMatchObject({ code: "BATCH_CLAIM_CONFLICT" });
  const before = s.ledger.listQueue(); s.restore();
  await expect(s.worker.processOne()).rejects.toMatchObject({ code: "RECONCILIATION_EFFECTS_EXIST" });
  expect(s.ledger.listQueue()).toEqual(before);
  expect(s.calls()).toBe(4);
});


test("mixed reconciliation refuses changed source state after a crash", async () => {
  const s = await mixedAttemptScenario({ crash: true });
  await expect(s.worker.processOne()).rejects.toThrow("reconciliation crash");
  s.advance();
  const now = new Date("2026-08-31T20:53:00.000Z");
  const token = "synthetic-independent-recovery";
  expect(s.ledger.acquireWorkerLease("evaluator", token, 300_000, now)).toBe(true);
  const trace = s.ledger.listQueue().find(record => record.status === "queued")!.traceId;
  const [claimed] = s.ledger.claimBatchExact(token, [trace], now);
  s.ledger.retry(claimed!, 300_000, "batch_provider_failure", now);
  s.ledger.releaseWorkerLease("evaluator", token);
  const before = s.ledger.listQueue();
  await expect(s.worker.processOne()).rejects.toMatchObject({ code: "RECONCILIATION_CONFLICT" });
  expect(s.ledger.listQueue()).toEqual(before);
});

test("mixed recovery still requires current producer authority", async () => {
  const s = await mixedAttemptScenario({ legacy: true });
  await s.worker.processOne(); s.restore(); s.advance();
  const denied = new BatchLiveWorker({ ...(s.worker as any).options,
    resolveAuthorityContracts: () => ({ producerRegistry: {}, authorityPolicy: {} }) });
  const before = s.ledger.listQueue();
  await expect(denied.processOne()).rejects.toMatchObject({ code: "AUTHORITY_DENIED" });
  expect(s.ledger.listQueue()).toEqual(before);
});
