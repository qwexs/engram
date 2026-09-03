import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EpisodicShadowEvaluator, episodicEvaluationPrompt, parseEpisodicEvaluation } from "./episodic-evaluator.ts";
import {
  MemoryObservationLedger,
  sha256,
  type LedgerFaultPoint,
  type TrustedCompletedTurn,
} from "./ledger.ts";

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

const contractRoot = join(import.meta.dir, "..", "..", "contracts", "memory-observation", "v1");
const registry = JSON.parse(readFileSync(join(contractRoot, "producer-registry.json"), "utf8"));
const policy = JSON.parse(readFileSync(join(contractRoot, "authority-policy.json"), "utf8"));
const runtime = registry.producers.find((entry: any) => entry.id === "openclaw-runtime");
const observer = registry.producers.find((entry: any) => entry.id === "post-turn-observer");
const sessionKey = "agent:fixture-main:telegram:direct:100000001";

function workspace(): string {
  const path = join(tmpdir(), `engram-episodic-evaluator-${crypto.randomUUID()}`);
  roots.push(path);
  return path;
}

function source(seed = "a"): TrustedCompletedTurn {
  const sourceTurnId = `channel-user:v1:${seed.repeat(64)}`;
  return {
    sourceTurnId,
    scope: { workspaceId: "fixture-main", runtimeSessionKey: sessionKey, scopeClass: "self", scopeId: "telegram:100000001" },
    sourceCompletedAt: "2026-08-24T18:00:00.000Z",
    authority: { id: runtime.id, version: runtime.version, digest: runtime.digest },
    evidenceRefs: [{ kind: "source-turn", ref: sourceTurnId, digest: sha256(`evidence-${seed}`) }],
    redactedEvidence: { target: { user: "Продолжай", assistant: "Реализация завершена и тесты прошли." }, replyContext: [] },
    trustedInputs: ["completed-source-turn", "runtime-session-key", "workspace-binding", "source-completion-time"],
  };
}

function ledger(root: string, options: { fault?: (point: LedgerFaultPoint) => void; maxAttempts?: number } = {}): MemoryObservationLedger {
  return new MemoryObservationLedger({
    workspace: root,
    workspaceId: "fixture-main",
    exactSessionKeys: [sessionKey],
    producerRegistry: registry,
    authorityPolicy: policy,
    evaluatorEnabled: true,
    evaluationStartedAt: "2026-08-24T17:59:00.000Z",
    fault: options.fault,
    limits: {
      evidenceTtlMs: 72 * 60 * 60 * 1_000,
      maxJobs: 100,
      maxBytes: 1_000_000,
      maxQueueAgeMs: 7 * 24 * 60 * 60 * 1_000,
      maxAttempts: options.maxAttempts ?? 2,
      claimTtlMs: 30_000,
      maxInferenceCalls: 1,
    },
  });
}

function writeOutput(sourceTurn: TrustedCompletedTurn): string {
  return JSON.stringify({
    decision: "write",
    section: "events",
    text: "Реализация завершена, тесты прошли.",
    actorRef: "assistant",
    outcomeStatus: "completed",
    confidence: 0.97,
    reasonCodes: ["explicit-completed-event"],
    evidenceRefs: sourceTurn.evidenceRefs,
  });
}

describe("ISS-7 episodic evaluator strict contract", () => {
  test("keeps semantic decisions causal, novelty-aware, and exact about pending actions", () => {
    const turn = source();
    const request = episodicEvaluationPrompt({
      envelope: {
        schema: "engram.memory-observation-envelope.v1",
        traceId: sha256("trace"),
        sourceTurnId: turn.sourceTurnId,
        sourceCompletedAt: turn.sourceCompletedAt,
        scope: turn.scope,
        producer: turn.authority,
        evidenceRefs: turn.evidenceRefs,
        trustedInputs: turn.trustedInputs,
        createdAt: turn.sourceCompletedAt,
      },
      evidence: {
        schema: "engram.memory-observation-evidence.v1",
        traceId: sha256("trace"),
        payload: turn.redactedEvidence,
        redaction: { policy: "deterministic-v1", applied: false, reasonCodes: [] },
        createdAt: turn.sourceCompletedAt,
        expiresAt: "2026-08-27T18:00:00.000Z",
      },
    });

    expect(request.system).toContain("Never infer later supersession");
    expect(request.system).toContain("target outcome itself introduces a new");
    expect(request.system).toContain("merely restates an earlier result");
    expect(request.system).toContain("proposed follow-up action still awaits approval");
  });

  test("accepts only exact write or skip JSON", () => {
    expect(parseEpisodicEvaluation('{"decision":"skip","reason":"noise"}')).toEqual({ decision: "skip", reason: "noise" });
    expect(() => parseEpisodicEvaluation('```json\n{"decision":"skip","reason":"noise"}\n```')).toThrow("strict JSON");
    expect(() => parseEpisodicEvaluation('{"decision":"skip","reason":"noise","note":"extra"}')).toThrow("unknown fields");
    expect(() => parseEpisodicEvaluation('{"decision":"write"}')).toThrow("strict episodic contract");
    expect(() => parseEpisodicEvaluation(JSON.stringify({
      decision: "write", section: "events", text: "Done", actorRef: "mallory", outcomeStatus: "completed",
      confidence: 1, reasonCodes: ["done"], evidenceRefs: source().evidenceRefs,
    }))).toThrow("strict episodic contract");
  });

  test("writes one immutable typed observation and no canonical memory", async () => {
    const root = workspace();
    const store = ledger(root);
    const turn = source();
    const admitted = store.admit(turn, new Date("2026-08-24T18:00:00.100Z"));
    const evaluator = new EpisodicShadowEvaluator({
      ledger: store,
      producer: observer,
      complete: async () => writeOutput(turn),
      now: () => new Date("2026-08-24T18:00:01.000Z"),
    });

    expect(await evaluator.processOne()).toEqual({ status: "written", traceId: admitted.envelope.traceId });
    expect(store.readEvaluationResult(admitted.envelope.traceId)?.decision.decision).toBe("write");
    expect(store.readObservation(admitted.envelope.traceId)).toMatchObject({
      schema: "engram.memory-observation.v1",
      observationClass: "episodic.event",
      targetConsumer: "daily-note",
      payload: { section: "events", outcomeStatus: "completed" },
    });
    expect(store.listQueue()[0]).toMatchObject({ status: "terminal", reasonCode: "semantic_write" });
    expect(store.readTrace(admitted.envelope.traceId).map((event) => event.stage)).toEqual(["source_completed", "observation_admitted"]);
    expect(existsSync(join(root, "memory"))).toBe(false);
    expect(existsSync(join(root, "life"))).toBe(false);
  });

  test("persists semantic skip without creating a typed write candidate", async () => {
    const store = ledger(workspace());
    const admitted = store.admit(source(), new Date("2026-08-24T18:00:00.100Z"));
    const evaluator = new EpisodicShadowEvaluator({
      ledger: store,
      producer: observer,
      complete: async () => '{"decision":"skip","reason":"noise"}',
      now: () => new Date("2026-08-24T18:00:01.000Z"),
    });

    expect(await evaluator.processOne()).toEqual({ status: "skipped", traceId: admitted.envelope.traceId, reason: "noise" });
    expect(store.readEvaluationResult(admitted.envelope.traceId)?.decision).toEqual({ decision: "skip", reason: "noise" });
    expect(store.readObservation(admitted.envelope.traceId)).toBeNull();
    expect(store.listQueue()[0]).toMatchObject({ status: "terminal", reasonCode: "semantic_skip_noise" });
    expect(store.readTrace(admitted.envelope.traceId).map((event) => event.stage)).toEqual(["source_completed", "observation_skipped"]);
    expect(store.readTrace(admitted.envelope.traceId).find((event) => event.stage === "observation_skipped")?.producer).toEqual(observer);
  });

  for (const point of ["after_typed_observation", "after_evaluation_trace"] as const) {
    test(`resumes ${point} without a second inference`, async () => {
      let armed = true;
      let now = new Date("2026-08-24T18:00:01.000Z");
      let calls = 0;
      const store = ledger(workspace(), { fault: (current) => { if (armed && current === point) throw new Error(`crash:${point}`); } });
      const turn = source();
      store.admit(turn, new Date("2026-08-24T18:00:00.100Z"));
      const evaluator = new EpisodicShadowEvaluator({
        ledger: store,
        producer: observer,
        complete: async () => { calls++; return writeOutput(turn); },
        retryDelayMs: 1,
        now: () => now,
      });

      expect((await evaluator.processOne()).status).toBe("retry");
      armed = false;
      now = new Date("2026-08-24T18:00:02.000Z");
      expect((await evaluator.processOne()).status).toBe("resumed");
      expect(calls).toBe(1);
      expect(store.listQueue()[0]?.status).toBe("terminal");
    });
  }

  test("resumes a persisted skip trace without a second inference", async () => {
    let armed = true;
    let now = new Date("2026-08-24T18:00:01.000Z");
    let calls = 0;
    const store = ledger(workspace(), { fault: (point) => { if (armed && point === "after_evaluation_trace") throw new Error("crash:skip-trace"); } });
    store.admit(source(), new Date("2026-08-24T18:00:00.100Z"));
    const evaluator = new EpisodicShadowEvaluator({
      ledger: store,
      producer: observer,
      complete: async () => { calls++; return '{"decision":"skip","reason":"noise"}'; },
      retryDelayMs: 1,
      now: () => now,
    });
    expect((await evaluator.processOne()).status).toBe("retry");
    armed = false;
    now = new Date("2026-08-24T18:00:02.000Z");
    expect((await evaluator.processOne()).status).toBe("resumed");
    expect(calls).toBe(1);
    expect(store.listQueue()[0]).toMatchObject({ status: "terminal", reasonCode: "semantic_skip_noise" });
  });

  for (const decision of ["write", "skip"] as const) {
    test(`resumes persisted ${decision} after a crash on the final allowed attempt`, async () => {
      let armed = true;
      let now = new Date("2026-08-24T18:00:01.000Z");
      let calls = 0;
      const faultPoint = decision === "write" ? "after_typed_observation" : "after_evaluation_trace";
      const store = ledger(workspace(), {
        maxAttempts: 1,
        fault: (point) => { if (armed && point === faultPoint) throw new Error(`crash:${decision}`); },
      });
      const turn = source();
      store.admit(turn, new Date("2026-08-24T18:00:00.100Z"));
      const evaluator = new EpisodicShadowEvaluator({
        ledger: store,
        producer: observer,
        complete: async () => {
          calls++;
          return decision === "write" ? writeOutput(turn) : '{"decision":"skip","reason":"noise"}';
        },
        retryDelayMs: 1,
        now: () => now,
      });
      expect((await evaluator.processOne()).status).toBe("retry");
      expect(store.listQueue()[0]).toMatchObject({ status: "queued", reasonCode: "persisted_completion_pending_resume" });
      armed = false;
      now = new Date("2026-08-24T18:00:02.000Z");
      expect((await evaluator.processOne()).status).toBe("resumed");
      expect(calls).toBe(1);
      expect(store.listQueue()[0]?.reasonCode).toBe(decision === "write" ? "semantic_write" : "semantic_skip_noise");
    });
  }

  test("retries malformed model output and terminates at the bounded attempt limit", async () => {
    let now = new Date("2026-08-24T18:00:01.000Z");
    const store = ledger(workspace(), { maxAttempts: 2 });
    store.admit(source(), new Date("2026-08-24T18:00:00.100Z"));
    const evaluator = new EpisodicShadowEvaluator({
      ledger: store,
      producer: observer,
      complete: async () => "not-json",
      retryDelayMs: 1,
      now: () => now,
    });
    expect((await evaluator.processOne()).status).toBe("retry");
    now = new Date("2026-08-24T18:00:02.000Z");
    expect((await evaluator.processOne()).status).toBe("terminal_failure");
    expect(store.listQueue()[0]).toMatchObject({ status: "terminal", reasonCode: "technical_invalid_json" });
  });

  test("contains no canonical writer or scheduler dependency", () => {
    const implementation = readFileSync(join(import.meta.dir, "episodic-evaluator.ts"), "utf8");
    for (const forbidden of ["daily-note-append", "engram_memory_save", "kg-v3/live-ingress", "cron", "scheduler"]) {
      expect(implementation).not.toContain(forbidden);
    }
  });
});
