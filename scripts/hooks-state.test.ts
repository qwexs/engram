/**
 * hooks-state.test.ts — heartbeat-state updates performed by Engram hooks.
 */

import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import sessionStartHandler from "../hooks/engram-session-start/handler.ts";
import dailyNoteHandler from "../hooks/engram-daily-note/handler.ts";

function makeWorkspace() {
  const workspace = mkdtempSync(join(tmpdir(), "engram-hooks-test-"));
  mkdirSync(join(workspace, "memory", "agent-main"), { recursive: true });
  writeFileSync(join(workspace, "memory", "heartbeat-state.json"), JSON.stringify({
    lastDailyNoteCreated: {},
    activeSessions: [],
  }, null, 2) + "\n");
  return workspace;
}

function today() {
  return new Date().toLocaleDateString("sv-SE", { timeZone: process.env.ENGRAM_TZ || process.env.TZ || "UTC" });
}

function readState(workspace: string) {
  return JSON.parse(readFileSync(join(workspace, "memory", "heartbeat-state.json"), "utf-8"));
}

describe("Engram hook heartbeat-state updates", () => {
  test("session-start registers active session before debounce return", async () => {
    const workspace = makeWorkspace();
    try {
      const date = today();
      const sessionDir = join(workspace, "memory", "agent-main", "telegram-direct-1");
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(join(sessionDir, `${date}.md`), `# ${date}\n\n<!-- session:start:2099-01-01T00:00:00+00:00 -->\n`);

      await sessionStartHandler({
        type: "agent",
        action: "bootstrap",
        context: { workspaceDir: workspace, sessionKey: "agent:main:telegram:direct:1" },
      });

      const state = readState(workspace);
      expect(state.lastDailyNoteCreated["telegram-direct-1"]).toBe(date);
      expect(state.activeSessions).toContain("telegram-direct-1");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("daily-note startup syncs lastDailyNoteCreated for existing notes", async () => {
    const workspace = makeWorkspace();
    try {
      const date = today();
      const sessionDir = join(workspace, "memory", "agent-main", "main");
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(join(sessionDir, `${date}.md`), `# ${date}\n`);

      await dailyNoteHandler({
        type: "gateway",
        action: "startup",
        context: { workspaceDir: workspace },
        messages: [],
      });

      const state = readState(workspace);
      expect(state.lastDailyNoteCreated.main).toBe(date);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("daily-note startup does not create notes for historical session directories", async () => {
    const workspace = makeWorkspace();
    try {
      const date = today();
      const sessionDir = join(workspace, "memory", "agent-main", "historical-session");
      mkdirSync(sessionDir, { recursive: true });

      await dailyNoteHandler({
        type: "gateway",
        action: "startup",
        context: { workspaceDir: workspace },
        messages: [],
      });

      expect(() => readFileSync(join(sessionDir, `${date}.md`), "utf8")).toThrow();
      const state = readState(workspace);
      expect(state.lastDailyNoteCreated["historical-session"]).toBeUndefined();
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
