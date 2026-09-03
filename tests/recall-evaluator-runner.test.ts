import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { sha256, type Digest, type JsonValue } from "../src/memory-observation/ledger.ts";
import {
  sealRecallEvalDataset,
  type RecallApprovedEpisode,
  type RecallEvalDataset,
  type RecallRequiredQuestionClass,
} from "../src/qmd/recall-evaluator-baseline.ts";
import type { RecallAuthorityManifest } from "../src/qmd/recall-evaluator-authority.ts";
import type { RecallEvalCase, RecallExactScope } from "../src/qmd/recall-evaluator-contracts.ts";
import {
  RecallQmdRunnerError,
  runRecallQmdRetrieval,
} from "../src/qmd/recall-evaluator-runner.ts";
import type { QmdContext } from "../src/qmd/types.ts";

const FAKE_QMD = join(import.meta.dir, "fixtures", "fake-qmd.js");
const CLI = join(import.meta.dir, "..", "scripts", "recall-qmd-run.ts");
const RUN_ID = "11111111-1111-4111-8111-111111111111";
const STARTED_AT = "2026-08-29T12:30:00.000Z";
const COLLECTION = "main-direct-memory";
const POLICY_DIGEST = sha256("recall-runner-policy");
const DATASET_ID = sha256("recall-runner-dataset");
const scope: RecallExactScope = {
  workspaceId: "main",
  runtimeSessionKey: "agent:main:telegram:direct:100000001",
  scopeClass: "self",
  scopeId: "telegram:100000001",
};
const classes: RecallRequiredQuestionClass[] = [
  "factual-event",
  "explicit-decision",
  "state-correction",
  "temporal-relation",
  "no-evidence",
];

type Harness = {
  workspace: string;
  context: QmdContext;
  dataset: RecallEvalDataset;
  manifest: RecallAuthorityManifest;
  resultsByQuestion: Record<string, unknown[]>;
  indexPath: string;
};

function episode(index: number, canonicalRef: string, canonicalDigest: Digest): RecallApprovedEpisode {
  return {
    receiptId: sha256(`receipt-${index}`),
    traceId: sha256(`trace-${index}`),
    sourceCompletedAt: `2026-08-29T10:${String(index).padStart(2, "0")}:00.000Z`,
    completedAt: `2026-08-29T10:${String(index).padStart(2, "0")}:10.000Z`,
    canonicalRef,
    canonicalDigest,
    policyDigest: POLICY_DIGEST,
    scope,
  };
}

function evalCase(index: number, questionClass: RecallRequiredQuestionClass, episodes: RecallApprovedEpisode[]): RecallEvalCase {
  const source = episodes[index % episodes.length]!;
  const mustAbstain = questionClass === "no-evidence";
  return {
    schema: "engram.recall-eval-case.v1",
    caseId: sha256(`case-${index}`),
    datasetId: DATASET_ID,
    scope,
    questionClass,
    question: `Recall runner question ${index}`,
    sourceTraceIds: [source.traceId],
    goldEvidenceRefs: mustAbstain ? [] : [{ kind: "canonical-record", ref: source.canonicalRef, digest: source.canonicalDigest }],
    expectedClaims: mustAbstain ? ["abstain"] : [`claim-${index}`],
    forbiddenClaims: [`forbidden-${index}`],
    mustAbstain,
    critical: questionClass === "state-correction",
    tags: [questionClass],
    adjudication: { source: "human", verifierRef: "verifier://human/1", digest: sha256(`adjudication-${index}`) },
  };
}

function authorityManifest(dataset: RecallEvalDataset): RecallAuthorityManifest {
  const base = {
    schema: "engram.recall-authority-manifest.v1" as const,
    manifest: { id: sha256("authority-id"), compiledAt: "2026-08-29T12:20:00.000Z" },
    scope,
    projection: {
      digest: sha256("projection"),
      effectiveAfter: "2026-08-28T22:56:07.000Z",
      approvedBy: "operator",
      approvedAt: "2026-08-28T22:50:00.000Z",
      qmdCollection: COLLECTION,
    },
    captureFrame: {
      id: sha256("capture-frame-id"),
      digest: sha256("capture-frame-digest"),
      counts: { "not-admitted": 5, write: 20, skip: 5, failed: 0 },
      turns: [],
    },
    receiptPolicyDigest: POLICY_DIGEST,
    approvedEpisodes: dataset.approvedEpisodes,
  };
  return { ...base, manifest: { ...base.manifest, digest: sha256(base as unknown as JsonValue) } };
}

function createIndex(indexPath: string, collectionRoot: string, doc: string, includeCollection = true): void {
  const db = new Database(indexPath, { create: true });
  db.run("CREATE TABLE store_collections(name TEXT, path TEXT, pattern TEXT)");
  db.run("CREATE TABLE store_config(key TEXT, value TEXT)");
  db.run("CREATE TABLE documents(id INTEGER, collection TEXT, path TEXT, title TEXT, hash TEXT, created_at TEXT, modified_at TEXT, active INTEGER)");
  db.run("CREATE TABLE content(hash TEXT, doc TEXT, created_at TEXT)");
  db.run("INSERT INTO store_config VALUES (?, ?)", ["schema", "test-v1"]);
  if (includeCollection) db.run("INSERT INTO store_collections VALUES (?, ?, ?)", [COLLECTION, collectionRoot, "**/*.md"]);
  const hash = sha256(doc);
  db.run("INSERT INTO content VALUES (?, ?, ?)", [hash, doc, STARTED_AT]);
  db.run("INSERT INTO documents VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [1, COLLECTION, "2026-08-29.md", "2026-08-29", hash, STARTED_AT, STARTED_AT, 1]);
  db.close();
}

function harness(options: { includeCollection?: boolean; staleFirstEntry?: boolean } = {}): Harness {
  const workspace = mkdtempSync(join(tmpdir(), "recall-qmd-runner-"));
  const sessionRoot = join(workspace, "memory", "agent-main", "telegram-direct-100000001");
  mkdirSync(sessionRoot, { recursive: true });
  const lines = ["# 2026-08-29", "", "## Events", ""];
  const entries: Array<{ ref: string; digest: Digest; line: number }> = [];
  for (let index = 0; index < 20; index++) {
    const entryId = sha256(`entry-${index}`);
    const rendered = `<!-- engram-entry:${entryId} -->\n- Canonical event ${index}`;
    const line = lines.length + 2;
    lines.push(...rendered.split("\n"), "");
    entries.push({
      ref: `memory/agent-main/telegram-direct-100000001/2026-08-29.md#engram-entry:${entryId}`,
      digest: sha256(rendered),
      line,
    });
  }
  lines.push("## Decisions", "", "## Learnings", "", "## Active Threads", "", "## Next", "");
  const canonicalDoc = lines.join("\n");
  writeFileSync(join(sessionRoot, "2026-08-29.md"), canonicalDoc);
  const approvedEpisodes = entries.map((entry, index) => episode(index, entry.ref, entry.digest));
  const cases = classes.flatMap((questionClass, classIndex) => (
    Array.from({ length: 5 }, (_, offset) => evalCase(classIndex * 5 + offset, questionClass, approvedEpisodes))
  ));
  const dataset = sealRecallEvalDataset({
    schema: "engram.recall-eval-dataset.v1",
    dataset: { id: DATASET_ID, version: 1, sealedAt: "2026-08-29T12:00:00.000Z" },
    scope,
    collections: [COLLECTION],
    topK: [1, 3, 5, 10],
    approval: { approvedBy: "operator", approvedAt: "2026-08-28T22:50:00.000Z", effectiveAfter: "2026-08-28T22:56:07.000Z" },
    approvedEpisodes,
    cases,
  });
  const indexedDoc = options.staleFirstEntry ? canonicalDoc.replace("Canonical event 0", "Stale event 0") : canonicalDoc;
  const indexPath = join(workspace, "index.sqlite");
  createIndex(indexPath, sessionRoot, indexedDoc, options.includeCollection !== false);
  const context: QmdContext = {
    workspace,
    workspaceSource: "explicit",
    topology: "isolated",
    selector: { kind: "local" },
    physicalIndex: { path: indexPath, key: sha256(indexPath).slice(7), exists: true },
    command: { executable: process.execPath, prefixArgs: [FAKE_QMD] },
    policy: { ownedCollections: [COLLECTION], readableCollections: [COLLECTION] },
    warnings: [],
  };
  const lineByRef = new Map(entries.map((entry) => [entry.ref, entry.line]));
  const resultsByQuestion = Object.fromEntries(dataset.cases.map((item) => {
    const gold = item.goldEvidenceRefs[0];
    return [item.question, gold ? [{ file: `qmd://${COLLECTION}/2026-08-29.md`, line: lineByRef.get(gold.ref), score: 0.99 }] : []];
  }));
  return { workspace, context, dataset, manifest: authorityManifest(dataset), resultsByQuestion, indexPath };
}

async function run(item: Harness, results = item.resultsByQuestion) {
  return runRecallQmdRetrieval({
    context: item.context,
    dataset: item.dataset,
    authorityManifest: item.manifest,
    runId: RUN_ID,
    startedAt: STARTED_AT,
    runner: { env: { FAKE_QMD_RESULTS_BY_QUERY: JSON.stringify(results) } },
  });
}

describe("recall evaluator narrow typed QMD runner", () => {
  test("exposes a one-shot CLI with a content-free error boundary", () => {
    const help = spawnSync(process.execPath, [CLI, "--help"], { encoding: "utf8" });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("--capture-frame");
    expect(help.stdout).toContain("--dataset");
    const privatePath = "/private/operator/recall-dataset.json";
    const failed = spawnSync(process.execPath, [CLI, "--dataset", privatePath], { encoding: "utf8" });
    expect(failed.status).toBe(1);
    expect(failed.stderr).toBe("recall-qmd-run: INVALID_INPUT\n");
    expect(failed.stderr).not.toContain(privatePath);
  });

  test("binds ranked hits to exact canonical entries and emits a reproducible content-minimal pack", async () => {
    const item = harness();
    const first = await run(item);
    const replay = await run(item);
    expect(first.metrics).toMatchObject({
      recallAt1: { numerator: 20, denominator: 20, value: 1 },
      recallAt3: { numerator: 20, denominator: 20, value: 1 },
      recallAt5: { numerator: 20, denominator: 20, value: 1 },
      recallAt10: { numerator: 20, denominator: 20, value: 1 },
    });
    expect(first.metrics.recallAt5.wilson95).toEqual({ low: expect.any(Number), high: 1 });
    expect(first.cases[0]).toMatchObject({
      recallAt: { 1: true, 3: true, 5: true, 10: true },
      hits: [{ rank: 1, canonicalRef: item.dataset.cases[0]!.goldEvidenceRefs[0]!.ref, exactScope: true }],
    });
    const abstentionCaseId = item.dataset.cases.find((entry) => entry.mustAbstain)!.caseId;
    expect(first.cases.find((entry) => entry.caseId === abstentionCaseId)!.recallAt).toBeNull();
    expect(first.blocked).toBe(false);
    expect(first.run.digest).toBe(replay.run.digest);
    const serialized = JSON.stringify(first);
    expect(serialized).not.toContain("Recall runner question");
    expect(serialized).not.toContain('"snippet"');
    expect(serialized).not.toContain('"context"');
    expect(serialized).not.toContain('"expectedClaims"');
  });

  test("fails closed before retrieval when the bound collection is absent or indexed gold is stale", async () => {
    for (const [item, code] of [[harness({ includeCollection: false }), "COLLECTION_MISSING"], [harness({ staleFirstEntry: true }), "INDEX_GOLD_STALE"]] as const) {
      try {
        await run(item);
        throw new Error("expected runner failure");
      } catch (error) {
        expect(error).toBeInstanceOf(RecallQmdRunnerError);
        expect((error as RecallQmdRunnerError).code).toBe(code);
      }
    }
  });

  test("counts out-of-scope ranked results as a blocking safety violation", async () => {
    const item = harness();
    const crossScope = Object.fromEntries(item.dataset.cases.map((evalCase) => [
      evalCase.question,
      [{ file: "qmd://foreign-memory/other.md", line: 1, score: 0.9 }],
    ]));
    const result = await run(item, crossScope);
    expect(result.blocked).toBe(true);
    expect(result.safety.crossScopeResults).toBe(25);
    expect(result.metrics.recallAt5).toMatchObject({ numerator: 0, denominator: 20, value: 0 });
  });
});
