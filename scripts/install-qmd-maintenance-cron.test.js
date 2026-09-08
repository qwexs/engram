import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const script = "scripts/install-qmd-maintenance-cron.js";

function fixture(workspaceName = "workspace") {
  const root = mkdtempSync(join(tmpdir(), "engram-qmd-cron-"));
  const workspace = join(root, workspaceName);
  const manifest = join(root, "manifest.json");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "engram.json"), JSON.stringify({ agent: "main" }));
  writeFileSync(manifest, JSON.stringify({
    schema: "engram.qmd.global-migration.v1",
    registry: { schema: "engram.qmd.global-registry.v1", index: { name: "test" }, workspaces: [], collections: [] },
  }));
  return { workspace, manifest };
}

describe("install-qmd-maintenance-cron", () => {
  test("prints a protected agent payload that waits for the coordinator", async () => {
    const { workspace, manifest } = fixture();
    const result = Bun.spawnSync([
      "bun", script, "--dry-run", "--workspace", workspace, "--manifest", manifest,
    ], { stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).toBe(0);
    const spec = JSON.parse(new TextDecoder().decode(result.stdout));
    expect(spec.payload).toMatchObject({
      kind: "agentTurn",
      timeoutSeconds: 660,
      toolsAllow: ["exec", "process"],
    });
    expect(spec.payload.message).toContain("qmd-maintenance-coordinator.ts");
    expect(spec.payload.message).toContain(`'${manifest}'`);
    expect(spec.payload.message).toContain(JSON.stringify(workspace));
    expect(spec.payload.message).toContain("process polling");
    expect(spec.payload.message).toContain("Do not inspect environment variables or secrets");
    expect(spec.schedule).toEqual({ kind: "cron", expr: "33 * * * *", tz: "UTC", staggerMs: 0 });
  });

  test("preserves literal shell metacharacters in coordinator paths", () => {
    const { workspace, manifest } = fixture("work space ' $(printf substituted) `printf substituted` $USER");
    const result = Bun.spawnSync([
      "bun", script, "--dry-run", "--workspace", workspace, "--manifest", manifest,
    ], { stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).toBe(0);
    const spec = JSON.parse(new TextDecoder().decode(result.stdout));
    const command = spec.payload.message.match(/for command (.*), cwd /)[1];
    const parsed = Bun.spawnSync([
      "bash", "-c", `set -- ${command}; printf '%s\\0' "$@"`,
    ], { stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH, USER: "test-user" } });
    expect(parsed.exitCode).toBe(0);
    expect(new TextDecoder().decode(parsed.stdout).split("\0").slice(0, -1)).toEqual([
      "bun", "./skills/engram/scripts/qmd-maintenance-coordinator.ts",
      "--manifest", manifest, "--workspace", workspace, "--timeout-ms", "600000",
    ]);
  });

  test("rejects a scheduler declaration that is not a maintenance registry", async () => {
    const { workspace, manifest } = fixture();
    writeFileSync(manifest, JSON.stringify({ schema: "engram.qmd.global-maintenance-scheduler.v1" }));
    const result = Bun.spawnSync([
      "bun", script, "--dry-run", "--workspace", workspace, "--manifest", manifest,
    ], { stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).toBe(2);
    expect(new TextDecoder().decode(result.stderr)).toContain("global-registry");
  });
});
