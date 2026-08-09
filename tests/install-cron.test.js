import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const SKILL_DIR = join(import.meta.dir, "..");
const SCRIPT = join(SKILL_DIR, "scripts", "install-cron.js");

describe("install-cron.js schedule declarations", () => {
  test("uses the declared UTC cron schedule and exact staggering in dry-run", () => {
    const workspace = mkdtempSync(join(tmpdir(), "engram-install-cron-"));
    try {
      writeFileSync(join(workspace, "engram.json"), JSON.stringify({
        agent: "agent-example",
        cron: {
          expectedSchedule: {
            kind: "cron",
            expr: "17 * * * *",
            tz: "UTC",
            staggerMs: 0,
          },
        },
      }));
      const proc = Bun.spawnSync([
        "bun", SCRIPT, "install", "--dry-run", "--workspace", workspace,
      ], { stdout: "pipe", stderr: "pipe" });
      expect(proc.exitCode, proc.stderr.toString()).toBe(0);

      const spec = JSON.parse(proc.stdout.toString());
      expect(spec.schedule).toEqual({
        kind: "cron",
        expr: "17 * * * *",
        tz: "UTC",
        staggerMs: 0,
      });
      expect(spec.payload.message).toContain("yieldMs=120000");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
