import { describe, test, expect, beforeEach } from "bun:test";
import { join } from "path";
import { existsSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "fs";

const SCRIPTS_DIR = join(import.meta.dir, "..", "scripts");
const WORKSPACE_ROOT = join(import.meta.dir, "..", "..", "..");
const OBS_DIR = join(WORKSPACE_ROOT, "workspace", "ops", "observations");
const TENSION_DIR = join(WORKSPACE_ROOT, "workspace", "ops", "tensions");
const MEMORY_DIR = join(WORKSPACE_ROOT, "memory", "agent-main", "main");
const STATE_PATH = join(import.meta.dir, "..", "memory", "heartbeat-state.json");

const TEST_DATE = "2026-03-02";

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
    }
  );
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { exitCode, stdout, stderr };
}

function readState() {
  if (!existsSync(STATE_PATH)) return {};
  return JSON.parse(readFileSync(STATE_PATH, "utf-8"));
}

describe("process-handoff.js — no handoff block", () => {
  test("exits 0 when input has no handoff block", async () => {
    const { exitCode, stdout } = await runHandoff("just some random text");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("No handoff block found");
  });

  test("exits 0 on empty input", async () => {
    const { exitCode } = await runHandoff("");
    expect(exitCode).toBe(0);
  });
});

describe("process-handoff.js — HB-EXTRACT", () => {
  beforeEach(() => {
    cleanOpsDir(OBS_DIR);
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
    expect(stdout).toContain("Wrote 1 observations");

    // Check observation file exists
    const indexPath = join(OBS_DIR, "index.json");
    expect(existsSync(indexPath)).toBe(true);
    const index = JSON.parse(readFileSync(indexPath, "utf-8"));
    expect(index.observations.length).toBeGreaterThan(0);
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
});

describe("process-handoff.js — HB-DOMAINS", () => {
  beforeEach(() => {
    cleanOpsDir(OBS_DIR);
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
    expect(stdout).toContain("Wrote 1 observations");
  });
});

describe("process-handoff.js — HB-SYNTHESIS", () => {
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
