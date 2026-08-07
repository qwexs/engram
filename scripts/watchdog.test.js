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
import { join, dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  auditWorkspace,
  parseQmdCollections,
  parseQmdIndexCollections,
  qmdCollectionListArgs,
} from "./_lib/workspace-watchdog.js";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "watchdog.js");
let workspace;

function createCleanWorkspace(root, { agent = "agent-main", project = "alpha" } = {}) {
  mkdirSync(join(root, "memory", "domains"), { recursive: true });
  mkdirSync(join(root, "memory", agent, "main"), { recursive: true });
  mkdirSync(join(root, "life", "projects", project), { recursive: true });
  writeFileSync(join(root, "engram.json"), JSON.stringify({
    agent,
    qmd: { command: "qmd", collection: `${project}-memory` },
    cron: { expectedJobName: `Heartbeat (Engram runner) — ${project}` },
  }, null, 2) + "\n");
  writeFileSync(join(root, "memory", "heartbeat-state.json"), JSON.stringify({
    lastDailyNoteCreated: { main: "2026-07-15" },
  }, null, 2) + "\n");
  writeFileSync(join(root, "memory", "domains", "registry.json"), JSON.stringify({ domains: {} }, null, 2) + "\n");
  writeFileSync(join(root, "life", "projects", project, "items.json"), JSON.stringify({
    entityId: `projects/${project}`,
    entityType: "project",
    facts: [{
      id: "fact-1",
      fact: `${project} project exists.`,
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
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "engram-watchdog-test-"));
  createCleanWorkspace(workspace);
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
    const report = auditWorkspace(workspace, { core: false, qmd: false, hooks: false });
    expect(report.status).toBe("ok");
    expect(report.summary).toMatchObject({ errors: 0, warnings: 0, readOnly: true, fixed: 0 });
  });

  test("detects registry domain without folder", () => {
    writeFileSync(join(workspace, "memory", "domains", "registry.json"), JSON.stringify({
      domains: {
        missing: { type: "dev-project", description: "Missing folder" },
      },
    }, null, 2) + "\n");
    const report = auditWorkspace(workspace, { core: false, qmd: false, hooks: false });
    expect(report.status).toBe("error");
    expect(codes(report)).toContain("WD-DOMAIN-001");
  });

  test("detects folder without registry entry", () => {
    mkdirSync(join(workspace, "memory", "domains", "orphan"), { recursive: true });
    const report = auditWorkspace(workspace, { core: false, qmd: false, hooks: false });
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
    const report = auditWorkspace(workspace, { core: false, qmd: false, hooks: false });
    expect(codes(report)).not.toContain("WD-DOMAIN-006");
  });

  test("meta-domain accepts peer or group binding without requiring topic", () => {
    writeFileSync(join(workspace, "memory", "domains", "registry.json"), JSON.stringify({
      domains: {
        peer_meta: {
          type: "meta-domain",
          peer: { id: "42" },
          qmdCollections: ["alpha-memory"],
        },
        group_meta: {
          type: "meta-domain",
          group: { id: "-1001" },
          qmdCollections: ["alpha-memory"],
        },
      },
    }, null, 2) + "\n");
    mkdirSync(join(workspace, "memory", "domains", "peer_meta"), { recursive: true });
    mkdirSync(join(workspace, "memory", "domains", "group_meta"), { recursive: true });
    const report = auditWorkspace(workspace, { core: false, qmd: false, hooks: false });
    expect(report.findings.filter((f) => f.code === "WD-DOMAIN-004")).toHaveLength(0);
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
    const report = auditWorkspace(workspace, { core: false, qmd: false, hooks: false });
    expect(codes(report)).toContain("WD-DOMAIN-006");
    const finding = report.findings.find((f) => f.code === "WD-DOMAIN-006");
    expect(finding.details.expectedCollection).toBe("domain-child");
  });

  test("warns when meta-domain vertical access has no qmd.collections maintenance allowlist", () => {
    writeFileSync(join(workspace, "memory", "domains", "registry.json"), JSON.stringify({
      domains: {
        general: {
          type: "meta-domain",
          topic: { chatId: "-1001", topicId: "1" },
          qmdCollections: ["alpha-memory", "child-memory"],
        },
      },
    }, null, 2) + "\n");
    mkdirSync(join(workspace, "memory", "domains", "general"), { recursive: true });
    const report = auditWorkspace(workspace, { core: false, qmd: false, hooks: false });
    expect(codes(report)).toContain("WD-QMD-008");
  });

  test("warns when qmd.collections includes vertical child access collections", () => {
    writeFileSync(join(workspace, "engram.json"), JSON.stringify({
      agent: "agent-main",
      qmd: {
        command: "qmd",
        collection: "alpha-memory",
        collections: ["alpha-memory", "alpha-domains", "child-memory"],
      },
      cron: { expectedJobName: "Heartbeat (Engram runner) — alpha" },
    }, null, 2) + "\n");
    writeFileSync(join(workspace, "memory", "domains", "registry.json"), JSON.stringify({
      domains: {
        general: {
          type: "meta-domain",
          topic: { chatId: "-1001", topicId: "1" },
          qmdCollections: ["alpha-memory", "alpha-domains", "child-memory"],
        },
      },
    }, null, 2) + "\n");
    mkdirSync(join(workspace, "memory", "domains", "general"), { recursive: true });
    const report = auditWorkspace(workspace, { core: false, qmd: false, hooks: false });
    expect(codes(report)).toContain("WD-QMD-009");
    const finding = report.findings.find((f) => f.code === "WD-QMD-009");
    expect(finding.details.collections).toEqual(["child-memory"]);
  });

  test("accepts qmd.collections limited to self-owned maintenance collections", () => {
    writeFileSync(join(workspace, "engram.json"), JSON.stringify({
      agent: "agent-main",
      qmd: {
        command: "qmd",
        collection: "alpha-memory",
        collections: ["alpha-memory", "alpha-domains", "domain-general"],
      },
      cron: { expectedJobName: "Heartbeat (Engram runner) — alpha" },
    }, null, 2) + "\n");
    writeFileSync(join(workspace, "memory", "domains", "registry.json"), JSON.stringify({
      domains: {
        general: {
          type: "meta-domain",
          topic: { chatId: "-1001", topicId: "1" },
          qmdCollections: ["alpha-memory", "alpha-domains", "child-memory"],
        },
      },
    }, null, 2) + "\n");
    mkdirSync(join(workspace, "memory", "domains", "general"), { recursive: true });
    const report = auditWorkspace(workspace, { core: false, qmd: false, hooks: false });
    expect(codes(report)).not.toContain("WD-QMD-008");
    expect(codes(report)).not.toContain("WD-QMD-009");
  });

  test("accepts custom-named maintenance collections owned by the audited workspace", () => {
    writeFileSync(join(workspace, "engram.json"), JSON.stringify({
      agent: "agent-alpha",
      qmd: {
        command: "qmd",
        index: "alpha",
        workspaceKgCollection: "alpha-life",
        collections: ["alpha-life", "alpha-outline", "child-topic-memory"],
      },
      cron: { expectedJobName: "Heartbeat (Alpha Engram runner)" },
    }, null, 2) + "\n");
    writeFileSync(join(workspace, "memory", "domains", "registry.json"), JSON.stringify({
      domains: {
        general: {
          type: "meta-domain",
          topic: { chatId: "-1001", topicId: "1" },
          qmdCollections: ["alpha-life", "alpha-outline", "child-topic-memory"],
        },
      },
    }, null, 2) + "\n");
    mkdirSync(join(workspace, "memory", "domains", "general"), { recursive: true });
    mkdirSync(join(workspace, ".qmd"), { recursive: true });
    writeFileSync(join(workspace, ".qmd", "index.yml"), `collections:
  alpha-life:
    path: ${join(workspace, "life")}
    pattern: "**/*.md"
  alpha-outline:
    path: ${join(workspace, "docs")}
    pattern: "**/*.md"
  child-topic-memory:
    path: ${join(workspace, "memory", "agent-alpha", "topic-2")}
    pattern: "**/*.md"
models:
  embed: test
`);

    const report = auditWorkspace(workspace, { core: false, qmd: false, hooks: false });
    expect(codes(report)).not.toContain("WD-QMD-009");
  });

  test("QMD collection listing uses the workspace named index", () => {
    expect(qmdCollectionListArgs({ qmd: { index: "alpha" } })).toEqual([
      "--index", "alpha", "collection", "list",
    ]);
    expect(qmdCollectionListArgs({ qmd: {} })).toEqual(["collection", "list"]);
  });

  test("warns when heartbeat qmd embed can cover only the first configured collection", () => {
    writeFileSync(join(workspace, "engram.json"), JSON.stringify({
      agent: "agent-main",
      qmd: {
        command: "qmd",
        collection: "alpha-memory",
        collections: ["alpha-memory", "life", "alpha-domains"],
      },
      cron: { expectedJobName: "Heartbeat (Engram runner) — alpha" },
    }, null, 2) + "\n");

    const qmdList = `Collections (3):

alpha-memory (qmd://alpha-memory/)
  Files:    3

life (qmd://life/)
  Files:    2

alpha-domains (qmd://alpha-domains/)
  Files:    4
`;
    const report = auditWorkspace(workspace, {
      core: false,
      qmd: true,
      hooks: false,
      qmdListStdout: qmdList,
      qmdCapabilitiesStdout: JSON.stringify({ schema: "qmd.capabilities.v1", embed: { multipleCollections: false } }),
    });
    const finding = report.findings.find((f) => f.code === "WD-QMD-014");
    expect(finding).toBeTruthy();
    expect(finding.details).toEqual({
      embeddedCollection: "alpha-memory",
      uncoveredCollections: ["life", "alpha-domains"],
      configuredCollections: ["alpha-memory", "life", "alpha-domains"],
      capabilitySchema: "qmd.capabilities.v1",
      multipleCollections: false,
    });
  });

  test("accepts multiple heartbeat collections when QMD reports support", () => {
    writeFileSync(join(workspace, "engram.json"), JSON.stringify({
      agent: "agent-main",
      qmd: { collections: ["alpha-memory", "life", "alpha-domains"] },
    }, null, 2) + "\n");
    const qmdList = ["alpha-memory", "life", "alpha-domains"]
      .map((name) => `${name} (qmd://${name}/)\n  Files:    1`)
      .join("\n\n");

    const report = auditWorkspace(workspace, {
      core: false,
      qmd: true,
      hooks: false,
      qmdListStdout: `Collections (3):\n\n${qmdList}\n`,
      qmdCapabilitiesStdout: JSON.stringify({
        schema: "qmd.capabilities.v1",
        embed: { multipleCollections: true, indexScopedLock: true, structuredOutput: true },
      }),
    });
    expect(codes(report)).not.toContain("WD-QMD-014");
  });

  test("does not warn about qmd embed coverage for a single maintenance collection", () => {
    writeFileSync(join(workspace, "engram.json"), JSON.stringify({
      agent: "agent-main",
      qmd: {
        command: "qmd",
        collection: "alpha-memory",
        collections: ["alpha-memory"],
      },
      cron: { expectedJobName: "Heartbeat (Engram runner) — alpha" },
    }, null, 2) + "\n");

    const qmdList = `Collections (1):

alpha-memory (qmd://alpha-memory/)
  Files:    3
`;
    const report = auditWorkspace(workspace, { core: false, qmd: true, hooks: false, qmdListStdout: qmdList });
    expect(codes(report)).not.toContain("WD-QMD-014");
  });

  test("QMD parser captures path, pattern, and zero-file collections", () => {
    const parsed = parseQmdCollections(`Collections (2):

alpha (qmd://alpha/)
  Path:     /srv/openclaw/workspaces/main/memory/agent-main/main
  Pattern:  **/*.md
  Files:    3

empty-domain (qmd://empty-domain/)
  Path:     /srv/openclaw/workspaces/main/memory/domains/empty
  Pattern:  **/*.md
  Files:    0
`);
    expect(parsed.get("alpha").path).toBe("/srv/openclaw/workspaces/main/memory/agent-main/main");
    expect(parsed.get("alpha").pattern).toBe("**/*.md");
    expect(parsed.get("alpha").files).toBe(3);
    expect(parsed.get("empty-domain").files).toBe(0);
  });

  test("QMD index parser is workspace-path agnostic", () => {
    const parsed = parseQmdIndexCollections(`version: 1
collections:
  domain-main:
    path: /var/lib/openclaw/workspaces/main/memory/domains/main
    pattern: "**/*.md"
  root-scan:
    path: D:\\OpenClaw\\workspaces\\main
    pattern: '**/*.md'
models:
  embedding: test
`);
    expect(parsed.get("domain-main")).toEqual({
      path: "/var/lib/openclaw/workspaces/main/memory/domains/main",
      pattern: "**/*.md",
    });
    expect(parsed.get("root-scan")).toEqual({
      path: "D:\\OpenClaw\\workspaces\\main",
      pattern: "**/*.md",
    });
  });

  test("detects heartbeat-state/session drift", () => {
    mkdirSync(join(workspace, "memory", "agent-main", "telegram-group--100-topic-7"), { recursive: true });
    writeFileSync(join(workspace, "memory", "heartbeat-state.json"), JSON.stringify({
      lastDailyNoteCreated: { main: "2026-07-15", ghost: "2026-07-15" },
    }, null, 2) + "\n");
    const report = auditWorkspace(workspace, { core: false, qmd: false, hooks: false });
    expect(codes(report)).toContain("WD-SESSION-001");
    expect(codes(report)).toContain("WD-SESSION-002");
  });

  test("ephemeral session dirs (cron-*-run-*, subagent-*) are not flagged", () => {
    mkdirSync(join(workspace, "memory", "agent-main", "cron-abc-123-run-def"), { recursive: true });
    mkdirSync(join(workspace, "memory", "agent-main", "subagent-xyz"), { recursive: true });
    const report = auditWorkspace(workspace, { core: false, qmd: false, hooks: false });
    expect(codes(report)).not.toContain("WD-SESSION-001");
  });


  test("detects missing runtime hooks when hook drift check is enabled", () => {
    const hooksDir = join(workspace, "runtime-hooks");
    mkdirSync(hooksDir, { recursive: true });
    const report = auditWorkspace(workspace, { core: false, qmd: false, hooksDir });
    expect(codes(report)).toContain("WD-HOOK-001");
  });

  test("detects KG v2 schema errors and test pollution", () => {
    mkdirSync(join(workspace, "life", "projects", "test-project"), { recursive: true });
    writeFileSync(join(workspace, "life", "projects", "test-project", "items.json"), JSON.stringify({
      entityId: "projects/test-project",
      entityType: "project",
      facts: [{ id: "bad", title: "Old", content: "test fixture", category: "technical", tags: ["test"] }],
    }, null, 2) + "\n");
    const report = auditWorkspace(workspace, { core: false, qmd: false, hooks: false });
    expect(report.status).toBe("error");
    expect(codes(report)).toContain("WD-KG-001");
    expect(codes(report)).toContain("WD-KG-002");
    expect(codes(report)).toContain("WD-KG-003");
    expect(codes(report)).toContain("WD-KG-004");
  });

  test("detects generated runtime artifacts inside the Engram skill repo", () => {
    const skillDir = join(workspace, "synthetic-skill");
    mkdirSync(join(skillDir, "memory", "agent-main", "main"), { recursive: true });
    mkdirSync(join(skillDir, "memory", "domains", "smoke"), { recursive: true });
    mkdirSync(join(skillDir, "life", "_derived"), { recursive: true });
    mkdirSync(join(skillDir, "workspace", "ops", "watchdog"), { recursive: true });
    const report = auditWorkspace(workspace, { core: false, qmd: false, hooks: false, skillDir });
    const artifactFindings = report.findings.filter((f) => f.code === "WD-ARTIFACT-001");
    expect(artifactFindings.map((f) => f.path).sort()).toEqual([
      "skill:life/_derived",
      "skill:memory/agent-main",
      "skill:memory/domains",
      "skill:workspace/ops/watchdog",
    ]);
    expect(artifactFindings.every((f) => !JSON.stringify(f.details || {}).includes(skillDir))).toBe(true);
  });

  test("detects QMD path guardrails without treating stale index entries as live collections", () => {
    mkdirSync(join(workspace, ".qmd"), { recursive: true });
    mkdirSync(join(workspace, "memory", "domains", "main"), { recursive: true });
    mkdirSync(join(workspace, "memory", "domains", "empty"), { recursive: true });
    writeFileSync(join(workspace, "memory", "domains", "registry.json"), JSON.stringify({
      domains: {
        main: { type: "dev-project", qmdCollections: ["domain-main"] },
        ghost: { type: "dev-project", qmdCollections: ["domain-ghost"] },
      },
    }, null, 2) + "\n");
    writeFileSync(join(workspace, ".qmd", "index.yml"), `version: 1
collections:
  alpha-memory:
    path: ./memory/agent-main/main
    pattern: "**/*.md"
  domain-main:
    path: ./domain-main
    pattern: "**/*.md"
  domain-ghost:
    path: ./memory/domains/ghost
    pattern: "**/*.md"
  domain-empty:
    path: ./memory/domains/empty
    pattern: "**/*.md"
  root-scan:
    path: .
    pattern: "**/*"
  outside:
    path: ../outside
    pattern: "**/*.md"
models: {}
`);
    const qmdList = `Collections (5):

alpha-memory (qmd://alpha-memory/)
  Pattern:  **/*.md
  Files:    1

domain-main (qmd://domain-main/)
  Pattern:  **/*.md
  Files:    3

domain-empty (qmd://domain-empty/)
  Pattern:  **/*.md
  Files:    0

root-scan (qmd://root-scan/)
  Pattern:  **/*
  Files:    99

outside (qmd://outside/)
  Pattern:  **/*.md
  Files:    1
`;
    const report = auditWorkspace(workspace, { core: false, qmd: true, hooks: false, qmdListStdout: qmdList });
    expect(codes(report)).toContain("WD-QMD-001");
    expect(codes(report)).toContain("WD-QMD-010");
    expect(codes(report)).toContain("WD-QMD-011");
    expect(codes(report)).toContain("WD-QMD-012");
    expect(codes(report)).toContain("WD-QMD-013");
    const missing = report.findings.find((f) => f.code === "WD-QMD-001" && f.details?.collection === "domain-ghost");
    expect(missing).toBeTruthy();
    const empty = report.findings.find((f) => f.code === "WD-QMD-012");
    expect(empty.level).toBe("info");
    const mismatch = report.findings.find((f) => f.code === "WD-QMD-010");
    expect(mismatch.details.actualPath).toBe("domain-main");
  });

  test("allows external QMD paths explicitly declared by a meta-domain", () => {
    mkdirSync(join(workspace, ".qmd"), { recursive: true });
    mkdirSync(join(workspace, "memory", "domains", "general"), { recursive: true });
    writeFileSync(join(workspace, "memory", "domains", "registry.json"), JSON.stringify({
      domains: {
        general: {
          type: "meta-domain",
          peer: { id: "42" },
          qmdCollections: ["child-memory", "domain-child"],
        },
      },
    }, null, 2) + "\n");
    writeFileSync(join(workspace, ".qmd", "index.yml"), `version: 1
collections:
  child-memory:
    path: ../child/memory/agent-child/main
    pattern: "**/*.md"
  domain-child:
    path: ../child/memory/domains/child
    pattern: "**/*.md"
  undeclared:
    path: ../undeclared
    pattern: "**/*.md"
models: {}
`);
    const qmdList = `Collections (3):

child-memory (qmd://child-memory/)
  Files:    1

domain-child (qmd://domain-child/)
  Files:    1

undeclared (qmd://undeclared/)
  Files:    1
`;
    const report = auditWorkspace(workspace, { core: false, qmd: true, hooks: false, qmdListStdout: qmdList });
    const external = report.findings.filter((f) => f.code === "WD-QMD-013");
    expect(external.map((f) => f.details.collection)).toEqual(["undeclared"]);
    expect(report.findings.some((f) => f.code === "WD-QMD-010" && f.details.collection === "domain-child")).toBe(false);
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
    const report = auditWorkspace(workspace, { core: false, qmd: false, hooks: false });
    const pollution = report.findings.filter((f) => f.code === "WD-KG-004" && f.path?.includes("qmd-config"));
    expect(pollution).toHaveLength(0);
  });
});

describe("watchdog CLI", () => {
  test("--json prints structured report and returns 0 for clean workspace", () => {
    const r = runCli(["--workspace", workspace, "--json", "--no-core", "--no-qmd", "--no-hooks"]);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.schema).toBe("engram.watchdog.v1");
    expect(out.summary.readOnly).toBe(true);
  });

  test("warnings-only exits 2 by default and 0 with --exit-zero-on-warn", () => {
    mkdirSync(join(workspace, "memory", "domains", "orphan"), { recursive: true });
    const strict = runCli(["--workspace", workspace, "--json", "--no-core", "--no-qmd", "--no-hooks"]);
    expect(strict.status).toBe(2);
    const cron = runCli(["--workspace", workspace, "--json", "--no-core", "--no-qmd", "--no-hooks", "--exit-zero-on-warn"]);
    expect(cron.status).toBe(0);
  });

  test("merges global QMD registry scope violations into the read-only report", () => {
    const registry = join(workspace, "qmd-registry.json");
    writeFileSync(registry, JSON.stringify({
      schema: "engram.qmd.global-registry.v1",
      index: { name: "engram-global" },
      workspaces: [
        { id: "main", path: workspace, kind: "technical", parents: [], readableCollections: ["main-memory", "client-memory"] },
        { id: "client", path: join(workspace, "client"), kind: "business", parents: [], readableCollections: ["client-memory"] },
      ],
      collections: [
        { name: "main-memory", path: join(workspace, "memory"), owner: "main", mask: "**/*.md" },
        { name: "client-memory", path: join(workspace, "client", "memory"), owner: "client", mask: "**/*.md" },
      ],
    }));
    mkdirSync(join(workspace, "client", "memory"), { recursive: true });

    const r = runCli([
      "--workspace", workspace,
      "--qmd-registry", registry,
      "--json", "--no-core", "--no-qmd", "--no-hooks",
    ]);
    expect(r.status).toBe(1);
    const out = JSON.parse(r.stdout);
    expect(codes(out)).toContain("WD-QMD-REGISTRY-TECHNICAL_SCOPE_ESCAPE");
  });

  test("repeated --workspace audits only the selected workspaces", () => {
    const root = mkdtempSync(join(tmpdir(), "engram-watchdog-multi-"));
    try {
      const selectedMain = join(root, "main");
      const selectedSecondary = join(root, "secondary");
      const notSelected = join(root, "other");
      createCleanWorkspace(selectedMain, { agent: "agent-main", project: "main" });
      createCleanWorkspace(selectedSecondary, { agent: "agent-secondary", project: "secondary" });
      createCleanWorkspace(notSelected, { agent: "agent-other", project: "other" });

      const r = runCli([
        "--workspace", selectedMain,
        "--workspace", selectedSecondary,
        "--workspace", selectedMain,
        "--json",
        "--no-core",
        "--no-qmd",
        "--no-hooks",
      ]);

      expect(r.status).toBe(0);
      const out = JSON.parse(r.stdout);
      expect(out.summary.workspaces).toBe(2);
      expect(out.reports.map((report) => report.workspace).sort()).toEqual([
        resolve(selectedMain),
        resolve(selectedSecondary),
      ].sort());
      expect(out.reports.some((report) => report.workspace === resolve(notSelected))).toBe(false);
      expect(out.reports.every((report) => report.summary.readOnly && report.status === "ok")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("requires explicit workspaces-dir for --all", () => {
    const r = runCli(["--all", "--json", "--no-core", "--no-qmd"]);
    expect(r.status).toBe(3);
    expect(r.stderr).toContain("--all requires");
  });
});
