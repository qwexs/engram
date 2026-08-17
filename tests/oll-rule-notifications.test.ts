import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const roots: string[] = [];
const script = join(import.meta.dir, "..", "scripts", "oll-rule-notifications.ts");

function notification(workspace: string, notificationId: string, targetSession: string) {
  const root = join(workspace, "memory-state", "oll", "notifications", "outbox");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, `${notificationId}.json`), JSON.stringify({
    schema: "oll.rule-activation-notification.v1",
    notificationId,
    workspaceId: "fixture",
    batchId: "nightly-fixture",
    planId: "sha256:plan",
    operationId: "sha256:operation",
    targetSession,
    status: "pending",
    items: [],
    messageText: `message-${notificationId}`,
    createdAt: "2026-01-01T00:00:00.000Z",
    deliveredAt: null,
    messageId: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
  }));
}

afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

describe("OLL rule notification delivery routes", () => {
  test("adds an explicit OpenClaw target while preserving legacy route fields", () => {
    const workspace = mkdtempSync(join(tmpdir(), "engram-rule-notifications-")); roots.push(workspace);
    notification(workspace, "direct", "telegram-direct-42");
    notification(workspace, "topic", "telegram-group--100123-topic-7");

    const result = spawnSync("bun", [script, "pending", "--workspace", workspace], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).deliveries).toEqual([
      expect.objectContaining({ notificationId: "direct", channel: "telegram", chatId: "42", target: "telegram:42" }),
      expect.objectContaining({ notificationId: "topic", channel: "telegram", chatId: "-100123", target: "telegram:-100123", threadId: "7" }),
    ]);
  });
});
