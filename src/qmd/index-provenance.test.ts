import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import { purgeMemoryObservationLifecycle, sha256, type Digest } from "../memory-observation/ledger.ts";
import type { MemoryApplyReceiptV1 } from "../memory-observation/daily-note-applicator.ts";
import { qmdMaintenancePaths } from "./maintenance.ts";
import {
  indexProvenancePaths,
  readIndexGeneration,
  reconcileIndexHandoffs,
  recordCanonicalIndexed,
  storeIndexHandoff,
  syntheticIndexContext,
} from "./index-provenance.ts";

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "engram-index-provenance-"));
  roots.push(root);
  return root;
}

const scope = {
  workspaceId: "main",
  runtimeSessionKey: "agent:main:telegram:direct:100000001",
  scopeClass: "self" as const,
  scopeId: "telegram:100000001",
};

function receipt(root: string, suffix = "one"): MemoryApplyReceiptV1 {
  const traceId = sha256(`trace-${suffix}`);
  const observationId = sha256(`observation-${suffix}`);
  const entryId = sha256(`entry-${suffix}`);
  const operationId = sha256(`engram.memory-apply.v1\0daily-note\0${observationId}\0${entryId}`);
  const rendered = `<!-- engram-entry:${entryId} -->\n- Indexed event ${suffix}.`;
  const path = join(root, "memory", "agent-main", "telegram-direct-100000001", "2026-09-06.md");
  mkdirSync(dirname(path), { recursive: true });
  const current = (() => { try { return readFileSync(path, "utf8"); } catch { return "# 2026-09-06\n\n## Events\n\n"; } })();
  writeFileSync(path, `${current}${rendered}\n\n`);
  const value: MemoryApplyReceiptV1 = {
    schema: "engram.memory-apply-receipt.v1",
    receiptId: sha256(`engram.memory-apply-receipt.v1\0${operationId}`),
    traceId,
    sourceObservationRef: observationId,
    sourceCompletedAt: "2026-09-06T00:00:00.000Z",
    scope,
    producer: { id: "daily-note-applicator", version: "v1", digest: "sha256:f9e632bc639b5f4240c15f4ac1fffb2ffa1c0b299a380d1432216c9a2c8b7ef5" },
    sourceProvenance: {
      sourceTurnId: `channel-user:v1:${"a".repeat(64)}`,
      producer: { id: "post-turn-observer", version: "v1", digest: sha256("observer") },
      observationClass: "episodic.event",
      evidenceRefs: [],
      observationDigest: sha256(`observation-digest-${suffix}`),
    },
    consumer: "daily-note",
    operationId,
    destinationDate: "2026-09-06",
    destinationRef: `memory/agent-main/telegram-direct-100000001/2026-09-06.md#engram-entry:${entryId}`,
    destinationEntryId: entryId,
    status: "applied",
    canonicalMutation: true,
    readBackDigest: sha256(rendered),
    policyDigest: sha256("policy"),
    completedAt: "2026-09-06T00:00:01.000Z",
  };
  const receiptPath = join(root, "memory-state", "memory-observation", "v1", "receipts", "by-operation", `${operationId.slice(7)}.json`);
  mkdirSync(dirname(receiptPath), { recursive: true });
  writeFileSync(receiptPath, `${JSON.stringify(value, null, 2)}\n`);
  return value;
}

function dirty(root: string, apply: MemoryApplyReceiptV1, generation = 1) {
  const indexKey = "f".repeat(64);
  const stateRoot = join(root, "qmd-maintenance");
  const markedAt = "2026-09-06T00:00:01.500Z";
  const reason = `memory-observation:index-handoff:${apply.receiptId}`;
  const statePath = qmdMaintenancePaths(stateRoot, indexKey).state;
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, `${JSON.stringify({
    schema: "engram.qmd.maintenance-state.v1", indexKey, generation,
    updateCompletedGeneration: 0, embedCompletedGeneration: 0,
    dirty: { bm25: true, vectors: true, collections: ["main-direct-memory"], reasons: [{ generation, reason, markedAt }] },
    lastUpdateAt: null, lastEmbedAt: null, lastError: null,
  }, null, 2)}\n`);
  return {
    schema: "engram.qmd.dirty-mark.v1" as const,
    status: "marked" as const,
    mode: "coordinated" as const,
    workspace: root,
    indexKey,
    generation,
    collections: ["main-direct-memory"],
    stateRoot,
    reason,
    markedAt,
  };
}

function createIndex(root: string, document: string, collection = "main-direct-memory", embedded = true): string {
  const path = join(root, "index.sqlite");
  const db = new Database(path, { create: true });
  db.run("CREATE TABLE store_collections(name TEXT, path TEXT, pattern TEXT)");
  db.run("CREATE TABLE documents(id INTEGER, collection TEXT, path TEXT, hash TEXT, modified_at TEXT, active INTEGER)");
  db.run("CREATE TABLE content(hash TEXT, doc TEXT)");
  db.run("CREATE TABLE content_vectors(hash TEXT)");
  const canonicalRoot = join(root, "memory", "agent-main", "telegram-direct-100000001");
  const hash = sha256(document);
  db.run("INSERT INTO store_collections VALUES (?, ?, ?)", [collection, canonicalRoot, "*.md"]);
  db.run("INSERT INTO content VALUES (?, ?)", [hash, document]);
  db.run("INSERT INTO documents VALUES (?, ?, ?, ?, ?, ?)", [1, collection, "2026-09-06.md", hash, "2026-09-06T00:01:00.000Z", 1]);
  if (embedded) db.run("INSERT INTO content_vectors VALUES (?)", [hash]);
  db.close();
  return path;
}

describe("memory observation QMD index provenance", () => {
  test("joins one apply receipt to an exact indexed entry and replays idempotently", () => {
    const root = workspace();
    const apply = receipt(root);
    const handoff = storeIndexHandoff({ workspace: root, applyReceipt: apply, dirtyMark: dirty(root, apply), recordedAt: "2026-09-06T00:00:02.000Z" });
    expect(storeIndexHandoff({ workspace: root, applyReceipt: apply, dirtyMark: dirty(root, apply), recordedAt: "2026-09-06T00:09:00.000Z" })).toEqual(handoff);
    const indexPath = createIndex(root, readFileSync(join(root, "memory", "agent-main", "telegram-direct-100000001", "2026-09-06.md"), "utf8"));
    const context = syntheticIndexContext(root, indexPath, "f".repeat(64));

    expect(recordCanonicalIndexed({ workspace: root, handoff, context, completedMaintenanceGeneration: 0 }).status).toBe("deferred");
    const indexed = recordCanonicalIndexed({ workspace: root, handoff, context, completedMaintenanceGeneration: 1, completedAt: "2026-09-06T00:02:00.000Z" });
    expect(indexed.status).toBe("indexed");
    expect(indexed.receipt).toMatchObject({
      schema: "qmd.index-generation.v1",
      traceId: apply.traceId,
      applyReceiptId: apply.receiptId,
      canonicalRef: apply.destinationRef,
      canonicalDigest: apply.readBackDigest,
      index: { generation: 1, collection: "main-direct-memory" },
    });
    expect(recordCanonicalIndexed({ workspace: root, handoff, context, completedMaintenanceGeneration: 1 }).status).toBe("duplicate");
    expect(readIndexGeneration(root, apply.receiptId)?.generationDigest).toBe(indexed.receipt?.generationDigest);
    const traceFiles = readdirSync(join(indexProvenancePaths(root).traces, apply.traceId.slice(7)));
    const trace = JSON.parse(readFileSync(join(indexProvenancePaths(root).traces, apply.traceId.slice(7), traceFiles[0]!), "utf8"));
    expect(trace).toMatchObject({ stage: "canonical_indexed", stageRef: { kind: "index-generation", ref: indexed.receipt?.generationId }, verification: null });
    expect(JSON.stringify(indexed.receipt)).not.toContain("Indexed event");
  });

  test("isolates a corrupt handoff and refuses stale indexed content", () => {
    const root = workspace();
    const apply = receipt(root, "valid");
    storeIndexHandoff({ workspace: root, applyReceipt: apply, dirtyMark: dirty(root, apply), recordedAt: "2026-09-06T00:00:02.000Z" });
    const paths = indexProvenancePaths(root);
    writeFileSync(join(paths.handoffs, "0000000000000000000000000000000000000000000000000000000000000000.json"), "{broken\n");
    const indexPath = createIndex(root, readFileSync(join(root, "memory", "agent-main", "telegram-direct-100000001", "2026-09-06.md"), "utf8").replace("Indexed event valid.", "Stale event."));
    const result = reconcileIndexHandoffs({
      workspace: root,
      context: syntheticIndexContext(root, indexPath, "f".repeat(64)),
      completedMaintenanceGeneration: 1,
      completedAt: "2026-09-06T00:02:00.000Z",
    });
    expect(result).toMatchObject({ scanned: 2, indexed: 0, failed: 2 });
    expect(result.failures.map((entry) => entry.code).sort()).toEqual(["INDEX_ENTRY_STALE", "INDEX_RECONCILE_FAILED"]);
  });

  test("requires durable apply and dirty predecessors before publishing a handoff", () => {
    const root = workspace();
    const apply = receipt(root, "predecessors");
    const receiptPath = join(root, "memory-state", "memory-observation", "v1", "receipts", "by-operation", `${apply.operationId.slice(7)}.json`);
    unlinkSync(receiptPath);
    expect(() => storeIndexHandoff({ workspace: root, applyReceipt: apply, dirtyMark: dirty(root, apply) }))
      .toThrow("immutable apply receipt is absent");
    writeFileSync(receiptPath, `${JSON.stringify(apply, null, 2)}\n`);
    const fabricated = { ...dirty(root, apply), stateRoot: join(root, "missing-state") };
    expect(() => storeIndexHandoff({ workspace: root, applyReceipt: apply, dirtyMark: fabricated }))
      .toThrow("dirty generation is absent");
  });

  test("accepts a same-root physical-index rotation only after exact read-back", () => {
    const root = workspace();
    const apply = receipt(root, "rotation");
    const handoff = storeIndexHandoff({ workspace: root, applyReceipt: apply, dirtyMark: dirty(root, apply) });
    const notePath = join(root, "memory", "agent-main", "telegram-direct-100000001", "2026-09-06.md");
    const indexPath = createIndex(root, readFileSync(notePath, "utf8"), "main-direct-memory-v2");
    const rotatedKey = "e".repeat(64);
    const result = recordCanonicalIndexed({
      workspace: root,
      handoff,
      context: syntheticIndexContext(root, indexPath, rotatedKey),
      completedMaintenanceGeneration: 0,
      allowedCollections: ["main-direct-memory-v2"],
      completedAt: "2026-09-06T00:03:00.000Z",
    });
    expect(result.status).toBe("indexed");
    expect(result.receipt?.index).toMatchObject({ indexKey: rotatedKey, collection: "main-direct-memory-v2", generation: 0 });
  });

  test("refuses a BM25-only physical-index rotation without an exact vector", () => {
    const root = workspace();
    const apply = receipt(root, "rotation-without-vector");
    const handoff = storeIndexHandoff({ workspace: root, applyReceipt: apply, dirtyMark: dirty(root, apply) });
    const notePath = join(root, "memory", "agent-main", "telegram-direct-100000001", "2026-09-06.md");
    const indexPath = createIndex(root, readFileSync(notePath, "utf8"), "main-direct-memory-v2", false);
    expect(() => recordCanonicalIndexed({
      workspace: root,
      handoff,
      context: syntheticIndexContext(root, indexPath, "e".repeat(64)),
      completedMaintenanceGeneration: 0,
      allowedCollections: ["main-direct-memory-v2"],
    })).toThrow("no exact vector");
  });

  test("purges content-free QMD provenance at the declared 180-day boundary", () => {
    const root = workspace();
    const apply = receipt(root, "retention");
    const handoff = storeIndexHandoff({
      workspace: root,
      applyReceipt: apply,
      dirtyMark: dirty(root, apply),
      recordedAt: "2026-01-01T00:00:00.000Z",
    });
    const indexPath = createIndex(root, readFileSync(join(root, "memory", "agent-main", "telegram-direct-100000001", "2026-09-06.md"), "utf8"));
    recordCanonicalIndexed({
      workspace: root,
      handoff,
      context: syntheticIndexContext(root, indexPath, "f".repeat(64)),
      completedMaintenanceGeneration: 1,
      completedAt: "2026-01-01T00:01:00.000Z",
    });
    expect(purgeMemoryObservationLifecycle(root, new Date("2026-07-01T00:01:00.001Z"))).toMatchObject({ receipts: 2 });
    expect(existsSync(indexProvenancePaths(root).handoffs)).toBe(true);
    expect(readdirSync(indexProvenancePaths(root).handoffs)).toHaveLength(0);
    expect(readdirSync(indexProvenancePaths(root).generations)).toHaveLength(0);
  });

  test("retains the complete predecessor chain while a newer generation remains auditable", () => {
    const root = workspace();
    const apply = receipt(root, "retention-chain");
    apply.completedAt = "2025-12-01T00:00:00.000Z";
    const applyPath = join(root, "memory-state", "memory-observation", "v1", "receipts", "by-operation", `${apply.operationId.slice(7)}.json`);
    writeFileSync(applyPath, `${JSON.stringify(apply, null, 2)}\n`);
    const handoff = storeIndexHandoff({
      workspace: root,
      applyReceipt: apply,
      dirtyMark: dirty(root, apply),
      recordedAt: "2025-12-02T00:00:00.000Z",
    });
    const indexPath = createIndex(root, readFileSync(join(root, "memory", "agent-main", "telegram-direct-100000001", "2026-09-06.md"), "utf8"));
    recordCanonicalIndexed({
      workspace: root,
      handoff,
      context: syntheticIndexContext(root, indexPath, "f".repeat(64)),
      completedMaintenanceGeneration: 1,
      completedAt: "2026-06-30T00:00:00.000Z",
    });

    expect(purgeMemoryObservationLifecycle(root, new Date("2026-07-01T00:00:00.000Z"))).toMatchObject({ receipts: 0 });
    expect(existsSync(applyPath)).toBe(true);
    expect(readIndexGeneration(root, apply.receiptId)).not.toBeNull();
    expect(readdirSync(indexProvenancePaths(root).handoffs)).toHaveLength(1);

    expect(purgeMemoryObservationLifecycle(root, new Date("2027-01-01T00:00:00.000Z"))).toMatchObject({ receipts: 3 });
    expect(existsSync(applyPath)).toBe(false);
    expect(readdirSync(indexProvenancePaths(root).handoffs)).toHaveLength(0);
    expect(readdirSync(indexProvenancePaths(root).generations)).toHaveLength(0);
  });
});
