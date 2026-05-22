import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { tmpdir } from "os";
import { existsSync, mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "fs";

import { getAgentDir } from "../scripts/config.js";
import { applyHandoff, parseHandoff } from "../scripts/process-handoff-core.js";

const SCRIPTS_DIR = join(import.meta.dir, "..", "scripts");
const TEST_DATE = "2026-03-02";
let WORKSPACE_ROOT;
let OBS_DIR;
let MEMORY_DIR;
let STATE_PATH;

function cleanOpsDir(dir) {
  if (!existsSync(dir)) return;
  for (const f of require("fs").readdirSync(dir)) {
    if (f.endsWith(".json")) rmSync(join(dir, f), { force: true });
  }
}

async function runHandoff(handoffBlock, session = "main", date = TEST_DATE) {
  const proc = Bun.spawn(
    ["bun", join(SCRIPTS_DIR, "process-handoff.js"), "--session", session, "--date", date],
    {
      stdin: new Blob([handoffBlock]),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ENGRAM_WORKSPACE: WORKSPACE_ROOT },
    }
  );
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { exitCode, stdout, stderr };
}

function writeDailyNote() {
  mkdirSync(MEMORY_DIR, { recursive: true });
  writeFileSync(join(MEMORY_DIR, `${TEST_DATE}.md`), `# ${TEST_DATE}

## Events

## Decisions

## Learnings

## Active Threads

## Next
`, "utf-8");
}

function readState() {
  if (!existsSync(STATE_PATH)) return {};
  return JSON.parse(readFileSync(STATE_PATH, "utf-8"));
}

describe("process-handoff.js — no handoff block", () => {
  beforeEach(() => {
    WORKSPACE_ROOT = mkdtempSync(join(tmpdir(), "engram-handoff-"));
    OBS_DIR = join(WORKSPACE_ROOT, "workspace", "ops", "observations");
    MEMORY_DIR = join(WORKSPACE_ROOT, "memory", getAgentDir(WORKSPACE_ROOT), "main");
    STATE_PATH = join(WORKSPACE_ROOT, "memory", "heartbeat-state.json");
    writeDailyNote();
  });

  afterEach(() => {
    if (WORKSPACE_ROOT?.startsWith(tmpdir())) rmSync(WORKSPACE_ROOT, { recursive: true, force: true });
  });

  test("exits 1 when input has no handoff block", async () => {
    const { exitCode, stdout } = await runHandoff("just some random text");
    expect(exitCode).toBe(1);
  });

  test("exits 1 on empty input", async () => {
    const { exitCode } = await runHandoff("");
    expect(exitCode).toBe(1);
  });
});

describe("process-handoff.js — HB-EXTRACT", () => {
  beforeEach(() => {
    WORKSPACE_ROOT = mkdtempSync(join(tmpdir(), "engram-handoff-"));
    OBS_DIR = join(WORKSPACE_ROOT, "workspace", "ops", "observations");
    MEMORY_DIR = join(WORKSPACE_ROOT, "memory", getAgentDir(WORKSPACE_ROOT), "main");
    STATE_PATH = join(WORKSPACE_ROOT, "memory", "heartbeat-state.json");
    writeDailyNote();
    cleanOpsDir(OBS_DIR);
  });

  afterEach(() => {
    if (WORKSPACE_ROOT?.startsWith(tmpdir())) rmSync(WORKSPACE_ROOT, { recursive: true, force: true });
  });

  test("processes ok extract with watermark", async () => {
    const block = `=== HB-EXTRACT HANDOFF ===
Status: ok
Summary: Extracted 1 fact
Stats: {"facts_written": 1, "facts_skipped_dedup": 0, "new_watermark": "L20"}
Observations: []
Tensions: []
Alerts: []
=== END ===`;

    const { exitCode, stdout } = await runHandoff(block);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("HB-EXTRACT");
    expect(stdout).toContain("✅");

    const state = readState();
    expect(state.subagentRuns?.["hb-extract"]?.status).toBe("ok");
  });

  test("processes extract with observations", async () => {
    const block = `=== HB-EXTRACT HANDOFF ===
Status: ok
Summary: Extracted 2 facts
Stats: {"facts_written": 2, "facts_skipped_dedup": 0, "new_watermark": "L25"}
Observations: [{"observation": "process-handoff test observation alpha", "category": "quality"}]
Tensions: []
Alerts: []
=== END ===`;

    const { exitCode, stdout } = await runHandoff(block);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Logged 1 flags");

    const note = readFileSync(join(MEMORY_DIR, `${TEST_DATE}.md`), "utf-8");
    expect(note).toContain("process-handoff test observation alpha");
  });

  test("handles error status", async () => {
    const block = `=== HB-EXTRACT HANDOFF ===
Status: error
Summary: Failed to read daily note
Stats: {}
Observations: []
Tensions: []
Alerts: []
=== END ===`;

    const { exitCode, stdout } = await runHandoff(block);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("error");

    const state = readState();
    expect(state.subagentRuns?.["hb-extract"]?.status).toBe("failed");
  });

  test("core applyHandoff accepts context directly without CLI side effects", async () => {
    const block = `=== HB-EXTRACT HANDOFF ===
Status: ok
Summary: Extracted 1 fact
Stats: {"facts_written": 1, "facts_skipped_dedup": 0, "new_watermark": "L20"}
Observations: []
Tensions: []
Alerts: []
=== END ===`;

    const result = await applyHandoff(parseHandoff(block), {
      workspace: WORKSPACE_ROOT,
      session: "main",
      date: TEST_DATE,
    });

    expect(result.status).toBe("ok");
    expect(result.logs.join("\n")).toContain("HB-EXTRACT");
    const state = readState();
    expect(state.subagentRuns?.["hb-extract"]?.status).toBe("ok");
  });
});

describe("process-handoff.js — HB-DOMAINS", () => {
  beforeEach(() => {
    WORKSPACE_ROOT = mkdtempSync(join(tmpdir(), "engram-handoff-"));
    OBS_DIR = join(WORKSPACE_ROOT, "workspace", "ops", "observations");
    MEMORY_DIR = join(WORKSPACE_ROOT, "memory", getAgentDir(WORKSPACE_ROOT), "main");
    STATE_PATH = join(WORKSPACE_ROOT, "memory", "heartbeat-state.json");
    writeDailyNote();
    cleanOpsDir(OBS_DIR);
  });

  afterEach(() => {
    if (WORKSPACE_ROOT?.startsWith(tmpdir())) rmSync(WORKSPACE_ROOT, { recursive: true, force: true });
  });

  test("processes ok domains", async () => {
    const block = `=== HB-DOMAINS HANDOFF ===
Status: ok
Summary: 5 domains checked
Stats: {"checked": 5}
Observations: []
Tensions: []
Alerts: []
=== END ===`;

    const { exitCode, stdout } = await runHandoff(block);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("✅");

    const state = readState();
    expect(state.subagentRuns?.["hb-domains"]?.status).toBe("ok");
    expect(state.lastDomainScan).toBeDefined();
  });

  test("exits 2 when alerts present", async () => {
    const block = `=== HB-DOMAINS HANDOFF ===
Status: ok
Summary: 7 domains checked
Stats: {"checked": 7}
Observations: []
Tensions: []
Alerts: ["elena-ai-digest overdue by 3 days"]
=== END ===`;

    const { exitCode, stdout } = await runHandoff(block);
    expect(exitCode).toBe(2);
    expect(stdout).toContain("[ALERT]");
    expect(stdout).toContain("elena-ai-digest");
  });

  test("continues gracefully when tension fact IDs are invalid", async () => {
    const block = `=== HB-DOMAINS HANDOFF ===
Status: ok
Summary: test domains
Stats: {}
Observations: []
Tensions: [{"tension": "test conflict", "fact1": "nonexistent-001", "fact2": "nonexistent-002"}]
Alerts: []
=== END ===`;

    const { exitCode, stdout } = await runHandoff(block);
    expect(exitCode).toBe(0);
    // Should not crash — tension write fails gracefully
    expect(stdout).toContain("✅");
  });

  test("processes observations from domains", async () => {
    const block = `=== HB-DOMAINS HANDOFF ===
Status: ok
Summary: domains ok
Stats: {}
Observations: [{"observation": "process-handoff test domains observation beta", "category": "friction"}]
Tensions: []
Alerts: []
=== END ===`;

    const { exitCode, stdout } = await runHandoff(block);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Logged 1 flags");
  });
});

describe("process-handoff.js — HB-SYNTHESIS", () => {
  beforeEach(() => {
    WORKSPACE_ROOT = mkdtempSync(join(tmpdir(), "engram-handoff-"));
    OBS_DIR = join(WORKSPACE_ROOT, "workspace", "ops", "observations");
    MEMORY_DIR = join(WORKSPACE_ROOT, "memory", getAgentDir(WORKSPACE_ROOT), "main");
    STATE_PATH = join(WORKSPACE_ROOT, "memory", "heartbeat-state.json");
    writeDailyNote();
  });

  afterEach(() => {
    if (WORKSPACE_ROOT?.startsWith(tmpdir())) rmSync(WORKSPACE_ROOT, { recursive: true, force: true });
  });

  test("processes ok synthesis", async () => {
    const block = `=== HB-SYNTHESIS HANDOFF ===
Status: ok
Summary: 47 entities rebuilt
Stats: {"entities_total": 47, "entities_updated": 47}
Observations: []
Alerts: []
=== END ===`;

    const { exitCode, stdout } = await runHandoff(block);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("✅");

    const state = readState();
    expect(state.subagentRuns?.["hb-synthesis"]?.status).toBe("ok");
    expect(state.lastWeeklySynthesis).toBeDefined();
  });

  test("handles error status", async () => {
    const block = `=== HB-SYNTHESIS HANDOFF ===
Status: error
Summary: rebuild-summaries.js failed
Stats: {}
Observations: []
Alerts: []
=== END ===`;

    const { exitCode, stdout } = await runHandoff(block);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("error");

    const state = readState();
    expect(state.subagentRuns?.["hb-synthesis"]?.status).toBe("failed");
  });
});

describe("process-handoff.js — unknown type", () => {
  beforeEach(() => {
    WORKSPACE_ROOT = mkdtempSync(join(tmpdir(), "engram-handoff-"));
    OBS_DIR = join(WORKSPACE_ROOT, "workspace", "ops", "observations");
    MEMORY_DIR = join(WORKSPACE_ROOT, "memory", getAgentDir(WORKSPACE_ROOT), "main");
    STATE_PATH = join(WORKSPACE_ROOT, "memory", "heartbeat-state.json");
    writeDailyNote();
  });

  afterEach(() => {
    if (WORKSPACE_ROOT?.startsWith(tmpdir())) rmSync(WORKSPACE_ROOT, { recursive: true, force: true });
  });

  test("exits 1 for unknown handoff type", async () => {
    const block = `=== HB-UNKNOWN HANDOFF ===
Status: ok
Summary: test
Stats: {}
Observations: []
Alerts: []
=== END ===`;

    const { exitCode } = await runHandoff(block);
    expect(exitCode).toBe(1);
  });
});
