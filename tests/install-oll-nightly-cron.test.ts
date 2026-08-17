import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const roots: string[] = [];
const installer = join(import.meta.dir, "..", "scripts", "install-oll-nightly-cron.ts");
const jobId = "d567e285-0527-4879-904a-041236a9811a";

function environment() {
  const root = mkdtempSync(join(tmpdir(), "engram-oll-cron-")); roots.push(root);
  const statePath = join(root, "job.json");
  const registry = join(root, "registry-snapshot.json");
  const declaration = join(root, "scheduler-declaration.json");
  const workspace = resolve(process.cwd(), "..", "..");
  writeFileSync(registry, JSON.stringify({
    schema: "oll.workspace-registry-snapshot.v1", capturedAt: "2026-01-01T00:00:00.000Z",
    entries: [{ workspaceId: "workspace-a", workspacePath: join(root, "workspace-a"), registryRevision: 1, registryDigest: "sha256:registry", configDigest: "sha256:config" }],
  }));
  writeFileSync(declaration, JSON.stringify({
    schema: "engram.daily-summary-scheduler.v1",
    schedule: { kind: "cron", expr: "40 0 * * *", tz: "UTC" },
    payload: { kind: "command", argv: ["bun", "scripts/daily-summary-coordinator.js", "--workspace", workspace] },
  }));
  const initial = {
    id: jobId, name: "Engram daily summary reconciliation", enabled: true, agentId: "main",
    schedule: { kind: "cron", expr: "40 0 * * *", tz: "UTC", staggerMs: 0 },
    payload: { kind: "command", argv: ["bun", "daily-summary-coordinator.js"], cwd: "/opt/openclaw/workspace", env: { ENGRAM_CRON_MANAGED: "1" }, timeoutSeconds: 1500, toolsAllow: ["*"] },
    delivery: { mode: "none" },
  };
  writeFileSync(statePath, JSON.stringify(initial));
  const fake = join(root, "openclaw-fake.js");
  writeFileSync(fake, `#!/usr/bin/env bun
import { readFileSync, writeFileSync } from "node:fs";
const statePath = process.env.FAKE_CRON_STATE; const args = process.argv.slice(2); const state = JSON.parse(readFileSync(statePath, "utf8"));
if (args[0] !== "cron") process.exit(2);
if (args[1] === "get") { console.log(JSON.stringify(state)); process.exit(0); }
if (args[1] !== "edit") process.exit(2);
const value = (flag) => { const at=args.indexOf(flag); return at >= 0 ? args[at+1] : null; };
if (args.includes("--script")) state.payload = { kind:"script", script:readFileSync(0,"utf8"), timeoutSeconds:Math.min(900,Number(value("--script-timeout-seconds"))), toolBudget:Number(value("--script-tool-budget")), toolsAllow:String(value("--tools")||"").split(",").filter(Boolean) };
if (args.includes("--command-argv")) {
  const env={}; for (let i=0;i<args.length;i++) if (args[i]==="--command-env") { const raw=args[++i]; const at=raw.indexOf("="); if(at<1) process.exit(3); env[raw.slice(0,at)]=raw.slice(at+1); }
  if (!Object.keys(env).length) process.exit(4);
  state.payload = { kind:"command", argv:JSON.parse(value("--command-argv")), cwd:value("--command-cwd"), env, timeoutSeconds:Number(value("--timeout-seconds")), toolsAllow:args.includes("--clear-tools")?["*"]:state.payload.toolsAllow };
}
state.enabled = !args.includes("--disable"); writeFileSync(statePath, JSON.stringify(state)); console.log(JSON.stringify(state));
`);
  chmodSync(fake, 0o755);
  return { root, statePath, initial, fake, registry, declaration, workspace };
}

function run(env: ReturnType<typeof environment>, args: string[]) {
  return spawnSync("bun", [installer, ...args, "--job-id", jobId, "--workspace", env.workspace, "--registry-snapshot", env.registry, "--scheduler-declaration", env.declaration, "--state-root", env.root], {
    encoding: "utf8", env: { ...process.env, ENGRAM_OPENCLAW: env.fake, FAKE_CRON_STATE: env.statePath },
  });
}

afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

describe("PR 7 OpenClaw scheduler deployment boundary", () => {
  test("plan is read-only and install requires explicit acknowledgement", () => {
    const env = environment();
    const plan = run(env, ["--action", "plan"]);
    expect(plan.status).toBe(0);
    const planned = JSON.parse(plan.stdout);
    expect(planned).toMatchObject({ schema: "oll.scheduler-rollout-plan.v1", jobId, mutatesRuntime: false });
    expect(planned.allowedWorkspaceRoots).toEqual([resolve(env.workspace), join(resolve(env.workspace, ".."), "workspaces")]);
    expect(planned.candidatePayload.script).toContain('\\"--allowed-root\\"');
    const denied = run(env, ["--action", "install"]);
    expect(denied.status).toBe(1);
    expect(JSON.parse(readFileSync(env.statePath, "utf8")).payload).toEqual(env.initial.payload);
  });

  test("backs up exact command payload, installs exact script digest, and restores the old payload with read-back", () => {
    const env = environment();
    const installed = run(env, ["--action", "install", "--ack-scheduler"]);
    expect(installed.status).toBe(0);
    const result = JSON.parse(installed.stdout);
    expect(result).toMatchObject({ status: "installed", jobId, readbackPayloadRevision: result.candidatePayloadRevision });
    expect(existsSync(result.backupPath)).toBeTrue();
    expect(existsSync(result.evidencePath)).toBeTrue();
    const scriptPayload = JSON.parse(readFileSync(env.statePath, "utf8")).payload;
    expect(scriptPayload.kind).toBe("script");
    expect(scriptPayload.timeoutSeconds).toBe(900);
    expect(scriptPayload.script).toContain("SCRIPT_DEADLINE_MS");
    expect(scriptPayload.script).toContain("RUNTIME_SOURCE_REVISION");
    expect(scriptPayload.toolsAllow).toEqual(["exec", "process", "sessions_spawn", "message"]);
    expect(scriptPayload.script).toContain('tools.callValue("process", { action: "poll", sessionId');
    expect(scriptPayload.script).toContain('value?.status === "running"');
    expect(scriptPayload.script).toContain("existing.spawnedCwd ?? existing.spawnedWorkspaceDir");
    expect(scriptPayload.script).toContain("JSON.stringify(encodeURIComponent(dispatchError))");
    expect(scriptPayload.script).toContain('tools.callValue("message", args)');
    expect(scriptPayload.script).toContain('target: delivery.target');
    expect(scriptPayload.script).toContain('rule notification delivery has no target');
    expect(scriptPayload.script).not.toContain('chatId: delivery.chatId');
    expect(scriptPayload.script).toContain("oll-rule-notifications.ts");
    expect(scriptPayload.script).toContain("--scheduler-declaration");
    expect(scriptPayload.script).toContain('\\"--allowed-root\\"');
    const rolledBack = run(env, ["--action", "rollback", "--backup-path", result.backupPath, "--ack-scheduler-rollback"]);
    expect(rolledBack.status).toBe(0);
    expect(JSON.parse(rolledBack.stdout).status).toBe("rolled_back");
    expect(JSON.parse(readFileSync(env.statePath, "utf8")).payload).toEqual(env.initial.payload);
  });
});
