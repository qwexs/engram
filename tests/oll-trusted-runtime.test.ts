import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NightlySpawnRequestV1 } from "../src/oll/contracts";
import { sha256Digest } from "../src/oll/handoff-v2";
import { TrustedNightlyRuntime, type TrustedSpawnRecordV1, type TrustedSpawnTransport } from "../src/oll/trusted-runtime";

const NOW = "2026-08-11T00:40:00.000Z";

function request(root: string): NightlySpawnRequestV1 {
  return {
    schema: "oll.nightly-spawn-request.v1",
    batchId: "nightly-2026-08-11T00:40:00.000Z",
    workspaceId: "main",
    workspacePath: root,
    evaluationId: "11111111-1111-4111-8111-111111111111",
    runId: "22222222-2222-4222-8222-222222222222",
    phase: "hb-rethink",
    label: "main-hb-rethink",
    runtimeLabel: "main-hb-rethink-22222222-2222-4222-8222-222222222222",
    model: "deployment/full-reasoning",
    attempt: 1,
    policyVersion: 1,
    contextDigest: sha256Digest("context"),
    contextSnapshotPath: join(root, "context.json"),
    expectedHandoffPath: join(root, "incoming", "22222222-2222-4222-8222-222222222222.json"),
    fencingGeneration: 1,
    prompt: "proposal-only",
  };
}

describe("PR 5 trusted nightly runtime boundary", () => {
  test("maps a new dispatch to one spawn and reuses the exact runtime label after interruption", async () => {
    const root = mkdtempSync(join(tmpdir(), "engram-trusted-runtime-"));
    try {
      const records = new Map<string, TrustedSpawnRecordV1>();
      const calls: unknown[] = [];
      const transport: TrustedSpawnTransport = {
        async findByRuntimeLabel(label) { return records.get(label) || null; },
        async spawn(input) {
          calls.push(input);
          const record = { dispatchRef: "session:1", runtimeLabel: input.runtimeLabel, resolvedModel: input.model };
          records.set(input.runtimeLabel, record);
          return record;
        },
      };
      const runtime = new TrustedNightlyRuntime(transport, () => NOW);
      const input = request(root);
      const first = await runtime.spawn(input);
      const resumed = await runtime.spawn(input);
      expect(calls).toHaveLength(1);
      expect(first).toEqual(resumed);
      expect(first).toMatchObject({ accepted: true, runtimeLabel: input.runtimeLabel, resolvedModel: input.model, dispatchRef: "session:1" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fails closed when the trusted transport reports model drift", async () => {
    const root = mkdtempSync(join(tmpdir(), "engram-trusted-runtime-"));
    try {
      const transport: TrustedSpawnTransport = {
        async findByRuntimeLabel() { return null; },
        async spawn(input) { return { dispatchRef: "session:1", runtimeLabel: input.runtimeLabel, resolvedModel: "unexpected/model" }; },
      };
      const runtime = new TrustedNightlyRuntime(transport, () => NOW);
      await expect(runtime.spawn(request(root))).rejects.toThrow("different model");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
