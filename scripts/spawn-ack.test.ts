import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordDispatchAcknowledgement } from "./spawn-ack.js";

describe("spawn dispatch acknowledgement", () => {
  test("persists resolved model and acknowledgement idempotently", () => {
    const root = mkdtempSync(join(tmpdir(), "engram-spawn-ack-"));
    const runId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const done = join(root, "workspace", "ops", "heartbeat-spawns", "done");
    mkdirSync(done, { recursive: true });
    mkdirSync(join(root, "memory"), { recursive: true });
    const record = {
      workspaceId: "managers",
      runId,
      phase: "hb-rethink",
      label: "managers-hb-rethink",
      runtimeLabel: `managers-hb-rethink-${runId}`,
      model: "provider/full",
      status: "spawned",
    };
    writeFileSync(join(done, `${runId}.json`), JSON.stringify(record));
    writeFileSync(join(root, "memory", "heartbeat-state.json"), JSON.stringify({
      subagentRuns: { "hb-rethink": { ...record } },
    }));
    try {
      const first = recordDispatchAcknowledgement({
        workspace: root,
        runId,
        accepted: true,
        dispatchRef: "session:fake",
        acknowledgedAt: "2026-08-11T01:00:00.000Z",
      });
      expect(first.changed).toBe(true);
      expect(first.acknowledgement).toMatchObject({
        schema: "oll.dispatch-ack.v1",
        accepted: true,
        resolvedModel: "provider/full",
        runtimeLabel: `managers-hb-rethink-${runId}`,
      });
      const replay = recordDispatchAcknowledgement({
        workspace: root,
        runId,
        accepted: true,
        dispatchRef: "session:fake",
      });
      expect(replay.changed).toBe(false);
      const state = JSON.parse(readFileSync(join(root, "memory", "heartbeat-state.json"), "utf8"));
      expect(state.subagentRuns["hb-rethink"].dispatchAcknowledgement.dispatchRef).toBe("session:fake");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects a conflicting replay", () => {
    const root = mkdtempSync(join(tmpdir(), "engram-spawn-ack-"));
    const runId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const done = join(root, "workspace", "ops", "heartbeat-spawns", "done");
    mkdirSync(done, { recursive: true });
    writeFileSync(join(done, `${runId}.json`), JSON.stringify({
      runId,
      phase: "hb-rethink",
      runtimeLabel: `main-hb-rethink-${runId}`,
      model: "provider/full",
      status: "spawned",
      dispatchAcknowledgement: {
        schema: "oll.dispatch-ack.v1",
        runId,
        accepted: true,
        acknowledgedAt: "2026-08-11T01:00:00.000Z",
        runtimeLabel: `main-hb-rethink-${runId}`,
        resolvedModel: "provider/full",
        dispatchRef: "session:first",
      },
    }));
    try {
      expect(() => recordDispatchAcknowledgement({
        workspace: root,
        runId,
        accepted: true,
        dispatchRef: "session:other",
      })).toThrow("conflicting dispatch acknowledgement");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
