import { describe, expect, test } from "bun:test";
import { memoryWorkerRunResult } from "./worker-run-result.ts";

describe("memory worker execution result", () => {
  test("idle, deferred work, duplicate delivery and successful writes do not fail a pass", () => {
    expect(memoryWorkerRunResult()).toEqual({ status: "ok", exitCode: 0, errors: [] });
    expect(memoryWorkerRunResult({
      evaluations: [{ status: "idle" }, { status: "busy" }, { status: "completed" }, { status: "duplicate" }],
      applications: [{ status: "applied" }, { status: "duplicate" }, { status: "busy" }],
      domains: { indexedPending: 0 },
    }).exitCode).toBe(0);
  });

  test.each(["retry", "terminal_failure"] as const)("a current evaluator %s remains an execution error", status => {
    expect(memoryWorkerRunResult({ evaluations: [{ status }] })).toEqual({
      status: "error", exitCode: 1, errors: [`evaluation:${status}`],
    });
  });

  test.each(["retry", "terminal_failure", "qmd_pending", "disabled"] as const)("a current writer %s is not masked", status => {
    expect(memoryWorkerRunResult({ applications: [{ status }] }).exitCode).toBe(1);
  });

  test("an earlier failure survives a later successful batch and domain dirty-mark failures stay visible", () => {
    expect(memoryWorkerRunResult({ evaluations: [{ status: "retry" }, { status: "completed" }],
      applications: [{ status: "retry" }, { status: "retry" }, { status: "applied" }], domains: { indexedPending: 1 } })).toEqual({
      status: "error", exitCode: 1, errors: ["daily_note:retry", "domains:qmd_pending", "evaluation:retry"],
    });
  });
});
