import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseAgentIdFromSessionKey, resolveWorkspaceByAgentId } from "../workspace-resolver.js";

let fakeHome: string;

beforeAll(() => {
  fakeHome = mkdtempSync(join(tmpdir(), "engram-resolver-test-"));
});

afterAll(() => {
  if (fakeHome && existsSync(fakeHome)) {
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

describe("parseAgentIdFromSessionKey", () => {
  test("extracts agentId from a standard telegram sessionKey", () => {
    // Synthetic sessionKey — no real agent ids or chat ids.
    expect(parseAgentIdFromSessionKey("agent:alpha:telegram:group:-1:topic:1"))
      .toBe("alpha");
  });

  test("extracts agentId from a hyphenated agent id", () => {
    expect(parseAgentIdFromSessionKey("agent:foo-bar:telegram:group:-2:topic:3"))
      .toBe("foo-bar");
  });

  test("extracts agentId from a main (non-telegram) sessionKey", () => {
    expect(parseAgentIdFromSessionKey("agent:alpha:main"))
      .toBe("alpha");
  });

  test("returns null for empty sessionKey", () => {
    expect(parseAgentIdFromSessionKey("")).toBeNull();
  });

  test("returns null for a non-conforming sessionKey", () => {
    expect(parseAgentIdFromSessionKey("not:an:agent:key:at:all")).toBeNull();
  });
});

describe("resolveWorkspaceByAgentId", () => {
  test("returns null for empty agentId", () => {
    expect(resolveWorkspaceByAgentId("", fakeHome)).toBeNull();
  });

  test("returns null when openclaw.json does not exist", () => {
    // fakeHome exists but has no .openclaw/openclaw.json inside it
    expect(resolveWorkspaceByAgentId("alpha", fakeHome)).toBeNull();
  });

  test("resolves workspace from openclaw.json by agentId", () => {
    // Use generic, non-personal placeholders for ids and workspaces.
    const openclawDir = join(fakeHome, ".openclaw");
    mkdirSync(openclawDir, { recursive: true });
    const configPath = join(openclawDir, "openclaw.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        agents: {
          list: [
            { id: "alpha", workspace: "/workspaces/alpha" },
            { id: "beta",  workspace: "/workspaces/beta" },
            { id: "gamma", workspace: "/workspaces/gamma" },
          ],
        },
      }),
      "utf-8",
    );
    expect(resolveWorkspaceByAgentId("alpha", fakeHome)).toBe("/workspaces/alpha");
    expect(resolveWorkspaceByAgentId("beta",  fakeHome)).toBe("/workspaces/beta");
    expect(resolveWorkspaceByAgentId("gamma", fakeHome)).toBe("/workspaces/gamma");
  });

  test("returns null when agent is not in the list", () => {
    expect(resolveWorkspaceByAgentId("unknown-agent", fakeHome)).toBeNull();
  });

  test("returns null when config is malformed JSON", () => {
    const openclawDir = join(fakeHome, ".openclaw-malformed");
    mkdirSync(openclawDir, { recursive: true });
    writeFileSync(join(openclawDir, "openclaw.json"), "{ not json", "utf-8");
    // The resolver catches JSON.parse errors internally, so the home it
    // points at doesn't even need to exist on disk.
    expect(resolveWorkspaceByAgentId("alpha", join(fakeHome, "broken-home"))).toBeNull();
  });

  test("returns null when agents.list is not an array", () => {
    const brokenHome = mkdtempSync(join(tmpdir(), "engram-resolver-test-broken-"));
    try {
      const openclawDir = join(brokenHome, ".openclaw");
      mkdirSync(openclawDir, { recursive: true });
      writeFileSync(
        join(openclawDir, "openclaw.json"),
        JSON.stringify({ agents: { list: "not-an-array" } }),
        "utf-8",
      );
      expect(resolveWorkspaceByAgentId("alpha", brokenHome)).toBeNull();
    } finally {
      rmSync(brokenHome, { recursive: true, force: true });
    }
  });
});
