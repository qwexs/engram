import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [];

function temp(): string {
  const value = mkdtempSync(join(tmpdir(), "engram-registry-cli-"));
  roots.push(value);
  return value;
}

async function run(args: string[]) {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "qmd-global-registry-audit.ts"), ...args], {
    env: { ...process.env, PATH: "/nonexistent" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("qmd-global-registry-audit CLI", () => {
  test("validates a clean registry without any external QMD executable", async () => {
    const root = temp();
    const workspace = join(root, "main");
    mkdirSync(join(workspace, "memory"), { recursive: true });
    const registry = join(root, "registry.json");
    writeFileSync(registry, JSON.stringify({
      schema: "engram.qmd.global-registry.v1",
      index: { name: "engram-global" },
      workspaces: [{
        id: "main",
        path: workspace,
        kind: "technical",
        parents: [],
        readableCollections: ["main-memory"],
      }],
      collections: [{
        name: "main-memory",
        path: join(workspace, "memory"),
        owner: "main",
        mask: "**/*.md",
      }],
    }));

    const result = await run(["--registry", registry, "--json"]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, registry: { ok: true } });
    expect(result.stderr).toBe("");
  });

  test("returns exit 2 with exact legacy collision names", async () => {
    const root = temp();
    const workspacePaths = ["one", "two"].map((name) => {
      const workspace = join(root, name);
      mkdirSync(workspace);
      writeFileSync(join(workspace, "engram.json"), JSON.stringify({
        qmd: { collections: [`${name}-memory`, "life", "ops"] },
      }));
      return workspace;
    });

    const result = await run([
      "--workspace", workspacePaths[0]!,
      "--workspace", workspacePaths[1]!,
      "--json",
    ]);
    expect(result.exitCode).toBe(2);
    const output = JSON.parse(result.stdout);
    expect(output.ok).toBe(false);
    expect(output.legacy.findings.map((entry: any) => entry.details.collection)).toEqual(["life", "ops"]);
  });
});
