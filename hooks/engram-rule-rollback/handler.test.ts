import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import handler from "./handler";
import { acknowledgeRuleActivationNotification, activateCandidateRuleOptimistically } from "../../src/oll/adaptation-store";
import { sha256Digest } from "../../src/oll/handoff-v2";

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function write(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value)}\n`);
}

function fixture() {
  const workspace = mkdtempSync(join(tmpdir(), "engram-rule-rollback-"));
  roots.push(workspace);
  const stateRoot = join(workspace, "state");
  mkdirSync(stateRoot, { recursive: true });
  write(join(workspace, "engram.json"), { workspace: { id: "main" }, oll: { adaptation: { mode: "active" } } });
  const activated = activateCandidateRuleOptimistically({
    workspace,
    stateRoot,
    scope: { level: "workspace", subject: "main" },
    rule: "Всегда возвращать ссылку на созданную карточку.",
    sourceCandidates: [sha256Digest("candidate")],
    expectedImprovement: "Результат можно проверить.",
    costOfInaction: "Ссылка теряется.",
    rollbackRef: "test",
    runId: "22222222-2222-4222-8222-222222222222",
    actionId: sha256Digest("action"),
    operationId: sha256Digest("operation"),
    planId: sha256Digest("plan"),
    batchId: "batch:test",
    notificationSession: "telegram-direct-42",
    now: "2026-08-15T10:00:00.000Z",
  });
  acknowledgeRuleActivationNotification({ workspace, notificationId: activated.notification.notificationId, messageId: "8885" });
  return { workspace, stateRoot, activated };
}

describe("engram-rule-rollback hook", () => {
  test("suspends the numbered rule from an exact replied command and informs the agent", async () => {
    const fx = fixture();
    const previous = process.env.ENGRAM_STATE_ROOT;
    process.env.ENGRAM_STATE_ROOT = fx.stateRoot;
    const event: any = {
      type: "message",
      action: "received",
      context: { workspaceDir: fx.workspace, content: "Отменить 1", metadata: { replyToMessageId: "8885" } },
      messages: [],
    };
    try { await handler(event); } finally {
      if (previous === undefined) delete process.env.ENGRAM_STATE_ROOT;
      else process.env.ENGRAM_STATE_ROOT = previous;
    }
    expect(event.messages[0]).toContain("OLL rollback applied");
    const rules = join(fx.workspace, "memory-state", "oll", "rules");
    expect(existsSync(rules)).toBe(true);
    const rule = JSON.parse(readFileSync(join(rules, readdirSync(rules)[0]), "utf8"));
    expect(rule.status).toBe("suspended");
  });

  test("ignores cancellation text without a reply reference", async () => {
    const fx = fixture();
    const event: any = { type: "message", action: "received", context: { workspaceDir: fx.workspace, content: "Отменить 1", metadata: {} }, messages: [] };
    await handler(event);
    expect(event.messages).toEqual([]);
  });
});
