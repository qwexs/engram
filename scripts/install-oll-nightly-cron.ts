#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { spawnSync } from "node:child_process";
import { atomicWriteJson } from "../src/oll/legacy-migration";
import { canonicalizeJcs, sha256Digest } from "../src/oll/handoff-v2";

type JsonObject = Record<string, any>;

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    action: { type: "string", default: "plan" },
    "job-id": { type: "string" },
    workspace: { type: "string", default: "/opt/openclaw/workspace" },
    "state-root": { type: "string", default: "/opt/openclaw/state/engram" },
    "registry-snapshot": { type: "string" },
    "allowed-root": { type: "string", multiple: true },
    "scheduler-declaration": { type: "string", default: "/opt/openclaw/workspace/ops/engram-daily-summary-scheduler.json" },
    "backup-path": { type: "string" },
    "ack-scheduler": { type: "boolean", default: false },
    "ack-scheduler-rollback": { type: "boolean", default: false },
  },
  strict: true,
});

function object(path: string): JsonObject {
  const value = JSON.parse(readFileSync(resolve(path), "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must contain an object`);
  return value;
}
const required = (name: "job-id" | "registry-snapshot"): string => {
  const value = values[name];
  if (typeof value !== "string" || !value) throw new Error(`--${name} is required`);
  return value;
};
const q = (value: string) => JSON.stringify(value);
const digestPayload = (payload: unknown) => sha256Digest(canonicalizeJcs(payload));
const OPENCLAW_SCRIPT_TIMEOUT_SECONDS = 900;
const OPENCLAW_SCRIPT_BUDGET_SECONDS = 840;
const DEPLOYMENT_SOURCE_FILES = [
  "scripts/oll-nightly-runtime.ts",
  "scripts/oll-write-empty-handoff.ts",
  "scripts/config.js",
  "src/oll/deployment-runtime.ts",
  "src/oll/nightly-coordinator.ts",
  "src/oll/nightly-discovery.ts",
  "src/oll/nightly-context.ts",
  "src/oll/nightly-state-store.ts",
  "src/oll/trusted-runtime.ts",
  "src/oll/handoff-applicator.ts",
  "src/oll/handoff-v2.ts",
  "src/oll/handoff-v3.ts",
  "src/oll/memory-candidates.ts",
  "src/oll/memory-candidate-compiler-v2.ts",
  "src/oll/memory-candidate-contracts-v2.ts",
  "src/oll/adaptation-store.ts",
  "src/oll/reconciliation.ts",
] as const;

function deploymentSourceRevision(workspace: string): string {
  const skillRoot = join(workspace, "skills", "engram");
  return digestPayload(DEPLOYMENT_SOURCE_FILES.map((path) => ({ path, digest: sha256Digest(readFileSync(join(skillRoot, path))) })));
}

function openclaw(argv: string[], input?: string): string {
  const binary = process.env.ENGRAM_OPENCLAW || Bun.which("openclaw");
  if (!binary) throw new Error("openclaw binary is unavailable");
  const result = spawnSync(binary, argv, { encoding: "utf8", input });
  if (result.error || result.status !== 0) throw new Error(result.stderr || result.error?.message || `openclaw exited ${result.status}`);
  return result.stdout || "";
}

function liveJob(jobId: string): JsonObject {
  return JSON.parse(openclaw(["cron", "get", jobId]));
}

function buildScript(options: { workspace: string; stateRoot: string; registrySnapshot: string; allowedRoots: string[]; declarationPath: string; declaration: JsonObject }): string {
  const declaration = options.declaration;
  if (declaration?.schema !== "engram.daily-summary-scheduler.v1" || declaration?.payload?.kind !== "command") {
    throw new Error("daily summary scheduler declaration is invalid");
  }
  const argv = declaration.payload.argv;
  if (!Array.isArray(argv) || argv.some((entry) => typeof entry !== "string")) throw new Error("daily summary argv is invalid");
  const reconcileArgv = argv.slice(0, 2);
  for (let index = 2; index < argv.length; index += 1) {
    if (argv[index] === "--workspace") {
      const workspacePath = argv[index + 1];
      if (typeof workspacePath !== "string" || !workspacePath) throw new Error("daily summary workspace argument is invalid");
      index += 1;
    } else reconcileArgv.push(argv[index]);
  }
  const workspaceCount = argv.filter((entry) => entry === "--workspace").length;
  if (!workspaceCount) throw new Error("daily summary declaration has no workspaces");
  reconcileArgv.splice(2, 0, "--scheduler-declaration", options.declarationPath);
  const reconcileCommand = reconcileArgv.map(q).join(" ");
  const runtimeCommand = [
    "bun", "./skills/engram/scripts/oll-nightly-runtime.ts", "run",
    "--state-root", options.stateRoot,
    "--registry-snapshot", options.registrySnapshot,
    ...options.allowedRoots.flatMap((root) => ["--allowed-root", root]),
    "--scripts-dir", join(options.workspace, "skills", "engram", "scripts"),
    "--reconciliation-completed-externally",
  ].map(q).join(" ");
  const ackPrefix = [
    "bun", "./skills/engram/scripts/oll-nightly-runtime.ts", "ack",
    "--state-root", options.stateRoot,
  ].map(q).join(" ");
  const sourceRevision = deploymentSourceRevision(options.workspace);
  return `// Generated by install-oll-nightly-cron.ts.
const WORKSPACE = ${q(options.workspace)};
const RUNTIME_SOURCE_REVISION = ${q(sourceRevision)};
const SCRIPT_DEADLINE_MS = Date.now() + ${OPENCLAW_SCRIPT_BUDGET_SECONDS * 1000};
const remaining = (cap) => {
  const seconds = Math.floor((SCRIPT_DEADLINE_MS - Date.now()) / 1000);
  if (seconds < 1) throw new Error("nightly script execution budget exhausted");
  return Math.min(cap, seconds);
};
const execText = async (command, yieldMs, timeout) => {
  const detail = (value) => value?.result?.details ?? value?.details ?? value;
  let value = detail(await tools.callValue("exec", { command, workdir: WORKSPACE, yieldMs, timeout }));
  while (value?.status === "running") {
    const sessionId = value?.sessionId ?? value?.session_id;
    if (!sessionId) throw new Error("nightly exec yielded without a session id");
    value = detail(await tools.callValue("process", { action: "poll", sessionId, timeout: Math.min(30000, remaining(30) * 1000) }));
  }
  const exitCode = value?.exitCode ?? value?.code ?? (value?.status === "failed" ? 1 : 0);
  if (exitCode !== 0) {
    const diagnostic = value?.stderr ?? value?.output ?? value?.aggregated ?? JSON.stringify(value);
    throw new Error("nightly exec failed (" + exitCode + "): " + String(diagnostic).slice(0, 2000));
  }
  return String(value?.aggregated ?? value?.stdout ?? value?.output ?? "").trim();
};
const parse = (text) => { const value = JSON.parse(text); if (!value || typeof value !== "object") throw new Error("invalid nightly runtime response"); return value; };
const reconciliation = parse(await execText(${q(reconcileCommand)}, 120000, remaining(150)));
if (reconciliation.errors !== 0) throw new Error("fleet reconciliation reported errors");
let step = parse(await execText(${q(runtimeCommand)}, 60000, remaining(720)));
let dispatches = 0;
while (step.status === "spawn_required") {
  if (++dispatches > 50) throw new Error("nightly dispatch budget exceeded");
  const request = step.request;
  if (request?.schema !== "oll.openclaw-spawn-request.v1") throw new Error("invalid spawn request schema");
  let accepted = false; let dispatchRef = ""; let resolvedModel = request.model; let dispatchError = "";
  try {
    const lookup = "openclaw sessions --all-agents --json --limit all | jq -c --arg label " + JSON.stringify(request.runtimeLabel)
      + " '[.sessions[] | select(.label == \\$label)]'";
    const matches = JSON.parse(await execText(lookup, 30000, remaining(120)));
    if (!Array.isArray(matches) || matches.length > 1) throw new Error("exact runtime label lookup is ambiguous");
    if (matches.length === 1) {
      const existing = matches[0];
      const existingCwd = existing.spawnedCwd ?? existing.spawnedWorkspaceDir;
      if (existingCwd && existingCwd !== request.workspacePath) throw new Error("runtime label workspace drift");
      resolvedModel = existing.modelProvider && existing.model ? existing.modelProvider + "/" + existing.model : String(existing.resolvedModel ?? existing.model ?? "");
      dispatchRef = String(existing.key ?? existing.sessionKey ?? existing.sessionId ?? request.runtimeLabel);
      accepted = resolvedModel === request.model;
      if (!accepted) dispatchError = "existing runtime label model drift";
    } else {
      const spawned = await tools.callValue("sessions_spawn", { task: request.task, label: request.runtimeLabel, model: request.model, cleanup: "delete", cwd: request.workspacePath, runTimeoutSeconds: request.runTimeoutSeconds });
      dispatchRef = String(spawned?.sessionKey ?? spawned?.sessionId ?? spawned?.id ?? request.runtimeLabel);
      const observedModel = spawned?.modelProvider && spawned?.model ? spawned.modelProvider + "/" + spawned.model : (spawned?.resolvedModel ?? spawned?.model ?? request.model);
      resolvedModel = String(observedModel);
      accepted = resolvedModel === request.model;
      if (!accepted) dispatchError = "sessions_spawn model drift";
    }
  } catch (error) { dispatchError = String(error); dispatchRef = "dispatch-error"; }
  const ack = ${q(ackPrefix)} + " --runtime-label " + request.runtimeLabel + " --accepted " + String(accepted)
    + " --dispatch-ref-uri " + JSON.stringify(encodeURIComponent(dispatchRef))
    + " --resolved-model-uri " + JSON.stringify(encodeURIComponent(resolvedModel))
    + " --error-uri " + JSON.stringify(encodeURIComponent(dispatchError));
  await execText(ack, 60000, remaining(120));
  if (!accepted) throw new Error("trusted nightly dispatch failed: " + dispatchError);
  step = parse(await execText(${q(runtimeCommand)}, 60000, remaining(720)));
}
if (step.status !== "completed") throw new Error("unexpected nightly terminal status: " + String(step.status));
return { state: { lastRunAt: new Date().toISOString(), runtimeSourceRevision: RUNTIME_SOURCE_REVISION, reconciliationWorkspaces: reconciliation.workspaces?.length ?? 0, dispatches, batchStatus: step.report?.status ?? null, maxConcurrentRethinkRuns: step.report?.maxConcurrentRethinkRuns ?? 0 } };`;
}

function candidate() {
  const workspace = resolve(String(values.workspace));
  const stateRoot = resolve(String(values["state-root"]));
  const registrySnapshot = resolve(required("registry-snapshot"));
  const requestedRoots = values["allowed-root"];
  const allowedRoots = [...new Set(
    (Array.isArray(requestedRoots) && requestedRoots.length > 0
      ? requestedRoots
      : [workspace, join(dirname(workspace), "workspaces")]
    ).map((root) => resolve(String(root))),
  )];
  const declarationPath = resolve(String(values["scheduler-declaration"]));
  const declaration = object(declarationPath);
  const script = buildScript({ workspace, stateRoot, registrySnapshot, allowedRoots, declarationPath, declaration });
  const payload = { kind: "script", script, timeoutSeconds: OPENCLAW_SCRIPT_TIMEOUT_SECONDS, toolBudget: 80, toolsAllow: ["exec", "process", "sessions_spawn"] };
  return { workspace, stateRoot, registrySnapshot, allowedRoots, declaration, payload, payloadRevision: digestPayload(payload) };
}

function plan() {
  const jobId = required("job-id");
  const current = liveJob(jobId);
  const next = candidate();
  if (current.id !== jobId || current.enabled !== true) throw new Error("live scheduler identity or enabled state drifted");
  if (current.schedule?.expr !== next.declaration.schedule?.expr || current.schedule?.tz !== next.declaration.schedule?.tz) {
    throw new Error("live scheduler schedule drifted from the declaration");
  }
  return {
    schema: "oll.scheduler-rollout-plan.v1", jobId,
    schedule: current.schedule,
    currentPayloadRevision: digestPayload(current.payload),
    candidatePayloadRevision: next.payloadRevision,
    candidatePayload: next.payload,
    reconciliationArgv: next.declaration.payload.argv,
    registrySnapshotPath: next.registrySnapshot,
    allowedWorkspaceRoots: next.allowedRoots,
    mutatesRuntime: false,
  };
}

function install() {
  if (values["ack-scheduler"] !== true) throw new Error("install requires --ack-scheduler");
  const rollout = plan();
  const current = liveJob(rollout.jobId);
  const next = candidate();
  const backupPath = join(next.stateRoot, "oll-rollouts", "scheduler-backups", `${rollout.currentPayloadRevision.slice(7)}.json`);
  if (!existsSync(backupPath)) atomicWriteJson(backupPath, {
    schema: "oll.scheduler-backup.v1", jobId: rollout.jobId, job: current,
    payloadRevision: rollout.currentPayloadRevision, candidatePayloadRevision: rollout.candidatePayloadRevision,
    createdAt: new Date().toISOString(),
  });
  openclaw([
    "cron", "edit", rollout.jobId, "--script", "-", "--script-timeout-seconds", String(next.payload.timeoutSeconds),
    "--script-tool-budget", String(next.payload.toolBudget), "--tools", next.payload.toolsAllow.join(","), "--no-deliver", "--enable",
  ], next.payload.script);
  const readback = liveJob(rollout.jobId);
  const actualRevision = digestPayload(readback.payload);
  if (actualRevision !== rollout.candidatePayloadRevision) throw new Error("scheduler read-back payload revision mismatch");
  const evidencePath = join(next.stateRoot, "oll-rollouts", "scheduler-releases", `${actualRevision.slice(7)}.json`);
  atomicWriteJson(evidencePath, {
    schema: "oll.scheduler-release-evidence.v1", jobId: rollout.jobId, payloadRevision: actualRevision,
    schedule: readback.schedule, enabled: readback.enabled, backupPath, readBackAt: new Date().toISOString(),
  });
  return { status: "installed", ...rollout, backupPath, evidencePath, readbackPayloadRevision: actualRevision };
}

function restoredCommandPayload(payload: JsonObject): JsonObject {
  const env = payload?.env && typeof payload.env === "object" && !Array.isArray(payload.env)
    ? { ...payload.env }
    : { ENGRAM_CRON_MANAGED: "1" };
  if (Object.keys(env).length === 0) env.ENGRAM_CRON_MANAGED = "1";
  return { ...payload, env, toolsAllow: ["*"] };
}

function restorePayload(jobId: string, payload: JsonObject): JsonObject {
  if (payload?.kind === "command") {
    const normalized = restoredCommandPayload(payload);
    const envArgs = Object.entries(normalized.env).flatMap(([key, value]) => {
      if (!key.trim() || typeof value !== "string") throw new Error("scheduler backup command env is invalid");
      return ["--command-env", `${key}=${value}`];
    });
    openclaw([
      "cron", "edit", jobId,
      "--command-argv", JSON.stringify(normalized.argv),
      "--command-cwd", String(normalized.cwd),
      ...envArgs,
      "--timeout-seconds", String(normalized.timeoutSeconds || 1500),
      "--clear-tools", "--no-deliver", "--enable",
    ]);
    return normalized;
  }
  if (payload?.kind === "script") {
    openclaw([
      "cron", "edit", jobId, "--script", "-",
      "--script-timeout-seconds", String(payload.timeoutSeconds),
      "--script-tool-budget", String(payload.toolBudget),
      "--tools", (payload.toolsAllow || []).join(","), "--no-deliver", "--enable",
    ], payload.script);
    return payload;
  }
  throw new Error("unsupported scheduler backup payload kind");
}

function rollback() {
  if (values["ack-scheduler-rollback"] !== true) throw new Error("rollback requires --ack-scheduler-rollback");
  const backupPath = resolve(String(values["backup-path"] || ""));
  if (!values["backup-path"] || !existsSync(backupPath)) throw new Error("--backup-path is required");
  const backup = object(backupPath);
  if (backup.schema !== "oll.scheduler-backup.v1" || backup.jobId !== required("job-id")) throw new Error("scheduler backup is invalid");
  const payload = backup.job?.payload;
  const expectedPayload = restorePayload(backup.jobId, payload);
  const readback = liveJob(backup.jobId);
  const actualRevision = digestPayload(readback.payload);
  const expectedRevision = digestPayload(expectedPayload);
  if (actualRevision !== expectedRevision) throw new Error("scheduler rollback read-back mismatch");
  return { status: "rolled_back", jobId: backup.jobId, payloadRevision: actualRevision, sourcePayloadRevision: backup.payloadRevision, backupPath };
}

try {
  const action = String(values.action);
  const result = action === "plan" ? plan() : action === "install" ? install() : action === "rollback" ? rollback() : action === "status" ? liveJob(required("job-id")) : (() => { throw new Error("action must be plan|install|rollback|status"); })();
  console.log(JSON.stringify(result, null, 2));
} catch (error: any) {
  console.error(JSON.stringify({ status: "error", error: String(error?.message || error) }));
  process.exit(1);
}

export { buildScript, digestPayload };
