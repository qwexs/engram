import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { memoryBatchIsIdle } from "./idle-preflight.ts";

const roots: string[] = [];
const key = "a".repeat(64) + ".json";
const mo = "memory-state/memory-observation/";
const domain = "memory-state/domain-effects/v1/";
function fixture() {
  const workspace = mkdtempSync(join(tmpdir(), "memory-idle-")); roots.push(workspace);
  const put = (directory: string, value: unknown) => {
    const path = join(workspace, directory, key);
    mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value));
  };
  return { workspace, put, idle: () => memoryBatchIsIdle(workspace, true) };
}
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

test("empty workspace is idle; an arrival on the next tick is not cached away", () => {
  const f = fixture(); expect(f.idle()).toBe(true);
  f.put(mo + "v1/envelopes", { traceId: "sha256:" + key.slice(0, -5) });
  expect(f.idle()).toBe(false);
});

for (const [directory, schema, statuses] of [
  ["v1/queues/evaluator", "engram.memory-observation-ledger-queue.v1", ["queued", "claimed"]],
  ["v1/consumers/daily-note/queue", "engram.memory-observation-consumer-queue.v1", ["queued", "claimed", "qmd_pending"]],
] as const) {
  for (const status of statuses) test(`preserves ${directory} ${status}, including future retries`, () => {
    const f = fixture(); f.put(mo + directory, { schema, status, nextAttemptAt: "2099-01-01T00:00:00Z" });
    expect(f.idle()).toBe(false);
    f.put(mo + directory, { schema, status: "terminal" }); expect(f.idle()).toBe(true);
  });
}

for (const directory of ["v1/observations/batch", "v1/observations/typed"]) {
  test(`preserves interrupted queue publication for ${directory}`, () => {
    const f = fixture(); f.put(mo + directory, {}); expect(f.idle()).toBe(false);
    f.put(mo + "v1/consumers/daily-note/queue", { schema: "engram.memory-observation-consumer-queue.v1", status: "terminal" });
    expect(f.idle()).toBe(true);
  });
}

test("unfinished persisted batch is work even without an evaluator queue", () => {
  const f = fixture(); f.put(mo + "batch-live-store/memory-batch-live/v1/jobs", {});
  expect(f.idle()).toBe(false);
  f.put(mo + "batch-live-store/memory-batch-live/v1/done", {}); expect(f.idle()).toBe(true);
});

test("domain projection and QMD handoff each prevent idle; recovery survives source retention", () => {
  const f = fixture(); f.put(mo + "v1/receipts/by-operation", {}); expect(f.idle()).toBe(false);
  expect(memoryBatchIsIdle(f.workspace, false)).toBe(true);
  f.put(domain + "receipts", {}); expect(f.idle()).toBe(false);
  rmSync(join(f.workspace, mo, "v1/receipts"), { recursive: true }); expect(f.idle()).toBe(false);
  f.put(domain + "dirty", {}); expect(f.idle()).toBe(true);
});

test("malformed JSON, unknown queue schema and unreadable directory use the full path", () => {
  const f = fixture(); f.put(mo + "v1/queues/evaluator", { status: "terminal" }); expect(f.idle()).toBe(false);
  writeFileSync(join(f.workspace, mo, "v1/queues/evaluator", key), "{"); expect(f.idle()).toBe(false);
  rmSync(join(f.workspace, mo, "v1/queues/evaluator"), { recursive: true });
  writeFileSync(join(f.workspace, mo, "v1/queues/evaluator"), "not a directory"); expect(f.idle()).toBe(false);
});
