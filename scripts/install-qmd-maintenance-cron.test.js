import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const script = "scripts/install-qmd-maintenance-cron.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "engram-qmd-cron-"));
  const workspace = join(root, "workspace");
  const manifest = join(root, "manifest.json");
  Bun.write(join(workspace, "engram.json"), JSON.stringify({ agent: "main" }));
  writeFileSync(manifest, JSON.stringify({ schema: "test" }));
  return { workspace, manifest };
}

describe("install-qmd-maintenance-cron", () => {
  test("prints a command payload, never an agent turn", async () => {
    const { workspace, manifest } = fixture();
    const result = Bun.spawnSync([
      "bun", script, "--dry-run", "--workspace", workspace, "--manifest", manifest,
    ], { stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).toBe(0);
    const spec = JSON.parse(new TextDecoder().decode(result.stdout));
    expect(spec.payload).toMatchObject({
      kind: "command",
      cwd: workspace,
      timeoutSeconds: 660,
    });
    expect(spec.payload.argv).toEqual([
      "bun",
      "./skills/engram/scripts/qmd-maintenance-coordinator.ts",
      "--manifest", manifest,
      "--workspace", workspace,
      "--timeout-ms", "600000",
    ]);
    expect(spec.schedule).toEqual({ kind: "cron", expr: "33 * * * *", tz: "UTC", staggerMs: 0 });
    expect(spec.payload.kind).not.toBe("agentTurn");
  });
});
