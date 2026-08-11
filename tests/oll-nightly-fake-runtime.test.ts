import { describe, expect, test } from "bun:test";
import type { NightlySpawnRequestV1 } from "../src/oll/contracts";
import { FakeNightlyRuntime } from "./fixtures/oll-nightly/fake-runtime";

const ids = {
  firstEvaluation: "11111111-1111-4111-8111-111111111111",
  firstRun: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  secondEvaluation: "22222222-2222-4222-8222-222222222222",
  secondRun: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
};

function request(
  workspaceId: string,
  evaluationId: string,
  runId: string,
): NightlySpawnRequestV1 {
  return {
    schema: "oll.nightly-spawn-request.v1",
    batchId: "nightly-2026-08-11T00:40:00Z",
    workspaceId,
    workspacePath: `/fixtures/${workspaceId}`,
    evaluationId,
    runId,
    phase: "hb-rethink",
    label: `${workspaceId}-hb-rethink`,
    runtimeLabel: `${workspaceId}-hb-rethink-${runId}`,
    model: "deployment/full-reasoning",
    attempt: 1,
    policyVersion: 1,
    contextDigest: `sha256:${"a".repeat(64)}`,
    contextSnapshotPath: `/state/contexts/${workspaceId}.json`,
    expectedHandoffPath: `/state/handoffs/${runId}.json`,
    fencingGeneration: 7,
    prompt: "proposal-only fixture prompt",
  };
}

describe("OLL nightly fake runtime contract", () => {
  test("proves spawn -> handoff -> terminal apply -> next workspace", async () => {
    const runtime = new FakeNightlyRuntime();
    const first = request("main", ids.firstEvaluation, ids.firstRun);
    const second = request("managers", ids.secondEvaluation, ids.secondRun);
    runtime.queueHandoff(first.expectedHandoffPath);
    runtime.queueHandoff(second.expectedHandoffPath);

    for (const item of [first, second]) {
      const acknowledgement = await runtime.spawn(item);
      expect(acknowledgement).toMatchObject({ accepted: true, runId: item.runId });
      const handoff = await runtime.awaitHandoff(item.expectedHandoffPath);
      expect(handoff).toMatchObject({ status: "file", runId: item.runId });
      runtime.markTerminalApplied(item.runId);
    }

    expect(runtime.events.map((event) => `${event.type}:${event.workspaceId || ""}`)).toEqual([
      "spawn:main",
      "handoff:main",
      "terminal_apply:main",
      "spawn:managers",
      "handoff:managers",
      "terminal_apply:managers",
    ]);
    expect(runtime.maxConcurrentRethinkRuns).toBe(1);
  });

  test("rejects a second spawn before terminal application", async () => {
    const runtime = new FakeNightlyRuntime();
    const first = request("main", ids.firstEvaluation, ids.firstRun);
    const second = request("managers", ids.secondEvaluation, ids.secondRun);
    await runtime.spawn(first);
    await expect(runtime.spawn(second)).rejects.toThrow(`spawn-before-terminal-apply:${first.runId}`);
  });

  test("resume is an explicit durable batch operation", async () => {
    const runtime = new FakeNightlyRuntime();
    await expect(runtime.resume("nightly-2026-08-11T00:40:00Z")).resolves.toMatchObject({
      schema: "oll.resume-result.v1",
      resumed: true,
    });
    expect(runtime.events).toEqual([{ type: "resume", batchId: "nightly-2026-08-11T00:40:00Z" }]);
  });
});
