import { readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { inspectQmdCapabilities } from "./diagnostics.ts";
import { executeQmdRead, type QmdReadOptions } from "./read.ts";
import { preflightRecallEvalDataset, type RecallEvalDataset } from "./recall-evaluator-baseline.ts";
import type { RecallAuthorityManifest } from "./recall-evaluator-authority.ts";
import type { RecallExactScope } from "./recall-evaluator-contracts.ts";
import type { QmdContext, QmdOperationRecord } from "./types.ts";
import { sha256, type Digest, type JsonValue } from "../memory-observation/ledger.ts";

export const RECALL_QMD_SNAPSHOT_SCHEMA = "engram.recall-qmd-snapshot.v1" as const;
export const RECALL_QMD_CASE_RECORD_SCHEMA = "engram.recall-qmd-case-record.v1" as const;
export const RECALL_QMD_RUN_SCHEMA = "engram.recall-qmd-run.v1" as const;

const TOP_K = [1, 3, 5, 10] as const;
const RUN_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CANONICAL_REF_RE = /^(memory\/[a-zA-Z0-9._/-]+\.md)#engram-entry:(sha256:[a-f0-9]{64})$/;
const ENTRY_ANCHOR_RE = /^<!-- engram-entry:(sha256:[a-f0-9]{64}) -->$/;

export type RecallQmdSafety = {
  crossScopeResults: number;
  rawEvidenceIndexed: number;
  unauthorizedMutations: number;
  unknownAuthorityAccepted: number;
  mixedSnapshots: number;
  missingTraceCoverage: number;
  modelOnlyAuthoritativeOutcomes: number;
};

export type RecallWilsonMetric = {
  numerator: number;
  denominator: number;
  value: number | null;
  wilson95: { low: number; high: number } | null;
};

export type RecallQmdSnapshot = {
  schema: typeof RECALL_QMD_SNAPSHOT_SCHEMA;
  snapshot: { id: Digest; digest: Digest; capturedAt: string };
  runId: string;
  dataset: { id: string; version: number; digest: string };
  authority: { manifestId: Digest; manifestDigest: Digest; captureFrameDigest: Digest; policyDigest: Digest };
  scope: RecallExactScope;
  evaluatorDigest: Digest;
  qmd: {
    version: string;
    indexKey: string;
    indexGeneration: Digest;
    retrievalConfigDigest: Digest;
    collection: string;
    operation: "query";
    topK: [1, 3, 5, 10];
  };
};

export type RecallQmdRankedHit = {
  rank: number;
  score: number;
  qmdRef: string;
  canonicalRef: string | null;
  canonicalDigest: Digest | null;
  exactScope: boolean;
};

export type RecallQmdCaseRecord = {
  schema: typeof RECALL_QMD_CASE_RECORD_SCHEMA;
  record: { id: Digest; digest: Digest; createdAt: string };
  runId: string;
  caseId: string;
  datasetId: string;
  snapshotDigest: Digest;
  scope: RecallExactScope;
  questionDigest: Digest;
  operationRecordDigest: Digest;
  hits: RecallQmdRankedHit[];
  recallAt: { 1: boolean; 3: boolean; 5: boolean; 10: boolean } | null;
  safety: RecallQmdSafety;
};

export type RecallQmdRun = {
  schema: typeof RECALL_QMD_RUN_SCHEMA;
  run: { id: string; digest: Digest; createdAt: string };
  snapshot: RecallQmdSnapshot;
  cases: RecallQmdCaseRecord[];
  metrics: {
    recallAt1: RecallWilsonMetric;
    recallAt3: RecallWilsonMetric;
    recallAt5: RecallWilsonMetric;
    recallAt10: RecallWilsonMetric;
  };
  safety: RecallQmdSafety;
  blocked: boolean;
};

export class RecallQmdRunnerError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "RecallQmdRunnerError";
  }
}

type IndexedDocument = { path: string; hash: string; modifiedAt: string | null; doc: string };
type IndexSnapshot = {
  generation: Digest;
  collectionRoot: string;
  documents: Map<string, IndexedDocument>;
};

function fail(code: string, message: string): never {
  throw new RecallQmdRunnerError(code, message);
}

function same(left: unknown, right: unknown): boolean {
  return sha256(left as JsonValue) === sha256(right as JsonValue);
}

function validInstant(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value));
}

function canonicalRoot(path: string): string {
  try {
    return realpathSync(resolve(path));
  } catch {
    fail("COLLECTION_ROOT_UNREADABLE", "QMD collection root is unavailable.");
  }
}

function inside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function parseCanonicalRef(ref: string): { path: string; entryId: Digest } {
  const match = CANONICAL_REF_RE.exec(ref);
  if (!match) fail("CANONICAL_REF_INVALID", "Approved episode canonical ref is invalid.");
  return { path: match[1]!, entryId: match[2]! as Digest };
}

function expectedCollectionRoot(workspace: string, dataset: RecallEvalDataset): string {
  const roots = new Set(dataset.approvedEpisodes.map((episode) => {
    const parsed = parseCanonicalRef(episode.canonicalRef);
    const absolute = resolve(workspace, dirname(parsed.path));
    if (!inside(workspace, absolute)) fail("CANONICAL_REF_ESCAPE", "Approved episode canonical ref escapes the workspace.");
    return canonicalRoot(absolute);
  }));
  if (roots.size !== 1) fail("MIXED_CANONICAL_ROOT", "Approved episodes do not share one exact session root.");
  return [...roots][0]!;
}

function readIndexSnapshot(context: QmdContext, collection: string, requiredRoot: string): IndexSnapshot {
  if (!context.physicalIndex.exists) fail("INDEX_MISSING", "Resolved QMD index is unavailable.");
  let db: Database | undefined;
  try {
    db = new Database(context.physicalIndex.path, { readonly: true, strict: true });
    const row = db.query("SELECT name, path, pattern FROM store_collections WHERE name = ?").get(collection) as {
      name: string;
      path: string;
      pattern: string;
    } | null;
    if (!row) fail("COLLECTION_MISSING", "Authority-bound QMD collection is not registered in the resolved index.");
    const collectionRoot = canonicalRoot(row.path);
    if (collectionRoot !== requiredRoot) fail("COLLECTION_SCOPE_MISMATCH", "Authority-bound QMD collection does not map to the exact canonical session root.");
    const rawDocuments = db.query(
      "SELECT d.path, d.hash, d.modified_at AS modifiedAt, c.doc FROM documents d JOIN content c ON c.hash = d.hash WHERE d.collection = ? AND d.active = 1 ORDER BY d.path",
    ).all(collection) as Array<{ path: string; hash: string; modifiedAt: string | null; doc: string }>;
    const documents = new Map<string, IndexedDocument>();
    for (const document of rawDocuments) {
      if (typeof document.path !== "string" || typeof document.hash !== "string" || typeof document.doc !== "string") {
        fail("INDEX_DOCUMENT_INVALID", "QMD index contains an invalid active document.");
      }
      const normalized = document.path.replaceAll("\\", "/").replace(/^\.\//, "");
      if (normalized.startsWith("/") || normalized.split("/").includes("..") || documents.has(normalized)) {
        fail("INDEX_DOCUMENT_INVALID", "QMD index contains an unsafe or duplicate active document path.");
      }
      documents.set(normalized, { ...document, path: normalized });
    }
    const config = db.query("SELECT key, value FROM store_config ORDER BY key").all() as Array<{ key: string; value: string }>;
    const generation = sha256({
      indexKey: context.physicalIndex.key,
      collection: { name: row.name, path: collectionRoot, pattern: row.pattern },
      config,
      documents: [...documents.values()].map(({ path, hash, modifiedAt }) => ({ path, hash, modifiedAt })),
    } as unknown as JsonValue);
    return { generation, collectionRoot, documents };
  } catch (error) {
    if (error instanceof RecallQmdRunnerError) throw error;
    throw new RecallQmdRunnerError("INDEX_UNREADABLE", "Resolved QMD index cannot be inspected read-only.");
  } finally {
    db?.close();
  }
}

function indexedPath(workspace: string, collectionRoot: string, canonicalPath: string): string {
  const absolute = resolve(workspace, canonicalPath);
  if (!inside(collectionRoot, absolute)) fail("CANONICAL_SCOPE_MISMATCH", "Canonical ref is outside the authority-bound QMD collection root.");
  return relative(collectionRoot, absolute).replaceAll("\\", "/");
}

function renderedEntryAtAnchor(doc: string, entryId: Digest): string | null {
  const lines = doc.split(/\r?\n/);
  const anchor = `<!-- engram-entry:${entryId} -->`;
  const index = lines.findIndex((line) => line === anchor);
  if (index < 0 || !lines[index + 1]?.startsWith("- ")) return null;
  const entry = [lines[index]!, lines[index + 1]!];
  for (let cursor = index + 2; cursor < lines.length && lines[cursor]!.startsWith("  "); cursor++) entry.push(lines[cursor]!);
  return entry.join("\n");
}

function verifyGoldIndexed(workspace: string, snapshot: IndexSnapshot, dataset: RecallEvalDataset): void {
  for (const episode of dataset.approvedEpisodes) {
    const parsed = parseCanonicalRef(episode.canonicalRef);
    const path = indexedPath(workspace, snapshot.collectionRoot, parsed.path);
    const document = snapshot.documents.get(path);
    if (!document) fail("INDEX_GOLD_MISSING", "Approved canonical episode is absent from the fixed QMD index generation.");
    const rendered = renderedEntryAtAnchor(document.doc, parsed.entryId);
    if (!rendered || sha256(rendered) !== episode.canonicalDigest) {
      fail("INDEX_GOLD_STALE", "Approved canonical episode does not match the fixed QMD index generation.");
    }
  }
}

function manifestIdentity(manifest: RecallAuthorityManifest): JsonValue {
  return {
    ...manifest,
    manifest: { id: manifest.manifest.id, compiledAt: manifest.manifest.compiledAt },
  } as unknown as JsonValue;
}

function verifyAuthority(dataset: RecallEvalDataset, manifest: RecallAuthorityManifest): void {
  if (manifest.schema !== "engram.recall-authority-manifest.v1"
    || manifest.manifest.digest !== sha256(manifestIdentity(manifest))) {
    fail("AUTHORITY_MANIFEST_INVALID", "Recall authority manifest identity is invalid.");
  }
  if (!same(dataset.scope, manifest.scope)) fail("AUTHORITY_SCOPE_MISMATCH", "Dataset and authority manifest do not share the exact scope.");
  if (dataset.collections.length !== 1 || dataset.collections[0] !== manifest.projection.qmdCollection) {
    fail("AUTHORITY_COLLECTION_MISMATCH", "Dataset collection does not match the authority-bound QMD collection.");
  }
  if (!manifest.receiptPolicyDigest || dataset.approvedEpisodes.some((episode) => episode.policyDigest !== manifest.receiptPolicyDigest)) {
    fail("AUTHORITY_POLICY_MISMATCH", "Dataset episodes do not share the authority manifest policy snapshot.");
  }
  const approved = new Map(manifest.approvedEpisodes.map((episode) => [episode.receiptId, episode]));
  for (const episode of dataset.approvedEpisodes) {
    const authoritative = approved.get(episode.receiptId);
    if (!authoritative || !same(authoritative, episode)) fail("AUTHORITY_EPISODE_MISMATCH", "Dataset contains an episode not proven by the authority manifest.");
  }
}

function entryAtLine(doc: string, line: number): { entryId: Digest; rendered: string } | null {
  const lines = doc.split(/\r?\n/);
  let cursor = Math.min(line - 1, lines.length - 1);
  while (cursor >= 0) {
    const value = lines[cursor]!;
    const anchor = ENTRY_ANCHOR_RE.exec(value);
    if (anchor) {
      const rendered = renderedEntryAtAnchor(doc, anchor[1]! as Digest);
      return rendered ? { entryId: anchor[1]! as Digest, rendered } : null;
    }
    if (/^## /.test(value)) return null;
    cursor--;
  }
  return null;
}

function rankedHits(
  workspace: string,
  collection: string,
  snapshot: IndexSnapshot,
  values: unknown[],
): RecallQmdRankedHit[] {
  return values.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail("QMD_HIT_INVALID", "QMD returned a non-object ranked hit.");
    const hit = value as Record<string, unknown>;
    if (typeof hit.file !== "string" || typeof hit.line !== "number" || !Number.isSafeInteger(hit.line) || hit.line < 1
      || typeof hit.score !== "number" || !Number.isFinite(hit.score)) {
      fail("QMD_HIT_INVALID", "QMD ranked hit is missing typed file, line, or score fields.");
    }
    const prefix = `qmd://${collection}/`;
    if (!hit.file.startsWith(prefix)) {
      return { rank: index + 1, score: hit.score, qmdRef: hit.file, canonicalRef: null, canonicalDigest: null, exactScope: false };
    }
    let path: string;
    try { path = decodeURIComponent(hit.file.slice(prefix.length)); }
    catch { fail("QMD_HIT_INVALID", "QMD ranked hit contains an invalid encoded path."); }
    path = path!.replaceAll("\\", "/").replace(/^\.\//, "");
    if (path.startsWith("/") || path.split("/").includes("..")) {
      return { rank: index + 1, score: hit.score, qmdRef: hit.file, canonicalRef: null, canonicalDigest: null, exactScope: false };
    }
    const document = snapshot.documents.get(path);
    if (!document) return { rank: index + 1, score: hit.score, qmdRef: hit.file, canonicalRef: null, canonicalDigest: null, exactScope: false };
    const absolute = resolve(snapshot.collectionRoot, path);
    const exactScope = inside(snapshot.collectionRoot, absolute);
    const entry = exactScope ? entryAtLine(document.doc, hit.line) : null;
    if (!entry) return { rank: index + 1, score: hit.score, qmdRef: hit.file, canonicalRef: null, canonicalDigest: null, exactScope };
    const canonicalPath = relative(workspace, absolute).replaceAll("\\", "/");
    return {
      rank: index + 1,
      score: hit.score,
      qmdRef: hit.file,
      canonicalRef: `${canonicalPath}#engram-entry:${entry.entryId}`,
      canonicalDigest: sha256(entry.rendered),
      exactScope,
    };
  });
}

function emptySafety(): RecallQmdSafety {
  return {
    crossScopeResults: 0,
    rawEvidenceIndexed: 0,
    unauthorizedMutations: 0,
    unknownAuthorityAccepted: 0,
    mixedSnapshots: 0,
    missingTraceCoverage: 0,
    modelOnlyAuthoritativeOutcomes: 0,
  };
}

function safetyForHits(hits: RecallQmdRankedHit[]): RecallQmdSafety {
  return { ...emptySafety(), crossScopeResults: hits.filter((hit) => !hit.exactScope).length };
}

function wilson(numerator: number, denominator: number): RecallWilsonMetric {
  if (denominator === 0) return { numerator, denominator, value: null, wilson95: null };
  const value = numerator / denominator;
  const z = 1.959963984540054;
  const denominatorAdjusted = 1 + (z * z) / denominator;
  const center = (value + (z * z) / (2 * denominator)) / denominatorAdjusted;
  const margin = (z * Math.sqrt((value * (1 - value)) / denominator + (z * z) / (4 * denominator * denominator))) / denominatorAdjusted;
  return { numerator, denominator, value, wilson95: { low: Math.max(0, center - margin), high: Math.min(1, center + margin) } };
}

function sumSafety(cases: RecallQmdCaseRecord[]): RecallQmdSafety {
  const total = emptySafety();
  for (const record of cases) for (const key of Object.keys(total) as Array<keyof RecallQmdSafety>) total[key] += record.safety[key];
  return total;
}

function retrievalConfigDigest(context: QmdContext, collection: string, qmdVersion: string, options: QmdReadOptions): Digest {
  const env = { ...process.env, ...options.env };
  const relevantEnvironment = Object.keys(env).filter((key) => /^(?:QMD|OLLAMA|JINA)_/.test(key)).sort().map((key) => [key, env[key] ?? null]);
  return sha256({
    qmdVersion,
    operation: "query",
    collection,
    topK: TOP_K,
    indexKey: context.physicalIndex.key,
    command: context.command,
    timeoutMs: options.timeoutMs ?? null,
    environment: relevantEnvironment,
  } as unknown as JsonValue);
}

function snapshotDigest(value: Omit<RecallQmdSnapshot, "snapshot"> & { snapshot: { id: Digest; capturedAt: string } }): Digest {
  return sha256(value as unknown as JsonValue);
}

function operationProof(record: QmdOperationRecord): Digest {
  const { startedAt: _startedAt, completedAt: _completedAt, elapsedMs: _elapsedMs, ...stableRecord } = record;
  return sha256(stableRecord as unknown as JsonValue);
}

function caseRecordDigest(value: Omit<RecallQmdCaseRecord, "record"> & { record: { id: Digest; createdAt: string } }): Digest {
  return sha256(value as unknown as JsonValue);
}

export function recallQmdEvaluatorDigest(): Digest {
  return sha256(readFileSync(fileURLToPath(import.meta.url), "utf8"));
}

export async function runRecallQmdRetrieval(options: {
  context: QmdContext;
  dataset: RecallEvalDataset;
  authorityManifest: RecallAuthorityManifest;
  runId: string;
  startedAt: string;
  runner?: QmdReadOptions;
}): Promise<RecallQmdRun> {
  if (!RUN_ID_RE.test(options.runId)) fail("RUN_ID_INVALID", "Recall QMD runId must be an RFC 4122 UUID.");
  if (!validInstant(options.startedAt)) fail("RUN_TIME_INVALID", "Recall QMD startedAt must be an RFC3339 timestamp.");
  const preflight = preflightRecallEvalDataset(options.dataset);
  verifyAuthority(options.dataset, options.authorityManifest);
  const collection = options.dataset.collections[0]!;
  if (!options.context.policy.readableCollections.includes(collection)) fail("COLLECTION_NOT_READABLE", "Authority-bound QMD collection is not readable in the resolved context.");
  const workspace = resolve(options.context.workspace);
  const root = expectedCollectionRoot(workspace, options.dataset);
  const before = readIndexSnapshot(options.context, collection, root);
  verifyGoldIndexed(workspace, before, options.dataset);

  const caller = { kind: "coordinator" as const, allowedCollections: [collection], capabilities: ["diagnostics", "read"] as const };
  const runner = { ...options.runner, caller: { ...caller, capabilities: [...caller.capabilities] } };
  const capabilities = await inspectQmdCapabilities(options.context, { runner: options.runner, caller: runner.caller });
  const configDigest = retrievalConfigDigest(options.context, collection, capabilities.qmd.version, runner);
  const evaluatorDigest = recallQmdEvaluatorDigest();
  const snapshotId = sha256({ runId: options.runId, datasetDigest: options.dataset.dataset.digest, authorityManifestDigest: options.authorityManifest.manifest.digest } as unknown as JsonValue);
  const snapshotBase = {
    schema: RECALL_QMD_SNAPSHOT_SCHEMA,
    snapshot: { id: snapshotId, capturedAt: options.startedAt },
    runId: options.runId.toLowerCase(),
    dataset: { id: options.dataset.dataset.id, version: options.dataset.dataset.version, digest: options.dataset.dataset.digest },
    authority: {
      manifestId: options.authorityManifest.manifest.id,
      manifestDigest: options.authorityManifest.manifest.digest,
      captureFrameDigest: options.authorityManifest.captureFrame.digest,
      policyDigest: preflight.policyDigest as Digest,
    },
    scope: options.dataset.scope,
    evaluatorDigest,
    qmd: {
      version: capabilities.qmd.version,
      indexKey: options.context.physicalIndex.key,
      indexGeneration: before.generation,
      retrievalConfigDigest: configDigest,
      collection,
      operation: "query" as const,
      topK: [...TOP_K] as [1, 3, 5, 10],
    },
  };
  const snapshot: RecallQmdSnapshot = { ...snapshotBase, snapshot: { ...snapshotBase.snapshot, digest: snapshotDigest(snapshotBase) } };

  const records: RecallQmdCaseRecord[] = [];
  for (const evalCase of options.dataset.cases) {
    const current = readIndexSnapshot(options.context, collection, root);
    if (current.generation !== snapshot.qmd.indexGeneration) fail("SNAPSHOT_DRIFT", "QMD index generation changed during the recall run.");
    const output = await executeQmdRead(options.context, { operation: "query", query: evalCase.question, collections: [collection], limit: 10 }, runner);
    const after = readIndexSnapshot(options.context, collection, root);
    if (after.generation !== snapshot.qmd.indexGeneration) fail("SNAPSHOT_DRIFT", "QMD index generation changed during the recall run.");
    const hits = rankedHits(workspace, collection, after, output.data.results.slice(0, 10));
    const gold = new Set(evalCase.goldEvidenceRefs.filter((ref) => ref.kind === "canonical-record").map((ref) => `${ref.ref}\0${ref.digest}`));
    const at = (limit: number) => hits.slice(0, limit).some((hit) => hit.canonicalRef !== null && hit.canonicalDigest !== null && gold.has(`${hit.canonicalRef}\0${hit.canonicalDigest}`));
    const recallAt = evalCase.mustAbstain ? null : { 1: at(1), 3: at(3), 5: at(5), 10: at(10) };
    const id = sha256({ schema: RECALL_QMD_CASE_RECORD_SCHEMA, runId: snapshot.runId, caseId: evalCase.caseId } as unknown as JsonValue);
    const base = {
      schema: RECALL_QMD_CASE_RECORD_SCHEMA,
      record: { id, createdAt: options.startedAt },
      runId: snapshot.runId,
      caseId: evalCase.caseId,
      datasetId: evalCase.datasetId,
      snapshotDigest: snapshot.snapshot.digest,
      scope: evalCase.scope,
      questionDigest: sha256(evalCase.question),
      operationRecordDigest: operationProof(output.data.operationRecord),
      hits,
      recallAt,
      safety: safetyForHits(hits),
    };
    records.push({ ...base, record: { ...base.record, digest: caseRecordDigest(base) } });
  }

  const eligible = records.filter((record) => record.recallAt !== null);
  const metric = (key: 1 | 3 | 5 | 10) => wilson(eligible.filter((record) => record.recallAt![key]).length, eligible.length);
  const safety = sumSafety(records);
  const runBase = {
    schema: RECALL_QMD_RUN_SCHEMA,
    run: { id: snapshot.runId, createdAt: options.startedAt },
    snapshot,
    cases: records,
    metrics: { recallAt1: metric(1), recallAt3: metric(3), recallAt5: metric(5), recallAt10: metric(10) },
    safety,
    blocked: Object.values(safety).some((count) => count > 0),
  };
  return { ...runBase, run: { ...runBase.run, digest: sha256(runBase as unknown as JsonValue) } };
}
