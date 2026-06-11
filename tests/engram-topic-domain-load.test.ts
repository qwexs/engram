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
 */

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

// Pin timezone so the daily-note filename is deterministic across hosts.
process.env.ENGRAM_TZ = "UTC";
process.env.TZ = "UTC";

const TZ = "UTC";

function todayString(): string {
  return new Date().toLocaleDateString("sv-SE", { timeZone: TZ });
}

type MakeWorkspaceOpts = {
  chatId: string; // event-side chatId (may or may not have leading "-")
  registryChatId: string; // chatId stored in registry.json
  topicId: string;
  agentId?: string;
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

function extractDomainMarker(content: string): { slug: string; hash: string } | null {
  const m = content.match(/<!-- domain-context:([\w-]+):([a-f0-9]+) -->/);
  return m ? { slug: m[1], hash: m[2] } : null;
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
  // Test 1: Happy path
  // -------------------------------------------------------------------------
  test("Test 1: injects domain context block into a fresh daily note", async () => {
    const ws = makeWorkspace({
      chatId: "-1001234567890",
      registryChatId: "-1001234567890",
      topicId: "1",
    });
    try {
      const event = makeEvent(ws.root, {
        chatId: "-1001234567890",
        topicId: "1",
      });

      // Handler must not throw and must return undefined
      await expect(handler(event)).resolves.toBeUndefined();

      const after = readFileSync(ws.notePath, "utf-8");

      // 1. Marker present, well-formed
      const marker = extractDomainMarker(after);
      expect(marker).not.toBeNull();
      expect(marker!.slug).toBe("test");
      expect(marker!.hash).toMatch(/^[a-f0-9]{12}$/);

      // 2. Marker sits directly after the "# YYYY-MM-DD" heading
      const lines = after.split(/\r?\n/);
      const dateLineIdx = lines.findIndex((l) => l === `# ${ws.today}`);
      expect(dateLineIdx).toBe(0);
      // Only a blank line may sit between the heading and the marker
      expect(lines[dateLineIdx + 1].trim()).toBe("");
      expect(lines[dateLineIdx + 2].startsWith("<!-- domain-context:")).toBe(true);

      // 3. Block has the expected shape
      expect(after).toContain("## Domain Context (auto)");
      expect(after).toContain("Domain");
      expect(after).toContain("topic-thread");
      expect(after).toContain("Status");
      expect(after).toContain("changelog");
      expect(after).toContain("<!-- /domain-context -->");

      // 4. Only one block was injected
      const sentinels = (after.match(/<!-- domain-context:/g) || []).length;
      expect(sentinels).toBe(1);
      const closers = (after.match(/<!-- \/domain-context -->/g) || []).length;
      expect(closers).toBe(1);

      // 5. console.log was called with the "Injected" prefix
      const injectedCall = logSpy.mock.calls.find(
        (c: unknown[]) =>
          typeof c[0] === "string" && c[0].includes("Injected domain context"),
      );
      expect(injectedCall).toBeTruthy();
    } finally {
      rmSync(ws.root, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Test 2: Idempotency
  // -------------------------------------------------------------------------
  test("Test 2: re-running with the same domain content leaves the note untouched", async () => {
    const ws = makeWorkspace({
      chatId: "-1001234567890",
      registryChatId: "-1001234567890",
      topicId: "1",
    });
    try {
      const event = makeEvent(ws.root, {
        chatId: "-1001234567890",
        topicId: "1",
      });

      // First run — injects the block
      await handler(event);
      const firstContent = readFileSync(ws.notePath, "utf-8");
      const firstMarker = extractDomainMarker(firstContent);
      expect(firstMarker).not.toBeNull();
      const firstSize = statSync(ws.notePath).size;
      const firstInjectedCalls = logSpy.mock.calls.filter(
        (c: unknown[]) => typeof c[0] === "string" && c[0].includes("Injected domain context"),
      ).length;
      expect(firstInjectedCalls).toBe(1);

      // Second run — must be a no-op
      await handler(event);
      const secondContent = readFileSync(ws.notePath, "utf-8");
      const secondSize = statSync(ws.notePath).size;

      // File bytes identical
      expect(secondSize).toBe(firstSize);
      expect(secondContent).toBe(firstContent);

      // Marker hash unchanged
      const secondMarker = extractDomainMarker(secondContent);
      expect(secondMarker).not.toBeNull();
      expect(secondMarker!.hash).toBe(firstMarker!.hash);

      // No new "Injected" log on the second call
      const totalInjectedCalls = logSpy.mock.calls.filter(
        (c: unknown[]) => typeof c[0] === "string" && c[0].includes("Injected domain context"),
      ).length;
      expect(totalInjectedCalls).toBe(1);
    } finally {
      rmSync(ws.root, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Test 3: Content change → re-inject
  // -------------------------------------------------------------------------
  test("Test 3: domain content change replaces the old block with a new one", async () => {
    const ws = makeWorkspace({
      chatId: "-1001234567890",
      registryChatId: "-1001234567890",
      topicId: "1",
    });
    try {
      const event = makeEvent(ws.root, {
        chatId: "-1001234567890",
        topicId: "1",
      });

      // First run
      await handler(event);
      const firstContent = readFileSync(ws.notePath, "utf-8");
      const firstMarker = extractDomainMarker(firstContent);
      expect(firstMarker).not.toBeNull();
      const firstSentinels = (firstContent.match(/<!-- domain-context:/g) || []).length;
      expect(firstSentinels).toBe(1);

      // Mutate status.md — append a new line so the content hash changes
      // (the hash mixes path + mtime + size + content, so the new content
      // is enough to force a new hash even if mtime resolution is coarse).
      const statusPath = join(ws.domainDir, "status.md");
      appendFileSync(statusPath, "\nAdditional line after change.\n");

      // Second run — must replace old block, not duplicate it
      await handler(event);
      const secondContent = readFileSync(ws.notePath, "utf-8");
      const secondMarker = extractDomainMarker(secondContent);
      expect(secondMarker).not.toBeNull();

      // 1. New hash differs from old hash
      expect(secondMarker!.hash).not.toBe(firstMarker!.hash);
      // Same slug
      expect(secondMarker!.slug).toBe(firstMarker!.slug);

      // 2. Old sentinel-closing text from the previous block is fully gone
      //    (only ONE domain-context block in the file now).
      const secondSentinels = (secondContent.match(/<!-- domain-context:/g) || []).length;
      expect(secondSentinels).toBe(1);
      const secondClosers = (secondContent.match(/<!-- \/domain-context -->/g) || []).length;
      expect(secondClosers).toBe(1);

      // 3. New content from the mutated status.md is reflected
      expect(secondContent).toContain("Additional line after change.");
      expect(secondContent).toContain("## Domain Context (auto)");

      // 4. Two "Injected" log calls total (one per non-idempotent run)
      const injectedCount = logSpy.mock.calls.filter(
        (c: unknown[]) => typeof c[0] === "string" && c[0].includes("Injected domain context"),
      ).length;
      expect(injectedCount).toBe(2);
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
        chatId: "-1001234567890",
        registryChatId: "-1001234567890",
        topicId: "1",
      });
      try {
        const event = makeEvent(ws.root, {
          chatId: "-1001234567890",
          topicId: "1",
        });
        await handler(event);
        const after = readFileSync(ws.notePath, "utf-8");
        const marker = extractDomainMarker(after);
        expect(marker).not.toBeNull();
        expect(marker!.slug).toBe("test");
        expect(after).toContain("## Domain Context (auto)");
        expect(after).toContain("<!-- /domain-context -->");
      } finally {
        rmSync(ws.root, { recursive: true, force: true });
      }
    });

    test("4b: registry has a leading minus, event has none → match (symmetric normalization)", async () => {
      // The handler now symmetrically normalizes entry.topic.chatId the same
      // way it normalizes event.context.chatId (both are stripped of the
      // leading "-" before comparison). So registry "-X" with event "X" matches.
      // This is the case the original three-way match got wrong; the new
      // comparison is "String(entry.topic.chatId).replace(/^-/, '') === absChatId".
      const ws = makeWorkspace({
        chatId: "-1001234567890",
        registryChatId: "-1001234567890",
        topicId: "1",
      });
      try {
        // Event payload omits the leading minus
        const event = makeEvent(ws.root, {
          chatId: "1001234567890",
          topicId: "1",
        });
        await handler(event);
        const after = readFileSync(ws.notePath, "utf-8");
        const marker = extractDomainMarker(after);
        expect(marker).not.toBeNull();
        expect(marker!.slug).toBe("test");
        expect(after).toContain("## Domain Context (auto)");
        expect(after).toContain("<!-- /domain-context -->");
      } finally {
        rmSync(ws.root, { recursive: true, force: true });
      }
    });

    test("4c: registry has no minus (edge), event has a leading minus → match", async () => {
      const ws = makeWorkspace({
        chatId: "-1001234567890",
        registryChatId: "1001234567890",
        topicId: "1",
      });
      try {
        const event = makeEvent(ws.root, {
          chatId: "-1001234567890",
          topicId: "1",
        });
        await handler(event);
        const after = readFileSync(ws.notePath, "utf-8");
        const marker = extractDomainMarker(after);
        expect(marker).not.toBeNull();
        expect(marker!.slug).toBe("test");
        expect(after).toContain("## Domain Context (auto)");
        expect(after).toContain("<!-- /domain-context -->");
      } finally {
        rmSync(ws.root, { recursive: true, force: true });
      }
    });
  });
});
