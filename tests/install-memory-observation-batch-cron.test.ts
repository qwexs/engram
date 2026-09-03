import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const roots: string[] = [];
const installer = join(import.meta.dir, "..", "scripts", "install-memory-observation-batch-cron.ts");
const jobId = "11111111-2222-4333-8444-555555555555";

function environment() {
  const root = mkdtempSync(join(tmpdir(), "engram-memory-batch-cron-"));
  roots.push(root);
  const statePath = join(root, "job.json");
  const initial = {
    id: jobId,
    enabled: true,
    agentId: "main",
    sessionKey: "agent:main:telegram:direct:100000001",
    owner: { agentId: "main", sessionKey: "agent:main:telegram:direct:100000001", accountId: "default" },
    schedule: { kind: "cron", expr: "7,27,47 * * * *", tz: "UTC", staggerMs: 0 },
    payload: {
      kind: "script",
      script: "return { state: { workerResult: 'legacy' } };",
      timeoutSeconds: 300,
      toolBudget: 2,
      toolsAllow: ["exec"],
    },
    delivery: { mode: "none" },
    failureAlert: { after: 1, channel: "telegram", to: "100000001" },
  };
  writeFileSync(statePath, JSON.stringify(initial));
  const fake = join(root, "openclaw-fake.js");
  writeFileSync(fake, `#!/usr/bin/env bun
import { readFileSync, writeFileSync } from "node:fs";
const statePath = process.env.FAKE_CRON_STATE; const args = process.argv.slice(2); const state = JSON.parse(readFileSync(statePath, "utf8"));
if (args[0] !== "cron") process.exit(2);
if (args[1] === "get") { console.log(JSON.stringify(state)); process.exit(0); }
if (args[1] !== "edit") process.exit(2);
const value = (flag) => { const at = args.indexOf(flag); return at >= 0 ? args[at + 1] : null; };
state.payload = { kind: "script", script: readFileSync(0, "utf8"), timeoutSeconds: Number(value("--script-timeout-seconds")), toolBudget: Number(value("--script-tool-budget")), toolsAllow: String(value("--tools") || "").split(",").filter(Boolean) };
writeFileSync(statePath, JSON.stringify(state)); console.log(JSON.stringify(state));
`);
  chmodSync(fake, 0o755);
  return { root, statePath, initial, fake };
}

function run(env: ReturnType<typeof environment>, args: string[]) {
  return spawnSync("bun", [installer, ...args, "--job-id", jobId, "--workspace", "/workspaces/alpha", "--state-root", env.root], {
    encoding: "utf8",
    env: { ...process.env, ENGRAM_OPENCLAW: env.fake, FAKE_CRON_STATE: env.statePath },
  });
}

afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

describe("memory observation batch scheduler installer", () => {
  test("plans read-only and requires an explicit install acknowledgement", () => {
    const env = environment();
    const planned = run(env, ["--action", "plan"]);
    expect(planned.status).toBe(0);
    const plan = JSON.parse(planned.stdout);
    expect(plan).toMatchObject({ schema: "engram.memory-batch-scheduler-rollout-plan.v1", jobId, mutatesRuntime: false });
    expect(JSON.parse(readFileSync(env.statePath, "utf8"))).toEqual(env.initial);
    expect(run(env, ["--action", "install"]).status).toBe(1);
    expect(JSON.parse(readFileSync(env.statePath, "utf8"))).toEqual(env.initial);
  });

  test("installs nested exec validation, preserves scheduler controls, and rolls back", async () => {
    const env = environment();
    const installed = run(env, ["--action", "install", "--ack-scheduler"]);
    expect(installed.status).toBe(0);
    const result = JSON.parse(installed.stdout);
    const current = JSON.parse(readFileSync(env.statePath, "utf8"));
    expect(current.payload.script).toContain('tools.call("exec"');
    expect(current.payload.script).toContain("call?.result?.details");
    expect(current.payload.script).toContain('execution.status !== "completed"');
    expect(current.payload.script).toContain("!Number.isInteger(execution.exitCode)");
    expect(current.payload.script).toContain("execution.exitCode !== 0");
    expect({ ...current, payload: env.initial.payload }).toEqual(env.initial);

    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const execute = new AsyncFunction("tools", current.payload.script);
    await expect(execute({ call: async () => ({ result: { details: { status: "completed", exitCode: 7, aggregated: "worker failed" } } }) }))
      .rejects.toThrow("Engram batch worker exited 7: worker failed");
    await expect(execute({ call: async () => ({ result: { details: { status: "running", aggregated: "" } } }) }))
      .rejects.toThrow("did not return a completed exit status");
    expect(await execute({ call: async () => ({ result: { details: { status: "completed", exitCode: 0, aggregated: "ok" } } }) }))
      .toEqual({ state: { workerResult: "ok" } });

    const rolledBack = run(env, ["--action", "rollback", "--backup-path", result.backupPath, "--ack-scheduler-rollback"]);
    expect(rolledBack.status).toBe(0);
    expect(JSON.parse(readFileSync(env.statePath, "utf8"))).toEqual(env.initial);
  });
});
