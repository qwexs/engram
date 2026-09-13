import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Database } from "bun:sqlite";
import type { MemoryApplyReceiptV1 } from "../memory-observation/daily-note-applicator.ts";
import { deriveTraceEventId, sha256, type Digest, type JsonValue, type ObservationScope, type ProducerRef, type TraceEventV1 } from "../memory-observation/ledger.ts";
import type { WorkspaceDirtyMarkResult } from "./maintenance-integration.ts";
import { readQmdMaintenanceState } from "./maintenance.ts";
import type { QmdContext } from "./types.ts";

export const MEMORY_INDEX_HANDOFF_SCHEMA = "engram.memory-index-handoff.v1" as const;
export const QMD_INDEX_GENERATION_SCHEMA = "qmd.index-generation.v1" as const;

export const QMD_INDEXER: ProducerRef = {
  id: "qmd-indexer",
  version: "v1",
  digest: "sha256:c4a63d368a772e949b7b56f4dcd2918985fffc464f5dc6051ce94e73377a7c41",
};

export type MemoryIndexHandoffV1 = {
  schema: typeof MEMORY_INDEX_HANDOFF_SCHEMA;
  handoffId: Digest;
  handoffDigest: Digest;
  traceId: Digest;
  applyReceiptId: Digest;
  canonicalRef: string;
  canonicalDigest: Digest;
  scope: ObservationScope;
  producer: ProducerRef;
  policyDigest: Digest;
  index: {
    indexKey: string;
    collection: string;
    canonicalRoot: string;
    generation: number;
    bindingDigest: Digest;
  };
  createdAt: string;
};

export type QmdIndexGenerationV1 = {
  schema: typeof QMD_INDEX_GENERATION_SCHEMA;
  generationId: Digest;
  generationDigest: Digest;
  traceId: Digest;
  handoffId: Digest;
  applyReceiptId: Digest;
  canonicalRef: string;
  canonicalDigest: Digest;
  scope: ObservationScope;
  producer: ProducerRef;
  policyDigest: Digest;
  index: {
    indexKey: string;
    collection: string;
    canonicalRoot: string;
    generation: number;
    snapshotDigest: Digest;
  };
  verification: { source: "deterministic-check"; digest: Digest };
  completedAt: string;
};

export type IndexProvenanceReconcileResult = {
  scanned: number;
  indexed: number;
  duplicate: number;
  deferred: number;
  failed: number;
  failures: Array<{ handoffId: Digest | null; code: string }>;
};

export class IndexProvenanceError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "IndexProvenanceError";
  }
}

const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const INDEX_KEY_RE = /^[a-f0-9]{64}$/;
const ROOT_SEGMENTS = ["memory-state", "memory-observation", "v1"] as const;
const DAILY_NOTE_APPLICATOR: ProducerRef = {
  id: "daily-note-applicator",
  version: "v1",
  digest: "sha256:f9e632bc639b5f4240c15f4ac1fffb2ffa1c0b299a380d1432216c9a2c8b7ef5",
};
type VerifiedDirtyMark = WorkspaceDirtyMarkResult & {
  status: "marked";
  indexKey: string;
  generation: number;
  collections: [string];
  stateRoot: string;
  reason: string;
  markedAt: string;
};

function fail(code: string, message: string): never {
  throw new IndexProvenanceError(code, message);
}

function digestKey(value: Digest): string {
  return value.slice("sha256:".length);
}

function validInstant(value: string): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function same(left: unknown, right: unknown): boolean {
  return sha256(left as JsonValue) === sha256(right as JsonValue);
}

function validScope(value: unknown): value is ObservationScope {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const scope = value as Record<string, unknown>;
  return Object.keys(scope).length === 4
    && typeof scope.workspaceId === "string" && scope.workspaceId.length > 0
    && typeof scope.runtimeSessionKey === "string" && scope.runtimeSessionKey.startsWith("agent:")
    && ["self", "managers", "company", "project"].includes(String(scope.scopeClass))
    && typeof scope.scopeId === "string" && scope.scopeId.length > 0;
}

function validProducer(value: unknown, expected: ProducerRef): boolean {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && same(value, expected));
}

function inside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function writeImmutable(path: string, value: unknown): boolean {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  let published = false;
  let descriptor: number | null = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(descriptor, payload);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    try {
      if (process.platform === "win32") {
        const target = openSync(path, "wx", 0o600);
        try { writeFileSync(target, payload); fsyncSync(target); }
        finally { closeSync(target); }
      } else {
        linkSync(temporary, path);
      }
      published = true;
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
    }
  } finally {
    if (descriptor !== null) closeSync(descriptor);
    try { unlinkSync(temporary); } catch (error: any) { if (error?.code !== "ENOENT") throw error; }
  }
  if (process.platform !== "win32") {
    const directory = openSync(dirname(path), "r");
    try { fsyncSync(directory); } finally { closeSync(directory); }
  }
  return published;
}

function handoffPayload(value: Omit<MemoryIndexHandoffV1, "handoffDigest">): JsonValue {
  return value as unknown as JsonValue;
}

function generationPayload(value: Omit<QmdIndexGenerationV1, "generationDigest">): JsonValue {
  return value as unknown as JsonValue;
}

function rootForCanonicalRef(workspace: string, canonicalRef: string): { path: string; root: string; entryId: Digest } {
  const normalizedRef = canonicalRef.replaceAll("\\", "/");
  const match = /^(memory\/[A-Za-z0-9._/-]+\.md)#engram-entry:(sha256:[a-f0-9]{64})$/.exec(normalizedRef);
  if (!match) fail("CANONICAL_REF_INVALID", "canonical reference is invalid");
  const canonicalWorkspace = realpathSync(resolve(workspace));
  const path = realpathSync(resolve(canonicalWorkspace, match[1]!));
  if (!inside(canonicalWorkspace, path)) fail("CANONICAL_REF_ESCAPE", "canonical reference escapes the workspace");
  return { path, root: realpathSync(dirname(path)), entryId: match[2]! as Digest };
}

function authoritativeApplyReceipt(workspace: string, candidate: MemoryApplyReceiptV1): MemoryApplyReceiptV1 {
  if (!DIGEST_RE.test(candidate.operationId) || !DIGEST_RE.test(candidate.receiptId)) {
    fail("APPLY_RECEIPT_INVALID", "apply receipt identity is invalid");
  }
  const path = join(resolve(workspace), ...ROOT_SEGMENTS, "receipts", "by-operation", `${digestKey(candidate.operationId)}.json`);
  if (!existsSync(path)) fail("APPLY_RECEIPT_MISSING", "immutable apply receipt is absent");
  const stored = JSON.parse(readFileSync(path, "utf8")) as MemoryApplyReceiptV1;
  if (!same(stored, candidate)
    || stored.receiptId !== sha256(`engram.memory-apply-receipt.v1\0${stored.operationId}`)
    || stored.schema !== "engram.memory-apply-receipt.v1" || stored.status !== "applied"
    || stored.canonicalMutation !== true || !DIGEST_RE.test(stored.readBackDigest)
    || !validScope(stored.scope) || !validProducer(stored.producer, DAILY_NOTE_APPLICATOR)) {
    fail("APPLY_RECEIPT_INVALID", "apply receipt does not match the authoritative immutable record");
  }
  const canonical = rootForCanonicalRef(workspace, stored.destinationRef);
  const document = readFileSync(canonical.path, "utf8");
  const rendered = renderedEntry(document, canonical.entryId);
  if (!rendered || sha256(rendered) !== stored.readBackDigest) {
    fail("APPLY_RECEIPT_STALE", "canonical destination no longer matches the apply receipt");
  }
  return stored;
}

function verifyDirtyPredecessor(
  workspace: string,
  receipt: MemoryApplyReceiptV1,
  dirty: WorkspaceDirtyMarkResult,
): asserts dirty is VerifiedDirtyMark {
  const expectedReason = `memory-observation:index-handoff:${receipt.receiptId}`;
  if (dirty.status !== "marked" || !dirty.indexKey || !INDEX_KEY_RE.test(dirty.indexKey)
    || !dirty.generation || !Number.isSafeInteger(dirty.generation)
    || !dirty.collections || dirty.collections.length !== 1
    || resolve(dirty.workspace) !== resolve(workspace)
    || typeof dirty.stateRoot !== "string" || !isAbsolute(dirty.stateRoot)
    || dirty.reason !== expectedReason || !dirty.markedAt || !validInstant(dirty.markedAt)) {
    fail("DIRTY_MARK_INVALID", "index handoff requires one exact durable dirty mark");
  }
  const state = readQmdMaintenanceState(dirty.stateRoot, dirty.indexKey);
  const durableReason = state.dirty.reasons.find((entry) => entry.generation === dirty.generation && entry.reason === expectedReason);
  if (state.indexKey !== dirty.indexKey || state.generation < dirty.generation
    || !state.dirty.collections.includes(dirty.collections[0]!)
    || durableReason?.markedAt !== dirty.markedAt) {
    fail("DIRTY_MARK_UNVERIFIED", "dirty generation is absent from authoritative maintenance state");
  }
}

function validateHandoff(value: MemoryIndexHandoffV1): MemoryIndexHandoffV1 {
  const { handoffDigest, ...base } = value;
  if (value.schema !== MEMORY_INDEX_HANDOFF_SCHEMA
    || !DIGEST_RE.test(value.handoffId) || !DIGEST_RE.test(value.handoffDigest)
    || !DIGEST_RE.test(value.traceId) || !DIGEST_RE.test(value.applyReceiptId)
    || !DIGEST_RE.test(value.canonicalDigest) || !DIGEST_RE.test(value.policyDigest)
    || !validScope(value.scope) || !validProducer(value.producer, DAILY_NOTE_APPLICATOR)
    || typeof value.canonicalRef !== "string" || typeof value.index?.collection !== "string"
    || typeof value.index?.canonicalRoot !== "string"
    || !INDEX_KEY_RE.test(value.index.indexKey) || !DIGEST_RE.test(value.index.bindingDigest)
    || !Number.isSafeInteger(value.index.generation) || value.index.generation < 1
    || !validInstant(value.createdAt)
    || value.handoffId !== sha256(`${MEMORY_INDEX_HANDOFF_SCHEMA}\0${value.applyReceiptId}`)
    || handoffDigest !== sha256(handoffPayload(base))) {
    fail("HANDOFF_INVALID", "index handoff is invalid");
  }
  return value;
}

function validateGeneration(value: QmdIndexGenerationV1): QmdIndexGenerationV1 {
  const { generationDigest, ...base } = value;
  if (value.schema !== QMD_INDEX_GENERATION_SCHEMA
    || !DIGEST_RE.test(value.generationId) || !DIGEST_RE.test(value.generationDigest)
    || !DIGEST_RE.test(value.traceId) || !DIGEST_RE.test(value.handoffId)
    || !DIGEST_RE.test(value.applyReceiptId) || !DIGEST_RE.test(value.canonicalDigest)
    || !DIGEST_RE.test(value.policyDigest) || !DIGEST_RE.test(value.index.snapshotDigest)
    || !validScope(value.scope) || !validProducer(value.producer, QMD_INDEXER)
    || typeof value.canonicalRef !== "string" || typeof value.index?.collection !== "string"
    || typeof value.index?.canonicalRoot !== "string"
    || !INDEX_KEY_RE.test(value.index.indexKey)
    || !Number.isSafeInteger(value.index.generation) || value.index.generation < 0
    || value.verification.source !== "deterministic-check" || value.verification.digest !== value.canonicalDigest
    || !validInstant(value.completedAt)
    || value.generationId !== sha256(`${QMD_INDEX_GENERATION_SCHEMA}\0${value.handoffId}`)
    || generationDigest !== sha256(generationPayload(base))) {
    fail("GENERATION_INVALID", "index generation receipt is invalid");
  }
  return value;
}

export function indexProvenancePaths(workspace: string) {
  const root = join(resolve(workspace), ...ROOT_SEGMENTS);
  return {
    root,
    handoffs: join(root, "qmd", "index-handoffs"),
    generations: join(root, "qmd", "index-generations"),
    traces: join(root, "traces"),
  };
}

export function readIndexHandoff(workspace: string, applyReceiptId: Digest): MemoryIndexHandoffV1 | null {
  const handoffId = sha256(`${MEMORY_INDEX_HANDOFF_SCHEMA}\0${applyReceiptId}`);
  const path = join(indexProvenancePaths(workspace).handoffs, `${digestKey(handoffId)}.json`);
  return existsSync(path) ? validateHandoff(JSON.parse(readFileSync(path, "utf8")) as MemoryIndexHandoffV1) : null;
}

export function readIndexGeneration(workspace: string, applyReceiptId: Digest): QmdIndexGenerationV1 | null {
  const handoffId = sha256(`${MEMORY_INDEX_HANDOFF_SCHEMA}\0${applyReceiptId}`);
  const generationId = sha256(`${QMD_INDEX_GENERATION_SCHEMA}\0${handoffId}`);
  const path = join(indexProvenancePaths(workspace).generations, `${digestKey(generationId)}.json`);
  return existsSync(path) ? validateGeneration(JSON.parse(readFileSync(path, "utf8")) as QmdIndexGenerationV1) : null;
}

export function storeIndexHandoff(input: {
  workspace: string;
  applyReceipt: MemoryApplyReceiptV1;
  dirtyMark: WorkspaceDirtyMarkResult;
  bindingDigest?: Digest;
  recordedAt?: string;
}): MemoryIndexHandoffV1 {
  const workspace = resolve(input.workspace);
  const receipt = authoritativeApplyReceipt(workspace, input.applyReceipt);
  const dirty = input.dirtyMark;
  verifyDirtyPredecessor(workspace, receipt, dirty);
  const canonical = rootForCanonicalRef(workspace, receipt.destinationRef);
  const bindingDigest = input.bindingDigest ?? receipt.qmdBinding?.bindingDigest ?? sha256([
    "engram.memory-observation-qmd-static-binding.v1",
    dirty.indexKey,
    dirty.collections[0]!,
    canonical.root,
    receipt.scope.runtimeSessionKey,
  ].join("\0"));
  const handoffId = sha256(`${MEMORY_INDEX_HANDOFF_SCHEMA}\0${receipt.receiptId}`);
  const existing = readIndexHandoff(workspace, receipt.receiptId);
  if (existing) {
    if (existing.handoffId !== handoffId || existing.traceId !== receipt.traceId
      || existing.canonicalRef !== receipt.destinationRef || existing.canonicalDigest !== receipt.readBackDigest
      || !same(existing.scope, receipt.scope) || existing.policyDigest !== receipt.policyDigest
      || existing.index.indexKey !== dirty.indexKey || existing.index.collection !== dirty.collections[0]
      || existing.index.canonicalRoot !== canonical.root || existing.index.bindingDigest !== bindingDigest) {
      fail("CONTENT_CONFLICT", "existing index handoff has different authoritative content");
    }
    return existing;
  }
  const base = {
    schema: MEMORY_INDEX_HANDOFF_SCHEMA,
    handoffId,
    traceId: receipt.traceId,
    applyReceiptId: receipt.receiptId,
    canonicalRef: receipt.destinationRef,
    canonicalDigest: receipt.readBackDigest,
    scope: receipt.scope,
    producer: receipt.producer,
    policyDigest: receipt.policyDigest,
    index: {
      indexKey: dirty.indexKey,
      collection: dirty.collections[0]!,
      canonicalRoot: canonical.root,
      generation: dirty.generation,
      bindingDigest,
    },
    createdAt: input.recordedAt ?? new Date().toISOString(),
  };
  const handoff: MemoryIndexHandoffV1 = { ...base, handoffDigest: sha256(handoffPayload(base)) };
  const path = join(indexProvenancePaths(workspace).handoffs, `${digestKey(handoffId)}.json`);
  if (!writeImmutable(path, handoff) && !same(validateHandoff(JSON.parse(readFileSync(path, "utf8"))), handoff)) {
    fail("CONTENT_CONFLICT", "index handoff publication conflicted");
  }
  return handoff;
}

function renderedEntry(doc: string, entryId: Digest): string | null {
  const lines = doc.split(/\r?\n/);
  const start = lines.indexOf(`<!-- engram-entry:${entryId} -->`);
  if (start < 0 || !lines[start + 1]?.startsWith("- ")) return null;
  const entry = [lines[start]!, lines[start + 1]!];
  for (let cursor = start + 2; cursor < lines.length && lines[cursor]!.startsWith("  "); cursor++) entry.push(lines[cursor]!);
  return entry.join("\n");
}

function verifyIndexed(
  workspace: string,
  context: QmdContext,
  handoff: MemoryIndexHandoffV1,
  allowedCollections?: readonly string[],
  requireVectorProof = false,
): { snapshotDigest: Digest; collection: string } {
  if (!context.physicalIndex.exists) fail("INDEX_UNAVAILABLE", "physical index is unavailable");
  const canonical = rootForCanonicalRef(workspace, handoff.canonicalRef);
  if (canonical.root !== resolve(handoff.index.canonicalRoot)) fail("SCOPE_MISMATCH", "handoff canonical root is inconsistent");
  let db: Database | undefined;
  try {
    db = new Database(context.physicalIndex.path, { readonly: true, strict: true });
    const allowed = allowedCollections ? new Set(allowedCollections) : null;
    const collections = db.query("SELECT name, path, pattern FROM store_collections").all() as Array<{ name: string; path: string; pattern: string }>;
    const candidates = collections.filter((entry) => (!allowed || allowed.has(entry.name))
      && realpathSync(resolve(entry.path)) === canonical.root);
    const collection = candidates.find((entry) => entry.name === handoff.index.collection)
      ?? (candidates.length === 1 ? candidates[0] : null);
    if (!collection) fail("COLLECTION_MISMATCH", "QMD collection does not resolve uniquely to the exact canonical root");
    const relativePath = relative(canonical.root, canonical.path).replaceAll("\\", "/");
    const document = db.query("SELECT d.hash, d.modified_at AS modifiedAt, c.doc FROM documents d JOIN content c ON c.hash = d.hash WHERE d.collection = ? AND d.path = ? AND d.active = 1").get(collection.name, relativePath) as { hash: string; modifiedAt: string | null; doc: string } | null;
    if (!document) fail("INDEX_ENTRY_MISSING", "canonical entry is absent from the active QMD document set");
    const entry = renderedEntry(document.doc, canonical.entryId);
    if (!entry || sha256(entry) !== handoff.canonicalDigest) fail("INDEX_ENTRY_STALE", "indexed canonical entry digest is stale");
    const vector = requireVectorProof
      ? db.query("SELECT 1 AS present FROM content_vectors WHERE hash = ? LIMIT 1").get(document.hash) as { present: number } | null
      : null;
    if (requireVectorProof && vector?.present !== 1) {
      fail("INDEX_VECTOR_MISSING", "rotated QMD index has no exact vector for the canonical document");
    }
    return { collection: collection.name, snapshotDigest: sha256({
      indexKey: context.physicalIndex.key,
      collection: collection.name,
      canonicalRoot: canonical.root,
      path: relativePath,
      documentHash: document.hash,
      modifiedAt: document.modifiedAt,
      canonicalDigest: handoff.canonicalDigest,
      vectorVerified: requireVectorProof,
    } as unknown as JsonValue) };
  } catch (error) {
    if (error instanceof IndexProvenanceError) throw error;
    return fail("INDEX_UNREADABLE", "physical QMD index cannot be verified");
  } finally { db?.close(); }
}

function persistIndexedTrace(workspace: string, receipt: QmdIndexGenerationV1): void {
  const eventId = deriveTraceEventId(receipt.traceId, "canonical_indexed", receipt.generationDigest);
  const event: TraceEventV1 = {
    schema: "engram.memory-trace-event.v1",
    eventId,
    traceId: receipt.traceId,
    stage: "canonical_indexed",
    scope: receipt.scope,
    producer: QMD_INDEXER,
    stageRef: { kind: "index-generation", ref: receipt.generationId, digest: receipt.generationDigest },
    recordedAt: receipt.completedAt,
    policyDigest: receipt.policyDigest,
    reasonCode: "canonical_entry_indexed",
    verification: null,
  };
  const path = join(indexProvenancePaths(workspace).traces, digestKey(receipt.traceId), `${digestKey(eventId)}.json`);
  if (!writeImmutable(path, event) && !same(JSON.parse(readFileSync(path, "utf8")), event)) fail("CONTENT_CONFLICT", "canonical_indexed trace conflicted");
}

export function recordCanonicalIndexed(input: {
  workspace: string;
  handoff: MemoryIndexHandoffV1;
  context: QmdContext;
  completedMaintenanceGeneration: number;
  allowedCollections?: string[];
  completedAt?: string;
}): { status: "indexed" | "duplicate" | "deferred"; receipt?: QmdIndexGenerationV1 } {
  const workspace = resolve(input.workspace);
  const handoff = validateHandoff(input.handoff);
  if (!INDEX_KEY_RE.test(input.context.physicalIndex.key)) fail("INDEX_UNAVAILABLE", "physical index identity is invalid");
  if (!Number.isSafeInteger(input.completedMaintenanceGeneration) || input.completedMaintenanceGeneration < 0) return { status: "deferred" };
  if (input.context.physicalIndex.key === handoff.index.indexKey
    && input.completedMaintenanceGeneration < handoff.index.generation) return { status: "deferred" };
  const existing = readIndexGeneration(workspace, handoff.applyReceiptId);
  if (existing) {
    if (existing.handoffId !== handoff.handoffId || existing.canonicalDigest !== handoff.canonicalDigest || !same(existing.scope, handoff.scope)) fail("CONTENT_CONFLICT", "existing index receipt does not match its handoff");
    persistIndexedTrace(workspace, existing);
    return { status: "duplicate", receipt: existing };
  }
  const rotated = input.context.physicalIndex.key !== handoff.index.indexKey;
  const verified = verifyIndexed(workspace, input.context, handoff, input.allowedCollections, rotated);
  const generationId = sha256(`${QMD_INDEX_GENERATION_SCHEMA}\0${handoff.handoffId}`);
  const base = {
    schema: QMD_INDEX_GENERATION_SCHEMA,
    generationId,
    traceId: handoff.traceId,
    handoffId: handoff.handoffId,
    applyReceiptId: handoff.applyReceiptId,
    canonicalRef: handoff.canonicalRef,
    canonicalDigest: handoff.canonicalDigest,
    scope: handoff.scope,
    producer: QMD_INDEXER,
    policyDigest: handoff.policyDigest,
    index: {
      indexKey: input.context.physicalIndex.key,
      collection: verified.collection,
      canonicalRoot: handoff.index.canonicalRoot,
      generation: input.context.physicalIndex.key === handoff.index.indexKey
        ? handoff.index.generation
        : input.completedMaintenanceGeneration,
      snapshotDigest: verified.snapshotDigest,
    },
    verification: { source: "deterministic-check" as const, digest: handoff.canonicalDigest },
    completedAt: input.completedAt ?? new Date().toISOString(),
  };
  const receipt: QmdIndexGenerationV1 = { ...base, generationDigest: sha256(generationPayload(base)) };
  const path = join(indexProvenancePaths(workspace).generations, `${digestKey(generationId)}.json`);
  if (!writeImmutable(path, receipt) && !same(validateGeneration(JSON.parse(readFileSync(path, "utf8"))), receipt)) fail("CONTENT_CONFLICT", "index generation publication conflicted");
  persistIndexedTrace(workspace, receipt);
  return { status: "indexed", receipt };
}

export function reconcileIndexHandoffs(input: {
  workspace: string;
  context: QmdContext;
  completedMaintenanceGeneration: number;
  collections?: string[];
  completedAt?: string;
}): IndexProvenanceReconcileResult {
  const paths = indexProvenancePaths(input.workspace);
  const names = existsSync(paths.handoffs) ? readdirSync(paths.handoffs).filter((name) => name.endsWith(".json")).sort() : [];
  const allowed = input.collections ? new Set(input.collections) : null;
  const result: IndexProvenanceReconcileResult = { scanned: names.length, indexed: 0, duplicate: 0, deferred: 0, failed: 0, failures: [] };
  for (const name of names) {
    let handoffId: Digest | null = null;
    try {
      const handoff = validateHandoff(JSON.parse(readFileSync(join(paths.handoffs, name), "utf8")) as MemoryIndexHandoffV1);
      handoffId = handoff.handoffId;
      if (allowed && allowed.size === 0) { result.deferred++; continue; }
      const outcome = recordCanonicalIndexed({
        workspace: input.workspace,
        handoff,
        context: input.context,
        completedMaintenanceGeneration: input.completedMaintenanceGeneration,
        ...(input.collections ? { allowedCollections: input.collections } : {}),
        ...(input.completedAt ? { completedAt: input.completedAt } : {}),
      });
      result[outcome.status]++;
    } catch (error) {
      result.failed++;
      result.failures.push({ handoffId, code: error instanceof IndexProvenanceError ? error.code : "INDEX_RECONCILE_FAILED" });
    }
  }
  return result;
}

export function syntheticIndexContext(workspace: string, physicalIndexPath: string, indexKey: string): QmdContext {
  return {
    workspace: resolve(workspace),
    workspaceSource: "explicit",
    topology: "shared",
    selector: { kind: "named", name: "engram-global" },
    physicalIndex: { path: resolve(physicalIndexPath), key: indexKey, exists: existsSync(physicalIndexPath) },
    command: { executable: "qmd", prefixArgs: [] },
    policy: { ownedCollections: [], readableCollections: [] },
    warnings: [],
  };
}
