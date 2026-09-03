import { describe, expect, test } from "bun:test";
import { AutonomousDailyNoteCanaryRunner } from "./daily-note-runner.ts";

describe("autonomous daily-note canary runner", () => {
  test("resumes persisted due work after idle and a QMD-pending result", async () => {
    let calls = 0;
    let dueAt: Date | null = new Date(Date.now() + 20);
    const statuses: string[] = [];
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => { resolveDone = resolve; });
    const runner = new AutonomousDailyNoteCanaryRunner({
      isActive: () => true,
      nextDueAt: () => dueAt,
      processOne: async () => {
        calls++;
        if (calls === 1) return { status: "idle" };
        if (calls === 2) {
          const nextAttemptAt = new Date(Date.now() + 20).toISOString();
          dueAt = new Date(nextAttemptAt);
          return { status: "qmd_pending", traceId: "trace", reason: "QMD_DIRTY_MARK_FAILED", nextAttemptAt };
        }
        dueAt = null;
        return { status: "disabled" };
      },
      onResult: (result) => {
        statuses.push(result.status);
        if (statuses.length === 3) resolveDone();
      },
    });
    runner.start();
    await Promise.race([
      done,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("runner did not resume due work")), 1_000)),
    ]);
    runner.stop();
    expect(statuses).toEqual(["idle", "qmd_pending", "disabled"]);
  });
});
