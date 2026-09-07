import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryWorkerHealth } from "./worker-health.ts";
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "worker-health-")); roots.push(root);
  const put = (dir: string, name: string, value: any) => { const path = join(root, "memory-state/memory-observation/v1", dir);
    mkdirSync(path, { recursive: true }); writeFileSync(join(path, name + ".json"), JSON.stringify(value)); };
  return { root, put };
}
test("terminal JSON failure and pre-admission gap remain visible even with an empty pending queue", () => {
  const f = fixture();
  f.put("queues/evaluator", "a", { status: "terminal", reasonCode: "batch_invalid_json" });
  f.put("pre-admission/checkpoints", "b", { stage: "terminal_gap" });
  expect(memoryWorkerHealth(f.root)).toMatchObject({ status: "degraded", pending: 0, terminalFailures: 1, admissionGaps: 1 });
});
test("legitimate skips and successful applications are not failures", () => {
  const f = fixture();
  f.put("queues/evaluator", "a", { status: "terminal", reasonCode: "semantic_batch_skip" });
  f.put("consumers/daily-note/queue", "b", { status: "terminal", reasonCode: "canonical_applied" });
  expect(memoryWorkerHealth(f.root).status).toBe("ok");
});
test("waiting context is distinguished from technical failure and reports age", () => {
  const f = fixture(); f.put("queues/evaluator", "a", { status: "queued", reasonCode: "semantic_batch_defer", createdAt: "2026-09-07T12:00:00Z" });
  expect(memoryWorkerHealth(f.root, new Date("2026-09-07T12:10:00Z"))).toMatchObject({ status: "waiting_context", waitingContext: 1, oldestPendingAgeSeconds: 600 });
});
