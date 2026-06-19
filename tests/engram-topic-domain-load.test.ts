/**
 * engram-topic-domain-load hook — must-tests
 *
 * Run:
 *   cd <path-to-engram-skill>
 *   bun test tests/engram-topic-domain-load.test.ts
 *
 * Notes:
 *   - The handler is a .ts file. Bun loads .ts natively, so we import it
 *     with the explicit `.ts` extension (Bun does not require a build step).
 *   - The handler derives "today" from `process.env.ENGRAM_TZ || TZ || "UTC"`
 *     via `toLocaleDateString("sv-SE", { timeZone })`. We pin ENGRAM_TZ=UTC
 *     below so the daily-note filename is reproducible regardless of host TZ.
 *   - Each test creates its own temp workspace under os.tmpdir() and
 *     cleans it up in `finally`, so tests are fully isolated.
 *   - Two blocks are now injected: ## Domain Context (auto) and
 *     ## Domain AGENTS (auto). Each has its own hash and sentinel.
 */

// IMPORTANT: env vars must be set BEFORE the handler import (ES `import` is
// hoisted, so module-level `const` would capture stale env values).
process.env.ENGRAM_TZ = "UTC";
process.env.TZ = "UTC";

import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  statSync,
  appendFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import handler from "../hooks/engram-topic-domain-load/handler.ts";

const TZ = "UTC";

function todayString(): string {
  return new Date().toLocaleDateString("sv-SE", { timeZone: TZ });
}

type MakeWorkspaceOpts = {
  chatId: string; // event-side chatId (may or may not have leading "-")
  registryChatId: string; // chatId stored in registry.json
  topicId: string;
  agentId?: string;
  /** If provided, also create agents.md in the domain dir with this content. */
  agentsContent?: string;
};

function makeWorkspace(opts: MakeWorkspaceOpts) {
  const root = mkdtempSync(join(tmpdir(), "engram-tdl-"));
  const agentId = opts.agentId ?? "test";
  const absChatId = opts.chatId.replace(/^-/, "");
  const sessionSegment = `telegram-group--${absChatId}-topic-${opts.topicId}`;
  const sessionDir = join(root, "memory", `agent-${agentId}`, sessionSegment);

  // Domain directory + files
  const domainDir = join(root, "memory", "domains", "test");
  mkdirSync(domainDir, { recursive: true });
  writeFileSync(
    join(domainDir, "decisions.md"),
    "# decisions\n\n### 2026-06-11 — test decision\n\nSome decision text.\n",
  );
  writeFileSync(
    join(domainDir, "status.md"),
    "# status\n\nCurrent status line.\n",
  );
  writeFileSync(
    join(domainDir, "changelog.md"),
    "## 2026-06-11\n\nInitial setup of test domain.\n",
  );
  if (opts.agentsContent !== undefined) {
    writeFileSync(join(domainDir, "agents.md"), opts.agentsContent);
  }

  // Registry
  const registry = {
    domains: {
      test: {
        type: "topic-thread",
        topic: {
          chatId: opts.registryChatId,
          topicId: opts.topicId,
        },
        kgEntity: "projects/test",
      },
    },
  };
  mkdirSync(join(root, "memory", "domains"), { recursive: true });
  writeFileSync(
    join(root, "memory", "domains", "registry.json"),
    JSON.stringify(registry, null, 2) + "\n",
  );

  // Session dir + daily note
  mkdirSync(sessionDir, { recursive: true });
  const today = todayString();
  const notePath = join(sessionDir, `${today}.md`);
  writeFileSync(notePath, `# ${today}\n\n## Events\n\n`);

  return { root, sessionDir, notePath, domainDir, agentId, absChatId, today };
}

function makeEvent(workspaceDir: string, opts: { chatId: string; topicId: string; agentId?: string }) {
  return {
    type: "message",
    action: "received",
    context: {
      workspaceDir,
      agentId: opts.agentId ?? "test",
      topicId: opts.topicId,
      chatId: opts.chatId,
    },
  };
}

function extractMarker(
  content: string,
  block: "context" | "agents",
): { slug: string; hash: string } | null {
  const re = new RegExp(`<!-- domain-${block}:([\\w-]+):([a-f0-9]+) -->`);
  const m = content.match(re);
  return m ? { slug: m[1], hash: m[2] } : null;
}

function countBlocks(content: string, block: "context" | "agents"): number {
  return (content.match(new RegExp(`<!-- domain-${block}:`, "g")) || []).length;
}

function expectInjectedLogs(logSpy: ReturnType<typeof spyOn>, expected: number) {
  const calls = logSpy.mock.calls.filter(
    (c: unknown[]) =>
      typeof c[0] === "string" && c[0].includes("Injected domain context"),
  );
  expect(calls.length).toBe(expected);
}

describe("engram-topic-domain-load hook", () => {
  let logSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    logSpy = spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // Test 1: Happy path — both blocks injected on fresh daily note
  // -------------------------------------------------------------------------
  test("Test 1: injects context + agents blocks into a fresh daily note", async () => {
    const ws = makeWorkspace({
      chatId: "-1001",
      registryChatId: "-1001",
      topicId: "1",
    });
    try {
      const event = makeEvent(ws.root, {
        chatId: "-1001",
        topicId: "1",
      });

      await expect(handler(event)).resolves.toBeUndefined();
      const after = readFileSync(ws.notePath, "utf-8");

      // --- Context block ---
      const contextMarker = extractMarker(after, "context");
      expect(contextMarker).not.toBeNull();
      expect(contextMarker!.slug).toBe("test");
      expect(contextMarker!.hash).toMatch(/^[a-f0-9]{12}$/);

      const lines = after.split(/\r?\n/);
      const dateLineIdx = lines.findIndex((l) => l === `# ${ws.today}`);
      expect(dateLineIdx).toBe(0);
      expect(lines[dateLineIdx + 1].trim()).toBe("");
      expect(lines[dateLineIdx + 2].startsWith("<!-- domain-context:")).toBe(true);

      expect(after).toContain("## Domain Context (auto)");
      expect(after).toContain("topic-thread");
      expect(after).toContain("Status");
      expect(after).toContain("changelog");
      expect(after).toContain("<!-- /domain-context -->");
      expect(countBlocks(after, "context")).toBe(1);

      // --- Agents block (no agents.md → fallback) ---
      const agentsMarker = extractMarker(after, "agents");
      expect(agentsMarker).not.toBeNull();
      expect(agentsMarker!.slug).toBe("test");
      expect(agentsMarker!.hash).toMatch(/^[a-f0-9]{12}$/);
      // Hashes must differ — they come from different sources
      expect(agentsMarker!.hash).not.toBe(contextMarker!.hash);

      expect(after).toContain("## Domain AGENTS (auto)");
      // Fallback warning is shown when agents.md is missing
      expect(after).toContain("⚠️");
      expect(after).toContain("fallback");
      expect(after).toContain("backfill-domain-agents.js");
      expect(after).toContain("<!-- /domain-agents -->");
      expect(countBlocks(after, "agents")).toBe(1);

      // Agents block is positioned AFTER the context block
      const contextPos = after.indexOf("<!-- domain-context:");
      const agentsPos = after.indexOf("<!-- domain-agents:");
      expect(contextPos).toBeGreaterThanOrEqual(0);
      expect(agentsPos).toBeGreaterThan(contextPos);

      // The "Injected" log fires once
      expectInjectedLogs(logSpy, 1);
    } finally {
      rmSync(ws.root, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Test 2: Idempotency
  // -------------------------------------------------------------------------
  test("Test 2: re-running with unchanged domain leaves the note untouched", async () => {
    const ws = makeWorkspace({
      chatId: "-1001",
      registryChatId: "-1001",
      topicId: "1",
    });
    try {
      const event = makeEvent(ws.root, {
        chatId: "-1001",
        topicId: "1",
      });

      await handler(event);
      const firstContent = readFileSync(ws.notePath, "utf-8");
      const firstContext = extractMarker(firstContent, "context");
      const firstAgents = extractMarker(firstContent, "agents");
      expect(firstContext).not.toBeNull();
      expect(firstAgents).not.toBeNull();
      const firstSize = statSync(ws.notePath).size;
      expectInjectedLogs(logSpy, 1);

      // Second run — must be a no-op (both hashes match)
      await handler(event);
      const secondContent = readFileSync(ws.notePath, "utf-8");
      const secondSize = statSync(ws.notePath).size;
      expect(secondSize).toBe(firstSize);
      expect(secondContent).toBe(firstContent);
      expect(extractMarker(secondContent, "context")!.hash).toBe(firstContext!.hash);
      expect(extractMarker(secondContent, "agents")!.hash).toBe(firstAgents!.hash);
      // No new "Injected" log
      expectInjectedLogs(logSpy, 1);
    } finally {
      rmSync(ws.root, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Test 3: Content change → re-inject both blocks
  // -------------------------------------------------------------------------
  test("Test 3: domain content change replaces both blocks with new hashes", async () => {
    const ws = makeWorkspace({
      chatId: "-1001",
      registryChatId: "-1001",
      topicId: "1",
    });
    try {
      const event = makeEvent(ws.root, {
        chatId: "-1001",
        topicId: "1",
      });

      await handler(event);
      const firstContent = readFileSync(ws.notePath, "utf-8");
      const firstContext = extractMarker(firstContent, "context")!;
      const firstAgents = extractMarker(firstContent, "agents")!;
      expect(countBlocks(firstContent, "context")).toBe(1);
      expect(countBlocks(firstContent, "agents")).toBe(1);

      // Mutate status.md → context hash must change, agents hash stable
      const statusPath = join(ws.domainDir, "status.md");
      appendFileSync(statusPath, "\nAdditional line after change.\n");

      await handler(event);
      const secondContent = readFileSync(ws.notePath, "utf-8");
      const secondContext = extractMarker(secondContent, "context")!;
      const secondAgents = extractMarker(secondContent, "agents")!;

      // Context hash changed, agents hash stayed
      expect(secondContext.hash).not.toBe(firstContext.hash);
      expect(secondContext.slug).toBe(firstContext.slug);
      expect(secondAgents.hash).toBe(firstAgents.hash);
      expect(secondAgents.slug).toBe(firstAgents.slug);

      // Only one of each block, no duplication
      expect(countBlocks(secondContent, "context")).toBe(1);
      expect(countBlocks(secondContent, "agents")).toBe(1);

      expect(secondContent).toContain("Additional line after change.");
      expect(secondContent).toContain("## Domain Context (auto)");
      expect(secondContent).toContain("## Domain AGENTS (auto)");

      // Two "Injected" logs total
      expectInjectedLogs(logSpy, 2);
    } finally {
      rmSync(ws.root, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Test 4: chatId variants
  // -------------------------------------------------------------------------
  describe("Test 4: chatId variants", () => {
    test("4a: registry and event both have a leading minus → match", async () => {
      const ws = makeWorkspace({
        chatId: "-1001",
        registryChatId: "-1001",
        topicId: "1",
      });
      try {
        const event = makeEvent(ws.root, {
          chatId: "-1001",
          topicId: "1",
        });
        await handler(event);
        const after = readFileSync(ws.notePath, "utf-8");
        expect(extractMarker(after, "context")).not.toBeNull();
        expect(extractMarker(after, "agents")).not.toBeNull();
        expect(after).toContain("## Domain Context (auto)");
        expect(after).toContain("## Domain AGENTS (auto)");
      } finally {
        rmSync(ws.root, { recursive: true, force: true });
      }
    });

    test("4b: registry has leading minus, event has none → match (symmetric)", async () => {
      const ws = makeWorkspace({
        chatId: "-1001",
        registryChatId: "-1001",
        topicId: "1",
      });
      try {
        const event = makeEvent(ws.root, {
          chatId: "1001",
          topicId: "1",
        });
        await handler(event);
        const after = readFileSync(ws.notePath, "utf-8");
        expect(extractMarker(after, "context")).not.toBeNull();
        expect(extractMarker(after, "agents")).not.toBeNull();
      } finally {
        rmSync(ws.root, { recursive: true, force: true });
      }
    });

    test("4c: registry has no minus (edge), event has leading minus → match", async () => {
      const ws = makeWorkspace({
        chatId: "-1001",
        registryChatId: "1001",
        topicId: "1",
      });
      try {
        const event = makeEvent(ws.root, {
          chatId: "-1001",
          topicId: "1",
        });
        await handler(event);
        const after = readFileSync(ws.notePath, "utf-8");
        expect(extractMarker(after, "context")).not.toBeNull();
        expect(extractMarker(after, "agents")).not.toBeNull();
      } finally {
        rmSync(ws.root, { recursive: true, force: true });
      }
    });
  });

  // -------------------------------------------------------------------------
  // Test 5: agents.md present → reads from file, no fallback warning
  // -------------------------------------------------------------------------
  test("Test 5: agents.md present → reads from file, no fallback warning", async () => {
    const agentsBody = `# Domain AGENTS — test (custom)

## Custom rule
This is a user-customized agents block.
`;
    const ws = makeWorkspace({
      chatId: "-1001",
      registryChatId: "-1001",
      topicId: "1",
      agentsContent: agentsBody,
    });
    try {
      const event = makeEvent(ws.root, {
        chatId: "-1001",
        topicId: "1",
      });
      await handler(event);
      const after = readFileSync(ws.notePath, "utf-8");

      // Agents block present
      const agentsMarker = extractMarker(after, "agents");
      expect(agentsMarker).not.toBeNull();
      expect(after).toContain("## Domain AGENTS (auto)");
      expect(after).toContain("<!-- /domain-agents -->");

      // Custom content is rendered verbatim
      expect(after).toContain("(custom)");
      expect(after).toContain("This is a user-customized agents block.");

      // No fallback warning (the warning is keyed on the word "fallback" + ⚠️)
      // It only appears when agents.md is missing
      // Extract the agents block body and check for the warning
      const blockMatch = after.match(
        /<!-- domain-agents:test:[a-f0-9]+ -->\n## Domain AGENTS \(auto\)\n([\s\S]*?)\n<!-- \/domain-agents -->/,
      );
      expect(blockMatch).not.toBeNull();
      const agentsBlockBody = blockMatch![1];
      expect(agentsBlockBody).not.toContain("⚠️");
      expect(agentsBlockBody).not.toContain("fallback");
      expect(agentsBlockBody).not.toContain("backfill-domain-agents.js");
    } finally {
      rmSync(ws.root, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Test 6: agents.md change → new agents hash, context hash stable
  // -------------------------------------------------------------------------
  test("Test 6: agents.md change → new agents hash, context hash stable", async () => {
    const ws = makeWorkspace({
      chatId: "-1001",
      registryChatId: "-1001",
      topicId: "1",
      agentsContent: "# Domain AGENTS — test\n\nInitial agents body.\n",
    });
    try {
      const event = makeEvent(ws.root, {
        chatId: "-1001",
        topicId: "1",
      });

      await handler(event);
      const firstContent = readFileSync(ws.notePath, "utf-8");
      const firstContext = extractMarker(firstContent, "context")!;
      const firstAgents = extractMarker(firstContent, "agents")!;

      // Edit agents.md
      const agentsPath = join(ws.domainDir, "agents.md");
      appendFileSync(agentsPath, "\n## New rule added by operator\n");

      await handler(event);
      const secondContent = readFileSync(ws.notePath, "utf-8");
      const secondContext = extractMarker(secondContent, "context")!;
      const secondAgents = extractMarker(secondContent, "agents")!;

      // Context hash unchanged (no decision/status/changelog change),
      // agents hash changed (new content).
      expect(secondContext.hash).toBe(firstContext.hash);
      expect(secondAgents.hash).not.toBe(firstAgents.hash);

      // New content is reflected
      expect(secondContent).toContain("New rule added by operator");
      // Old single-sentinel pair is preserved (no duplication)
      expect(countBlocks(secondContent, "agents")).toBe(1);
      expect(countBlocks(secondContent, "context")).toBe(1);
    } finally {
      rmSync(ws.root, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Test 7: agents.md removed after first inject → next call uses fallback
  // -------------------------------------------------------------------------
  test("Test 7: agents.md removed after first inject → next call uses fallback", async () => {
    const ws = makeWorkspace({
      chatId: "-1001",
      registryChatId: "-1001",
      topicId: "1",
      agentsContent: "# Domain AGENTS — test\n\nOriginal agents body.\n",
    });
    try {
      const event = makeEvent(ws.root, {
        chatId: "-1001",
        topicId: "1",
      });

      await handler(event);
      const firstContent = readFileSync(ws.notePath, "utf-8");
      // No fallback warning on first call (file existed)
      expect(firstContent).not.toContain("⚠️");

      // Operator deletes agents.md
      const agentsPath = join(ws.domainDir, "agents.md");
      rmSync(agentsPath, { force: true });

      await handler(event);
      const secondContent = readFileSync(ws.notePath, "utf-8");

      // Fallback warning now appears
      expect(secondContent).toContain("⚠️");
      expect(secondContent).toContain("fallback");
      // The original custom content is gone
      expect(secondContent).not.toContain("Original agents body.");
    } finally {
      rmSync(ws.root, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Test 8: OpenClaw 2026.6.6 event format
  //
  // In OC66, message:received events deliver topicId and chatId via:
  //   - internal:  event.context.metadata.threadId  + event.context.metadata.to
  //   - plugin:    event.threadId (top-level)        + event.context.conversationId
  // conversationId arrives as "telegram:{chatId}" — no :topic: suffix, so
  // the older regex `^telegram:(-?\d+)(?::topic:(\d+))?$` would only
  // match chatId (group 2 stays empty). The handler must fall back to
  // metadata.{threadId,to} / event.threadId to recover topicId/chatId.
  // -------------------------------------------------------------------------
  describe("Test 8: OpenClaw 2026.6.6 event format", () => {
    function makeOc66Event(workspaceDir: string, opts: { chatId: string; topicId: string }) {
      // Internal OC66 shape: from/content/channelId/conversationId + metadata
      return {
        type: "message",
        action: "received",
        sessionKey: `agent:test:telegram:group:${opts.chatId.replace(/^-/, "")}:topic:${opts.topicId}`,
        context: {
          workspaceDir,
          agentId: "test",
          from: "999",
          content: "oc66 test",
          timestamp: Date.now(),
          channelId: "telegram",
          accountId: "test",
          conversationId: `telegram:${opts.chatId.replace(/^-/, "")}`,
          messageId: "oc66-msg-001",
          senderId: "999",
          provider: "telegram",
          surface: "telegram",
          metadata: {
            to: opts.chatId,
            provider: "telegram",
            surface: "telegram",
            threadId: opts.topicId,
            topicName: "Engram",
          },
        },
      };
    }

    test("8a: OC66 internal event — resolves topicId from metadata.threadId, chatId from metadata.to", async () => {
      const ws = makeWorkspace({
        chatId: "-1001",
        registryChatId: "-1001",
        topicId: "1",
      });
      try {
        const event = makeOc66Event(ws.root, {
          chatId: "-1001",
          topicId: "1",
        });
        await handler(event);
        const after = readFileSync(ws.notePath, "utf-8");
        expect(extractMarker(after, "context")).not.toBeNull();
        expect(extractMarker(after, "agents")).not.toBeNull();
        expect(after).toContain("## Domain Context (auto)");
        expect(after).toContain("## Domain AGENTS (auto)");
        expect(after).toContain("<!-- /domain-context -->");
        expect(after).toContain("<!-- /domain-agents -->");
        expectInjectedLogs(logSpy, 1);
      } finally {
        rmSync(ws.root, { recursive: true, force: true });
      }
    });

    test("8b: OC66 plugin event — resolves topicId from top-level event.threadId, chatId from conversationId", async () => {
      const ws = makeWorkspace({
        chatId: "-1001",
        registryChatId: "-1001",
        topicId: "1",
      });
      try {
        // Plugin OC66 shape: threadId top-level, conversationId in context
        // (no metadata.threadId, no metadata.to).
        const event = {
          type: "message",
          action: "received",
          sessionKey: "agent:test:telegram:group:1001:topic:1",
          threadId: "1",
          context: {
            workspaceDir: ws.root,
            agentId: "test",
            from: "999",
            content: "oc66 plugin test",
            timestamp: Date.now(),
            channelId: "telegram",
            accountId: "test",
            conversationId: "telegram:1001",
            messageId: "oc66-plug-001",
            senderId: "999",
          },
        };
        await handler(event);
        const after = readFileSync(ws.notePath, "utf-8");
        expect(extractMarker(after, "context")).not.toBeNull();
        expect(extractMarker(after, "agents")).not.toBeNull();
        expect(after).toContain("## Domain Context (auto)");
        expectInjectedLogs(logSpy, 1);
      } finally {
        rmSync(ws.root, { recursive: true, force: true });
      }
    });

    test("8c: OC66 internal event with negative-sign mismatch on chatId → still matches", async () => {
      // Registry has leading minus, OC66 metadata.to has no leading minus.
      // Handler's symmetric chatId comparison + fallback to metadata.to
      // should still resolve and inject.
      const ws = makeWorkspace({
        chatId: "-1001",
        registryChatId: "-1001",
        topicId: "1",
      });
      try {
        const event = makeOc66Event(ws.root, {
          chatId: "1001", // no leading minus
          topicId: "1",
        });
        await handler(event);
        const after = readFileSync(ws.notePath, "utf-8");
        expect(extractMarker(after, "context")).not.toBeNull();
        expectInjectedLogs(logSpy, 1);
      } finally {
        rmSync(ws.root, { recursive: true, force: true });
      }
    });
  });
});
