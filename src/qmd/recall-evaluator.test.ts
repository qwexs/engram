import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateQmdRecallCorpus, loadRecallCorpus } from "./recall-evaluator.ts";
import type { QmdContext } from "./types.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const fixture = join(root, "tests/fixtures/fake-qmd.js");
const corpusPath = join(root, "tests/fixtures/recall-evaluator/corpus.v1.json");
const tempRoots: string[] = [];

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "engram-recall-eval-"));
  tempRoots.push(dir);
  return dir;
}

function context(): QmdContext {
  const ws = workspace();
  return {
    workspace: ws,
    workspaceSource: "explicit",
    topology: "shared",
    selector: { kind: "named", name: "team" },
    physicalIndex: { path: join(ws, "team.sqlite"), key: "team-key", exists: false },
    command: { executable: process.execPath, prefixArgs: [fixture] },
    policy: { ownedCollections: ["workspace-memory"], readableCollections: ["workspace-memory", "private"] },
    warnings: [],
  };
}

afterEach(() => { while (tempRoots.length) rmSync(tempRoots.pop()!, { recursive: true, force: true }); });

test("loadRecallCorpus validates the versioned contract", () => {
  expect(loadRecallCorpus(corpusPath)).toMatchObject({ schema: "engram.qmd.recall-corpus.v1", collectionScope: "workspace-memory" });
});

test("evaluateQmdRecallCorpus emits deterministic recall metrics and miss diagnostics", async () => {
  const ctx = context();
  const corpus = loadRecallCorpus(corpusPath);
  const env = {
    FAKE_QMD_RESULTS_BY_QUERY: JSON.stringify({
      "exact memory": [{ file: "qmd://workspace-memory/exact.md", score: 1.0 }],
      "semantic memory": [{ file: "qmd://workspace-memory/near.md", score: 0.9 }, { file: "qmd://workspace-memory/vector.md", score: 0.8 }],
      shared: [{ file: "qmd://workspace-memory/visible.md", score: 0.92 }, { file: "qmd://visible/adjacent.md", score: 0.85 }],
      default: [{ file: "qmd://workspace-memory/near.md", score: 0.9 }],
    }),
  } as Record<string, string>;
  const data = await evaluateQmdRecallCorpus(ctx, corpus, { env });
  expect(data.schema).toBe("engram.qmd.recall-evaluator.v1");
  expect(data.totals).toEqual({ cases: 4, passed: 4, failed: 0 });
  expect(data.recallAt1).toBe(0.5);
  expect(data.recallAt3).toBe(1);
  expect(data.diagnostics.misses).toEqual([]);
});

test("vector rank1 counts toward Recall@1 and exact rank2 counts toward Recall@3", async () => {
  const ctx = context();
  const corpus = loadRecallCorpus(corpusPath);
  const result = await evaluateQmdRecallCorpus(ctx, {
    ...corpus,
    cases: [corpus.cases[0]!, corpus.cases[1]!],
  }, {
    env: {
      FAKE_QMD_RESULTS_BY_QUERY: JSON.stringify({
        "exact memory": [{ file: "qmd://workspace-memory/other.md", score: 0.99 }, { file: "qmd://workspace-memory/exact.md", score: 0.98 }],
        "semantic memory": [{ file: "qmd://workspace-memory/vector.md", score: 0.99 }, { file: "qmd://workspace-memory/other.md", score: 0.9 }],
      }),
    },
  });
  expect(result.totals).toEqual({ cases: 2, passed: 1, failed: 1 });
  expect(result.recallAt1).toBe(0.5);
  expect(result.recallAt3).toBe(1);
  expect(result.cases.find((entry) => entry.id === "exact-doc")).toMatchObject({ passed: false, top1: "qmd://workspace-memory/other.md", top3: ["qmd://workspace-memory/other.md", "qmd://workspace-memory/exact.md"] });
  expect(result.cases.find((entry) => entry.id === "vector-doc")).toMatchObject({ passed: true, top1: "qmd://workspace-memory/vector.md" });
});

test("read-only evaluator spawns only qmd read commands and policy denial does not spawn", async () => {
  const ctx = context();
  const corpus = loadRecallCorpus(corpusPath);
  const log = join(ctx.workspace, "qmd.log");
  await evaluateQmdRecallCorpus(ctx, corpus, {
    env: {
      FAKE_QMD_LOG: log,
      FAKE_QMD_RESULTS_BY_QUERY: JSON.stringify({
        "exact memory": [{ file: "qmd://workspace-memory/exact.md", score: 1.0 }],
        "semantic memory": [{ file: "qmd://workspace-memory/near.md", score: 0.9 }, { file: "qmd://workspace-memory/vector.md", score: 0.8 }],
        shared: [{ file: "qmd://workspace-memory/visible.md", score: 0.92 }, { file: "qmd://visible/adjacent.md", score: 0.85 }],
        default: [{ file: "qmd://workspace-memory/near.md", score: 0.9 }],
      }),
    },
  });
  const lines = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  expect(lines.every((argv) => ["search", "query", "vsearch"].includes(argv[argv.includes("search") ? argv.indexOf("search") : argv.includes("query") ? argv.indexOf("query") : argv.indexOf("vsearch")]))).toBe(true);
  expect(lines.some((argv) => argv.includes("update") || argv.includes("embed"))).toBe(false);
});

test("timeout reaches the QMD invocation", async () => {
  const ctx = context();
  const corpus = loadRecallCorpus(corpusPath);
  const result = await evaluateQmdRecallCorpus(ctx, { ...corpus, cases: [corpus.cases[0]!] }, {
    timeoutMs: 20,
    env: { FAKE_QMD_MODE: "timeout", FAKE_QMD_DELAY_MS: "1000" },
  });
  expect(result.cases[0]).toMatchObject({ kind: "positive-exact", passed: false });
  expect(result.cases[0]?.error?.code || result.cases[0]?.operationRecord?.timedOut).toBeTruthy();
});

test("policy denial does not spawn the QMD process", async () => {
  const ctx = context();
  const corpus = loadRecallCorpus(corpusPath);
  const log = join(ctx.workspace, "policy.log");
  await evaluateQmdRecallCorpus(ctx, { ...corpus, cases: corpus.cases.filter((entry) => entry.kind === "negative-policy") }, {
    env: { FAKE_QMD_LOG: log },
  });
  expect(existsSync(log)).toBe(false);
});

test("negative isolation is an allowed read that excludes the protected document", async () => {
  const ctx = context();
  const corpus = loadRecallCorpus(corpusPath);
  const log = join(ctx.workspace, "isolation.log");
  const result = await evaluateQmdRecallCorpus(ctx, { ...corpus, cases: corpus.cases.filter((entry) => entry.kind === "negative-isolation") }, {
    env: {
      FAKE_QMD_LOG: log,
      FAKE_QMD_RESULTS_BY_QUERY: JSON.stringify({
        shared: [{ file: "qmd://workspace-memory/visible.md", score: 0.92 }, { file: "qmd://visible/adjacent.md", score: 0.85 }],
      }),
    },
  });
  expect(result.totals).toEqual({ cases: 1, passed: 1, failed: 0 });
  expect(result.cases[0]).toMatchObject({ kind: "negative-isolation", passed: true });
  expect(result.cases[0]?.top1).toBe("qmd://workspace-memory/visible.md");
  expect(result.cases[0]?.top3).not.toContain("qmd://protected/secret.md");
});
