import { afterEach, describe, expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  DailyNoteCanaryApplicator,
  type DailyNoteApplicatorFaultPoint,
  type DailyNoteCanaryPolicy,
} from "./daily-note-applicator.ts";
import {
  deriveObservationId,
  sha256,
  type Digest,
  type EpisodicObservationV1,
  type JsonValue,
} from "./ledger.ts";
import {
  BATCH_EVALUATOR_AUTHORITY,
  deriveBatchObservationId,
  type BatchObservationV1,
} from "./batch-observation.ts";
import type { WorkspaceDirtyMarkResult } from "../qmd/maintenance-integration.ts";

const roots: string[] = [];
const contractSchema = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "schemas", "memory-observation-contracts-v1.schema.json"), "utf8"));
const ajv = new Ajv2020({ strict: true });
addFormats(ajv);
ajv.addSchema(contractSchema);
const validateReceipt = ajv.getSchema(`${contractSchema.$id}#/$defs/applyReceipt`)!;
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function workspace(): string {
  const value = mkdtempSync(join(tmpdir(), "daily-note-canary-"));
  roots.push(value);
  return value;
}

const runtimeSessionKey = "agent:main:telegram:direct:100000001";
const scope = {
  workspaceId: "main",
  runtimeSessionKey,
  scopeClass: "self" as const,
  scopeId: "telegram:100000001",
};

function policy(overrides: Partial<DailyNoteCanaryPolicy> = {}): DailyNoteCanaryPolicy {
  return {
    workspaceId: "main",
    exactScope: scope,
    applyAfter: "2026-08-26T21:00:00.000Z",
    timezone: "Europe/Moscow",
    allowedObservationClasses: ["episodic.event"],
    maxAppliesPerWake: 1,
    policyDigest: `sha256:${"a".repeat(64)}`,
    ...overrides,
  };
}

function observation(overrides: Partial<EpisodicObservationV1> = {}): EpisodicObservationV1 {
  const traceId = (overrides.traceId ?? `sha256:${"1".repeat(64)}`) as Digest;
  const observationClass = overrides.observationClass ?? "episodic.event";
  const producer = {
    id: "post-turn-observer",
    version: "v1",
    digest: `sha256:d4f0bf349ea08594fbd3a72f1e6f05ea5dda32800422c1e2cefbc434552cd406` as Digest,
  };
  const base = {
    schema: "engram.memory-observation.v1" as const,
    observationId: deriveObservationId(traceId, producer.id, observationClass),
    traceId,
    sourceTurnId: `channel-user:v1:${"b".repeat(64)}`,
    scope,
    producer,
    observationClass,
    targetConsumer: "daily-note" as const,
    payload: {
      section: "events" as const,
      text: "Canary result verified.\nNo unrelated sink was enabled.",
      actorRef: "assistant" as const,
      outcomeStatus: "completed" as const,
    },
    evidenceRefs: [{ kind: "source-turn" as const, ref: "source", digest: `sha256:${"c".repeat(64)}` as Digest }],
    sourceCompletedAt: "2026-08-26T21:30:00.000Z",
    confidence: 0.99,
    reasonCodes: ["verified_status"],
    completedAt: "2026-08-26T21:31:00.000Z",
    ...overrides,
  };
  const { observationDigest: _ignored, ...withoutDigest } = base as EpisodicObservationV1;
  return { ...withoutDigest, observationDigest: sha256(withoutDigest as unknown as JsonValue) };
}

function persist(root: string, value: EpisodicObservationV1): void {
  const path = join(root, "memory-state", "memory-observation", "v1", "observations", "typed", `${value.traceId.slice(7)}.json`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function batchObservation(): BatchObservationV1 {
  const traceId = sha256("batch-trace");
  const sourceTurnId = `channel-user:v1:${"d".repeat(64)}`;
  const evidenceRef = { kind: "source-turn" as const, ref: sourceTurnId, digest: sha256("batch-evidence-ref") };
  const identity = {
    bundleId: sha256("batch-bundle"),
    groupId: "group-1",
    assertionIndex: 0,
    observationClass: "episodic.decision" as const,
    evaluationPolicyDigest: sha256("batch-evaluation-policy"),
  };
  const base = {
    schema: "engram.memory-batch-observation.v1" as const,
    observationId: deriveBatchObservationId(identity),
    bundleId: identity.bundleId,
    groupId: identity.groupId,
    assertionIndex: identity.assertionIndex,
    scope,
    sourceRefs: [{
      traceId,
      sourceTurnId,
      sourceDigest: sha256("batch-source"),
      evidenceDigest: sha256("batch-evidence"),
      sourceCompletedAt: "2026-08-26T21:30:00.000Z",
    }],
    producer: BATCH_EVALUATOR_AUTHORITY,
    observationClass: identity.observationClass,
    targetConsumer: "daily-note" as const,
    payload: {
      section: "decisions" as const,
      text: "Batch decisions require their evaluator policy digest downstream.",
      actorRef: "user" as const,
      outcomeStatus: "decided" as const,
    },
    citations: [{ traceId, evidenceRef }],
    sourceCompletedAt: "2026-08-26T21:30:00.000Z",
    confidence: 0.99,
    reasonCodes: ["explicit_decision"],
    evaluationPolicyDigest: identity.evaluationPolicyDigest,
    completedAt: "2026-08-26T21:31:00.000Z",
  };
  return { ...base, observationDigest: sha256(base as unknown as JsonValue) };
}

function persistBatch(root: string, value: BatchObservationV1): void {
  const path = join(root, "memory-state", "memory-observation", "v1", "observations", "batch", `${value.observationId.slice(7)}.json`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function marked(root: string): WorkspaceDirtyMarkResult {
  return {
    schema: "engram.qmd.dirty-mark.v1",
    status: "marked",
    mode: "coordinated",
    workspace: root,
    indexKey: "named:sample-global",
    generation: 1,
    collections: ["main-direct-memory"],
  };
}

describe("daily-note canary applicator", () => {
  test("applies one future event to the source date with immutable receipt and deterministic read-back", async () => {
    const root = workspace();
    const value = observation();
    persist(root, value);
    const applicator = new DailyNoteCanaryApplicator({ workspace: root, resolveActivePolicy: () => policy() });

    const result = await applicator.processOne(new Date("2026-08-26T21:32:00.000Z"));
    expect(result.status).toBe("applied");
    const notePath = join(root, "memory", "agent-main", "telegram-direct-100000001", "2026-08-27.md");
    const note = readFileSync(notePath, "utf8");
    expect(note).toContain("Canary result verified.\n  No unrelated sink was enabled.");
    expect(count(note, "<!-- engram-entry:sha256:")).toBe(1);
    const receipt = applicator.readReceipt(value.observationId);
    expect(receipt?.status).toBe("applied");
    expect(validateReceipt(receipt)).toBe(true);
    expect(applicator.listQueue()[0]?.reasonCode).toBe("canonical_applied");
    const traces = readdirSync(join(root, "memory-state", "memory-observation", "v1", "traces", value.traceId.slice(7)));
    expect(traces.length).toBe(1);
    expect(readFileSync(join(root, "memory-state", "memory-observation", "v1", "traces", value.traceId.slice(7), traces[0]!), "utf8"))
      .toContain('"stage": "canonical_applied"');
  });

  test("recovers after every post-mutation crash without duplicating the Markdown entry", async () => {
    for (const point of ["after_note_write", "after_receipt", "after_trace"] as DailyNoteApplicatorFaultPoint[]) {
      const root = workspace();
      const value = observation({ traceId: sha256(`trace-${point}`) });
      persist(root, value);
      let faulted = false;
      const first = new DailyNoteCanaryApplicator({
        workspace: root,
        resolveActivePolicy: () => policy(),
        fault: (current) => {
          if (!faulted && current === point) { faulted = true; throw new Error(`fault:${point}`); }
        },
      });
      expect((await first.processOne(new Date("2026-08-26T21:32:00.000Z"))).status).toBe("retry");
      if (point === "after_note_write") {
        const queuePath = join(root, "memory-state", "memory-observation", "v1", "consumers", "daily-note", "queue", `${value.observationId.slice(7)}.json`);
        const queue = JSON.parse(readFileSync(queuePath, "utf8"));
        writeFileSync(queuePath, `${JSON.stringify({
          ...queue,
          status: "claimed",
          claimedAt: "2026-08-26T21:32:00.000Z",
          claimToken: "crashed-worker",
        }, null, 2)}\n`);
      }

      const resumed = new DailyNoteCanaryApplicator({ workspace: root, resolveActivePolicy: () => policy() });
      expect(["applied", "duplicate"]).toContain((await resumed.processOne(new Date("2026-08-26T21:33:00.000Z"))).status);
      const note = readFileSync(join(root, "memory", "agent-main", "telegram-direct-100000001", "2026-08-27.md"), "utf8");
      expect(count(note, "<!-- engram-entry:sha256:")).toBe(1);
      expect(resumed.readReceipt(value.observationId)?.status).toBe("applied");
    }
  });

  test("rejects a destination read-back mismatch before persisting a receipt", async () => {
    const root = workspace();
    const value = observation({ traceId: sha256("destination-read-back-mismatch") });
    persist(root, value);
    const notePath = join(root, "memory", "agent-main", "telegram-direct-100000001", "2026-08-27.md");
    let corrupted = false;
    const applicator = new DailyNoteCanaryApplicator({
      workspace: root,
      resolveActivePolicy: () => policy(),
      fault: (point) => {
        if (!corrupted && point === "after_note_write") {
          corrupted = true;
          writeFileSync(notePath, readFileSync(notePath, "utf8").replace("Canary result verified.", "Corrupted destination content."));
        }
      },
    });

    expect(await applicator.processOne(new Date("2026-08-26T21:32:00.000Z"))).toEqual({
      status: "retry",
      traceId: value.traceId,
      reason: "READ_BACK_FAILED",
    });
    expect(applicator.readReceipt(value.observationId)).toBeNull();
    expect(applicator.listQueue()[0]?.reasonCode).toBe("retry_read_back_failed");
  });

  test("rereads the kill switch after claim and leaves the canonical note untouched", async () => {
    const root = workspace();
    const value = observation();
    persist(root, value);
    let active: DailyNoteCanaryPolicy | null = policy();
    let switchedOff = false;
    const applicator = new DailyNoteCanaryApplicator({
      workspace: root,
      resolveActivePolicy: () => active,
      fault: (point) => {
        if (!switchedOff && point === "after_claim") { switchedOff = true; active = null; }
      },
    });
    expect((await applicator.processOne(new Date("2026-08-26T21:32:00.000Z"))).status).toBe("disabled");
    expect(existsSync(join(root, "memory"))).toBe(false);
    expect(applicator.listQueue()[0]?.status).toBe("queued");

    active = policy();
    expect((await applicator.processOne(new Date("2026-08-26T21:33:00.000Z"))).status).toBe("applied");
  });

  test("does not enqueue pre-canary or decision-class observations under the event-only policy", () => {
    const root = workspace();
    persist(root, observation({ completedAt: "2026-08-26T20:59:59.000Z" }));
    const decision = observation({
      traceId: sha256("decision-trace"),
      observationClass: "episodic.decision",
      payload: {
        section: "decisions",
        text: "A decision",
        actorRef: "user",
        outcomeStatus: "decided",
      },
    } as Partial<EpisodicObservationV1>);
    persist(root, decision);
    const applicator = new DailyNoteCanaryApplicator({ workspace: root, resolveActivePolicy: () => policy() });
    expect(applicator.reconcile(new Date("2026-08-26T21:32:00.000Z"))).toBe(0);
    expect(applicator.listQueue()).toHaveLength(0);
  });

  test("applies an admitted decision to Decisions with a typed receipt and idempotent replay", async () => {
    const root = workspace();
    const value = observation({
      traceId: sha256("admitted-decision-trace"),
      observationClass: "episodic.decision",
      payload: {
        section: "decisions",
        text: "Observer owns daily-note capture for this exact session.",
        actorRef: "user",
        outcomeStatus: "decided",
      },
    } as Partial<EpisodicObservationV1>);
    persist(root, value);
    const ownershipPolicy = policy({ allowedObservationClasses: ["episodic.event", "episodic.decision"] });
    const applicator = new DailyNoteCanaryApplicator({ workspace: root, resolveActivePolicy: () => ownershipPolicy });

    expect((await applicator.processOne(new Date("2026-08-26T21:32:00.000Z"))).status).toBe("applied");
    const notePath = join(root, "memory", "agent-main", "telegram-direct-100000001", "2026-08-27.md");
    const note = readFileSync(notePath, "utf8");
    expect(note.indexOf("## Decisions")).toBeLessThan(note.indexOf("Observer owns daily-note capture"));
    expect(note.indexOf("Observer owns daily-note capture")).toBeLessThan(note.indexOf("## Learnings"));
    expect(note.slice(note.indexOf("## Events"), note.indexOf("## Decisions"))).not.toContain("Observer owns daily-note capture");
    expect(applicator.readReceipt(value.observationId)?.sourceProvenance.observationClass).toBe("episodic.decision");
    expect((await applicator.processOne(new Date("2026-08-26T21:33:00.000Z"))).status).toBe("idle");
    expect(count(readFileSync(notePath, "utf8"), "Observer owns daily-note capture")).toBe(1);
  });

  test("an exact-scope applicator skips queued observations owned by another main session", async () => {
    const root = workspace();
    const direct = observation({ traceId: sha256("direct-scope-trace") });
    const topicScope = {
      workspaceId: "main",
      runtimeSessionKey: "agent:main:telegram:group:-100123:topic:7",
      scopeClass: "self" as const,
      scopeId: "workspace:main",
    };
    const topic = observation({
      traceId: sha256("topic-scope-trace"),
      scope: topicScope,
      payload: {
        section: "events",
        text: "Topic progress was summarized.",
        actorRef: "assistant",
        outcomeStatus: "completed",
      },
    });
    persist(root, direct);
    persist(root, topic);
    const directApplicator = new DailyNoteCanaryApplicator({ workspace: root, resolveActivePolicy: () => policy() });
    expect(directApplicator.reconcile(new Date("2026-08-26T21:32:00.000Z"))).toBe(1);

    const topicApplicator = new DailyNoteCanaryApplicator({
      workspace: root,
      resolveActivePolicy: () => policy({ exactScope: topicScope }),
    });
    expect((await topicApplicator.processOne(new Date("2026-08-26T21:33:00.000Z"))).status).toBe("applied");
    expect(readFileSync(join(root, "memory", "agent-main", "telegram-group--100123-topic-7", "2026-08-27.md"), "utf8"))
      .toContain("Topic progress was summarized.");
    expect(topicApplicator.listQueue().find((record) => record.observationId === direct.observationId)?.status).toBe("queued");
  });

  test("preserves the batch evaluator policy digest in the canonical apply receipt", async () => {
    const root = workspace();
    const value = batchObservation();
    persistBatch(root, value);
    const applicator = new DailyNoteCanaryApplicator({
      workspace: root,
      resolveActivePolicy: () => policy({
        allowedObservationClasses: ["episodic.event", "episodic.decision"],
        allowedBatchEvaluationPolicyDigest: value.evaluationPolicyDigest,
      }),
    });

    const result = await applicator.processOne(new Date("2026-08-26T21:32:00.000Z"));
    expect(result.status).toBe("applied");
    const receipt = applicator.readReceipt(value.observationId);
    expect(receipt?.sourceProvenance.batchEvaluationPolicyDigest).toBe(value.evaluationPolicyDigest);
    expect(receipt?.sourceProvenance.batchSourceRefs).toEqual(value.sourceRefs);
    expect(receipt?.sourceProvenance.batchCitations).toEqual(value.citations);
    expect(validateReceipt(receipt)).toBe(true);
    const { batchEvaluationPolicyDigest: _legacyMissingField, ...legacyProvenance } = receipt!.sourceProvenance;
    expect(validateReceipt({ ...receipt, sourceProvenance: legacyProvenance })).toBe(true);
  });

  test("hands a bound note to QMD before trace and terminal, then replays safely after a crash", async () => {
    const root = workspace();
    const value = observation({ traceId: sha256("bound-dirty-crash") });
    persist(root, value);
    const calls: unknown[] = [];
    let faulted = false;
    const first = new DailyNoteCanaryApplicator({
      workspace: root,
      resolveActivePolicy: () => policy({ qmdBinding: { collection: "main-direct-memory" } }),
      dirtyMarker: async (input) => { calls.push(input); return marked(root); },
      fault: (point) => {
        if (!faulted && point === "after_dirty_mark") { faulted = true; throw new Error("crash-after-dirty"); }
      },
    });
    expect((await first.processOne(new Date("2026-08-26T21:32:00.000Z"))).status).toBe("retry");

    const resumed = new DailyNoteCanaryApplicator({
      workspace: root,
      resolveActivePolicy: () => policy({ qmdBinding: { collection: "main-direct-memory" } }),
      dirtyMarker: async (input) => { calls.push(input); return marked(root); },
    });
    expect((await resumed.processOne(new Date("2026-08-26T21:33:00.000Z"))).status).toBe("duplicate");
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ workspace: root, collections: ["main-direct-memory"], bm25: true, vectors: true });
    const note = readFileSync(join(root, "memory", "agent-main", "telegram-direct-100000001", "2026-08-27.md"), "utf8");
    expect(count(note, "<!-- engram-entry:sha256:")).toBe(1);
    expect(readdirSync(join(root, "memory-state", "memory-observation", "v1", "traces", value.traceId.slice(7)))).toHaveLength(1);
    expect(resumed.listQueue()[0]).toMatchObject({ status: "terminal", reasonCode: "duplicate_receipt" });
  });

  test("keeps QMD signaling recoverable past the generic attempt limit and honors persisted due time", async () => {
    const root = workspace();
    const value = observation({ traceId: sha256("qmd-retry") });
    persist(root, value);
    let shouldMark = false;
    const applicator = new DailyNoteCanaryApplicator({
      workspace: root,
      resolveActivePolicy: () => policy({ qmdBinding: { collection: "main-direct-memory" } }),
      dirtyMarker: async () => shouldMark
        ? marked(root)
        : { schema: "engram.qmd.dirty-mark.v1", status: "disabled", mode: "legacy", workspace: root },
    });

    let now = new Date("2026-08-26T21:32:00.000Z");
    for (let attempt = 0; attempt < 4; attempt++) {
      expect((await applicator.processOne(now)).status).toBe("qmd_pending");
      const queue = applicator.listQueue()[0]!;
      expect(queue).toMatchObject({ status: "qmd_pending", qmdAttempt: attempt + 1, terminalAt: null });
      expect((await applicator.processOne(new Date(now.getTime() + 1))).status).toBe("idle");
      now = new Date(queue.nextAttemptAt!);
    }

    shouldMark = true;
    expect((await applicator.processOne(now)).status).toBe("duplicate");
    expect(applicator.listQueue()[0]).toMatchObject({ status: "terminal", nextAttemptAt: null });
  });

  test("restores a missing canonical trace from an existing receipt before terminal", async () => {
    const root = workspace();
    const value = observation({ traceId: sha256("receipt-trace-replay") });
    persist(root, value);
    let faulted = false;
    const first = new DailyNoteCanaryApplicator({
      workspace: root,
      resolveActivePolicy: () => policy({ qmdBinding: { collection: "main-direct-memory" } }),
      dirtyMarker: async () => marked(root),
      fault: (point) => {
        if (!faulted && point === "after_receipt") { faulted = true; throw new Error("crash-after-receipt"); }
      },
    });
    expect((await first.processOne(new Date("2026-08-26T21:32:00.000Z"))).status).toBe("retry");
    expect(existsSync(join(root, "memory-state", "memory-observation", "v1", "traces", value.traceId.slice(7)))).toBe(false);

    const resumed = new DailyNoteCanaryApplicator({
      workspace: root,
      resolveActivePolicy: () => policy({ qmdBinding: { collection: "main-direct-memory" } }),
      dirtyMarker: async () => marked(root),
    });
    expect((await resumed.processOne(new Date("2026-08-26T21:33:00.000Z"))).status).toBe("duplicate");
    expect(readdirSync(join(root, "memory-state", "memory-observation", "v1", "traces", value.traceId.slice(7)))).toHaveLength(1);
  });

  test("converts a dirty-marker failure into durable QMD pending", async () => {
    const root = workspace();
    persist(root, observation({ traceId: sha256("qmd-throw") }));
    const applicator = new DailyNoteCanaryApplicator({
      workspace: root,
      resolveActivePolicy: () => policy({ qmdBinding: { collection: "main-direct-memory" } }),
      dirtyMarker: async () => { throw new Error("state unavailable"); },
    });
    expect((await applicator.processOne(new Date("2026-08-26T21:32:00.000Z"))).status).toBe("qmd_pending");
    expect(applicator.listQueue()[0]).toMatchObject({ status: "qmd_pending", reasonCode: "qmd_dirty_mark_failed", terminalAt: null });
  });
});
