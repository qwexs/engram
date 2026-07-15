/**
 * watchdog.test.js — read-only Engram workspace auditor tests.
 *
 * Fixtures are synthetic and live under os.tmpdir(). Tests run with
 * --no-core/--no-qmd unless explicitly checking CLI plumbing; this keeps the
 * auditor tests independent from local QMD/OpenClaw state.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { auditWorkspace, parseQmdCollections } from "./_lib/workspace-watchdog.js";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "watchdog.js");
let workspace;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "engram-watchdog-test-"));
  mkdirSync(join(workspace, "memory", "domains"), { recursive: true });
  mkdirSync(join(workspace, "memory", "agent-main", "main"), { recursive: true });
  mkdirSync(join(workspace, "life", "projects", "alpha"), { recursive: true });
  writeFileSync(join(workspace, "engram.json"), JSON.stringify({
    agent: "agent-main",
    qmd: { command: "qmd", collection: "alpha-memory" },
    cron: { expectedJobName: "Heartbeat (Engram runner) — alpha" },
  }, null, 2) + "\n");
  writeFileSync(join(workspace, "memory", "heartbeat-state.json"), JSON.stringify({
    lastDailyNoteCreated: { main: "2026-07-15" },
  }, null, 2) + "\n");
  writeFileSync(join(workspace, "memory", "domains", "registry.json"), JSON.stringify({ domains: {} }, null, 2) + "\n");
  writeFileSync(join(workspace, "life", "projects", "alpha", "items.json"), JSON.stringify({
    entityId: "projects/alpha",
    entityType: "project",
    facts: [{
      id: "fact-1",
      fact: "Alpha project exists.",
      category: "context",
      timestamp: "2026-07-15T00:00:00.000Z",
      lastAccessed: "2026-07-15T00:00:00.000Z",
      accessCount: 0,
      confidence: 0.8,
      abstractionLevel: "episode",
      tags: [],
      status: "active",
    }],
  }, null, 2) + "\n");
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

function runCli(args) {
  const r = spawnSync("bun", [SCRIPT, ...args], { cwd: workspace, encoding: "utf-8" });
  return { status: r.status ?? -1, stdout: r.stdout || "", stderr: r.stderr || "" };
}

function codes(report) {
  return report.findings.map((f) => f.code);
}

describe("workspace watchdog core", () => {
  test("clean synthetic workspace is ok when core/qmd checks are skipped", () => {
    const report = auditWorkspace(workspace, { core: false, qmd: false });
    expect(report.status).toBe("ok");
    expect(report.summary).toMatchObject({ errors: 0, warnings: 0, readOnly: true, fixed: 0 });
  });

  test("detects registry domain without folder", () => {
    writeFileSync(join(workspace, "memory", "domains", "registry.json"), JSON.stringify({
      domains: {
        missing: { type: "dev-project", description: "Missing folder" },
      },
    }, null, 2) + "\n");
    const report = auditWorkspace(workspace, { core: false, qmd: false });
    expect(report.status).toBe("error");
    expect(codes(report)).toContain("WD-DOMAIN-001");
  });

  test("detects folder without registry entry", () => {
    mkdirSync(join(workspace, "memory", "domains", "orphan"), { recursive: true });
    const report = auditWorkspace(workspace, { core: false, qmd: false });
    expect(report.status).toBe("warn");
    expect(codes(report)).toContain("WD-DOMAIN-002");
  });

  test("meta-domain coverage accepts aggregate domains collection", () => {
    writeFileSync(join(workspace, "memory", "domains", "registry.json"), JSON.stringify({
      domains: {
        general: {
          type: "meta-domain",
          topic: { chatId: "-1001", topicId: "1" },
          qmdCollections: ["alpha-memory", "alpha-domains"],
        },
        child: {
          type: "topic-thread",
          topic: { chatId: "-1001", topicId: "2" },
        },
      },
    }, null, 2) + "\n");
    mkdirSync(join(workspace, "memory", "domains", "general"), { recursive: true });
    mkdirSync(join(workspace, "memory", "domains", "child"), { recursive: true });
    const report = auditWorkspace(workspace, { core: false, qmd: false });
    expect(codes(report)).not.toContain("WD-DOMAIN-006");
  });

  test("meta-domain coverage warns when child domain is neither explicit nor aggregate-covered", () => {
    writeFileSync(join(workspace, "memory", "domains", "registry.json"), JSON.stringify({
      domains: {
        general: {
          type: "meta-domain",
          topic: { chatId: "-1001", topicId: "1" },
          qmdCollections: ["alpha-memory"],
        },
        child: {
          type: "topic-thread",
          topic: { chatId: "-1001", topicId: "2" },
        },
      },
    }, null, 2) + "\n");
    mkdirSync(join(workspace, "memory", "domains", "general"), { recursive: true });
    mkdirSync(join(workspace, "memory", "domains", "child"), { recursive: true });
    const report = auditWorkspace(workspace, { core: false, qmd: false });
    expect(codes(report)).toContain("WD-DOMAIN-006");
    const finding = report.findings.find((f) => f.code === "WD-DOMAIN-006");
    expect(finding.details.expectedCollection).toBe("domain-child");
  });

  test("QMD parser captures zero-file collections", () => {
    const parsed = parseQmdCollections(`Collections (2):

alpha (qmd://alpha/)
  Pattern:  **/*.md
  Files:    3

empty-domain (qmd://empty-domain/)
  Pattern:  **/*.md
  Files:    0
`);
    expect(parsed.get("alpha").files).toBe(3);
    expect(parsed.get("empty-domain").files).toBe(0);
  });

  test("detects heartbeat-state/session drift", () => {
    mkdirSync(join(workspace, "memory", "agent-main", "telegram-group--100-topic-7"), { recursive: true });
    writeFileSync(join(workspace, "memory", "heartbeat-state.json"), JSON.stringify({
      lastDailyNoteCreated: { main: "2026-07-15", ghost: "2026-07-15" },
    }, null, 2) + "\n");
    const report = auditWorkspace(workspace, { core: false, qmd: false });
    expect(codes(report)).toContain("WD-SESSION-001");
    expect(codes(report)).toContain("WD-SESSION-002");
  });

  test("ephemeral session dirs (cron-*-run-*, subagent-*) are not flagged", () => {
    mkdirSync(join(workspace, "memory", "agent-main", "cron-abc-123-run-def"), { recursive: true });
    mkdirSync(join(workspace, "memory", "agent-main", "subagent-xyz"), { recursive: true });
    const report = auditWorkspace(workspace, { core: false, qmd: false });
    expect(codes(report)).not.toContain("WD-SESSION-001");
  });

  test("detects KG v2 schema errors and test pollution", () => {
    mkdirSync(join(workspace, "life", "projects", "test-project"), { recursive: true });
    writeFileSync(join(workspace, "life", "projects", "test-project", "items.json"), JSON.stringify({
      entityId: "projects/test-project",
      entityType: "project",
      facts: [{ id: "bad", title: "Old", content: "test fixture", category: "technical", tags: ["test"] }],
    }, null, 2) + "\n");
    const report = auditWorkspace(workspace, { core: false, qmd: false });
    expect(report.status).toBe("error");
    expect(codes(report)).toContain("WD-KG-001");
    expect(codes(report)).toContain("WD-KG-002");
    expect(codes(report)).toContain("WD-KG-003");
    expect(codes(report)).toContain("WD-KG-004");
  });

  test("does not flag qmd-config as test pollution by name alone", () => {
    mkdirSync(join(workspace, "life", "projects", "qmd-config"), { recursive: true });
    writeFileSync(join(workspace, "life", "projects", "qmd-config", "items.json"), JSON.stringify({
      entityId: "projects/qmd-config",
      entityType: "project",
      facts: [{
        id: "qmd-config-1",
        fact: "QMD model configuration is real operational memory, not a test fixture.",
        category: "decision",
        timestamp: "2026-07-15T00:00:00.000Z",
        lastAccessed: "2026-07-15T00:00:00.000Z",
        accessCount: 0,
        confidence: 0.8,
        abstractionLevel: "pattern",
        tags: ["qmd", "architecture"],
        status: "active",
      }],
    }, null, 2) + "\n");
    const report = auditWorkspace(workspace, { core: false, qmd: false });
    const pollution = report.findings.filter((f) => f.code === "WD-KG-004" && f.path?.includes("qmd-config"));
    expect(pollution).toHaveLength(0);
  });
});

describe("watchdog CLI", () => {
  test("--json prints structured report and returns 0 for clean workspace", () => {
    const r = runCli(["--workspace", workspace, "--json", "--no-core", "--no-qmd"]);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.schema).toBe("engram.watchdog.v1");
    expect(out.summary.readOnly).toBe(true);
  });

  test("warnings-only exits 2 by default and 0 with --exit-zero-on-warn", () => {
    mkdirSync(join(workspace, "memory", "domains", "orphan"), { recursive: true });
    const strict = runCli(["--workspace", workspace, "--json", "--no-core", "--no-qmd"]);
    expect(strict.status).toBe(2);
    const cron = runCli(["--workspace", workspace, "--json", "--no-core", "--no-qmd", "--exit-zero-on-warn"]);
    expect(cron.status).toBe(0);
  });

  test("requires explicit workspaces-dir for --all", () => {
    const r = runCli(["--all", "--json", "--no-core", "--no-qmd"]);
    expect(r.status).toBe(3);
    expect(r.stderr).toContain("--all requires");
  });
});
