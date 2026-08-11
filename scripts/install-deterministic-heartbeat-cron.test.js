import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const script = join(import.meta.dir, "install-deterministic-heartbeat-cron.js");
function workspace() {
  const dir = mkdtempSync(join(tmpdir(), "engram-deterministic-heartbeat-"));
  writeFileSync(join(dir, "engram.json"), JSON.stringify({ agent: "agent-main", cron: { expectedSchedule: { kind: "cron", expr: "20 * * * *", tz: "UTC", staggerMs: 0 } } }));
  return dir;
}
describe("install-deterministic-heartbeat-cron", () => {
  test("dry run creates a no-model script payload with constrained tools", () => {
    const result = spawnSync("bun", [script, "--workspace", workspace(), "--dry-run"], { encoding: "utf8" });
    expect(result.status).toBe(0); const spec = JSON.parse(result.stdout);
    expect(spec.payload.kind).toBe("script"); expect(spec.payload.source).toContain('tools.callValue("sessions_spawn"');
    expect(spec.payload.source).toContain("heartbeat-runner.js"); expect(spec.payload.source).toContain("spawn-claim.js");
    expect(spec.payload.source).toContain("spawn-ack.js");
    expect(spec.payload.source).toContain("workdir: WORKSPACE");
    expect(spec.payload.source).toContain("--spawn-hb-domains-write");
    expect(spec.payload.source).not.toContain("--spawn-rethink");
    expect(spec.payload.source).not.toContain("--spawn-rethink2");
    expect(spec.payload.source).not.toContain("--recover-stale-oll-locks");
    expect(spec.payload.source).not.toContain("rethinkAlerts");
    expect(spec.payload.source).not.toContain("agentTurn"); expect(spec.payload.toolsAllow).toEqual(["exec", "sessions_spawn"]);
    expect(spec.schedule).toEqual({ kind: "cron", expr: "20 * * * *", tz: "UTC", staggerMs: 0 });
  });
  test("can prepare a disabled canary without changing its deterministic contract", () => {
    const result = spawnSync("bun", [script, "--workspace", workspace(), "--disabled", "--dry-run"], { encoding: "utf8" });
    expect(result.status).toBe(0); const spec = JSON.parse(result.stdout);
    expect(spec.enabled).toBeFalse(); expect(spec.payload.timeoutSeconds).toBe(420); expect(spec.payload.toolBudget).toBe(20);
  });
});
