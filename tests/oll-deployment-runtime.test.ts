import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableTrustedNightlyRuntime, FileDispatchTransport, NightlyDispatchPendingError } from "../src/oll/deployment-runtime";

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function request() {
  return {
    schema: "oll.nightly-spawn-request.v1" as const,
    batchId: "nightly-test", workspaceId: "target", workspacePath: "/srv/target",
    evaluationId: "11111111-1111-4111-8111-111111111111", runId: "22222222-2222-4222-8222-222222222222",
    phase: "hb-rethink" as const, label: "target-hb-rethink", runtimeLabel: "target-hb-rethink-22222222-2222-4222-8222-222222222222",
    model: "deployment/terra", attempt: 1, policyVersion: 1 as const,
    contextDigest: `sha256:${"a".repeat(64)}` as const, contextSnapshotPath: "/state/context.json",
    expectedHandoffPath: "/srv/target/incoming/run.json", fencingGeneration: 1, prompt: "proposal only",
  };
}

describe("OpenClaw durable nightly deployment bridge", () => {
  test("resolves repeated allowed roots without passing Array.map metadata into path.resolve", () => {
    const source = readFileSync(join(import.meta.dir, "..", "scripts", "oll-nightly-runtime.ts"), "utf8");
    expect(source).toContain("allowedRoots.map((root) => resolve(root))");
    expect(source).not.toContain("allowedRoots.map(resolve)");
  });

  test("yields one immutable spawn request, accepts exact-model ack, and resumes without a duplicate spawn", async () => {
    const root = mkdtempSync(join(tmpdir(), "engram-deployment-runtime-")); roots.push(root);
    const transport = new FileDispatchTransport(root, () => "2026-08-11T19:40:00.000Z");
    const runtime = new DurableTrustedNightlyRuntime(transport, () => "2026-08-11T19:40:00.000Z");
    const first = runtime.spawn(request());
    await expect(first).rejects.toBeInstanceOf(NightlyDispatchPendingError);
    transport.acknowledge({ runtimeLabel: request().runtimeLabel, accepted: true, dispatchRef: "session:one", resolvedModel: request().model });
    await expect(runtime.spawn(request())).resolves.toMatchObject({ accepted: true, dispatchRef: "session:one", resolvedModel: "deployment/terra" });
  });

  test("fails closed on model drift or a rejected dispatch", async () => {
    const root = mkdtempSync(join(tmpdir(), "engram-deployment-runtime-")); roots.push(root);
    const transport = new FileDispatchTransport(root);
    const runtime = new DurableTrustedNightlyRuntime(transport);
    await expect(runtime.spawn(request())).rejects.toBeInstanceOf(NightlyDispatchPendingError);
    expect(() => transport.acknowledge({ runtimeLabel: request().runtimeLabel, accepted: true, dispatchRef: "session:one", resolvedModel: "wrong/model" })).toThrow("differs");
    transport.acknowledge({ runtimeLabel: request().runtimeLabel, accepted: false, dispatchRef: "dispatch:error", resolvedModel: request().model, error: "spawn failed" });
    await expect(runtime.spawn(request())).rejects.toThrow("trusted dispatch was rejected");
  });
});
