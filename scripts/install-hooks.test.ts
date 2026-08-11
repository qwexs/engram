import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const skill = join(import.meta.dir, "..");
const installer = join(import.meta.dir, "install-hooks.js");
const roots: string[] = [];

function target(): string {
  const root = mkdtempSync(join(tmpdir(), "engram-install-hooks-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("install-hooks mutation boundary", () => {
  test("existing hook without --force is byte-stable and creates no backup", () => {
    const hooks = target();
    const existing = join(hooks, "engram-daily-note");
    mkdirSync(existing, { recursive: true });
    writeFileSync(join(existing, "handler.js"), "operator-owned-current\n");
    writeFileSync(join(existing, "HOOK.md"), "current metadata\n");
    const beforeHandler = readFileSync(join(existing, "handler.js"), "utf8");
    const beforeMetadata = readFileSync(join(existing, "HOOK.md"), "utf8");

    const result = spawnSync("bun", [installer, "--skill-dir", skill, "--hooks-dir", hooks], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("no files were moved or replaced");
    expect(readFileSync(join(existing, "handler.js"), "utf8")).toBe(beforeHandler);
    expect(readFileSync(join(existing, "HOOK.md"), "utf8")).toBe(beforeMetadata);
    expect(readdirSync(hooks).some((name) => name.startsWith("_pre-install-"))).toBe(false);
  });

  test("--force backs up existing bytes and installs the complete nine-hook set", () => {
    const hooks = target();
    const existing = join(hooks, "engram-daily-note");
    mkdirSync(existing, { recursive: true });
    writeFileSync(join(existing, "handler.js"), "operator-owned-current\n");
    writeFileSync(join(existing, "HOOK.md"), "current metadata\n");

    const result = spawnSync("bun", [installer, "--skill-dir", skill, "--hooks-dir", hooks, "--force"], { encoding: "utf8" });
    expect(result.status, result.stderr || result.stdout).toBe(0);
    const installed = readdirSync(hooks).filter((name) => name.startsWith("engram-")).sort();
    expect(installed).toHaveLength(9);
    expect(installed).toContain("engram-rule-context-load");
    expect(existsSync(join(hooks, "engram-rule-context-load", "handler.js"))).toBe(true);
    const backup = readdirSync(hooks).find((name) => name.startsWith("_pre-install-"));
    expect(backup).toBeDefined();
    expect(readFileSync(join(hooks, backup!, "engram-daily-note", "handler.js"), "utf8")).toBe("operator-owned-current\n");
  });
});
