#!/usr/bin/env bun
// Tests for list-pending.js — covers CLI parsing, error states, filtering
// (--all, --type), and JSON output shape.
//
// Run:  bun test scripts/list-pending.test.ts

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const SCRIPT = join(import.meta.dir, "list-pending.js");

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "listpending-test-"));
  mkdirSync(join(workspace, "memory", "domains"), { recursive: true });
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

interface FixtureEntry {
  pending?: boolean;
  type?: "dev-project" | "cron-task" | "topic-thread";
  created?: string;
  description?: string;
  topic?: { chatId: string; topicId: number };
  kgEntity?: string;
}

function setupRegistry(entries: Record<string, FixtureEntry>) {
  const domains: Record<string, Record<string, unknown>> = {};
  for (const [name, opts] of Object.entries(entries)) {
    const entry: Record<string, unknown> = {
      type: opts.type ?? "topic-thread",
      created: opts.created ?? "2026-06-01",
      description: opts.description ?? `Test ${name}`,
    };
    if (opts.pending) entry.pending = true;
    if (opts.topic) entry.topic = opts.topic;
    if (opts.kgEntity) entry.kgEntity = opts.kgEntity;
    domains[name] = entry;
  }
  writeFileSync(
    join(workspace, "memory", "domains", "registry.json"),
    JSON.stringify({ domains }) + "\n",
  );
}

function runScript(args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync("bun", [SCRIPT, ...args], {
    cwd: workspace,
    encoding: "utf-8",
  });
  return {
    status: r.status ?? -1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}

describe("list-pending — CLI / errors", () => {
  test("--help exits 0 and contains usage", () => {
    const r = runScript(["--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("list-pending");
    expect(r.stdout).toContain("--all");
    expect(r.stdout).toContain("--type");
    expect(r.stdout).toContain("--json");
  });

  test("missing registry.json exits 0 with empty message", () => {
    // No setupRegistry call → no registry.json on disk.
    const r = runScript([]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("registry.json не найден");
  });

  test("corrupt registry JSON exits 1", () => {
    writeFileSync(
      join(workspace, "memory", "domains", "registry.json"),
      "{not valid",
    );
    const r = runScript([]);
    expect(r.status).toBe(1);
  });

  test("registry.domains as array exits 1 (schema guard)", () => {
    writeFileSync(
      join(workspace, "memory", "domains", "registry.json"),
      JSON.stringify({ domains: [] }) + "\n",
    );
    const r = runScript([]);
    expect(r.status).toBe(1);
  });
});

describe("list-pending — filtering", () => {
  test("empty registry prints 'no pending' message", () => {
    setupRegistry({});
    const r = runScript([]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("нет pending доменов");
  });

  test("singular pluralization (1 domain)", () => {
    setupRegistry({ alpha: { pending: true } });
    const r = runScript([]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/1 pending-домен:/);
  });

  test("pluralization 2..4 (uses 'pending-домена' form)", () => {
    setupRegistry({
      a: { pending: true },
      b: { pending: true },
      c: { pending: true },
    });
    const r = runScript([]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/3 pending-домен[а-я]*/);
    // The script uses < 5 to pick the "a" suffix form.
    expect(r.stdout).toContain("3 pending-домена");
  });

  test("pluralization 5+ (uses 'pending-доменов' form)", () => {
    setupRegistry({
      a: { pending: true },
      b: { pending: true },
      c: { pending: true },
      d: { pending: true },
      e: { pending: true },
    });
    const r = runScript([]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("5 pending-доменов");
  });

  test("without --all, only pending entries are shown", () => {
    setupRegistry({
      pending1: { pending: true, type: "topic-thread" },
      active1: { pending: false, type: "topic-thread" },
      active2: { pending: false, type: "dev-project" },
    });
    const r = runScript([]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("pending1");
    expect(r.stdout).not.toContain("active1");
    expect(r.stdout).not.toContain("active2");
  });

  test("--all shows pending and active entries", () => {
    setupRegistry({
      pending1: { pending: true, type: "topic-thread" },
      active1: { pending: false, type: "topic-thread" },
      active2: { pending: false, type: "dev-project" },
    });
    const r = runScript(["--all"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("pending1");
    expect(r.stdout).toContain("active1");
    expect(r.stdout).toContain("active2");
  });
});

describe("list-pending — --type filter", () => {
  test("--type topic-thread returns only topic-thread", () => {
    setupRegistry({
      tt1: { pending: true, type: "topic-thread" },
      dp1: { pending: true, type: "dev-project" },
      ct1: { pending: true, type: "cron-task" },
    });
    const r = runScript(["--type", "topic-thread"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("tt1");
    expect(r.stdout).not.toContain("dp1");
    expect(r.stdout).not.toContain("ct1");
  });

  test("--type combined with --all returns all of that type", () => {
    setupRegistry({
      tt_pending: { pending: true, type: "topic-thread" },
      tt_active: { pending: false, type: "topic-thread" },
      dp_active: { pending: false, type: "dev-project" },
    });
    const r = runScript(["--all", "--type", "topic-thread"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("tt_pending");
    expect(r.stdout).toContain("tt_active");
    expect(r.stdout).not.toContain("dp_active");
  });
});

describe("list-pending — JSON output", () => {
  test("--json returns structured object with expected fields", () => {
    setupRegistry({
      alpha: {
        pending: true,
        type: "topic-thread",
        topic: { chatId: "1001234567890", topicId: 7 },
        kgEntity: "projects/alpha",
        created: "2026-06-15",
      },
    });
    const r = runScript(["--json"]);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(Array.isArray(out)).toBe(true);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      name: "alpha",
      pending: true,
      type: "topic-thread",
      topic: "1001234567890:7",
      kgEntity: "projects/alpha",
      created: "2026-06-15",
    });
    expect(typeof out[0].ageDays).toBe("number");
    expect(out[0].ageDays).toBeGreaterThanOrEqual(0);
  });

  test("--json with no matches returns []", () => {
    setupRegistry({ active: { pending: false } });
    const r = runScript(["--json"]);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("[]");
  });

  test("--json: ageDays is null when created is missing", () => {
    setupRegistry({ alpha: { pending: true } });
    // Strip the "created" field post-setup.
    const regPath = join(workspace, "memory", "domains", "registry.json");
    const reg = JSON.parse(readFileSync(regPath, "utf-8"));
    delete reg.domains.alpha.created;
    writeFileSync(regPath, JSON.stringify(reg) + "\n");
    const r = runScript(["--json"]);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out[0].ageDays).toBeNull();
    expect(out[0].created).toBeNull();
  });
});
