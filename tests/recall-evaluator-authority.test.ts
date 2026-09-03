import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import {
  DailyNoteCanaryApplicator,
  type DailyNoteCanaryPolicy,
} from "../src/memory-observation/daily-note-applicator.ts";
import {
  deriveObservationId,
  deriveSourceDigest,
  deriveTraceEventId,
  deriveTraceId,
  sha256,
  type Digest,
  type EpisodicObservationV1,
  type JsonValue,
  type LedgerQueueRecordV1,
  type ObservationJobV1,
  type ProducerRef,
  type TraceEventV1,
} from "../src/memory-observation/ledger.ts";
import { BATCH_EVALUATOR_AUTHORITY, deriveBatchObservationId, type BatchObservationV1 } from "../src/memory-observation/batch-observation.ts";
import {
  MEMORY_OBSERVATION_PROJECTION_SCHEMA,
  type MemoryObservationProjectionV1,
} from "../src/memory-observation/projection.ts";
import {
  compileRecallAuthorityManifest,
  parseRecallCaptureFrame,
  sealRecallCaptureFrame,
  type RecallCaptureFrame,
  type RecallCaptureFrameDraft,
} from "../src/qmd/recall-evaluator-authority.ts";
import type { RecallExactScope } from "../src/qmd/recall-evaluator-contracts.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const runtimeSessionKey = "agent:main:telegram:direct:100000001";
const scope: RecallExactScope = {
  workspaceId: "main",
  runtimeSessionKey,
  scopeClass: "self",
  scopeId: "telegram:100000001",
};
const effectiveAfter = "2026-08-29T09:00:00.000Z";
const policyDigest = sha256("recall-authority-policy");
const observer: ProducerRef = {
  id: "post-turn-observer",
  version: "v1",
  digest: "sha256:d4f0bf349ea08594fbd3a72f1e6f05ea5dda32800422c1e2cefbc434552cd406",
};

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "recall-authority-"));
  roots.push(root);
  return root;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function sourceTurnId(index: number): string {
  return `channel-user:v1:${sha256(`source-turn-${index}`).slice("sha256:".length)}`;
}

function completedAt(index: number): string {
  return new Date(Date.parse(effectiveAfter) + ((index + 1) * 60_000)).toISOString();
}

function projection(): MemoryObservationProjectionV1 {
  return {
    schema: MEMORY_OBSERVATION_PROJECTION_SCHEMA,
    workspaceId: "main",
    enabled: true,
    mode: "canary",
    bindings: [{
      runtimeSessionKey,
      scopeClass: "self",
      scopeId: "telegram:100000001",
      requireOwner: true,
      allowedChannels: ["telegram"],
    }],
    pluginDigest: sha256("installed-plugin"),
    inference: {
      provider: "openai",
      model: "openai/gpt-5.6-sol",
      evaluateAfter: effectiveAfter,
    },
    limits: {
      evidenceTtlHours: 72,
      maxJobs: 1_000,
      maxBytes: 67_108_864,
      maxQueueAgeHours: 168,
      maxAttempts: 2,
      claimTtlSeconds: 300,
      maxInferenceCalls: 1,
    },
    consumers: {
      dailyNote: {
        mode: "canary",
        applyAfter: effectiveAfter,
        timezone: "UTC",
        allowedObservationClasses: ["episodic.event", "episodic.decision"],
        maxAppliesPerWake: 1,
        qmdBinding: { collection: "main-direct-memory" },
      },
    },
    captureOwnership: {
      owner: "observer",
      effectiveAfter,
      foregroundDailyNoteCapture: "disabled",
    },
    approvedBy: "operator",
    approvedAt: effectiveAfter,
  };
}

function writeTrace(root: string, event: TraceEventV1): void {
  writeJson(join(
    root,
    "memory-state",
    "memory-observation",
    "v1",
    "traces",
    event.traceId.slice("sha256:".length),
    `${event.eventId.slice("sha256:".length)}.json`,
  ), event);
}

function traceEvent(options: {
  traceId: Digest;
  stage: TraceEventV1["stage"];
  stageRef: TraceEventV1["stageRef"];
  recordedAt: string;
  reasonCode: string;
}): TraceEventV1 {
  return {
    schema: "engram.memory-trace-event.v1",
    eventId: deriveTraceEventId(options.traceId, options.stage, options.stageRef.digest),
    traceId: options.traceId,
    stage: options.stage,
    scope,
    producer: observer,
    stageRef: options.stageRef,
    recordedAt: options.recordedAt,
    policyDigest,
    reasonCode: options.reasonCode,
    verification: null,
  };
}

function makeObservation(traceId: Digest, index: number): EpisodicObservationV1 {
  const sourceCompletedAt = completedAt(index);
  const observationId = deriveObservationId(traceId, observer.id, "episodic.event");
  const base = {
    schema: "engram.memory-observation.v1" as const,
    observationId,
    traceId,
    sourceTurnId: sourceTurnId(index),
    scope,
    producer: observer,
    observationClass: "episodic.event" as const,
    targetConsumer: "daily-note" as const,
    payload: {
      section: "events" as const,
      text: `Canonical capture event ${index}.`,
      actorRef: "assistant" as const,
      outcomeStatus: "completed" as const,
    },
    evidenceRefs: [{ kind: "source-turn" as const, ref: sourceTurnId(index), digest: deriveSourceDigest(sourceTurnId(index), scope, sourceCompletedAt) }],
    sourceCompletedAt,
    confidence: 0.99,
    reasonCodes: ["verified_status"],
    completedAt: new Date(Date.parse(sourceCompletedAt) + 10_000).toISOString(),
  };
  return { ...base, observationDigest: sha256(base as unknown as JsonValue) };
}

function frameDraft(): RecallCaptureFrameDraft {
  return {
    schema: "engram.recall-capture-frame.v1",
    frame: { sealedAt: "2026-08-29T09:40:00.000Z" },
    scope,
    approval: {
      source: "human",
      verifierRef: "operator://recall-capture-frame/1",
      digest: sha256("operator-approved-consecutive-frame"),
    },
    turns: Array.from({ length: 30 }, (_, index) => ({
      sourceTurnId: sourceTurnId(index),
      sourceCompletedAt: completedAt(index),
    })),
  };
}

async function fixture(): Promise<{ root: string; frame: RecallCaptureFrame }> {
  const root = workspace();
  writeJson(join(root, "memory-state", "memory-observation", "projection.json"), projection());
  const ledgerRoot = join(root, "memory-state", "memory-observation", "v1");

  for (let index = 0; index < 26; index++) {
    const sourceCompletedAt = completedAt(index);
    const currentSourceTurnId = sourceTurnId(index);
    const traceId = deriveTraceId(scope.workspaceId, runtimeSessionKey, currentSourceTurnId);
    const sourceDigest = deriveSourceDigest(currentSourceTurnId, scope, sourceCompletedAt);
    const envelope: ObservationJobV1 = {
      schema: "engram.memory-observation-job.v1",
      traceId,
      sourceTurnId: currentSourceTurnId,
      scope,
      sourceCompletedAt,
      sourceDigest,
      evidenceDigest: sha256(`evidence-${index}`),
      policyVersion: "memory-observation-authority-v1",
      policyDigest,
      evidenceRefs: [{ kind: "source-turn", ref: currentSourceTurnId, digest: sourceDigest }],
      authority: observer,
      admittedAt: new Date(Date.parse(sourceCompletedAt) + 1_000).toISOString(),
    };
    writeJson(join(ledgerRoot, "envelopes", `${traceId.slice("sha256:".length)}.json`), envelope);
    writeTrace(root, traceEvent({
      traceId,
      stage: "source_completed",
      stageRef: { kind: "source-turn", ref: currentSourceTurnId, digest: sourceDigest },
      recordedAt: envelope.admittedAt,
      reasonCode: "trusted_source_completed",
    }));

    const reasonCode = index < 2 ? "semantic_batch_write" : index < 20 ? "semantic_write" : index < 25 ? "semantic_skip_noise" : "evaluation_terminal_failure";
    const queue: LedgerQueueRecordV1 = {
      schema: "engram.memory-observation-ledger-queue.v1",
      traceId,
      queueClass: "evaluator",
      status: "terminal",
      attempt: 1,
      maxAttempts: 2,
      nextAttemptAt: envelope.admittedAt,
      createdAt: envelope.admittedAt,
      updatedAt: new Date(Date.parse(sourceCompletedAt) + 20_000).toISOString(),
      claimedAt: new Date(Date.parse(sourceCompletedAt) + 2_000).toISOString(),
      claimToken: null,
      terminalAt: new Date(Date.parse(sourceCompletedAt) + 20_000).toISOString(),
      reasonCode,
    };
    writeJson(join(ledgerRoot, "queues", "evaluator", `${traceId.slice("sha256:".length)}.json`), queue);

    if (index >= 2 && index < 20) {
      const observation = makeObservation(traceId, index);
      writeJson(join(ledgerRoot, "observations", "typed", `${traceId.slice("sha256:".length)}.json`), observation);
      writeTrace(root, traceEvent({
        traceId,
        stage: "observation_admitted",
        stageRef: { kind: "observation", ref: observation.observationId, digest: observation.observationDigest },
        recordedAt: observation.completedAt,
        reasonCode: "episodic_candidate_admitted",
      }));
    } else if (index < 25) {
      const skipDigest = sha256({ traceId, decision: { decision: "skip", reason: "noise" } } as unknown as JsonValue);
      writeTrace(root, traceEvent({
        traceId,
        stage: "observation_skipped",
        stageRef: { kind: "observation", ref: traceId, digest: skipDigest },
        recordedAt: queue.terminalAt!,
        reasonCode: "episodic_skip_noise",
      }));
    }
  }

  const batchSourceRefs = [0, 1].map((index) => {
    const currentSourceTurnId = sourceTurnId(index);
    return {
      traceId: deriveTraceId(scope.workspaceId, runtimeSessionKey, currentSourceTurnId),
      sourceTurnId: currentSourceTurnId,
      sourceDigest: deriveSourceDigest(currentSourceTurnId, scope, completedAt(index)),
      evidenceDigest: sha256(`evidence-${index}`),
      sourceCompletedAt: completedAt(index),
    };
  });
  const batchObservations: BatchObservationV1[] = [0, 1].map((assertionIndex) => {
    const identity = {
      bundleId: sha256("recall-batch"),
      groupId: "group-1",
      assertionIndex,
      observationClass: "episodic.event" as const,
      evaluationPolicyDigest: policyDigest,
    };
    const base = {
      schema: "engram.memory-batch-observation.v1" as const,
      observationId: deriveBatchObservationId(identity),
      ...identity,
      scope,
      sourceRefs: batchSourceRefs,
      producer: BATCH_EVALUATOR_AUTHORITY,
      targetConsumer: "daily-note" as const,
      payload: { section: "events" as const, text: `Canonical batch capture event ${assertionIndex}.`, actorRef: "assistant" as const, outcomeStatus: "completed" as const },
      citations: batchSourceRefs.map((source) => ({ traceId: source.traceId, evidenceRef: { kind: "source-turn" as const, ref: source.sourceTurnId, digest: source.sourceDigest } })),
      sourceCompletedAt: completedAt(1),
      confidence: 0.99,
      reasonCodes: ["verified_status"],
      completedAt: "2026-08-29T09:03:00.000Z",
    };
    return { ...base, observationDigest: sha256(base as unknown as JsonValue) };
  });
  for (const observation of batchObservations) writeJson(join(ledgerRoot, "observations", "batch", `${observation.observationId.slice(7)}.json`), observation);
  for (const source of batchSourceRefs) {
    writeTrace(root, {
      schema: "engram.memory-trace-event.v1",
      eventId: deriveTraceEventId(source.traceId, "batch_evaluation_terminal", sha256("recall-batch-result")),
      traceId: source.traceId,
      stage: "batch_evaluation_terminal",
      scope,
      producer: BATCH_EVALUATOR_AUTHORITY,
      stageRef: { kind: "batch-result", ref: sha256("recall-batch-terminal"), digest: sha256("recall-batch-result") },
      recordedAt: "2026-08-29T09:03:00.000Z",
      policyDigest,
      reasonCode: "semantic_batch_write",
      verification: null,
    });
  }

  const policy: DailyNoteCanaryPolicy = {
    workspaceId: "main",
    exactScope: scope,
    applyAfter: effectiveAfter,
    timezone: "UTC",
    allowedObservationClasses: ["episodic.event"],
    maxAppliesPerWake: 1,
    policyDigest,
    allowedBatchEvaluationPolicyDigest: policyDigest,
    qmdBinding: { collection: "main-direct-memory" },
  };
  const applicator = new DailyNoteCanaryApplicator({
    workspace: root,
    resolveActivePolicy: () => policy,
    dirtyMarker: async () => ({
      schema: "engram.qmd.dirty-mark.v1",
      status: "marked",
      mode: "coordinated",
      workspace: root,
      indexKey: "named:test",
      generation: 1,
      collections: ["main-direct-memory"],
    }),
  });
  for (let index = 0; index < 20; index++) {
    expect((await applicator.processOne(new Date("2026-08-29T09:50:00.000Z"))).status).toBe("applied");
  }
  return { root, frame: sealRecallCaptureFrame(frameDraft()) };
}

function snapshot(root: string): string {
  const rows: Array<[string, string]> = [];
  function visit(path: string): void {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) visit(child);
      else rows.push([relative(root, child), readFileSync(child, "utf8")]);
    }
  }
  visit(root);
  return JSON.stringify(rows);
}

describe("recall authoritative dataset compiler", () => {
  test("recomputes a read-only authority manifest from the full consecutive capture denominator", async () => {
    const { root, frame } = await fixture();
    const framePath = join(root, "recall-capture-frame.json");
    writeJson(framePath, frame);
    const before = snapshot(root);
    const manifest = compileRecallAuthorityManifest({
      workspace: root,
      workspaceId: "main",
      runtimeSessionKey,
      captureFrame: frame,
      compiledAt: "2026-08-29T10:00:00.000Z",
    });

    expect(manifest).toMatchObject({
      schema: "engram.recall-authority-manifest.v1",
      scope,
      projection: {
        effectiveAfter,
        approvedBy: "operator",
        approvedAt: effectiveAfter,
        qmdCollection: "main-direct-memory",
      },
      captureFrame: {
        id: frame.frame.id,
        digest: frame.frame.digest,
        counts: { write: 20, skip: 5, failed: 1, "not-admitted": 4 },
      },
      receiptPolicyDigest: policyDigest,
    });
    expect(manifest.captureFrame.turns).toHaveLength(30);
    expect(manifest.approvedEpisodes).toHaveLength(20);
    expect(manifest.captureFrame.turns.slice(0, 2).map((turn) => ({ outcome: turn.outcome, observations: turn.observationRefs.length, receipts: turn.receiptIds.length }))).toEqual([
      { outcome: "write", observations: 2, receipts: 2 },
      { outcome: "write", observations: 2, receipts: 2 },
    ]);
    expect(manifest.approvedEpisodes.filter((episode) => episode.traceId === deriveTraceId(scope.workspaceId, runtimeSessionKey, sourceTurnId(0)))).toHaveLength(2);
    expect(manifest.approvedEpisodes.every((episode) => episode.scope.scopeId === scope.scopeId)).toBe(true);

    const cli = Bun.spawnSync({
      cmd: [
        process.execPath,
        join(import.meta.dir, "..", "scripts", "recall-authority-compile.ts"),
        "--workspace", root,
        "--workspace-id", "main",
        "--runtime-session-key", runtimeSessionKey,
        "--capture-frame", framePath,
        "--compiled-at", "2026-08-29T10:00:00.000Z",
      ],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(cli.exitCode).toBe(0);
    expect(JSON.parse(new TextDecoder().decode(cli.stdout)).manifest.digest).toBe(manifest.manifest.digest);
    expect(snapshot(root)).toBe(before);
  });

  test("rejects an incomplete or tampered capture frame", async () => {
    expect(() => sealRecallCaptureFrame({ ...frameDraft(), turns: frameDraft().turns.slice(0, 29) })).toThrow(/30-50/);
    const { root, frame } = await fixture();
    const tampered = { ...frame, turns: [{ ...frame.turns[0]!, sourceCompletedAt: "2026-08-29T09:00:30.000Z" }, ...frame.turns.slice(1)] };
    expect(() => compileRecallAuthorityManifest({
      workspace: root,
      workspaceId: "main",
      runtimeSessionKey,
      captureFrame: tampered,
      compiledAt: "2026-08-29T10:00:00.000Z",
    })).toThrow(/does not match/);
    expect(parseRecallCaptureFrame(frame)).toEqual(frame);
  });

  test("keeps CLI failures content-free", () => {
    const root = workspace();
    const missingFrame = join(root, "private", "missing-frame.json");
    const cli = Bun.spawnSync({
      cmd: [
        process.execPath,
        join(import.meta.dir, "..", "scripts", "recall-authority-compile.ts"),
        "--workspace", root,
        "--workspace-id", "main",
        "--runtime-session-key", runtimeSessionKey,
        "--capture-frame", missingFrame,
        "--compiled-at", "2026-08-29T10:00:00.000Z",
      ],
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = new TextDecoder().decode(cli.stderr);
    expect(cli.exitCode).toBe(1);
    expect(stderr).toContain("capture frame is not valid JSON");
    expect(stderr).not.toContain(root);
    expect(stderr).not.toContain(missingFrame);
  });

  test("rejects mixed receipt policies instead of merging snapshots", async () => {
    const { root, frame } = await fixture();
    const receiptDirectory = join(root, "memory-state", "memory-observation", "v1", "receipts", "by-operation");
    const receiptPath = join(receiptDirectory, readdirSync(receiptDirectory).sort()[0]!);
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    writeJson(receiptPath, { ...receipt, policyDigest: sha256("different-policy") });
    expect(() => compileRecallAuthorityManifest({
      workspace: root,
      workspaceId: "main",
      runtimeSessionKey,
      captureFrame: frame,
      compiledAt: "2026-08-29T10:00:00.000Z",
    })).toThrow(/mixed policy snapshots/);
  });

  test("rejects a receipt whose canonical destination no longer reads back", async () => {
    const { root, frame } = await fixture();
    const notePath = join(root, "memory", "agent-main", "telegram-direct-100000001", "2026-08-29.md");
    writeFileSync(notePath, readFileSync(notePath, "utf8").replace("Canonical batch capture event 0.", "Tampered event."));
    expect(() => compileRecallAuthorityManifest({
      workspace: root,
      workspaceId: "main",
      runtimeSessionKey,
      captureFrame: frame,
      compiledAt: "2026-08-29T10:00:00.000Z",
    })).toThrow(/read back/);
  });

  test("rejects a self-consistent-looking but noncanonical skip trace", async () => {
    const { root, frame } = await fixture();
    const index = 20;
    const traceId = deriveTraceId(scope.workspaceId, runtimeSessionKey, sourceTurnId(index));
    const traceDirectory = join(root, "memory-state", "memory-observation", "v1", "traces", traceId.slice("sha256:".length));
    const tracePath = readdirSync(traceDirectory)
      .map((name) => join(traceDirectory, name))
      .find((path) => JSON.parse(readFileSync(path, "utf8")).stage === "observation_skipped")!;
    const trace = JSON.parse(readFileSync(tracePath, "utf8"));
    writeJson(tracePath, {
      ...trace,
      stageRef: {
        kind: "source-turn",
        ref: sourceTurnId(index),
        digest: deriveSourceDigest(sourceTurnId(index), scope, completedAt(index)),
      },
    });
    expect(() => compileRecallAuthorityManifest({
      workspace: root,
      workspaceId: "main",
      runtimeSessionKey,
      captureFrame: frame,
      compiledAt: "2026-08-29T10:00:00.000Z",
    })).toThrow(/trace is invalid/);
  });
});
