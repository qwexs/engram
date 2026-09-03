import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  BATCH_CONFIG_SCHEMA,
  BATCH_FRAME_SCHEMA,
  BatchCompilerError,
  compileBatchFrame,
  type BatchCompilerConfigV1,
  type BatchPartitionV1,
  type BatchSourceFrameEntryV1,
  type BatchSourceFrameV1,
} from "./batch-compiler.ts";
import { deriveSourceDigest, sha256, type JsonValue, type ObservationScope } from "./ledger.ts";

const scope: ObservationScope = {
  workspaceId: "main",
  runtimeSessionKey: "agent:main:telegram:direct:100000001",
  scopeClass: "self",
  scopeId: "telegram:100000001",
};
const policyDigest = sha256("policy-v1");
const partition: BatchPartitionV1 = { ...scope, producerEpoch: "runtime-v1", policyDigest };
const config: BatchCompilerConfigV1 = {
  schema: BATCH_CONFIG_SCHEMA,
  inactivityGapMs: 5 * 60_000,
  maxTurns: 10,
  maxEvidenceBytes: 10_000,
  maxAgeMs: 60 * 60_000,
};

function entry(index: number, sourceCompletedAt: string, payload: JsonValue = { text: `turn-${index}` }): BatchSourceFrameEntryV1 {
  const traceId = sha256(`trace-${index}`);
  const sourceTurnId = `channel-user:v1:${index.toString(16).padStart(64, "0")}`;
  const evidenceIdentity = {
    schema: "engram.memory-evidence-envelope.v1" as const,
    traceId,
    scope,
    payload,
  };
  const evidenceRef = { kind: "message" as const, ref: `telegram:${index}`, digest: sha256(`message-${index}`) };
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
      evidenceRefs: [evidenceRef],
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

function frame(sources = [
  entry(1, "2026-08-31T20:00:00.000Z"),
  entry(2, "2026-08-31T20:01:00.000Z"),
  entry(3, "2026-08-31T20:07:00.000Z"),
]): BatchSourceFrameV1 {
  return {
    schema: BATCH_FRAME_SCHEMA,
    partition,
    sealedAt: "2026-08-31T20:10:00.000Z",
    sources,
  };
}

function expectCode(callback: () => unknown, code: string): void {
  try {
    callback();
    throw new Error("expected compiler failure");
  } catch (error) {
    expect(error).toBeInstanceOf(BatchCompilerError);
    expect((error as BatchCompilerError).code).toBe(code);
  }
}

describe("deterministic offline batch compiler", () => {
  test("partitions a sealed ordered frame without reading or writing workspace state", () => {
    const source = frame();
    const first = compileBatchFrame(source, config);
    const second = compileBatchFrame(structuredClone(source), structuredClone(config));
    expect(second).toEqual(first);
    expect(first.bundles).toHaveLength(2);
    expect(first.bundles.map((bundle) => bundle.sourceRefs.map((ref) => ref.traceId))).toEqual([
      [source.sources[0].envelope.traceId, source.sources[1].envelope.traceId],
      [source.sources[2].envelope.traceId],
    ]);
    expect(first.exclusions).toEqual([]);
    expect(new Set(first.bundles.flatMap((bundle) => bundle.sourceRefs.map((ref) => ref.traceId))).size).toBe(3);
    expect(first.bundles.every((bundle) => bundle.partition.scopeClass === "self")).toBe(true);
  });

  test("exposes the compiler as a one-shot read-only CLI", () => {
    const root = mkdtempSync(join(tmpdir(), "engram-batch-compiler-"));
    try {
      const framePath = join(root, "frame.json");
      const configPath = join(root, "config.json");
      writeFileSync(framePath, JSON.stringify(frame()), "utf8");
      writeFileSync(configPath, JSON.stringify(config), "utf8");
      const result = spawnSync("bun", ["src/memory-observation/batch-compiler.ts", "--frame", framePath, "--config", configPath], {
        cwd: process.cwd(),
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout).schema).toBe("engram.memory-batch-compile.v1");
      expect(readdirSync(root).sort()).toEqual(["config.json", "frame.json"]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("uses max turns and evidence bytes as deterministic flush boundaries", () => {
    const source = frame([
      entry(1, "2026-08-31T20:00:00.000Z", { text: "a" }),
      entry(2, "2026-08-31T20:00:01.000Z", { text: "b" }),
      entry(3, "2026-08-31T20:00:02.000Z", { text: "c" }),
    ]);
    const report = compileBatchFrame(source, { ...config, maxTurns: 2 });
    expect(report.bundles.map((bundle) => bundle.sourceRefs.length)).toEqual([2, 1]);
    const oneSourceBytes = report.bundles[1].evidenceBytes;
    const byteBounded = compileBatchFrame(source, { ...config, maxEvidenceBytes: oneSourceBytes });
    expect(byteBounded.bundles.map((bundle) => bundle.sourceRefs.length)).toEqual([1, 1, 1]);
  });

  test("terminally excludes old or individually oversized sources and preserves exact coverage", () => {
    const old = entry(1, "2026-08-31T18:00:00.000Z");
    const large = entry(2, "2026-08-31T20:01:00.000Z", { text: "x".repeat(300) });
    const accepted = entry(3, "2026-08-31T20:02:00.000Z");
    const report = compileBatchFrame(frame([old, large, accepted]), { ...config, maxEvidenceBytes: 100 });
    expect(report.exclusions).toEqual([
      { traceId: old.envelope.traceId, reason: "source_too_old" },
      { traceId: large.envelope.traceId, reason: "evidence_bytes_exceeded" },
    ]);
    expect(report.bundles.flatMap((bundle) => bundle.sourceRefs).map((ref) => ref.traceId)).toEqual([accepted.envelope.traceId]);
    expect(report.sourceCount).toBe(3);
  });

  test("fails closed on reordered, duplicate, and cross-partition sources", () => {
    const first = entry(1, "2026-08-31T20:00:00.000Z");
    const second = entry(2, "2026-08-31T20:01:00.000Z");
    expectCode(() => compileBatchFrame(frame([second, first]), config), "REORDERED_SOURCE");
    expectCode(() => compileBatchFrame(frame([first, structuredClone(first)]), config), "DUPLICATE_SOURCE");
    const crossed = structuredClone(second);
    crossed.envelope.scope.scopeId = "telegram:other";
    crossed.evidence.scope.scopeId = "telegram:other";
    expectCode(() => compileBatchFrame(frame([first, crossed]), config), "CROSS_PARTITION_SOURCE");
  });

  test("fails closed on tampered, expired, or structurally unknown evidence", () => {
    const tampered = entry(1, "2026-08-31T20:00:00.000Z");
    tampered.evidence.payload = { text: "changed" };
    expectCode(() => compileBatchFrame(frame([tampered]), config), "EVIDENCE_DIGEST_MISMATCH");

    const expired = entry(2, "2026-08-31T20:01:00.000Z");
    expired.evidence.expiresAt = "2026-08-31T20:09:59.000Z";
    expectCode(() => compileBatchFrame(frame([expired]), config), "EVIDENCE_EXPIRED");

    const unknown = frame([entry(3, "2026-08-31T20:02:00.000Z")]) as unknown as Record<string, unknown>;
    unknown.queue = "live";
    expectCode(() => compileBatchFrame(unknown, config), "INVALID_FRAME");
  });
});
