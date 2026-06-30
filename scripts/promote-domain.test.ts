#!/usr/bin/env bun
// Tests for promote-domain.js — covers CLI parsing, error states, pending/--force
// semantics, idempotency, and --refresh-templates per type.
//
// Run:  bun test scripts/promote-domain.test.ts

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const SCRIPT = join(import.meta.dir, "promote-domain.js");

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "promote-test-"));
  mkdirSync(join(workspace, "memory", "domains"), { recursive: true });
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

interface DomainOpts {
  pending?: boolean;
  type?: "dev-project" | "cron-task" | "topic-thread";
  topic?: { chatId: string; topicId: number };
  kgEntity?: string;
  created?: string;
  description?: string;
}

function setupDomain(slug: string, opts: DomainOpts = {}) {
  const domainDir = join(workspace, "memory", "domains", slug);
  mkdirSync(domainDir, { recursive: true });
  writeFileSync(join(domainDir, "README.md"), `# ${slug}\n`);
  const entry: Record<string, unknown> = {
    type: opts.type ?? "topic-thread",
    created: opts.created ?? new Date().toISOString().split("T")[0],
    description: opts.description ?? `Test domain ${slug}`,
  };
  if (opts.pending) entry.pending = true;
  if (opts.topic) entry.topic = opts.topic;
  if (opts.kgEntity) entry.kgEntity = opts.kgEntity;
  const registry = { domains: { [slug]: entry } };
  writeFileSync(
    join(workspace, "memory", "domains", "registry.json"),
    JSON.stringify(registry, null, 2) + "\n",
  );
  return entry;
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

function readRegistry() {
  return JSON.parse(
    readFileSync(join(workspace, "memory", "domains", "registry.json"), "utf-8"),
  );
}

const TODAY = new Date().toISOString().split("T")[0];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

describe("promote-domain — CLI parsing", () => {
  test("--help exits 0 and contains usage", () => {
    const r = runScript(["--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("promote-domain");
    expect(r.stdout).toContain("--domain");
    expect(r.stdout).toContain("--refresh-templates");
    expect(r.stdout).toContain("--refresh-qmd");
    expect(r.stdout).toContain("--force");
  });

  test("no args exits 1 (missing --domain)", () => {
    const r = runScript([]);
    expect(r.status).toBe(1);
  });

  test("invalid domain name (uppercase) exits 1", () => {
    const r = runScript(["--domain", "Foo"]);
    expect(r.status).toBe(1);
    expect(r.stderr + r.stdout).toMatch(/Имя домена|domain name/i);
  });

  test("invalid domain name (underscore) exits 1", () => {
    const r = runScript(["--domain", "foo_bar"]);
    expect(r.status).toBe(1);
  });
});

describe("promote-domain — error cases", () => {
  test("domain does not exist exits 1", () => {
    const r = runScript(["--domain", "ghost"]);
    expect(r.status).toBe(1);
    expect(r.stderr + r.stdout).toContain("не найден");
  });

  test("domain dir exists but registry has no entry exits 1", () => {
    // Create the dir + README so the "exists" check passes, but skip the registry entry.
    const domainDir = join(workspace, "memory", "domains", "lonely");
    mkdirSync(domainDir, { recursive: true });
    writeFileSync(join(domainDir, "README.md"), "# lonely\n");
    writeFileSync(
      join(workspace, "memory", "domains", "registry.json"),
      JSON.stringify({ domains: {} }) + "\n",
    );
    const r = runScript(["--domain", "lonely"]);
    expect(r.status).toBe(1);
    expect(r.stderr + r.stdout).toContain("не найден в registry");
  });

  test("corrupt registry JSON exits 1", () => {
    const domainDir = join(workspace, "memory", "domains", "x");
    mkdirSync(domainDir, { recursive: true });
    writeFileSync(join(domainDir, "README.md"), "# x\n");
    writeFileSync(
      join(workspace, "memory", "domains", "registry.json"),
      "{not valid json",
    );
    const r = runScript(["--domain", "x"]);
    expect(r.status).toBe(1);
    expect(r.stderr + r.stdout).toContain("registry.json");
  });

  test("registry.domains as array exits 1 (schema guard)", () => {
    const domainDir = join(workspace, "memory", "domains", "x");
    mkdirSync(domainDir, { recursive: true });
    writeFileSync(join(domainDir, "README.md"), "# x\n");
    writeFileSync(
      join(workspace, "memory", "domains", "registry.json"),
      JSON.stringify({ domains: [] }) + "\n",
    );
    const r = runScript(["--domain", "x"]);
    expect(r.status).toBe(1);
    expect(r.stderr + r.stdout).toContain("повреждён");
  });
});

describe("promote-domain — pending semantics", () => {
  test("pending=true base case clears pending and sets promotedAt", () => {
    setupDomain("foo", { pending: true, type: "topic-thread" });
    const r = runScript(["--domain", "foo"]);
    expect(r.status).toBe(0);
    const reg = readRegistry();
    expect(reg.domains.foo.pending).toBeUndefined();
    expect(reg.domains.foo.promotedAt).toBe(TODAY);
    expect(r.stdout).toContain("pending снят");
  });

  test("pending=false without --force exits 1", () => {
    setupDomain("foo", { pending: false, type: "topic-thread" });
    const r = runScript(["--domain", "foo"]);
    expect(r.status).toBe(1);
    expect(r.stderr + r.stdout).toMatch(/не в статусе pending/);
    // Registry must be untouched
    const reg = readRegistry();
    expect(reg.domains.foo.promotedAt).toBeUndefined();
  });

  test("pending=false with --force succeeds and sets promotedAt", () => {
    setupDomain("foo", { pending: false, type: "topic-thread" });
    const r = runScript(["--domain", "foo", "--force"]);
    expect(r.status).toBe(0);
    const reg = readRegistry();
    expect(reg.domains.foo.promotedAt).toBe(TODAY);
    expect(r.stdout).toContain("force");
  });

  test("idempotency: second call without --force exits 1", () => {
    setupDomain("foo", { pending: true, type: "topic-thread" });
    const r1 = runScript(["--domain", "foo"]);
    expect(r1.status).toBe(0);
    // After first call, pending is gone but registry still has the entry.
    const r2 = runScript(["--domain", "foo"]);
    expect(r2.status).toBe(1);
    expect(r2.stderr + r2.stdout).toMatch(/не в статусе pending/);
  });
});

describe("promote-domain — --refresh-templates", () => {
  test("topic-thread writes agents.md, skips workflow.md", () => {
    setupDomain("engram", {
      pending: true,
      type: "topic-thread",
      topic: { chatId: "1001234567890", topicId: 42 },
      kgEntity: "projects/engram",
    });
    const r = runScript(["--domain", "engram", "--refresh-templates"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Перезаписываю шаблоны");
    const domainDir = join(workspace, "memory", "domains", "engram");
    expect(existsSync(join(domainDir, "agents.md"))).toBe(true);
    expect(existsSync(join(domainDir, "workflow.md"))).toBe(false);
    expect(existsSync(join(domainDir, "decisions.md"))).toBe(true);
    expect(existsSync(join(domainDir, "status.md"))).toBe(true);
    expect(existsSync(join(domainDir, "changelog.md"))).toBe(true);
    expect(existsSync(join(domainDir, "README.md"))).toBe(true);
  });

  test("dev-project writes workflow.md, skips agents.md", () => {
    setupDomain("monorepo", { pending: true, type: "dev-project" });
    const r = runScript(["--domain", "monorepo", "--refresh-templates"]);
    expect(r.status).toBe(0);
    const domainDir = join(workspace, "memory", "domains", "monorepo");
    expect(existsSync(join(domainDir, "workflow.md"))).toBe(true);
    expect(existsSync(join(domainDir, "agents.md"))).toBe(false);
  });

  test("topic-thread with entry.topic substitutes placeholders into agents.md", () => {
    setupDomain("engram", {
      pending: true,
      type: "topic-thread",
      topic: { chatId: "1001234567890", topicId: 42 },
      kgEntity: "projects/engram",
    });
    const r = runScript(["--domain", "engram", "--refresh-templates"]);
    expect(r.status).toBe(0);
    const agents = readFileSync(
      join(workspace, "memory", "domains", "engram", "agents.md"),
      "utf-8",
    );
    // ChatId with leading "-" form is preserved in the topic entry; the template
    // uses {{CHAT_ID}} for the raw stored value, and {{SESSION_KEY}} derives the
    // absolute form. The fixture stores positive "1001234567890" so both
    // CHAT_ID and SESSION_KEY embed the same number.
    expect(agents).not.toContain("{{CHAT_ID}}");
    expect(agents).not.toContain("{{TOPIC_ID}}");
    expect(agents).not.toContain("{{SESSION_KEY}}");
    expect(agents).toContain("1001234567890");
    expect(agents).toContain("42");
    expect(agents).not.toContain("{{DOMAIN}}");
    expect(agents).not.toContain("{{KG_ENTITY_DISPLAY}}");
  });
});
