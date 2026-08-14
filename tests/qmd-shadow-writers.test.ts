import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import sessionStartHandler from "../hooks/engram-session-start/handler.ts";
import sessionEndHandler from "../hooks/engram-session-end/handler.ts";
import { resolveQmdContext } from "../src/qmd/context.ts";
import {
  resolveQmdMaintenanceStateRoot,
  type QmdMaintenanceIntegrationRuntime,
} from "../src/qmd/maintenance-integration.ts";
import { readQmdMaintenanceState } from "../src/qmd/maintenance.ts";

const repositoryRoot = resolve(import.meta.dir, "..");
const roots: string[] = [];

function makeWorkspace(): { workspace: string; stateDir: string } {
  const root = mkdtempSync(join(tmpdir(), "engram-shadow-writers-"));
  roots.push(root);
  const workspace = join(root, "workspace");
  const stateDir = join(root, "openclaw-state");
  mkdirSync(join(workspace, "memory"), { recursive: true });
  mkdirSync(join(workspace, "life", "areas", "test"), { recursive: true });
  mkdirSync(join(workspace, "workspace", "memory-state"), { recursive: true });
  writeFileSync(join(workspace, "workspace", "memory-state", "fact-hashes.json"), "{}");
  writeFileSync(join(workspace, "life", "index.md"), "# Life\n");
  writeFileSync(join(workspace, "life", "areas", "test", "items.json"), JSON.stringify({
    entityId: "areas/test",
    entityType: "area",
    facts: [],
  }));
  writeFileSync(join(workspace, "life", "areas", "test", "summary.md"), "# Test\n");
  writeFileSync(join(workspace, "engram.json"), JSON.stringify({
    agent: "agent-main",
    qmd: {
      index: "global",
      command: join(repositoryRoot, "tests", "fixtures", "fake-qmd.js"),
      collection: "alpha-memory",
      collections: ["alpha-memory", "life"],
      maintenance: { mode: "shadow" },
    },
  }));
  return { workspace, stateDir };
}

function runtime(stateDir: string): QmdMaintenanceIntegrationRuntime {
  return {
    env: { OPENCLAW_STATE_DIR: stateDir, XDG_CACHE_HOME: join(stateDir, "cache") },
    homedir: () => join(stateDir, "home"),
    platform: "linux",
    warn: () => {},
    markDirty: async (stateRoot, input) => {
      const { markQmdDirty } = await import("../src/qmd/maintenance.ts");
      return markQmdDirty(stateRoot, input);
    },
  };
}

function readState(workspace: string, stateDir: string) {
  const rt = runtime(stateDir);
  const context = resolveQmdContext({ value: workspace, source: "explicit" }, rt);
  return readQmdMaintenanceState(resolveQmdMaintenanceStateRoot(rt), context.physicalIndex.key);
}

async function spawnScript(script: string, args: string[], workspace: string, stateDir: string) {
  const process = Bun.spawn(["bun", join(repositoryRoot, "scripts", script), ...args], {
    cwd: workspace,
    env: {
      ...globalThis.process.env,
      ENGRAM_WORKSPACE: workspace,
      OPENCLAW_STATE_DIR: stateDir,
      XDG_CACHE_HOME: join(stateDir, "cache"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  return { stdout, stderr, exitCode };
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("shadow dirty marks from real writers", () => {
  test("daily-note append marks the primary owned collection", async () => {
    const { workspace, stateDir } = makeWorkspace();
    const result = await spawnScript("daily-note-append.js", [
      "--session", "main",
      "--section", "events",
      "--text", "shadow integration event",
    ], workspace, stateDir);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).status).toBe("appended");
    expect(readState(workspace, stateDir)).toMatchObject({
      generation: 1,
      dirty: { collections: ["alpha-memory"] },
    });
  });

  test("daily-note append timestamps canonical decision records", async () => {
    const { workspace, stateDir } = makeWorkspace();
    const result = await spawnScript("daily-note-append.js", [
      "--session", "main",
      "--section", "decisions",
      "--text", "timestamped canonical decision",
    ], workspace, stateDir);

    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.recordTimestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(readFileSync(output.file, "utf8")).toContain(
      `### ${output.recordTimestamp} — decision\n\n- timestamped canonical decision`,
    );
  });

  test("daily-note append canonicalizes every Telegram topic session form", async () => {
    const variants = [
      "telegram-group--1001-topic-4",
      "telegram--1001-topic-4",
      "telegram:-1001:topic:4",
      "telegram:group:-1001:topic:4",
      "agent:main:telegram:group:-1001:topic:4",
      "telegram-1001-thread-4",
      "telegram--1001-4",
    ];

    for (const session of variants) {
      const { workspace, stateDir } = makeWorkspace();
      const result = await spawnScript("daily-note-append.js", [
        "--session", session,
        "--section", "events",
        "--text", `event from ${session}`,
      ], workspace, stateDir);

      expect(result.exitCode).toBe(0);
      const output = JSON.parse(result.stdout);
      expect(relative(workspace, dirname(output.file))).toBe(join(
        "memory",
        "agent-main",
        "telegram-group--1001-topic-4",
      ));
      expect(basename(output.file)).toMatch(/^\d{4}-\d{2}-\d{2}\.md$/);
    }
  });

  test("daily-note append rejects path traversal in session", async () => {
    const { workspace, stateDir } = makeWorkspace();
    const result = await spawnScript("daily-note-append.js", [
      "--session", "../outside",
      "--section", "events",
      "--text", "must not be written",
    ], workspace, stateDir);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Небезопасный или пустой --session");
  });

  test("daily-note append rejects a relative workspace override", async () => {
    const { workspace, stateDir } = makeWorkspace();
    const result = await spawnScript("daily-note-append.js", [
      "--workspace", "relative/workspace",
      "--session", "main",
      "--section", "events",
      "--text", "must not be written",
    ], workspace, stateDir);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--workspace должен быть абсолютным путём");
  });

  test("daily-note append rejects a bare runtime UUID session", async () => {
    const { workspace, stateDir } = makeWorkspace();
    const result = await spawnScript("daily-note-append.js", [
      "--workspace", workspace,
      "--session", "11111111-1111-4111-8111-111111111111",
      "--section", "events",
      "--text", "must not be written",
    ], workspace, stateDir);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--session не может быть runtime/turn UUID");
  });

  test("daily-note append writes an explicit retrieval card without a new collection", async () => {
    const { workspace, stateDir } = makeWorkspace();
    const result = await spawnScript("daily-note-append.js", [
      "--session", "main",
      "--section", "events",
      "--text", "Runner stayed in bounded foreground and cleared the stale lock.",
      "--retrieval-id", "heartbeat-stale-lock",
      "--retrieval-title", "Heartbeat stale-lock repair",
    ], workspace, stateDir);

    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(relative(workspace, dirname(output.retrievalCard))).toBe(join(
      "memory",
      "agent-main",
      "main",
      "retrieval",
    ));
    const dailyDate = basename(output.file, ".md");
    expect(basename(output.retrievalCard)).toBe(`${dailyDate}-heartbeat-stale-lock.md`);
    expect(readFileSync(output.retrievalCard, "utf8")).toContain("# Heartbeat stale-lock repair");
    expect(readState(workspace, stateDir)).toMatchObject({
      generation: 1,
      dirty: { collections: ["alpha-memory"] },
    });
  });

  test("duplicate session-start debounce does not create a second generation", async () => {
    const { workspace, stateDir } = makeWorkspace();
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    const previousCacheHome = process.env.XDG_CACHE_HOME;
    process.env.OPENCLAW_STATE_DIR = stateDir;
    process.env.XDG_CACHE_HOME = join(stateDir, "cache");
    try {
      const event = {
        type: "agent",
        action: "bootstrap",
        context: { workspaceDir: workspace, sessionKey: "agent:main:main" },
      };
      await sessionStartHandler(event);
      await sessionStartHandler(event);
    } finally {
      if (previousStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
      else process.env.OPENCLAW_STATE_DIR = previousStateDir;
      if (previousCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = previousCacheHome;
    }

    expect(readState(workspace, stateDir).generation).toBe(1);
  });

  test("session-start writes raw Telegram topic keys only to the canonical directory", async () => {
    const { workspace, stateDir } = makeWorkspace();
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    const previousCacheHome = process.env.XDG_CACHE_HOME;
    process.env.OPENCLAW_STATE_DIR = stateDir;
    process.env.XDG_CACHE_HOME = join(stateDir, "cache");
    try {
      await sessionStartHandler({
        type: "agent",
        action: "bootstrap",
        context: {
          workspaceDir: workspace,
          agentId: "main",
          sessionKey: "telegram:-1001:topic:4",
        },
      });
    } finally {
      if (previousStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
      else process.env.OPENCLAW_STATE_DIR = previousStateDir;
      if (previousCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = previousCacheHome;
    }

    const date = new Date().toLocaleDateString("sv-SE", {
      timeZone: process.env.ENGRAM_TZ || process.env.TZ || "UTC",
    });
    expect(readFileSync(join(
      workspace,
      "memory",
      "agent-main",
      "telegram-group--1001-topic-4",
      `${date}.md`,
    ), "utf8")).toContain("session:start");
  });

  test("duplicate session-end does not create a second generation", async () => {
    const { workspace, stateDir } = makeWorkspace();
    const date = new Date().toLocaleDateString("sv-SE", {
      timeZone: process.env.ENGRAM_TZ || process.env.TZ || "UTC",
    });
    const noteDir = join(workspace, "memory", "agent-main", "main");
    mkdirSync(noteDir, { recursive: true });
    writeFileSync(join(noteDir, `${date}.md`), `# ${date}\n`);
    const fakeBin = join(workspace, "test-bin");
    mkdirSync(fakeBin);
    writeFileSync(join(fakeBin, "qmd"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(fakeBin, "qmd"), 0o755);
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    const previousCacheHome = process.env.XDG_CACHE_HOME;
    const previousPath = process.env.PATH;
    process.env.OPENCLAW_STATE_DIR = stateDir;
    process.env.XDG_CACHE_HOME = join(stateDir, "cache");
    process.env.PATH = `${fakeBin}:${previousPath ?? ""}`;
    try {
      const event = {
        type: "command",
        action: "new",
        sessionKey: "agent:main:main",
        context: { workspaceDir: workspace },
      };
      await sessionEndHandler(event);
      await sessionEndHandler(event);
    } finally {
      if (previousStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
      else process.env.OPENCLAW_STATE_DIR = previousStateDir;
      if (previousCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = previousCacheHome;
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }

    expect(readState(workspace, stateDir).generation).toBe(1);
  });

});
