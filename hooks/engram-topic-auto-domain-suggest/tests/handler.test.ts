import { test, expect, describe, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import handler from "../handler.js";
import { slugifyTopicName } from "../../_lib/slugify.js";

let ws: string;

beforeAll(() => {
  ws = mkdtempSync(join(tmpdir(), "engram-suggest-test-"));
});

afterAll(() => {
  if (ws && existsSync(ws)) {
    rmSync(ws, { recursive: true, force: true });
  }
});

function setupWorkspace(registryDomains: any = {}): { sessionDir: string; notePath: string; today: string } {
  // Fresh per-test workspace dir
  const testDir = mkdtempSync(join(ws, "case-"));
  mkdirSync(join(testDir, "memory", "domains"), { recursive: true });
  writeFileSync(
    join(testDir, "memory", "domains", "registry.json"),
    JSON.stringify({ domains: registryDomains }, null, 2)
  );
  const today = new Date().toLocaleDateString("sv-SE", { timeZone: "UTC" });
  return { testDir, today };
}

function withSessionNote(testDir: string, chatId: string, topicId: string, today: string): { sessionDir: string; notePath: string } {
  const absChatId = chatId.replace(/^-/, "");
  const sessionDir = join(testDir, "memory", "agent-main", `telegram-group--${absChatId}-topic-${topicId}`);
  mkdirSync(sessionDir, { recursive: true });
  const notePath = join(sessionDir, `${today}.md`);
  writeFileSync(notePath, `# ${today}\n\n## Events\n\n`);
  return { sessionDir, notePath };
}

function makeEvent(testDir: string, chatId: string, topicId: string, content: string, extras: any = {}): any {
  return {
    type: "message",
    action: "received",
    context: {
      workspaceDir: testDir,
      chatId,
      topicId,
      content,
      ...extras,
    },
  };
}

describe("isTopicCreationServiceMessage (via handler integration)", () => {
  test("English: 'Alice created the topic \"Q3\"' writes hint file", async () => {
    const { testDir, today } = setupWorkspace();
    const evt = makeEvent(testDir, "-1", "42", 'Alice created the topic "Q3 Planning"', {
      metadata: { topicName: "Q3 Planning", threadId: "42" },
    });
    await handler(evt);
    const sessionDir = join(testDir, "memory", "agent-main", "telegram-group--1-topic-42");
    const hint = join(sessionDir, `.engram-topic-created-${today.replace(/-/g, "")}`);
    expect(existsSync(hint)).toBe(true);
  });

  test("Russian: 'Иван создал(а) тему \"Дорожная карта\"' writes hint file", async () => {
    const { testDir, today } = setupWorkspace();
    const evt = makeEvent(testDir, "-1", "43", 'Иван создал(а) тему "Дорожная карта"', {
      metadata: { topicName: "Дорожная карта", threadId: "43" },
    });
    await handler(evt);
    const sessionDir = join(testDir, "memory", "agent-main", "telegram-group--1-topic-43");
    const hint = join(sessionDir, `.engram-topic-created-${today.replace(/-/g, "")}`);
    expect(existsSync(hint)).toBe(true);
  });

  test("Russian alternate: 'Создана тема \"Foo\"' writes hint file", async () => {
    const { testDir, today } = setupWorkspace();
    const evt = makeEvent(testDir, "-1", "44", 'Создана тема "Foo"', {
      metadata: { topicName: "Foo", threadId: "44" },
    });
    await handler(evt);
    const sessionDir = join(testDir, "memory", "agent-main", "telegram-group--1-topic-44");
    const hint = join(sessionDir, `.engram-topic-created-${today.replace(/-/g, "")}`);
    expect(existsSync(hint)).toBe(true);
  });

  test("Regular user message (no service-message pattern) does NOT write hint file", async () => {
    const { testDir } = setupWorkspace();
    const evt = makeEvent(testDir, "-1", "45", "Just a normal user message", {
      metadata: { topicName: "Existing Topic", threadId: "45" },
    });
    await handler(evt);
    const sessionDir = join(testDir, "memory", "agent-main", "telegram-group--1-topic-45");
    // sessionDir might not even exist; the hook returns early on slow-path
    // because no daily note exists. If the dir does not exist, the hint
    // file is definitely not there.
    if (existsSync(sessionDir)) {
      const files = require("fs").readdirSync(sessionDir);
      expect(files.filter((f: string) => f.startsWith(".engram-topic-created-"))).toHaveLength(0);
    } else {
      expect(existsSync(sessionDir)).toBe(false);
    }
  });

  test("Service-message-shaped content WITHOUT topicName does NOT write hint", async () => {
    const { testDir } = setupWorkspace();
    const evt = makeEvent(testDir, "-1", "46", 'Alice created the topic "X"', {
      metadata: { /* no topicName */ },
    });
    await handler(evt);
    const sessionDir = join(testDir, "memory", "agent-main", "telegram-group--1-topic-46");
    if (existsSync(sessionDir)) {
      const files = require("fs").readdirSync(sessionDir);
      expect(files.filter((f: string) => f.startsWith(".engram-topic-created-"))).toHaveLength(0);
    }
  });

  test("Bot-initiated topic creation is skipped (fromBot=true)", async () => {
    const { testDir } = setupWorkspace();
    const evt = makeEvent(testDir, "-1", "47", 'Bot created the topic "X"', {
      fromBot: true,
      metadata: { topicName: "X", threadId: "47" },
    });
    await handler(evt);
    const sessionDir = join(testDir, "memory", "agent-main", "telegram-group--1-topic-47");
    if (existsSync(sessionDir)) {
      const files = require("fs").readdirSync(sessionDir);
      expect(files.filter((f: string) => f.startsWith(".engram-topic-created-"))).toHaveLength(0);
    }
  });

  test("Bound topic is skipped even if service-message arrives", async () => {
    const { testDir, today } = setupWorkspace({
      "bound-topic": {
        type: "topic-thread",
        topic: { chatId: "-1", topicId: "48" },
      },
    });
    withSessionNote(testDir, "-1", "48", today);
    const evt = makeEvent(testDir, "-1", "48", 'Alice created the topic "X"', {
      metadata: { topicName: "X", threadId: "48" },
    });
    await handler(evt);
    const notePath = join(testDir, "memory", "agent-main", "telegram-group--1-topic-48", `${today}.md`);
    const content = readFileSync(notePath, "utf-8");
    expect(content).not.toContain("<!-- engram:auto-suggest:");
    expect(content).not.toContain(".engram-topic-created-");
  });
});

describe("fast-path consumption (hint file → first user message)", () => {
  test("First user message after service message injects suggest block with fast-path copy", async () => {
    const { testDir, today } = setupWorkspace();
    const { notePath, sessionDir } = withSessionNote(testDir, "-1", "60", today);

    // 1. Service message → hint file written
    await handler(makeEvent(testDir, "-1", "60", 'Alice created the topic "Sprint Planning"', {
      metadata: { topicName: "Sprint Planning", threadId: "60" },
    }));
    const hintPath = join(sessionDir, `.engram-topic-created-${today.replace(/-/g, "")}`);
    expect(existsSync(hintPath)).toBe(true);

    // 2. First user message → hint consumed, suggest block injected
    await handler(makeEvent(testDir, "-1", "60", "Hello team, let's start.", {
      metadata: { topicName: "Sprint Planning", threadId: "60" },
    }));
    const content = readFileSync(notePath, "utf-8");
    expect(content).toContain("<!-- engram:auto-suggest:");
    expect(content).toContain("Топик только что создан в форуме");
    expect(content).toContain("sprint-planning-1-60");
    expect(content).toContain("--pending");

    // Hint file should be consumed
    expect(existsSync(hintPath)).toBe(false);
  });

  test("Suggest block suggests `add-domain --pending` (not just `add-domain`)", async () => {
    const { testDir, today } = setupWorkspace();
    const { notePath, sessionDir } = withSessionNote(testDir, "-1", "61", today);
    await handler(makeEvent(testDir, "-1", "61", 'Bob created the topic "Test"', {
      metadata: { topicName: "Test", threadId: "61" },
    }));
    await handler(makeEvent(testDir, "-1", "61", "first message", {
      metadata: { topicName: "Test", threadId: "61" },
    }));
    const content = readFileSync(notePath, "utf-8");
    expect(content).toMatch(/add-domain\.js[\s\S]*--pending/);
  });
});

describe("slow-path (counter-based, no hint file)", () => {
  test("Counter=1 (first user message) does NOT inject suggest block", async () => {
    const { testDir, today } = setupWorkspace();
    const { notePath } = withSessionNote(testDir, "-1", "70", today);
    await handler(makeEvent(testDir, "-1", "70", "first message"));
    const content = readFileSync(notePath, "utf-8");
    expect(content).not.toContain("<!-- engram:auto-suggest:");
  });

  test("Counter=2 (second user message) injects suggest block with slow-path copy", async () => {
    const { testDir, today } = setupWorkspace();
    const { notePath } = withSessionNote(testDir, "-1", "71", today);
    await handler(makeEvent(testDir, "-1", "71", "first message"));
    await handler(makeEvent(testDir, "-1", "71", "second message"));
    const content = readFileSync(notePath, "utf-8");
    expect(content).toContain("<!-- engram:auto-suggest:");
    expect(content).toContain("2 сообщений"); // slow-path copy
  });

  test("Re-injection blocked by daySentinel — second inject on same day is no-op", async () => {
    const { testDir, today } = setupWorkspace();
    const { notePath } = withSessionNote(testDir, "-1", "72", today);
    await handler(makeEvent(testDir, "-1", "72", "first"));
    await handler(makeEvent(testDir, "-1", "72", "second"));
    const before = readFileSync(notePath, "utf-8");
    // 3rd message should NOT cause another inject (same day, same count+1
    // is technically a different hash, but daySentinel blocks re-injection)
    await handler(makeEvent(testDir, "-1", "72", "third"));
    const after = readFileSync(notePath, "utf-8");
    // Both should have the same single suggest block (no duplicate)
    const beforeCount = (before.match(/<!-- engram:auto-suggest:/g) || []).length;
    const afterCount = (after.match(/<!-- engram:auto-suggest:/g) || []).length;
    expect(afterCount).toBe(beforeCount);
  });
});

describe("slugifyTopicName", () => {
  test("Latin name → slug + suffix", () => {
    expect(slugifyTopicName("Q3 Planning", 2, 60)).toBe("q3-planning-2-60");
  });
  test("Cyrillic name → fallback to topic + suffix", () => {
    expect(slugifyTopicName("Планирование Q3", 2, 60)).toBe("q3-2-60");
  });
  test("Empty name → fallback", () => {
    expect(slugifyTopicName("", 2, 60)).toBe("topic-2-60");
  });
  test("Punctuation only → fallback", () => {
    expect(slugifyTopicName("!!!###", 2, 60)).toBe("topic-2-60");
  });
  test("Long name → truncated + suffix", () => {
    const r = slugifyTopicName("A very very very long topic name that should be truncated for readability purposes", 2, 60);
    expect(r.length).toBeLessThanOrEqual(40 + 1 + 13 + 1 + 2); // 40 + - + 13 + - + 2
    expect(r).toMatch(/-2-60$/);
  });
  test("Suffix uniqueness: same name, different chatId/topicId → different slug", () => {
    expect(slugifyTopicName("Foo", 1000000000001, 1))
      .not.toBe(slugifyTopicName("Foo", 1000000000002, 1));
  });
  test("Handles chatId with leading minus", () => {
    expect(slugifyTopicName("Foo", "-1", 42)).toBe("foo-1-42");
  });
});
