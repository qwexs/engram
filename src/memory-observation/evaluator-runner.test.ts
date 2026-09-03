import { describe, expect, test } from "bun:test";
import { AutonomousEpisodicRunner } from "./evaluator-runner.ts";

function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (predicate()) return resolve();
      if (Date.now() - started >= timeoutMs) return reject(new Error("condition timed out"));
      setTimeout(poll, 5);
    };
    poll();
  });
}

describe("autonomous episodic evaluator runner", () => {
  test("drains due work and schedules a retry without another user turn", async () => {
    let calls = 0;
    let retryDueAt: Date | null = null;
    const statuses: string[] = [];
    const runner = new AutonomousEpisodicRunner({
      isActive: () => true,
      processOne: async () => {
        calls++;
        if (calls === 1) {
          retryDueAt = new Date(Date.now() + 25);
          return { status: "retry", traceId: "trace-1", reason: "technical_model_failure" };
        }
        if (calls === 2 && retryDueAt && Date.now() < retryDueAt.getTime()) return { status: "idle" };
        if (calls <= 3) {
          retryDueAt = null;
          return { status: "written", traceId: "trace-1" };
        }
        return { status: "idle" };
      },
      nextDueAt: () => retryDueAt,
      onResult: (result) => statuses.push(result.status),
      batchLimit: 10,
      errorDelayMs: 5,
    });
    runner.start();
    await waitFor(() => statuses.includes("written"));
    runner.stop();
    expect(statuses.slice(0, 3)).toEqual(["retry", "idle", "written"]);
  });

  test("stops immediately when the projection is inactive", async () => {
    let calls = 0;
    const runner = new AutonomousEpisodicRunner({
      isActive: () => false,
      processOne: async () => { calls++; return { status: "idle" }; },
      nextDueAt: () => null,
    });
    runner.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toBe(0);
  });
});
