import { readFileSync } from "node:fs";
import { contextError } from "../cli/errors.ts";
import { executeQmdRead, type QmdReadData } from "./read.ts";
import type { QmdProcessOptions } from "./runner.ts";
import type { QmdContext, QmdOperationRecord } from "./types.ts";

export type RecallCorpusVersion = "engram.qmd.recall-corpus.v1";
export type RecallCaseKind = "positive-exact" | "positive-vector" | "negative-policy" | "negative-isolation";

export type RecallCorpusCase = {
  id: string;
  kind: RecallCaseKind;
  operation: "search" | "query" | "vsearch";
  query: string;
  collections: string[];
  expectedCanonicalDocument: string;
  expectedPath: string;
  expectedErrorCode?: string;
};

export type RecallCorpus = {
  schema: RecallCorpusVersion;
  version: string;
  collectionScope: string;
  cases: RecallCorpusCase[];
};

export type RecallCaseResult = {
  id: string;
  kind: RecallCaseKind;
  query: string;
  collections: string[];
  passed: boolean;
  top1?: string;
  top3?: string[];
  error?: { code: string; message: string };
  operationRecord?: QmdOperationRecord;
  expectedCanonicalDocument: string;
  expectedPath: string;
};

export type RecallEvaluatorResult = {
  schema: "engram.qmd.recall-evaluator.v1";
  corpus: RecallCorpusVersion;
  version: string;
  collectionScope: string;
  totals: { cases: number; passed: number; failed: number };
  recallAt1: number;
  recallAt3: number;
  cases: RecallCaseResult[];
  diagnostics: { misses: Array<Pick<RecallCaseResult, "id" | "kind" | "expectedCanonicalDocument" | "expectedPath" | "error" | "top1" | "top3">> };
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function strings(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) {
    throw contextError(`${field} must be an array of non-empty strings.`, { field });
  }
  return value.map((item) => item.trim());
}

export function loadRecallCorpus(path: string): RecallCorpus {
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { throw contextError("Recall corpus is not valid JSON.", { path, cause: error instanceof Error ? error.message : String(error) }); }
  const root = asRecord(parsed);
  if (!root || root.schema !== "engram.qmd.recall-corpus.v1") throw contextError("Recall corpus schema is unsupported.", { path });
  if (typeof root.version !== "string" || root.version.trim() === "") throw contextError("Recall corpus version is required.", { path });
  if (typeof root.collectionScope !== "string" || root.collectionScope.trim() === "") throw contextError("Recall corpus collectionScope is required.", { path });
  if (!Array.isArray(root.cases) || root.cases.length === 0) throw contextError("Recall corpus must contain at least one case.", { path });
  const cases = root.cases.map((entry, index) => {
    const c = asRecord(entry);
    if (!c) throw contextError("Recall case must be an object.", { path, index });
    if (typeof c.id !== "string" || c.id.trim() === "") throw contextError("Recall case id is required.", { path, index });
    if (!(["positive-exact", "positive-vector", "negative-policy", "negative-isolation"] as const).includes(c.kind as any)) {
      throw contextError("Recall case kind is invalid.", { path, index, id: c.id });
    }
    if (!(["search", "query", "vsearch"] as const).includes(c.operation as any)) {
      throw contextError("Recall case operation is invalid.", { path, index, id: c.id });
    }
    if (typeof c.query !== "string" || c.query.trim() === "") throw contextError("Recall case query is required.", { path, index, id: c.id });
    const collections = strings(c.collections, `cases[${index}].collections`);
    if (typeof c.expectedCanonicalDocument !== "string" || c.expectedCanonicalDocument.trim() === "") throw contextError("Recall case expectedCanonicalDocument is required.", { path, index, id: c.id });
    if (typeof c.expectedPath !== "string" || c.expectedPath.trim() === "") throw contextError("Recall case expectedPath is required.", { path, index, id: c.id });
    return {
      id: c.id.trim(), kind: c.kind as RecallCaseKind, operation: c.operation as RecallCorpusCase["operation"], query: c.query.trim(), collections,
      expectedCanonicalDocument: c.expectedCanonicalDocument.trim(), expectedPath: c.expectedPath.trim(),
      ...(typeof c.expectedErrorCode === "string" ? { expectedErrorCode: c.expectedErrorCode.trim() } : {}),
    } as RecallCorpusCase;
  });
  return { schema: "engram.qmd.recall-corpus.v1", version: root.version.trim(), collectionScope: root.collectionScope.trim(), cases };
}

function resultsToPaths(data: QmdReadData): string[] {
  return data.results.map((row) => {
    if (typeof row === "string") return row;
    const record = asRecord(row);
    if (record && typeof record.file === "string") return record.file;
    if (record && typeof record.path === "string") return record.path;
    return JSON.stringify(row);
  });
}

function codeFromError(error: unknown): string {
  return error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "ERROR";
}

export async function evaluateQmdRecallCorpus(context: QmdContext, corpus: RecallCorpus, runner: QmdProcessOptions = {}): Promise<RecallEvaluatorResult> {
  const cases: RecallCaseResult[] = [];
  for (const testCase of corpus.cases) {
    try {
      const output = await executeQmdRead(context, {
        operation: testCase.operation,
        query: testCase.query,
        collections: testCase.collections,
      }, runner);
      const paths = resultsToPaths(output.data);
      const top1 = paths[0];
      const top3 = paths.slice(0, 3);
      const hitAt1 = top1 === testCase.expectedCanonicalDocument;
      const hitAt3 = top3.includes(testCase.expectedCanonicalDocument);
      const positiveExactPass = testCase.kind === "positive-exact" && hitAt1;
      const positiveVectorPass = testCase.kind === "positive-vector" && hitAt3;
      const isolationPass = testCase.kind === "negative-isolation" && !paths.includes(testCase.expectedCanonicalDocument);
      const passed = positiveExactPass || positiveVectorPass || isolationPass;
      cases.push({
        id: testCase.id,
        kind: testCase.kind,
        query: testCase.query,
        collections: testCase.collections,
        passed,
        ...(top1 ? { top1 } : {}),
        ...(top3.length > 0 ? { top3 } : {}),
        expectedCanonicalDocument: testCase.expectedCanonicalDocument,
        expectedPath: testCase.expectedPath,
        operationRecord: output.data.operationRecord,
      });
    } catch (error) {
      const code = codeFromError(error);
      const message = error instanceof Error ? error.message : String(error);
      const passed = testCase.kind === "negative-policy"
        ? (testCase.expectedErrorCode === undefined || testCase.expectedErrorCode === code)
        : false;
      cases.push({
        id: testCase.id,
        kind: testCase.kind,
        query: testCase.query,
        collections: testCase.collections,
        passed,
        error: { code, message },
        expectedCanonicalDocument: testCase.expectedCanonicalDocument,
        expectedPath: testCase.expectedPath,
      });
    }
  }
  const positives = cases.filter((entry) => entry.kind === "positive-exact" || entry.kind === "positive-vector");
  const passed = cases.filter((entry) => entry.passed).length;
  return {
    schema: "engram.qmd.recall-evaluator.v1",
    corpus: corpus.schema,
    version: corpus.version,
    collectionScope: corpus.collectionScope,
    totals: { cases: cases.length, passed, failed: cases.length - passed },
    recallAt1: positives.length === 0 ? 0 : positives.filter((entry) => entry.top1 === entry.expectedCanonicalDocument).length / positives.length,
    recallAt3: positives.length === 0 ? 0 : positives.filter((entry) => entry.top3?.includes(entry.expectedCanonicalDocument) ?? false).length / positives.length,
    cases,
    diagnostics: {
      misses: cases.filter((entry) => !entry.passed).map((entry) => ({
        id: entry.id,
        kind: entry.kind,
        expectedCanonicalDocument: entry.expectedCanonicalDocument,
        expectedPath: entry.expectedPath,
        ...(entry.top1 !== undefined ? { top1: entry.top1 } : {}),
        ...(entry.top3 !== undefined ? { top3: entry.top3 } : {}),
        ...(entry.error ? { error: entry.error } : {}),
      })),
    },
  };
}
