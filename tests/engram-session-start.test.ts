import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const HOOK = join(import.meta.dir, "..", "hooks", "engram-session-start", "handler.ts");

let workspace: string;

function seedWorkspace() {
  workspace = join(tmpdir(), "engram-hook-" + Date.now() + "-" + Math.random().toString(16).slice(2));
  mkdirSync(join(workspace, "memory"), { recursive: true });
}

async function callHook(event: any) {
  const mod = await import(HOOK);
  await mod.default(event);
}

function handoffFile(name: string, content = "# 2026-06-24\n\n## Events\n\n") {
  writeFileSync(join(workspace, "memory", name), content);
}

beforeEach(() => {
  seedWorkspace();
});

afterEach(() => {
  if (workspace && existsSync(workspace)) rmSync(workspace, { recursive: true, force: true });
});

describe("engram-session-start handoff move (ISS-7)", () => {
  test("moves handoff .md from memory/ root to memory/agent-{id}/{sessionKey}/{date}/ (not domains/)", async () => {
    handoffFile("2026-06-24.md", "# 2026-06-24\n\n## Events\n\nSome old handoff\n");
    await callHook({
      type: "agent",
      action: "bootstrap",
      context: {
        workspaceDir: workspace,
        agentId: "test-agent",
        sessionKey: "agent:test-agent:main",
      },
    });
    // Source file removed
    expect(existsSync(join(workspace, "memory", "2026-06-24.md"))).toBe(false);
    // Destination: memory/agent-test-agent/main/2026-06-24/2026-06-24.md
    const dest = join(workspace, "memory", "agent-test-agent", "main", "2026-06-24", "2026-06-24.md");
    expect(existsSync(dest)).toBe(true);
    // No legacy domains/<sess>/ created
    expect(existsSync(join(workspace, "memory", "domains"))).toBe(false);
    // Content preserved
    expect(readFileSync(dest, "utf-8")).toContain("Some old handoff");
  });

  test("respects sessionKey (not parsed from file content)", async () => {
    // File with legacy 'Session Key: agent:foo:bar' should land under the CURRENT sessionKey,
    // not the one mentioned in the file. (Old hook parsed session from content and used it.)
    handoffFile("2026-06-23.md", "Session Key: agent:foo:bar\n# 2026-06-23\n\n## Events\n\nLegacy\n");
    await callHook({
      type: "agent",
      action: "bootstrap",
      context: {
        workspaceDir: workspace,
        agentId: "test-agent",
        sessionKey: "agent:test-agent:telegram-group--5206956283",
      },
    });
    const dest = join(workspace, "memory", "agent-test-agent", "telegram-group--5206956283", "2026-06-23", "2026-06-23.md");
    expect(existsSync(dest)).toBe(true);
    // No folder for 'bar' (the legacy parsed session)
    expect(existsSync(join(workspace, "memory", "agent-test-agent", "bar"))).toBe(false);
    expect(existsSync(join(workspace, "memory", "agent-foo", "bar"))).toBe(false);
  });

  test("ignores non-date .md files and files in memory/ subdirs", async () => {
    handoffFile("2026-06-24.md");
    handoffFile("README.md"); // no date prefix
    mkdirSync(join(workspace, "memory", "agent-test-agent", "main"), { recursive: true });
    writeFileSync(join(workspace, "memory", "agent-test-agent", "main", "2026-06-22.md"), "kept");
    await callHook({
      type: "agent",
      action: "bootstrap",
      context: { workspaceDir: workspace, agentId: "test-agent", sessionKey: "agent:test-agent:main" },
    });
    // Date file moved
    expect(existsSync(join(workspace, "memory", "agent-test-agent", "main", "2026-06-24", "2026-06-24.md"))).toBe(true);
    // README untouched
    expect(existsSync(join(workspace, "memory", "README.md"))).toBe(true);
    // Subdir file untouched (recursive readdir was not used)
    expect(existsSync(join(workspace, "memory", "agent-test-agent", "main", "2026-06-22.md"))).toBe(true);
  });

  test("empty memory root: no handoff move, no error", async () => {
    await callHook({
      type: "agent",
      action: "bootstrap",
      context: { workspaceDir: workspace, agentId: "test-agent", sessionKey: "agent:test-agent:main" },
    });
    // No 'domains/' folder created (legacy path would create this)
    expect(existsSync(join(workspace, "memory", "domains"))).toBe(false);
    // No leftover handoff files at memory/ root
    const top = readdirSync(join(workspace, "memory")).filter(f => /^\d{4}-\d{2}-\d{2}/.test(f));
    expect(top).toEqual([]);
  });

  test("only acts on agent bootstrap events", async () => {
    handoffFile("2026-06-24.md");
    await callHook({
      type: "agent",
      action: "shutdown",
      context: { workspaceDir: workspace, agentId: "test-agent", sessionKey: "agent:test-agent:main" },
    });
    // Not moved on shutdown
    expect(existsSync(join(workspace, "memory", "2026-06-24.md"))).toBe(true);
  });
});
