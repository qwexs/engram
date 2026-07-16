import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { reconcileStrandedSpawnRecords, runtimeSpawnLabel, transitionSpawnRecord } from "./spawn-lifecycle.js";

function fixture(record) {
  const root = join(tmpdir(), `engram-spawn-lifecycle-${randomUUID()}`);
  const done = join(root, "done");
  mkdirSync(done, { recursive: true });
  writeFileSync(join(done, `${record.runId}.json`), JSON.stringify(record));
  return root;
}

describe("spawn lifecycle", () => {
  test("runtime labels are unique while phase label stays stable", () => {
    expect(runtimeSpawnLabel("hb-rethink", "hb-rethink-2026-07-16-aaaaaaaa")).toBe("hb-rethink-aaaaaaaa");
    expect(runtimeSpawnLabel("hb-rethink", "hb-rethink-2026-07-16-bbbbbbbb")).toBe("hb-rethink-bbbbbbbb");
  });

  test("spawned record transitions to done atomically and idempotently", async () => {
    const runId = "hb-rethink-2026-07-16-aaaaaaaa";
    const root = fixture({ runId, phase: "hb-rethink", status: "spawned" });
    try {
      const first = await transitionSpawnRecord({ spawnsDir: root, runId, phase: "hb-rethink", status: "done", handoffPath: join(root, "done", `${runId}.md`), now: "2026-07-16T10:00:00.000Z" });
      expect(first).toMatchObject({ ok: true, changed: true });
      const saved = JSON.parse(readFileSync(join(root, "done", `${runId}.json`), "utf8"));
      expect(saved).toMatchObject({ status: "done", completedAt: "2026-07-16T10:00:00.000Z" });
      const replay = await transitionSpawnRecord({ spawnsDir: root, runId, phase: "hb-rethink", status: "done" });
      expect(replay).toMatchObject({ ok: true, changed: false });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("rejects wrong phase and conflicting terminal transition", async () => {
    const runId = "hb-rethink-2026-07-16-aaaaaaaa";
    const root = fixture({ runId, phase: "hb-rethink", status: "spawned" });
    try {
      expect(await transitionSpawnRecord({ spawnsDir: root, runId, phase: "hb-rethink2", status: "done" })).toMatchObject({ ok: false, error: "phase-mismatch" });
      await transitionSpawnRecord({ spawnsDir: root, runId, phase: "hb-rethink", status: "failed" });
      expect(await transitionSpawnRecord({ spawnsDir: root, runId, phase: "hb-rethink", status: "done" })).toMatchObject({ ok: false, error: "already-terminal:failed" });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("rejects run-id path traversal", async () => {
    expect(await transitionSpawnRecord({ spawnsDir: "/tmp/engram", runId: "../escape", status: "failed" })).toMatchObject({ ok: false, error: "invalid-run-id" });
  });

  test("reconciler marks only old spawned records without handoff", async () => {
    const oldId = "hb-rethink-2026-07-15-oldold00";
    const freshId = "hb-rethink-2026-07-16-fresh000";
    const root = fixture({ runId: oldId, phase: "hb-rethink", status: "spawned", spawnedAt: "2026-07-15T00:00:00.000Z" });
    writeFileSync(join(root, "done", `${freshId}.json`), JSON.stringify({ runId: freshId, phase: "hb-rethink", status: "spawned", spawnedAt: "2026-07-16T11:30:00.000Z" }));
    try {
      const dry = await reconcileStrandedSpawnRecords({ spawnsDir: root, olderThanMs: 2 * 60 * 60 * 1000, nowMs: Date.parse("2026-07-16T12:00:00.000Z") });
      expect(dry).toMatchObject({ spawned: 2, pending: 1, stranded: 1, failed: 0 });
      const applied = await reconcileStrandedSpawnRecords({ spawnsDir: root, olderThanMs: 2 * 60 * 60 * 1000, nowMs: Date.parse("2026-07-16T12:00:00.000Z"), apply: true });
      expect(applied).toMatchObject({ stranded: 1, failed: 1, errors: [] });
      expect(JSON.parse(readFileSync(join(root, "done", `${oldId}.json`), "utf8"))).toMatchObject({ status: "failed", error: "legacy-missing-handoff" });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("malformed handoff does not keep an old record pending forever", async () => {
    const runId = "hb-rethink-2026-07-15-malform0";
    const root = fixture({ runId, phase: "hb-rethink", status: "spawned", spawnedAt: "2026-07-15T00:00:00.000Z" });
    mkdirSync(join(root, "handoff"), { recursive: true });
    writeFileSync(join(root, "handoff", `${runId}.md`), "not a handoff block");
    try {
      const result = await reconcileStrandedSpawnRecords({ spawnsDir: root, olderThanMs: 2 * 60 * 60 * 1000, nowMs: Date.parse("2026-07-16T12:00:00.000Z"), apply: true });
      expect(result).toMatchObject({ pending: 0, stranded: 1, failed: 1, errors: [] });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
