import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const roots: string[] = [];
const script = join(import.meta.dir, "..", "scripts", "oll-rule-notifications.ts");

function fixtureId(index: number): string {
  return `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`;
}

function notification(workspace: string, index: number, targetSession: string, options: {
  batchId?: string; ruleText?: string;
} = {}) {
  const notificationId = fixtureId(index);
  const ruleText = options.ruleText ?? `Правило ${index}`;
  const root = join(workspace, "memory-state", "oll", "notifications", "outbox");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, `${notificationId}.json`), JSON.stringify({
    schema: "oll.rule-activation-notification.v1",
    notificationId,
    workspaceId: "fixture",
    batchId: options.batchId ?? "nightly-fixture",
    planId: `sha256:${String(index).padStart(64, "0")}`,
    operationId: `sha256:${String(index + 10).padStart(64, "0")}`,
    targetSession,
    status: "pending",
    items: [{ number: 1, ruleId: fixtureId(index + 100), ruleRevision: 1, ruleText, status: "active" }],
    messageText: `> **1.** ${ruleText}`,
    createdAt: "2026-01-01T00:00:00.000Z",
    deliveredAt: null,
    messageId: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
  }));
}

function pending(...workspaces: string[]) {
  const result = spawnSync("bun", [script, "pending", ...workspaces.flatMap(workspace => ["--workspace", workspace])], { encoding: "utf8" });
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout).deliveries;
}

afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

describe("OLL rule notification delivery routes", () => {
  test("adds an explicit OpenClaw target while preserving legacy route fields", () => {
    const workspace = mkdtempSync(join(tmpdir(), "engram-rule-notifications-")); roots.push(workspace);
    notification(workspace, 1, "telegram-direct-42");
    notification(workspace, 2, "telegram-group--100123-topic-7");

    expect(pending(workspace)).toEqual([
      expect.objectContaining({ notificationId: fixtureId(1), channel: "telegram", chatId: "42", target: "telegram:42" }),
      expect.objectContaining({ notificationId: fixtureId(2), channel: "telegram", chatId: "-100123", target: "telegram:-100123", threadId: "7" }),
    ]);
  });

  test("groups independent plans on the same route without mixing topics, batches or workspaces", () => {
    const workspace = mkdtempSync(join(tmpdir(), "engram-rule-notifications-"));
    const other = mkdtempSync(join(tmpdir(), "engram-rule-notifications-"));
    roots.push(workspace, other);
    const topic = "telegram-group--100123-topic-7";
    notification(workspace, 1, topic);
    notification(workspace, 2, topic);
    notification(workspace, 3, "telegram-group--100123-topic-8");
    notification(workspace, 4, "telegram-group--100123");
    notification(workspace, 5, "telegram-group--100123");
    notification(workspace, 6, topic, { batchId: "older-batch" });
    notification(other, 7, topic);

    const deliveries = pending(workspace, other);
    expect(deliveries).toHaveLength(5);
    const grouped = deliveries.find((delivery: any) => delivery.message.includes("**2.** Правило 2"));
    expect(grouped).toMatchObject({ workspace, target: "telegram:-100123", threadId: "7" });
    expect(grouped.message).toContain("**1.** Правило 1");
    expect(deliveries).toContainEqual(expect.objectContaining({
      workspace, message: expect.stringContaining("**2.** Правило 5"), target: "telegram:-100123",
    }));
    expect(pending(workspace, other)).toEqual(deliveries);
  });

  test("does not combine texts that would exceed Telegram's limit or lose the next item", () => {
    const workspace = mkdtempSync(join(tmpdir(), "engram-rule-notifications-"));
    roots.push(workspace);
    const topic = "telegram-group--100123-topic-7";
    notification(workspace, 1, topic, { ruleText: "А".repeat(3900) });
    notification(workspace, 2, topic, { ruleText: "Б".repeat(600) });
    notification(workspace, 3, topic);

    const deliveries = pending(workspace);
    expect(deliveries).toHaveLength(2);
    expect(deliveries).toContainEqual(expect.objectContaining({ notificationId: fixtureId(1) }));
    const grouped = deliveries.find((delivery: any) => delivery.notificationId !== fixtureId(1));
    expect(grouped.message).toContain(`**1.** ${"Б".repeat(600)}`);
    expect(grouped.message).toContain("**2.** Правило 3");
  });
});
