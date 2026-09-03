#!/usr/bin/env bun
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  episodicEvaluationPrompt,
  parseEpisodicEvaluation,
} from "../src/memory-observation/episodic-evaluator.ts";
import type { EvaluationEvidenceV1 } from "../src/memory-observation/ledger.ts";

type JsonObject = Record<string, unknown>;
type GoldDecision = "write" | "skip";
type ReplayDecision = ReturnType<typeof parseEpisodicEvaluation>;

type ReplayCase = {
  traceId: string;
  sourceCreatedAt: string;
  evidenceQuality: string;
  goldDecision: GoldDecision;
  baselineReasonCode: string;
  baselineDecision: GoldDecision;
  evidenceDigest: string;
  result?: {
    decision: ReplayDecision;
    resolvedModel: string;
    latencyMs: number;
    usage: JsonObject;
  };
};

type ReplayArtifact = {
  schema: "engram.memory-observation-evaluator-replay.v1";
  status: "running" | "completed" | "failed";
  createdAt: string;
  updatedAt: string;
  workspace: string;
  labelsPath: string;
  outputPath: string;
  model: string;
  purpose: string;
  snapshot: {
    annotated: number;
    semanticEvaluated: number;
    included: number;
    excluded: Array<{ traceId: string; reason: "evidence_expired" | "not_semantically_evaluated" }>;
    classBalance: { write: number; skip: number };
  };
  cases: ReplayCase[];
  processed: number;
  summary?: ReturnType<typeof summarize>;
  failure?: string;
};

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const output: Record<string, string | boolean> = {};
  for (let index = 2; index < argv.length; index++) {
    const value = argv[index]!;
    if (!value.startsWith("--")) throw new Error(`unknown positional argument: ${value}`);
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) { output[value.slice(2)] = next; index++; }
    else output[value.slice(2)] = true;
  }
  return output;
}

function required(options: Record<string, string | boolean>, name: string): string {
  const value = options[name];
  if (typeof value !== "string" || !value.trim()) throw new Error(`--${name} is required`);
  return value.trim();
}

function absolute(value: string, name: string): string {
  if (!isAbsolute(value)) throw new Error(`--${name} must be absolute`);
  return resolve(value);
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"));
}

function atomicWrite(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const descriptor = openSync(temp, "wx", 0o600);
  try {
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temp, path);
  if (process.platform !== "win32") {
    const directory = openSync(dirname(path), "r");
    try { fsyncSync(directory); } finally { closeSync(directory); }
  }
}

function decisionFromReason(reasonCode: string): GoldDecision {
  if (reasonCode === "semantic_write") return "write";
  if (reasonCode.startsWith("semantic_skip_")) return "skip";
  throw new Error(`queue record is not semantically evaluated: ${reasonCode}`);
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function confusion(cases: ReplayCase[], selector: (entry: ReplayCase) => GoldDecision): JsonObject {
  let truePositive = 0;
  let falsePositive = 0;
  let trueNegative = 0;
  let falseNegative = 0;
  for (const entry of cases) {
    const predicted = selector(entry);
    if (entry.goldDecision === "write" && predicted === "write") truePositive++;
    else if (entry.goldDecision === "skip" && predicted === "write") falsePositive++;
    else if (entry.goldDecision === "skip" && predicted === "skip") trueNegative++;
    else falseNegative++;
  }
  return {
    truePositive,
    falsePositive,
    trueNegative,
    falseNegative,
    recall: ratio(truePositive, truePositive + falseNegative),
    precision: ratio(truePositive, truePositive + falsePositive),
    accuracy: ratio(truePositive + trueNegative, cases.length),
    f1: ratio(2 * truePositive, (2 * truePositive) + falsePositive + falseNegative),
  };
}

function summarize(cases: ReplayCase[]): JsonObject {
  if (cases.some((entry) => !entry.result)) throw new Error("cannot summarize an incomplete replay");
  const resolvedModels = [...new Set(cases.map((entry) => entry.result!.resolvedModel))];
  const latencyMs = cases.map((entry) => entry.result!.latencyMs).sort((a, b) => a - b);
  return {
    baseline: confusion(cases, (entry) => entry.baselineDecision),
    replay: confusion(cases, (entry) => entry.result!.decision.decision),
    agreementWithBaseline: ratio(
      cases.filter((entry) => entry.baselineDecision === entry.result!.decision.decision).length,
      cases.length,
    ),
    resolvedModels,
    latencyMs: {
      min: latencyMs[0] ?? null,
      median: latencyMs[Math.floor(latencyMs.length / 2)] ?? null,
      max: latencyMs.at(-1) ?? null,
    },
  };
}

async function runtime(openClawDist: string, model: string, sessionKey: string, agentId: string) {
  const llmModule = await import(pathToFileURL(join(openClawDist, "runtime-llm.runtime.js")).href) as {
    createRuntimeLlm: (options: JsonObject) => {
      complete: (request: {
        messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
        model: string;
        maxTokens: number;
        temperature: number;
        purpose: string;
      }) => Promise<{
        text: string;
        provider: string;
        model: string;
        usage?: JsonObject;
      }>;
    };
  };
  const configModule = await import(pathToFileURL(join(openClawDist, "config", "config.js")).href) as {
    loadConfig: () => JsonObject;
  };
  const config = configModule.loadConfig();
  return llmModule.createRuntimeLlm({
    getConfig: () => config,
    authority: {
      caller: { kind: "plugin", id: "engram-memory-observation", name: "Engram Memory Observation" },
      pluginIdForPolicy: "engram-memory-observation",
      requiresBoundAgent: true,
      sessionKey,
      agentId,
      allowAgentIdOverride: false,
      allowModelOverride: false,
      allowComplete: true,
    },
  }).complete;
}

function snapshot(workspace: string, labelsPath: string): {
  cases: ReplayCase[];
  excluded: ReplayArtifact["snapshot"]["excluded"];
  annotated: number;
  semanticEvaluated: number;
} {
  const labels = readJson(labelsPath);
  const annotations = Array.isArray(labels.annotations) ? labels.annotations : [];
  if (annotations.length === 0) throw new Error("label artifact has no annotations");
  const seen = new Set<string>();
  const cases: ReplayCase[] = [];
  const excluded: ReplayArtifact["snapshot"]["excluded"] = [];
  let semanticEvaluated = 0;
  for (const annotation of annotations) {
    const traceId = String(annotation.traceId ?? "");
    if (!/^sha256:[a-f0-9]{64}$/.test(traceId)) throw new Error(`invalid annotation traceId: ${traceId}`);
    if (seen.has(traceId)) throw new Error(`duplicate annotation traceId: ${traceId}`);
    seen.add(traceId);
    const key = traceId.slice("sha256:".length);
    const queuePath = join(workspace, "memory-state", "memory-observation", "v1", "queues", "evaluator", `${key}.json`);
    const queue = readJson(queuePath);
    const reasonCode = String(queue.reasonCode ?? "");
    if (!reasonCode.startsWith("semantic_")) {
      excluded.push({ traceId, reason: "not_semantically_evaluated" });
      continue;
    }
    semanticEvaluated++;
    const evidencePath = join(workspace, "memory-state", "memory-observation", "v1", "evidence", `${key}.json`);
    if (!existsSync(evidencePath)) {
      excluded.push({ traceId, reason: "evidence_expired" });
      continue;
    }
    const envelopePath = join(workspace, "memory-state", "memory-observation", "v1", "envelopes", `${key}.json`);
    const envelope = readJson(envelopePath);
    const evidenceText = readFileSync(evidencePath, "utf8");
    const goldDecision = String(annotation.memoryDecision) as GoldDecision;
    if (goldDecision !== "write" && goldDecision !== "skip") throw new Error(`invalid gold decision for ${traceId}`);
    cases.push({
      traceId,
      sourceCreatedAt: String(annotation.sourceCreatedAt ?? envelope.sourceCompletedAt ?? ""),
      evidenceQuality: String(annotation.evidenceQuality ?? "unknown"),
      goldDecision,
      baselineReasonCode: reasonCode,
      baselineDecision: decisionFromReason(reasonCode),
      evidenceDigest: digest(evidenceText),
    });
  }
  return { cases, excluded, annotated: annotations.length, semanticEvaluated };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv);
  const workspace = absolute(required(options, "workspace"), "workspace");
  const labelsPath = absolute(required(options, "labels"), "labels");
  const outputPath = absolute(required(options, "output"), "output");
  const openClawDist = absolute(required(options, "openclaw-dist"), "openclaw-dist");
  const model = required(options, "model");
  const sessionKey = required(options, "session-key");
  const agentId = required(options, "agent-id");
  const maxCasesRaw = options["max-cases"];
  const maxCases = typeof maxCasesRaw === "string" ? Number(maxCasesRaw) : Number.POSITIVE_INFINITY;
  if (!(maxCases === Number.POSITIVE_INFINITY || (Number.isInteger(maxCases) && maxCases >= 1))) {
    throw new Error("--max-cases must be a positive integer");
  }
  if (existsSync(outputPath)) throw new Error("--output already exists; choose a new immutable replay path");
  const frozen = snapshot(workspace, labelsPath);
  const selected = frozen.cases.slice(0, maxCases);
  const now = new Date().toISOString();
  const artifact: ReplayArtifact = {
    schema: "engram.memory-observation-evaluator-replay.v1",
    status: "running",
    createdAt: now,
    updatedAt: now,
    workspace,
    labelsPath,
    outputPath,
    model,
    purpose: "engram-memory-observation-evaluator-paired-replay",
    snapshot: {
      annotated: frozen.annotated,
      semanticEvaluated: frozen.semanticEvaluated,
      included: selected.length,
      excluded: frozen.excluded,
      classBalance: {
        write: selected.filter((entry) => entry.goldDecision === "write").length,
        skip: selected.filter((entry) => entry.goldDecision === "skip").length,
      },
    },
    cases: selected,
    processed: 0,
  };
  atomicWrite(outputPath, artifact);
  const complete = await runtime(openClawDist, model, sessionKey, agentId);
  try {
    for (const entry of artifact.cases) {
      const key = entry.traceId.slice("sha256:".length);
      const envelope = readJson(join(workspace, "memory-state", "memory-observation", "v1", "envelopes", `${key}.json`));
      const evidence = readJson(join(workspace, "memory-state", "memory-observation", "v1", "evidence", `${key}.json`));
      const request = episodicEvaluationPrompt({ envelope, evidence } as EvaluationEvidenceV1);
      const startedAt = Date.now();
      const response = await complete({
        messages: [
          { role: "system", content: request.system },
          { role: "user", content: request.prompt },
        ],
        model,
        maxTokens: request.maxTokens,
        temperature: request.temperature,
        purpose: artifact.purpose,
      });
      const resolvedModel = `${response.provider}/${response.model}`;
      if (resolvedModel !== model) throw new Error(`resolved unexpected model ${resolvedModel}`);
      entry.result = {
        decision: parseEpisodicEvaluation(response.text),
        resolvedModel,
        latencyMs: Date.now() - startedAt,
        usage: response.usage ?? {},
      };
      artifact.processed++;
      artifact.updatedAt = new Date().toISOString();
      atomicWrite(outputPath, artifact);
      console.log(JSON.stringify({ processed: artifact.processed, total: artifact.cases.length, traceId: entry.traceId, decision: entry.result.decision.decision }));
    }
    artifact.status = "completed";
    artifact.summary = summarize(artifact.cases);
    artifact.updatedAt = new Date().toISOString();
    atomicWrite(outputPath, artifact);
  } catch (error) {
    artifact.status = "failed";
    artifact.failure = error instanceof Error ? error.message : String(error);
    artifact.updatedAt = new Date().toISOString();
    atomicWrite(outputPath, artifact);
    throw error;
  }
  console.log(JSON.stringify({ status: artifact.status, outputPath, summary: artifact.summary }));
}

await main();
