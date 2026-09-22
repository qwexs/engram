import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCanonicalSessionKey } from "./contracts.ts";
import { completeMarkdownRecords } from "./markdown-records.ts";
import { resolveSessionContextSource } from "./session-source.ts";

const roots: string[] = [];

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "engram-session-source-"));
  roots.push(root);
  return root;
}

function note(root: string, segment: string, date: string, content: string): void {
  const directory = join(root, "memory", "agent-main", segment);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${date}.md`), content);
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("session context source", () => {
  test("reads only the exact session and selects bounded recent working state", () => {
    const root = workspace();
    note(root, "telegram-direct-42", "2026-09-17", `# Daily\n\n## Events\n- old event\n\n## Decisions\n- old decision\n`);
    note(root, "telegram-direct-42", "2026-09-18", `# Daily\n\n## Events\n- event one\n- event two\n\n## Decisions\n### 10:00 — first\nKeep A.\n\n### 11:00 — second\nKeep B.\n`);
    note(root, "telegram-direct-42", "2026-09-19", `# Daily\n\n## Events\n- event three\n- event four\n\n## Decisions\n- newest decision\n\n## Active Threads\n- build capsule\n- verify rollout\n\n## Next\n- run tests\n`);
    note(root, "telegram-direct-99", "2026-09-19", `# Daily\n\n## Events\n- private neighbor event\n`);

    const outcome = resolveSessionContextSource({
      workspace: root,
      scope: parseCanonicalSessionKey("agent:main:telegram:direct:42")!,
      now: "2026-09-19T00:00:00.000Z",
    });

    expect(outcome.status).toBe("selected");
    if (outcome.status === "selected") {
      expect(outcome.block.content).toContain("build capsule");
      expect(outcome.block.content).toContain("run tests");
      expect(outcome.block.content).toContain("newest decision");
      expect(outcome.block.content).toContain("Keep B.");
      expect(outcome.block.content).toContain("event four");
      expect(outcome.block.content).not.toContain("old decision");
      expect(outcome.block.content).not.toContain("private neighbor event");
      expect(Buffer.byteLength(outcome.block.content, "utf8")).toBeLessThanOrEqual(7 * 1024);
    }
  });

  test.skipIf(process.platform !== "win32")("reads session notes from a case-insensitive Windows workspace path", () => {
    const root = workspace();
    note(root, "telegram-direct-42", "2026-09-19", "# Daily\n\n## Next\n- case-insensitive path\n");
    const flipped = root.replace(/^[a-zA-Z]/, (letter) => (
      letter === letter.toUpperCase() ? letter.toLowerCase() : letter.toUpperCase()
    ));
    const outcome = resolveSessionContextSource({
      workspace: flipped,
      scope: parseCanonicalSessionKey("agent:main:telegram:direct:42")!,
      now: "2026-09-19T00:00:00.000Z",
    });
    expect(outcome.status).toBe("selected");
    if (outcome.status === "selected") expect(outcome.block.content).toContain("case-insensitive path");
  });

  test("returns missing for an absent or empty exact-session note set", () => {
    const root = workspace();
    const scope = parseCanonicalSessionKey("agent:main:telegram:direct:42")!;
    expect(resolveSessionContextSource({ workspace: root, scope, now: "2026-09-19T00:00:00.000Z" })).toEqual({
      source: "session", status: "omitted", reason: "SOURCE_MISSING",
    });
    note(root, "telegram-direct-42", "2026-09-19", "# Daily\n\n## Learnings\n- unrelated\n");
    expect(resolveSessionContextSource({ workspace: root, scope, now: "2026-09-19T00:00:00.000Z" })).toEqual({
      source: "session", status: "omitted", reason: "SOURCE_MISSING",
    });
  });

  test("keeps complete structured and bullet records", () => {
    expect(completeMarkdownRecords("### One\nBody one\n\n### Two\nBody two")).toEqual([
      "### One\nBody one", "### Two\nBody two",
    ]);
    expect(completeMarkdownRecords("- first\n  continuation\n- second")).toEqual([
      "- first\n  continuation", "- second",
    ]);
  });

  test("skips one oversized record instead of truncating it", () => {
    const root = workspace();
    note(root, "telegram-direct-42", "2026-09-19", `# Daily\n\n## Events\n- ${"x".repeat(3 * 1024)}\n\n## Next\n- safe next step\n`);
    const outcome = resolveSessionContextSource({
      workspace: root,
      scope: parseCanonicalSessionKey("agent:main:telegram:direct:42")!,
      now: "2026-09-19T00:00:00.000Z",
    });
    expect(outcome.status).toBe("selected");
    if (outcome.status === "selected") {
      expect(outcome.block.content).toContain("safe next step");
      expect(outcome.block.content).not.toContain("x".repeat(64));
    }
  });

  test("uses a completed rotated summary only as a fallback", () => {
    const root = workspace();
    note(root, "telegram-direct-42", "2026-09-19", `# Daily\n\n## Summary\n\nA bounded completed summary.\n<!-- Archive: archives/2026-09/2026-09-19.md -->\n`);
    const outcome = resolveSessionContextSource({
      workspace: root,
      scope: parseCanonicalSessionKey("agent:main:telegram:direct:42")!,
      now: "2026-09-19T00:00:00.000Z",
    });
    expect(outcome.status).toBe("selected");
    if (outcome.status === "selected") expect(outcome.block.content).toContain("A bounded completed summary");
  });

  test("fails closed on duplicate working sections and ignores far-future notes", () => {
    const root = workspace();
    note(root, "telegram-direct-42", "2026-09-19", "# Daily\n\n## Events\n- one\n\n## Events\n- two\n");
    note(root, "telegram-direct-42", "2099-01-01", "# Daily\n\n## Events\n- future\n");
    const outcome = resolveSessionContextSource({
      workspace: root,
      scope: parseCanonicalSessionKey("agent:main:telegram:direct:42")!,
      now: "2026-09-19T00:00:00.000Z",
    });
    expect(outcome).toEqual({ source: "session", status: "omitted", reason: "SOURCE_INVALID" });
  });
});
