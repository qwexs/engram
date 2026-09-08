import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BATCH_CONFIG_SCHEMA,
  BATCH_FRAME_SCHEMA,
  compileBatchFrame,
  type BatchCompilerConfigV1,
  type BatchSourceFrameEntryV1,
} from "./batch-compiler.ts";
import {
  BATCH_SHADOW_OUTPUT_SCHEMA,
  BATCH_SHADOW_RESULT_SCHEMA,
  MAX_ASSERTIONS_PER_WRITE_GROUP,
  BatchShadowRunnerError,
  batchShadowPrompt,
  parseBatchShadowOutput,
  runBatchShadow,
  storeBatchShadowResult,
  type BatchShadowOutputV1,
  type BatchShadowRunnerConfigV1,
  type BatchShadowRunnerConfigV2,
  type BatchShadowRunnerConfigV3,
} from "./batch-shadow-runner.ts";
import { deriveSourceDigest, sha256, type JsonValue, type ObservationScope } from "./ledger.ts";

const scope: ObservationScope = {
  workspaceId: "main",
  runtimeSessionKey: "agent:main:telegram:direct:100000001",
  scopeClass: "self",
  scopeId: "telegram:100000001",
};
const policyDigest = sha256("policy-v1");
const compilerConfig: BatchCompilerConfigV1 = {
  schema: BATCH_CONFIG_SCHEMA,
  inactivityGapMs: 300_000,
  maxTurns: 10,
  maxEvidenceBytes: 10_000,
  maxAgeMs: 3_600_000,
};
const runnerConfig: BatchShadowRunnerConfigV1 = {
  schema: "engram.memory-batch-shadow-runner-config.v1",
  requestedModel: "openai/gpt-5.6-terra",
  maxTokens: 2_000,
  temperature: 0,
};
const singlePromptConfig: BatchShadowRunnerConfigV2 = {
  schema: "engram.memory-batch-shadow-runner-config.v2",
  requestedModel: "openai/gpt-5.6-terra",
  maxTokens: 2_000,
  temperature: 0,
  messageMode: "single-user",
};
const measuredPromptConfig: BatchShadowRunnerConfigV3 = {
  schema: "engram.memory-batch-shadow-runner-config.v3",
  requestedModel: "openai/gpt-5.6-terra",
  maxTokens: 2_000,
  temperature: 0,
  messageMode: "single-user",
  providerMode: "gateway-agent-meta",
  gatewayAgentId: "managers",
};

function entry(index: number, sourceText?: string): BatchSourceFrameEntryV1 {
  const traceId = sha256(`trace-${index}`);
  const sourceTurnId = `channel-user:v1:${index.toString(16).padStart(64, "0")}`;
  const sourceCompletedAt = `2026-08-31T20:0${index}:00.000Z`;
  const payload = {
    source: { role: "user", text: sourceText ?? (index === 1 ? "PRIVATE-EVIDENCE-ALPHA" : "PRIVATE-EVIDENCE-BETA") },
    outcome: { role: "assistant", text: `completed-${index}` },
  };
  const evidenceIdentity = { schema: "engram.memory-evidence-envelope.v1" as const, traceId, scope, payload };
  return {
    envelope: {
      schema: "engram.memory-observation-job.v1",
      traceId,
      sourceTurnId,
      scope,
      sourceCompletedAt,
      sourceDigest: deriveSourceDigest(sourceTurnId, scope, sourceCompletedAt),
      evidenceDigest: sha256(evidenceIdentity as unknown as JsonValue),
      policyVersion: "memory-observation-authority-v1",
      policyDigest,
      evidenceRefs: [
        { kind: "source-turn", ref: sourceTurnId, digest: sha256(`source-turn-${index}`) },
        { kind: "message", ref: `telegram:${index}`, digest: sha256(`message-${index}`) },
      ],
      authority: { id: "openclaw-runtime", version: "runtime-v1", digest: sha256("runtime-v1") },
      admittedAt: sourceCompletedAt,
    },
    evidence: {
      ...evidenceIdentity,
      createdAt: sourceCompletedAt,
      expiresAt: "2026-08-31T23:00:00.000Z",
    },
  };
}

function bundle(sourceText?: string) {
  return compileBatchFrame({
    schema: BATCH_FRAME_SCHEMA,
    partition: { ...scope, producerEpoch: "runtime-v1", policyDigest },
    sealedAt: "2026-08-31T20:10:00.000Z",
    sources: [entry(1, sourceText), entry(2)],
  }, compilerConfig).bundles[0];
}

function validOutput(): BatchShadowOutputV1 {
  const compiled = bundle();
  return {
    schema: BATCH_SHADOW_OUTPUT_SCHEMA,
    groups: [{
      groupId: "case-1",
      decision: "write",
      sourceRefs: compiled.sourceRefs.map((ref) => ref.traceId),
      assertions: [{
        section: "events",
        text: "Работа по кейсу завершена.",
        actorRef: "assistant",
        outcomeStatus: "completed",
        confidence: 0.95,
        reasonCodes: ["material_result"],
        citations: compiled.inputs.map((input) => ({ traceId: input.traceId, evidenceRef: input.evidenceRefs[0] })),
      }],
    }],
  };
}

function expectCode(callback: () => unknown, code: string): void {
  try {
    callback();
    throw new Error("expected runner failure");
  } catch (error) {
    expect(error).toBeInstanceOf(BatchShadowRunnerError);
    expect((error as BatchShadowRunnerError).code).toBe(code);
  }
}

describe("Terra paired shadow runner", () => {
  test("grounds a literal multiline user comment before enforcing stored text shape", async () => {
    const original = "Сохрани размер.\nНе уменьшай заголовок.\nПоставь подпись сверху.";
    const compiled = bundle(original);
    const output = validOutput();
    const assertion = (output.groups[0] as any).assertions[0];
    Object.assign(assertion, { actorRef: "user", text: original, outcomeStatus: "unknown",
      citations: [{traceId: compiled.inputs[0]!.traceId, evidenceRef: compiled.inputs[0]!.evidenceRefs[0]}] });
    const root = mkdtempSync(join(tmpdir(), "engram-multiline-quote-"));
    try {
      const run = await runBatchShadow({bundle: compiled, config: singlePromptConfig, storeRoot: root,
        now: () => new Date("2026-08-31T20:11:00.000Z"),
        complete: async () => ({output: JSON.stringify(output), resolvedModel: singlePromptConfig.requestedModel})});
      expect((run.result.groups[0] as any).assertions[0]).toMatchObject({
        text: original.replace(/\s+/gu, " "), actorRef: "user", outcomeStatus: "unknown"});
      expect((run.result.groups[0] as any).assertions[0].reasonCodes).toContain("source_quote");
      assertion.actorRef = "assistant";
      expectCode(() => parseBatchShadowOutput(output, compiled, new Date("2026-08-31T20:11:00.000Z")), "INVALID_ASSERTION");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test("freezes a tool-free exact-model request and validates scoped citations", () => {
    const compiled = bundle();
    const first = batchShadowPrompt(compiled, runnerConfig, new Date("2026-08-31T20:11:00.000Z"));
    const second = batchShadowPrompt(structuredClone(compiled), structuredClone(runnerConfig), new Date("2026-08-31T20:12:00.000Z"));
    expect(second.promptDigest).toBe(first.promptDigest);
    expect(second.configDigest).toBe(first.configDigest);
    expect(second.resultKey).toBe(first.resultKey);
    expect(first.request.model).toBe("openai/gpt-5.6-terra");
    expect(first.request.tools).toEqual([]);
    expect(parseBatchShadowOutput(JSON.stringify(validOutput()), compiled, new Date("2026-08-31T20:11:00.000Z"))).toEqual(validOutput());
  });

  test("binds the raw model-run single-user wire shape into prompt and config digests", () => {
    const compiled = bundle();
    const legacy = batchShadowPrompt(compiled, runnerConfig, new Date("2026-08-31T20:11:00.000Z"));
    const raw = batchShadowPrompt(compiled, singlePromptConfig, new Date("2026-08-31T20:11:00.000Z"));
    expect(raw.request.system).toBe("");
    expect(raw.request.tools).toEqual([]);
    const wire = JSON.parse(raw.request.prompt);
    expect(wire.schema).toBe("engram.memory-batch-shadow-single-prompt.v1");
    expect(wire.task.outputContract.groups.type).toBe("array");
    expect(wire.task.outputContract.groups.items.oneOf[0].sourceRefs.type).toBe("array");
    expect(wire.task.outputContract.groups.items.oneOf[1].sourceRefs.type).toBe("array");
    expect(wire.task.outputContract.groups.items.oneOf[0].assertions.maxItems).toBe(MAX_ASSERTIONS_PER_WRITE_GROUP);
    expect(wire.instructions).toContain(`1 to ${MAX_ASSERTIONS_PER_WRITE_GROUP} assertions`);
    expect(wire.instructions).toContain("Never repeat or paraphrase the same fact");
    expect(wire.instructions).toContain("Find explicit continuation chains before classifying");
    expect(wire.instructions).toContain("do not split its diagnosis, clarification, approval, completion, or verification");
    expect(wire.instructions).toContain("routine restart or health confirmations");
    expect(wire.instructions).toContain("completed verified root-cause diagnosis");
    expect(wire.instructions).toContain("actor-aligned source-turn citation");
    expect(raw.promptDigest).not.toBe(legacy.promptDigest);
    expect(raw.configDigest).not.toBe(legacy.configDigest);
    expect(raw.resultKey).not.toBe(legacy.resultKey);
    const measured = batchShadowPrompt(compiled, measuredPromptConfig, new Date("2026-08-31T20:11:00.000Z"));
    expect(measured.promptDigest).toBe(raw.promptDigest);
    expect(measured.configDigest).not.toBe(raw.configDigest);
    expect(measured.resultKey).not.toBe(raw.resultKey);
  });

  test("rejects a tampered or expired compiler bundle before inference", async () => {
    const tampered = structuredClone(bundle());
    tampered.inputs[0].evidence = { text: "tampered" };
    expectCode(() => batchShadowPrompt(tampered, runnerConfig, new Date("2026-08-31T20:11:00.000Z")), "EVIDENCE_DIGEST_MISMATCH");

    const expired = structuredClone(bundle());
    expired.inputs[0].expiresAt = "2026-08-31T20:10:59.000Z";
    let calls = 0;
    const root = mkdtempSync(join(tmpdir(), "engram-batch-shadow-"));
    try {
      await expect(runBatchShadow({
        bundle: expired,
        config: runnerConfig,
        storeRoot: root,
        now: () => new Date("2026-08-31T20:11:00.000Z"),
        complete: async () => {
          calls++;
          return { output: JSON.stringify(validOutput()), resolvedModel: "openai/gpt-5.6-terra" };
        },
      })).rejects.toMatchObject({ code: "EVIDENCE_EXPIRED" });
      expect(calls).toBe(0);
      expect(readdirSync(root)).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("creates one content-addressed result without persisting evidence payload", async () => {
    const root = mkdtempSync(join(tmpdir(), "engram-batch-shadow-"));
    try {
      let requestTools: unknown = null;
      const result = await runBatchShadow({
        bundle: bundle(),
        config: runnerConfig,
        storeRoot: root,
        now: () => new Date("2026-08-31T20:11:00.000Z"),
        complete: async (request) => {
          requestTools = request.tools;
          return {
            output: JSON.stringify(validOutput()),
            resolvedModel: "openai/gpt-5.6-terra",
            usage: { inputTokens: 1200, outputTokens: 180 },
            latencyMs: 2500,
          };
        },
      });
      expect(result.status).toBe("created");
      expect(requestTools).toEqual([]);
      expect(result.result.schema).toBe(BATCH_SHADOW_RESULT_SCHEMA);
      expect(result.result.usageReadback).toBe("measured");
      expect(result.result.monetaryCost).toBe("unknown");
      const stored = readFileSync(result.path, "utf8");
      expect(stored).not.toContain("PRIVATE-EVIDENCE-ALPHA");
      expect(stored).not.toContain("PRIVATE-EVIDENCE-BETA");
      expect(readdirSync(root)).toEqual(["memory-batch-shadow"]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("returns an existing stable result without a second inference call", async () => {
    const root = mkdtempSync(join(tmpdir(), "engram-batch-shadow-"));
    try {
      let calls = 0;
      const options = {
        bundle: bundle(),
        config: runnerConfig,
        storeRoot: root,
        now: () => new Date("2026-08-31T20:11:00.000Z"),
        complete: async () => {
          calls++;
          return { output: JSON.stringify(validOutput()), resolvedModel: "openai/gpt-5.6-terra" };
        },
      };
      expect((await runBatchShadow(options)).status).toBe("created");
      expect((await runBatchShadow(options)).status).toBe("duplicate");
      expect(calls).toBe(1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("detects same-key different-content conflicts in the create-only store", async () => {
    const root = mkdtempSync(join(tmpdir(), "engram-batch-shadow-"));
    try {
      const created = await runBatchShadow({
        bundle: bundle(),
        config: runnerConfig,
        storeRoot: root,
        now: () => new Date("2026-08-31T20:11:00.000Z"),
        complete: async () => ({ output: JSON.stringify(validOutput()), resolvedModel: "openai/gpt-5.6-terra" }),
      });
      const conflicting = { ...created.result, latencyMs: 99 };
      expectCode(() => storeBatchShadowResult(root, conflicting), "RESULT_CONFLICT");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("fails closed on missing coverage, invented evidence refs, and model read-back mismatch", async () => {
    const compiled = bundle();
    const missing = validOutput();
    missing.groups[0].sourceRefs = [compiled.sourceRefs[0].traceId];
    if (missing.groups[0].decision !== "write") throw new Error("fixture is not a write group");
    missing.groups[0].assertions[0].citations = [missing.groups[0].assertions[0].citations[0]];
    expectCode(() => parseBatchShadowOutput(missing, compiled, new Date("2026-08-31T20:11:00.000Z")), "SOURCE_COVERAGE");

    const invented = validOutput();
    if (invented.groups[0].decision !== "write") throw new Error("fixture is not a write group");
    invented.groups[0].assertions[0].citations[0].evidenceRef = {
      kind: "message",
      ref: "invented",
      digest: sha256("invented"),
    };
    expectCode(() => parseBatchShadowOutput(invented, compiled, new Date("2026-08-31T20:11:00.000Z")), "INVALID_CITATION");

    const root = mkdtempSync(join(tmpdir(), "engram-batch-shadow-"));
    try {
      await expect(runBatchShadow({
        bundle: compiled,
        config: runnerConfig,
        storeRoot: root,
        now: () => new Date("2026-08-31T20:11:00.000Z"),
        complete: async () => ({ output: JSON.stringify(validOutput()), resolvedModel: "openai/gpt-5.6-sol" }),
      })).rejects.toMatchObject({ code: "MODEL_READBACK_MISMATCH" });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("accepts bounded distinct assertions and rejects duplicate or over-limit groups", () => {
    const compiled = bundle();
    const multiple = validOutput();
    if (multiple.groups[0].decision !== "write") throw new Error("fixture is not a write group");
    const citation = multiple.groups[0].assertions[0].citations;
    multiple.groups[0].assertions.push({
      section: "decisions",
      text: "Согласован bounded multi-assertion contract.",
      actorRef: "user",
      outcomeStatus: "decided",
      confidence: 1,
      reasonCodes: ["explicit_decision"],
      citations: structuredClone(citation),
    }, {
      section: "events",
      text: "Rollback-проверка завершена.",
      actorRef: "assistant",
      outcomeStatus: "completed",
      confidence: 0.99,
      reasonCodes: ["verified_outcome"],
      citations: structuredClone(citation),
    });
    expect(parseBatchShadowOutput(multiple, compiled, new Date("2026-08-31T20:11:00.000Z"))).toEqual(multiple);

    const duplicate = structuredClone(multiple);
    if (duplicate.groups[0].decision !== "write") throw new Error("fixture is not a write group");
    duplicate.groups[0].assertions.push(structuredClone(duplicate.groups[0].assertions[0]));
    expectCode(() => parseBatchShadowOutput(duplicate, compiled, new Date("2026-08-31T20:11:00.000Z")), "INVALID_ASSERTION");

    const overLimit = structuredClone(validOutput());
    if (overLimit.groups[0].decision !== "write") throw new Error("fixture is not a write group");
    overLimit.groups[0].assertions = Array.from({ length: MAX_ASSERTIONS_PER_WRITE_GROUP + 1 }, (_, index) => ({
      ...structuredClone(overLimit.groups[0].assertions[0]),
      text: `Уникальный факт ${index + 1}.`,
    }));
    expectCode(() => parseBatchShadowOutput(overLimit, compiled, new Date("2026-08-31T20:11:00.000Z")), "INVALID_OUTPUT");
  });

  test("rejects reply-context-only citations that do not anchor the asserted actor to a source turn", () => {
    const compiled = bundle();
    const output = validOutput();
    if (output.groups[0].decision !== "write") throw new Error("fixture is not a write group");
    output.groups[0].assertions[0].citations = compiled.inputs.map((input) => ({
      traceId: input.traceId,
      evidenceRef: input.evidenceRefs[1],
    }));
    expectCode(
      () => parseBatchShadowOutput(output, compiled, new Date("2026-08-31T20:11:00.000Z")),
      "ACTOR_CITATION_MISMATCH",
    );
  });

  test("marks economics unknown when provider usage is absent", async () => {
    const root = mkdtempSync(join(tmpdir(), "engram-batch-shadow-"));
    try {
      const result = await runBatchShadow({
        bundle: bundle(),
        config: runnerConfig,
        storeRoot: root,
        now: () => new Date("2026-08-31T20:11:00.000Z"),
        complete: async () => ({ output: JSON.stringify(validOutput()), resolvedModel: "openai/gpt-5.6-terra" }),
      });
      expect(result.result.usage).toBeNull();
      expect(result.result.usageReadback).toBe("unavailable");
      expect(result.result.monetaryCost).toBe("unknown");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("persists gateway-measured usage and cost without inventing price provenance", async () => {
    const root = mkdtempSync(join(tmpdir(), "engram-batch-shadow-"));
    try {
      const result = await runBatchShadow({
        bundle: bundle(),
        config: runnerConfig,
        storeRoot: root,
        now: () => new Date("2026-08-31T20:11:00.000Z"),
        complete: async () => ({
          output: JSON.stringify(validOutput()),
          resolvedModel: "openai/gpt-5.6-terra",
          usage: { inputTokens: 1200, outputTokens: 180, cacheReadTokens: 300, cacheWriteTokens: 0 },
          costUsd: 0.0042,
        }),
      });
      expect(result.result.usageReadback).toBe("measured");
      expect(result.result.usage).toEqual({
        inputTokens: 1200,
        outputTokens: 180,
        cacheReadTokens: 300,
        cacheWriteTokens: 0,
      });
      expect(result.result.monetaryCost).toEqual({
        provenance: "gateway-agent-meta",
        currency: "USD",
        amount: 0.0042,
      });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
