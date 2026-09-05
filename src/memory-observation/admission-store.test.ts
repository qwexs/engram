import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AdmissionStore,
  deriveAdmissionCandidateId,
  deriveAdmissionGapReceiptId,
  type AdmissionCheckpointV1,
} from "./admission-store.ts";
import { purgeMemoryObservationLifecycle, sha256, type ProducerRef } from "./ledger.ts";

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

const producer: ProducerRef = {
  id: "openclaw-runtime",
  version: "v1",
  digest: `sha256:${"a".repeat(64)}`,
};

function workspace(): string {
  const path = join(tmpdir(), `engram-admission-store-${crypto.randomUUID()}`);
  mkdirSync(path, { recursive: true });
  roots.push(path);
  return path;
}

function received(store: AdmissionStore, messageId = "42"): AdmissionCheckpointV1 {
  return store.recordCheckpoint({
    scope: {
      workspaceId: "fixture-main",
      runtimeSessionKey: "agent:main:telegram:direct:100000001",
      scopeClass: "self",
      scopeId: "telegram:100000001",
    },
    bindingFingerprint: sha256("binding"),
    channel: "telegram",
    inboundMessageId: messageId,
    actorId: "100000001",
    replyToId: null,
    sourceTurnId: null,
    runId: null,
    sessionId: null,
    sourceText: null,
    stage: "received",
    now: new Date("2026-09-06T00:00:00.000Z"),
  }).checkpoint;
}

function advance(store: AdmissionStore, checkpoint: AdmissionCheckpointV1, patch: Partial<AdmissionCheckpointV1>, now: string): AdmissionCheckpointV1 {
  const {
    schema: _schema,
    candidateId: _candidateId,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    expiresAt: _expiresAt,
    checkpointDigest: _checkpointDigest,
    ...content
  } = checkpoint;
  return store.recordCheckpoint({ ...content, ...patch, now: new Date(now) }).checkpoint;
}

describe("AdmissionStore", () => {
  test("derives exact candidate and gap identities deterministically", () => {
    const identity = {
      workspaceId: "fixture-main",
      runtimeSessionKey: "agent:main:telegram:direct:100000001",
      channel: "telegram" as const,
      inboundMessageId: "42",
    };
    const candidateId = deriveAdmissionCandidateId(identity);
    expect(deriveAdmissionCandidateId(identity)).toBe(candidateId);
    expect(deriveAdmissionCandidateId({ ...identity, inboundMessageId: "43" })).not.toBe(candidateId);
    expect(deriveAdmissionGapReceiptId(candidateId)).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  test("serializes process-level disposition attempts for one candidate", async () => {
    const root = workspace();
    const log = join(root, "disposition.log");
    const worker = join(root, "disposition-worker.ts");
    const modulePath = join(import.meta.dir, "admission-store.ts");
    writeFileSync(worker, `
      import { appendFileSync } from "node:fs";
      import { AdmissionStore } from ${JSON.stringify(modulePath)};
      const [root, candidateId, log, label, hold] = process.argv.slice(2);
      const store = new AdmissionStore(root, { id: "runtime", version: "v1", digest: "sha256:${"a".repeat(64)}" });
      store.withCandidateDisposition(candidateId, () => {
        appendFileSync(log, label + ":start\\n");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(hold));
        appendFileSync(log, label + ":end\\n");
      });
    `, "utf8");
    const candidateId = deriveAdmissionCandidateId({
      workspaceId: "fixture-main",
      runtimeSessionKey: "agent:main:telegram:direct:100000001",
      channel: "telegram",
      inboundMessageId: "42",
    });
    const first = Bun.spawn(["bun", worker, root, candidateId, log, "first", "300"], { stdout: "pipe", stderr: "pipe" });
    for (let attempt = 0; attempt < 100 && !existsSync(log); attempt++) await Bun.sleep(10);
    expect(existsSync(log)).toBe(true);
    const second = Bun.spawn(["bun", worker, root, candidateId, log, "second", "0"], { stdout: "pipe", stderr: "pipe" });
    expect(await first.exited).toBe(0);
    expect(await second.exited).toBe(0);
    expect(readFileSync(log, "utf8").trim().split("\n")).toEqual([
      "first:start",
      "first:end",
      "second:start",
      "second:end",
    ]);
  });

  test("persists monotonic checkpoints and rejects identity drift or regression", () => {
    const store = new AdmissionStore(workspace(), producer);
    const first = received(store);
    expect(store.recordCheckpoint({
      scope: first.scope,
      bindingFingerprint: first.bindingFingerprint,
      channel: first.channel,
      inboundMessageId: first.inboundMessageId,
      actorId: first.actorId,
      replyToId: first.replyToId,
      sourceTurnId: null,
      runId: null,
      sessionId: null,
      sourceText: null,
      stage: "received",
      now: new Date("2026-09-06T00:00:01.000Z"),
    }).status).toBe("duplicate");
    expect(() => store.recordCheckpoint({
      scope: first.scope,
      bindingFingerprint: first.bindingFingerprint,
      channel: first.channel,
      inboundMessageId: first.inboundMessageId,
      actorId: first.actorId,
      replyToId: "different-reply",
      sourceTurnId: null,
      runId: null,
      sessionId: null,
      sourceText: null,
      stage: "received",
      now: new Date("2026-09-06T00:00:01.000Z"),
    })).toThrow("reply identity changed");
    const persisted = advance(store, first, {
      sourceTurnId: `channel-user:v1:${"b".repeat(64)}`,
      sourceText: "sanitized source",
      stage: "persisted",
    }, "2026-09-06T00:00:02.000Z");
    expect(() => advance(store, persisted, { sourceText: "different source" }, "2026-09-06T00:00:02.500Z"))
      .toThrow("source evidence changed");
    const attached = advance(store, persisted, {
      runId: "run-1",
      sessionId: "session-1",
      stage: "run_attached",
    }, "2026-09-06T00:00:03.000Z");
    expect(store.findOpenByRun("run-1", ["run_attached"])).toHaveLength(1);
    expect(() => advance(store, attached, { stage: "persisted" }, "2026-09-06T00:00:04.000Z")).toThrow("stage regressed");
    expect(() => advance(store, attached, { runId: "run-2" }, "2026-09-06T00:00:04.000Z")).toThrow("run identity changed");
  });

  test("publishes one immutable content-free terminal gap receipt", () => {
    const store = new AdmissionStore(workspace(), producer);
    const persisted = advance(store, received(store), {
      sourceTurnId: `channel-user:v1:${"b".repeat(64)}`,
      sourceText: "private user content",
      stage: "persisted",
    }, "2026-09-06T00:00:02.000Z");
    const first = store.publishGapReceipt({
      checkpoint: persisted,
      failureStage: "persisted",
      reasonCode: "restart_before_completion",
      terminalAt: new Date("2026-09-06T00:01:00.000Z"),
    });
    expect(first.status).toBe("written");
    expect(first.checkpoint.stage).toBe("terminal_gap");
    expect(first.checkpoint.sourceText).toBeNull();
    const serialized = JSON.stringify(first.receipt);
    expect(serialized).not.toContain("private user content");
    expect(serialized).not.toContain("sourceText");
    expect(store.publishGapReceipt({
      checkpoint: first.checkpoint,
      failureStage: "persisted",
      reasonCode: "restart_before_completion",
      terminalAt: new Date("2026-09-06T00:01:00.000Z"),
    }).status).toBe("duplicate");
    expect(store.publishGapReceipt({
      checkpoint: first.checkpoint,
      failureStage: "persisted",
      reasonCode: "identity_conflict",
      terminalAt: new Date("2026-09-06T00:01:00.000Z"),
    }).receipt.reasonCode).toBe("restart_before_completion");
  });

  test("repairs the checkpoint after a crash between immutable receipt and terminal state", () => {
    const root = workspace();
    const crashing = new AdmissionStore(root, producer, (point) => {
      if (point === "after_gap_receipt") throw new Error("fault:after_gap_receipt");
    });
    const checkpoint = received(crashing);
    expect(() => crashing.publishGapReceipt({
      checkpoint,
      failureStage: "received",
      reasonCode: "delivery_failed",
      terminalAt: new Date("2026-09-06T00:01:00.000Z"),
    })).toThrow("fault:after_gap_receipt");

    const recovered = new AdmissionStore(root, producer);
    expect(recovered.scanCheckpoints().records[0]!.stage).toBe("received");
    expect(recovered.publishGapReceipt({
      checkpoint: recovered.scanCheckpoints().records[0]!,
      failureStage: "received",
      reasonCode: "restart_before_completion",
      terminalAt: new Date("2026-09-06T00:02:00.000Z"),
    })).toMatchObject({
      status: "duplicate",
      receipt: { reasonCode: "delivery_failed" },
      checkpoint: { stage: "terminal_gap", sourceText: null },
    });
  });

  test("isolates corrupt checkpoint and receipt records during scans", () => {
    const root = workspace();
    const store = new AdmissionStore(root, producer);
    received(store);
    const checkpointDir = join(root, "memory-state", "memory-observation", "v1", "pre-admission", "checkpoints");
    writeFileSync(join(checkpointDir, `${"c".repeat(64)}.json`), "{bad", "utf8");
    expect(store.scanCheckpoints()).toMatchObject({ records: [{ stage: "received" }], corrupt: [{ path: expect.any(String) }] });

    const terminal = store.publishGapReceipt({
      checkpoint: store.scanCheckpoints().records[0]!,
      failureStage: "received",
      reasonCode: "evidence_missing",
      terminalAt: new Date("2026-09-06T00:01:00.000Z"),
    });
    const receiptDir = join(root, "memory-state", "memory-observation", "v1", "receipts", "admission-gap");
    writeFileSync(join(receiptDir, `${"d".repeat(64)}.json`), "{}", "utf8");
    expect(store.scanGapReceipts().records).toEqual([terminal.receipt]);
    expect(store.scanGapReceipts().corrupt).toHaveLength(1);
  });

  test("retains terminal replay protection for 180 days and then purges it together", () => {
    const root = workspace();
    const store = new AdmissionStore(root, producer);
    const checkpoint = received(store);
    store.publishGapReceipt({
      checkpoint,
      failureStage: "received",
      reasonCode: "restart_before_completion",
      terminalAt: new Date("2026-09-06T00:01:00.000Z"),
    });
    expect(purgeMemoryObservationLifecycle(root, new Date("2026-10-07T00:01:00.001Z"))).toMatchObject({
      preAdmission: 0,
      receipts: 0,
    });
    expect(store.scanCheckpoints().records).toHaveLength(1);
    expect(store.scanGapReceipts().records).toHaveLength(1);
    expect(() => received(store)).toThrow("terminal gap receipt");
    expect(purgeMemoryObservationLifecycle(root, new Date("2027-03-05T00:01:00.001Z"))).toMatchObject({ receipts: 1 });
    expect(store.scanCheckpoints().records).toHaveLength(0);
    expect(store.scanGapReceipts().records).toHaveLength(0);
  });
});
