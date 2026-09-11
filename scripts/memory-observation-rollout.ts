#!/usr/bin/env bun
import { configuredGroupDirectBindings } from "../src/memory-observation/group-bindings.ts";
import { isGroupProjectionSchema, assertGroupHostRoutes } from "../src/memory-observation/group-bindings.ts";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  cpSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  MEMORY_OBSERVATION_PROJECTION_SCHEMA,
  MEMORY_OBSERVATION_PROJECTION_SCHEMA_V2,
  MEMORY_OBSERVATION_PROJECTION_SCHEMA_V3,
  MEMORY_OBSERVATION_PROJECTION_SCHEMA_V4,
  MEMORY_OBSERVATION_PROJECTION_SCHEMA_V5,
  memoryObservationProjectionPath,
  type MemoryObservationProjectionV1,
} from "../src/memory-observation/projection.ts";
import { hasExactInferenceModelAuthorization } from "../src/memory-observation/inference-boundary.ts";
import { deriveBatchEvaluationPolicyDigest } from "../src/memory-observation/batch-evaluation-policy.ts";
import {
  defineCanaryQmdRuntimeResolver,
  preflightCanaryQmdBinding,
  resolveCanaryQmdRuntimeBinding,
} from "../src/memory-observation/qmd-binding-preflight.ts";
import { resolveQmdContext } from "../src/qmd/context.ts";
import { personalBatchBinding, runtimeSourcePolicyDigest } from "./_lib/memory-observation-rollout-policy.ts";

import { configuredTopicBindings } from "../src/memory-observation/topic-bindings.ts";

const PLUGIN_ID = "engram-memory-observation";
const DEFAULT_INFERENCE_MODEL = "openai/gpt-5.6-sol";

function args(argv: string[]): Record<string, string | boolean> {
  const output: Record<string, string | boolean> = {};
  for (let index = 3; index < argv.length; index++) {
    const value = argv[index]!;
    if (!value.startsWith("--")) throw new Error(`unknown positional argument: ${value}`);
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) { output[value.slice(2)] = next; index++; }
    else output[value.slice(2)] = true;
  }
  return output;
}

function required(options: Record<string, string | boolean>, name: string): string {
  const value = options[name];
  if (typeof value !== "string" || !value.trim()) throw new Error(`--${name} is required`);
  return value.trim();
}

function acknowledged(options: Record<string, string | boolean>, name: string): void {
  if (options[name] !== true) throw new Error(`--${name} acknowledgement is required`);
}

function integer(options: Record<string, string | boolean>, name: string, fallback: number, min: number, max: number): number {
  const raw = options[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`--${name} must be an integer from ${min} to ${max}`);
  return value;
}

function inferenceModelOption(options: Record<string, string | boolean>): string {
  const model = typeof options["inference-model"] === "string"
    ? String(options["inference-model"]).trim()
    : DEFAULT_INFERENCE_MODEL;
  if (!/^[a-z0-9._-]+\/[A-Za-z0-9._:-]+$/.test(model)) throw new Error("--inference-model must be provider/model");
  return model;
}

function json(path: string): any { return JSON.parse(readFileSync(path, "utf8")); }

function atomicWrite(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const descriptor = openSync(temp, "wx", 0o600);
  try { writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8"); fsyncSync(descriptor); }
  finally { closeSync(descriptor); }
  renameSync(temp, path);
  if (process.platform !== "win32") {
    const directory = openSync(dirname(path), "r");
    try { fsyncSync(directory); } finally { closeSync(directory); }
  }
}

function runOpenClaw(arguments_: string[]): string {
  const result = spawnSync("openclaw", arguments_, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`openclaw ${arguments_.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
  return result.stdout.trim();
}

function normalizedModel(value: any): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value?.primary === "string" && value.primary.trim()) return value.primary.trim();
  return null;
}

function parsedConfigValue(output: string): any {
  const trimmed = output.trim();
  try { return JSON.parse(trimmed); }
  catch { return trimmed; }
}

function configuredAgentModel(agentId: string): string | null {
  try { return normalizedModel(parsedConfigValue(runOpenClaw(["config", "get", `agents.entries.${agentId}.model`]))); }
  catch {
    try { return normalizedModel(parsedConfigValue(runOpenClaw(["config", "get", "agents.defaults.model"]))); }
    catch { return null; }
  }
}

function configuredPluginLlmPolicy(): { allowModelOverride: boolean; allowedModels: unknown[] } {
  try {
    const value = parsedConfigValue(runOpenClaw(["config", "get", `plugins.entries.${PLUGIN_ID}.llm`]));
    return {
      allowModelOverride: value?.allowModelOverride === true,
      allowedModels: Array.isArray(value?.allowedModels) ? value.allowedModels : [],
    };
  } catch {
    return { allowModelOverride: false, allowedModels: [] };
  }
}

function hostInferenceBoundary(marker: MemoryObservationProjectionV1 | null): {
  active: boolean;
  agentId: string | null;
  foregroundModel: string | null;
  expectedModel: string | null;
  pluginLlmPolicy: { allowModelOverride: boolean; allowedModels: unknown[] };
} {
  const sessionKey = marker?.bindings?.[0]?.runtimeSessionKey;
  const agentId = typeof sessionKey === "string" ? sessionKey.match(/^agent:([^:]+):/)?.[1] ?? null : null;
  const foregroundModel = agentId ? configuredAgentModel(agentId) : null;
  const expectedModel = marker?.inference?.model ?? null;
  const pluginLlmPolicy = configuredPluginLlmPolicy();
  let topicAuthorized = false;
  if (isGroupProjectionSchema(marker?.schema)) {
    try {
      assertGroupHostRoutes(configuredTopicRoutes(), workspace, workspaceId, marker.bindings);
      topicAuthorized = true;
    } catch { /* Changed host routes revoke group activation. */ }
  }
  let personalAuthorized = false;
  if (marker && agentId !== "main" && marker.evaluation?.mode === "batch-cron") {
    try {
      const binding = personalBatchBinding(configuredPersonalRoutes(), workspace, workspaceId, sessionKey!);
      personalAuthorized = JSON.stringify(marker.bindings) === JSON.stringify([binding]);
    } catch { /* Missing or changed route is not activation authority. */ }
  }
  return {
    active: Boolean((agentId === "main" || personalAuthorized || topicAuthorized) && expectedModel
      && hasExactInferenceModelAuthorization(pluginLlmPolicy, expectedModel)),
    agentId,
    foregroundModel,
    expectedModel,
    pluginLlmPolicy,
  };
}

function configuredPersonalRoutes(): any {
  return {
    agents: { entries: parsedConfigValue(runOpenClaw(["config", "get", "agents.entries"])) },
    bindings: parsedConfigValue(runOpenClaw(["config", "get", "bindings"])),
  };
}

function configuredTopicRoutes(): any {
  return { agents: { entries: parsedConfigValue(runOpenClaw(["config", "get", "agents.entries"])) },
    bindings: parsedConfigValue(runOpenClaw(["config", "get", "bindings"])),
    channels: { telegram: { groups: parsedConfigValue(runOpenClaw(["config", "get", "channels.telegram.groups"])) } } };
}

async function buildPlugin(repository: string) {
  const previous = process.cwd();
  const result = await (async () => {
    try {
      process.chdir(repository);
      return await Bun.build({
        entrypoints: ["./integrations/openclaw-memory-observation/index.ts"],
        target: "node",
        format: "esm",
        external: ["openclaw/plugin-sdk/core", "openclaw/plugin-sdk/session-transcript-runtime"],
        minify: false,
        sourcemap: "none",
        write: false,
      });
    } finally { process.chdir(previous); }
  })();
  if (!result.success || result.outputs.length !== 1) throw new Error(`plugin build failed: ${result.logs.map(String).join("; ")}`);
  const bytes = Buffer.from(await result.outputs[0]!.arrayBuffer());
  return { bytes, digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}` as `sha256:${string}` };
}

function inspectPlugin() {
  const result = spawnSync("openclaw", ["plugins", "inspect", PLUGIN_ID, "--json", "--runtime"], { encoding: "utf8" });
  if (result.status !== 0 || !result.stdout.trim()) {
    return { installed: false, status: "absent", enabled: false, source: null, rootDir: null, digest: null, diagnostics: [], error: (result.stderr || result.stdout).trim() };
  }
  const value = JSON.parse(result.stdout);
  const plugin = value?.plugin || value;
  const source = typeof plugin?.source === "string" ? plugin.source : null;
  return {
    installed: true,
    status: plugin?.status || "unknown",
    enabled: plugin?.enabled === true,
    source,
    rootDir: typeof plugin?.rootDir === "string" ? plugin.rootDir : null,
    digest: source && existsSync(source) ? `sha256:${createHash("sha256").update(readFileSync(source)).digest("hex")}` : null,
    hookNames: plugin?.hookNames || [],
    diagnostics: value?.diagnostics || plugin?.diagnostics || [],
  };
}

function stateCounts(workspace: string): Record<string, number> {
  const root = join(workspace, "memory-state", "memory-observation", "v1");
  const count = (directory: string): number => existsSync(directory)
    ? readdirSync(directory, { withFileTypes: true }).reduce((total, entry) => total + (entry.isDirectory() ? count(join(directory, entry.name)) : 1), 0)
    : 0;
  return {
    envelopes: count(join(root, "envelopes")),
    evidence: count(join(root, "evidence")),
    transportLinks: count(join(root, "transport-links")),
    queueRecords: count(join(root, "queues", "evaluator")),
    typedObservations: count(join(root, "observations", "typed")),
    traceEvents: count(join(root, "traces")),
    dailyNoteQueueRecords: count(join(root, "consumers", "daily-note", "queue")),
    applyReceipts: count(join(root, "receipts", "by-operation")),
  };
}

function dailyNoteReadBack(marker: any): boolean {
  const classes = marker?.consumers?.dailyNote?.allowedObservationClasses;
  return Boolean(marker?.consumers?.dailyNote?.mode === "canary"
    && Array.isArray(classes)
    && (classes.length === 1
      ? classes[0] === "episodic.event"
      : classes.length === 2 && classes[0] === "episodic.event" && classes[1] === "episodic.decision")
    && marker?.consumers?.dailyNote?.maxAppliesPerWake === 1);
}

function ownershipReadBack(marker: any): boolean {
  return Boolean(marker?.captureOwnership?.owner === "observer"
    && marker?.captureOwnership?.foregroundDailyNoteCapture === "disabled"
    && marker?.captureOwnership?.effectiveAfter === marker?.consumers?.dailyNote?.applyAfter
    && marker?.consumers?.dailyNote?.allowedObservationClasses?.length === 2);
}

function latestSourcePolicyDigest(workspace: string, runtimeSessionKey: string): `sha256:${string}` {
  const directory = join(workspace, "memory-state", "memory-observation", "v1", "envelopes");
  const sourceDigest = runtimeSourcePolicyDigest(json(join(repository, "contracts", "memory-observation", "v1", "authority-policy.json")));
  if (!existsSync(directory)) return sourceDigest;
  const candidates = readdirSync(directory).filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
    .map((name) => json(join(directory, name)))
    .filter((value) => (runtimeSessionKey.endsWith(":*")
      ? value?.scope?.runtimeSessionKey?.startsWith(runtimeSessionKey.slice(0, -1))
      : value?.scope?.runtimeSessionKey === runtimeSessionKey)
      && typeof value?.sourceCompletedAt === "string"
      && /^sha256:[a-f0-9]{64}$/.test(value?.policyDigest))
    .sort((left, right) => right.sourceCompletedAt.localeCompare(left.sourceCompletedAt));
  if (candidates.length === 0) return sourceDigest;
  if (candidates[0].policyDigest !== sourceDigest) throw new Error("admitted source policy differs from the installed runtime contract");
  return candidates[0].policyDigest;
}

function help(): void {
  console.log(`memory-observation-rollout <plan|plan-canary|plan-ownership|plan-batch-canary|install|enable-shadow|enable-canary|enable-ownership|enable-batch-canary|status|disable> [options]

plan          Read-only exact-session shadow plan
install       Install and enable the plugin dormant (--ack-plugin-install)
enable-shadow Write one exact local projection after loaded-byte read-back
              (--ack-loaded-plugin-readback --ack-shadow)
plan-canary   Read-only exact-session, event-only daily-note canary plan
enable-canary Enable only the event daily-note sink after loaded-byte read-back
              (--ack-loaded-plugin-readback --ack-canary --ack-event-only --ack-kill-switch)
plan-ownership Read-only exact-session observer ownership plan
enable-ownership Transfer exact-session event and decision capture to the observer
                 (--ack-loaded-plugin-readback --ack-canary --ack-foreground-offload
                  --ack-decision-sidecars --ack-kill-switch)
plan-batch-canary Read-only exact-session durable micro-batch canary plan
enable-batch-canary Replace immediate evaluator with a separately scheduled batch worker
                    (--ack-loaded-plugin-readback --ack-canary --ack-foreground-offload
                     --ack-decision-sidecars --ack-batch-cron --ack-immediate-evaluator-off
                     --ack-kill-switch)
status        Read plugin, projection, and ledger state
disable       Immediate local projection kill switch (--ack-rollback)

Common:
  --workspace <absolute path>
  --session-key <full agent session key or agent:<id>:* for a v3 family canary>
  --group-domains <slug,...>     v5 exact groups without topics (same fleet worker)
  --topic-domains <slug,...>     v4 exact group topics (instead of session-key/scope-id)
  --qmd-collection <collection>   Optional exact canary QMD binding collection
  --qmd-manifest <path>           Registry/manifest file; alone enables the family exact-session resolver
  --scope-id <canonical exact scope>
  --approved-by <authority>
  --approved-at <ISO instant>
  --effective-after <ISO instant> (canary boundary; defaults to approved-at)
  --inference-model <provider/model> (default ${DEFAULT_INFERENCE_MODEL})
  --max-inference-calls <0|1> (default 0 for shadow; canary requires 1)
  --daily-note-timezone <IANA timezone> (canary only; default Europe/Moscow)`);
}

const command = process.argv[2];
if (!command || command === "help" || command === "--help") { help(); process.exit(command ? 0 : 1); }
const batchCommandRequested = command === "plan-batch-canary" || command === "enable-batch-canary";
const options = args(process.argv);
const repository = resolve(import.meta.dir, "..");
const workspaceArgument = required(options, "workspace");
if (!isAbsolute(workspaceArgument)) throw new Error("--workspace must be absolute");
const workspace = resolve(workspaceArgument);
const workspaceId = json(join(workspace, "engram.json"))?.workspace?.id;
if (typeof workspaceId !== "string" || !workspaceId.trim()) throw new Error("workspace.id is unavailable");
const projectionPath = memoryObservationProjectionPath(workspace);
const bundle = await buildPlugin(repository);

if (command === "install") {
  acknowledged(options, "ack-plugin-install");
  const inferenceModel = inferenceModelOption(options);
  const before = inspectPlugin();
  let backupPath: string | null = null;
  if (before.installed && before.rootDir && existsSync(before.rootDir)) {
    backupPath = join(workspace, "memory-state", "memory-observation", "rollout-backups", `${new Date().toISOString().replace(/[:.]/g, "-")}-${before.digest?.slice(-12) || "unknown"}`);
    mkdirSync(dirname(backupPath), { recursive: true, mode: 0o700 });
    cpSync(before.rootDir, backupPath, { recursive: true, errorOnExist: true });
  }
  const packageDirectory = mkdtempSync(join(tmpdir(), "engram-memory-observation-plugin-"));
  try {
    writeFileSync(join(packageDirectory, "index.js"), bundle.bytes, { mode: 0o600 });
    writeFileSync(join(packageDirectory, "package.json"), readFileSync(join(repository, "integrations", "openclaw-memory-observation", "package.json")));
    writeFileSync(join(packageDirectory, "openclaw.plugin.json"), readFileSync(join(repository, "integrations", "openclaw-memory-observation", "openclaw.plugin.json")));
    runOpenClaw(["plugins", "install", "--force", "--accept-capabilities", packageDirectory]);
    runOpenClaw(["plugins", "enable", PLUGIN_ID, "--accept-capabilities"]);
    runOpenClaw(["config", "set", `plugins.entries.${PLUGIN_ID}.hooks.allowConversationAccess`, "true", "--strict-json"]);
    runOpenClaw(["config", "set", `plugins.entries.${PLUGIN_ID}.llm.allowModelOverride`, "true", "--strict-json"]);
    runOpenClaw(["config", "set", `plugins.entries.${PLUGIN_ID}.llm.allowedModels`, JSON.stringify([inferenceModel]), "--strict-json"]);
  } finally { rmSync(packageDirectory, { recursive: true, force: true }); }
  const plugin = inspectPlugin();
  if (!plugin.installed || plugin.digest !== bundle.digest || plugin.diagnostics.length > 0) {
    throw new Error("installed plugin byte read-back failed");
  }
  const pluginLlmPolicy = configuredPluginLlmPolicy();
  if (!hasExactInferenceModelAuthorization(pluginLlmPolicy, inferenceModel)) {
    throw new Error("installed plugin inference-model authorization read-back failed");
  }
  console.log(JSON.stringify({
    schema: "engram.memory-observation-install.v1",
    status: "installed-dormant",
    pluginDigest: bundle.digest,
    backupPath,
    plugin,
    inferenceModel,
    pluginLlmPolicy,
    projection: existsSync(projectionPath) ? json(projectionPath) : null,
    gatewayRestartRequired: plugin.status !== "loaded",
  }, null, 2));
  process.exit(0);
}

if (command === "status") {
  const marker = existsSync(projectionPath) ? json(projectionPath) : null;
  const plugin = inspectPlugin();
  const hostBoundary = hostInferenceBoundary(marker);
  console.log(JSON.stringify({
    schema: "engram.memory-observation-status.v1",
    workspaceId,
    sourcePluginDigest: bundle.digest,
    plugin,
    marker,
    hostBoundary,
    consumerReadBack: marker?.mode === "canary" ? {
      dailyNote: dailyNoteReadBack(marker),
      captureOwnership: ownershipReadBack(marker),
      exactBindingCount: Array.isArray(marker?.bindings) ? marker.bindings.length : 0,
    } : null,
    activeReadBack: Boolean(plugin.installed && plugin.enabled && plugin.status === "loaded"
      && plugin.digest === bundle.digest && marker?.enabled === true && marker?.pluginDigest === bundle.digest
      && (marker?.limits?.maxInferenceCalls !== 1
        || hostBoundary.active)
      && (marker?.mode !== "canary" || ((marker?.bindings?.length === 1 || isGroupProjectionSchema(marker?.schema))
        && dailyNoteReadBack(marker)
        && (marker?.captureOwnership === undefined || ownershipReadBack(marker))))),
    state: stateCounts(workspace),
  }, null, 2));
  process.exit(0);
}

if (command === "disable") {
  acknowledged(options, "ack-rollback");
  const approvedBy = required(options, "approved-by");
  if (!existsSync(projectionPath)) {
    console.log(JSON.stringify({ status: "already-disabled", workspaceId }));
    process.exit(0);
  }
  const current = json(projectionPath);
  atomicWrite(projectionPath, { ...current, enabled: false, disabledBy: approvedBy, disabledAt: new Date().toISOString() });
  const readBack = json(projectionPath);
  if (readBack.enabled !== false || readBack.workspaceId !== workspaceId) throw new Error("disable read-back failed");
  console.log(JSON.stringify({ status: "disabled", workspaceId, projectionPath, readBack: true }, null, 2));
  process.exit(0);
}

if (!["plan", "plan-canary", "plan-ownership", "plan-batch-canary", "enable-shadow", "enable-canary", "enable-ownership", "enable-batch-canary"].includes(command)) {
  throw new Error("command must be plan, plan-canary, plan-ownership, plan-batch-canary, install, enable-shadow, enable-canary, enable-ownership, enable-batch-canary, status, or disable");
}
const batchCommand = batchCommandRequested;
const ownershipCommand = batchCommand || command === "plan-ownership" || command === "enable-ownership";
const canaryCommand = ownershipCommand || command === "plan-canary" || command === "enable-canary";
const topicNames = typeof options["topic-domains"] === "string" ? String(options["topic-domains"]).split(",").map(s => s.trim()) : null;
const groupNames = typeof options["group-domains"] === "string" ? String(options["group-domains"]).split(",").map(s => s.trim()) : null;
if (topicNames && groupNames) throw new Error("choose topic-domains or group-domains, not both");
const topicBindings = groupNames ? configuredGroupDirectBindings(configuredTopicRoutes(), workspace, workspaceId, groupNames)
  : topicNames ? configuredTopicBindings(configuredTopicRoutes(), workspace, workspaceId, topicNames) : null;
if (topicBindings && (!batchCommand || options["session-key"] || options["scope-id"])) throw new Error("topic domains require batch mode without session-key/scope-id overrides");
const sessionKey = topicBindings ? topicBindings.map(b => b.runtimeSessionKey).join(",") : required(options, "session-key");
if (!sessionKey.startsWith("agent:")) throw new Error("--session-key must be a full canonical agent session key");
const personalBinding = !topicBindings && !sessionKey.startsWith("agent:main:")
  ? personalBatchBinding(configuredPersonalRoutes(), workspace, workspaceId, sessionKey) : null;
if (personalBinding && !batchCommand) throw new Error("non-main personal activation requires the batch evaluator");
if (sessionKey.includes("*") && sessionKey !== "agent:main:*") {
  throw new Error("the only supported family selector is agent:main:*");
}
const scopeId = topicBindings ? `workspace:${workspaceId}:topics` : required(options, "scope-id");
if (personalBinding && scopeId !== personalBinding.scopeId) throw new Error("personal scope must match the configured direct peer");
const approvedBy = required(options, "approved-by");
const approvedAt = required(options, "approved-at");
if (!Number.isFinite(Date.parse(approvedAt))) throw new Error("--approved-at must be an ISO instant");
const effectiveAfter = typeof options["effective-after"] === "string"
  ? String(options["effective-after"]).trim()
  : approvedAt;
if (!Number.isFinite(Date.parse(effectiveAfter))) throw new Error("--effective-after must be an ISO instant");
if (Date.parse(effectiveAfter) < Date.parse(approvedAt)) throw new Error("--effective-after cannot precede --approved-at");
const inferenceModel = inferenceModelOption(options);
const projection: MemoryObservationProjectionV1 = {
  schema: MEMORY_OBSERVATION_PROJECTION_SCHEMA,
  workspaceId,
  enabled: true,
  mode: "shadow",
  bindings: topicBindings ?? (personalBinding ? [personalBinding] : [{
    runtimeSessionKey: sessionKey,
    scopeClass: "self",
    scopeId,
    requireOwner: true,
    allowedChannels: sessionKey === "agent:main:*" ? ["telegram", "openclaw"] : ["telegram"],
  }]),
  pluginDigest: bundle.digest,
  inference: {
    provider: inferenceModel.split("/", 1)[0]!,
    model: inferenceModel,
    evaluateAfter: new Date(effectiveAfter).toISOString(),
  },
  limits: {
    evidenceTtlHours: integer(options, "evidence-ttl-hours", 72, 1, 72),
    maxJobs: integer(options, "max-jobs", 1_000, 1, 100_000),
    maxBytes: integer(options, "max-bytes", 67_108_864, 1_024, 1_073_741_824),
    maxQueueAgeHours: integer(options, "max-queue-age-hours", 168, 1, 720),
    maxAttempts: integer(options, "max-attempts", 2, 1, 5),
    claimTtlSeconds: integer(options, "claim-ttl-seconds", 300, 1, 3_600),
    maxInferenceCalls: integer(options, "max-inference-calls", 0, 0, 1) as 0 | 1,
  },
  approvedBy,
  approvedAt: new Date(approvedAt).toISOString(),
};

if (batchCommand) {
  const schedulerId = required(options, "scheduler-id");
  const sourcePolicyDigest = latestSourcePolicyDigest(workspace, sessionKey);
  if (existsSync(projectionPath)) {
    const current = json(projectionPath);
    if (current?.bindings?.length === 1
      && current.bindings[0]?.runtimeSessionKey === sessionKey
      && typeof current?.inference?.evaluateAfter === "string"
      && Number.isFinite(Date.parse(current.inference.evaluateAfter))) {
      projection.inference.evaluateAfter = new Date(current.inference.evaluateAfter).toISOString();
    }
  }
  const batch = {
    sourcePolicyDigest,
    inactivityGapSeconds: integer(options, "batch-inactivity-gap-seconds", 300, 1, 3_600),
    maxTurns: integer(options, "batch-max-turns", 8, 2, 100),
    maxEvidenceBytes: integer(options, "batch-max-evidence-bytes", 262_144, 1_024, 1_073_741_824),
    maxAgeSeconds: integer(options, "batch-max-age-seconds", 900, 1, 86_400),
    maxInferenceCallsPerRun: 1 as const,
    schedulerId,
  };
  if (batch.maxAgeSeconds < batch.inactivityGapSeconds) {
    throw new Error("--batch-max-age-seconds cannot be below --batch-inactivity-gap-seconds");
  }
  projection.schema = groupNames ? MEMORY_OBSERVATION_PROJECTION_SCHEMA_V5 : topicBindings ? MEMORY_OBSERVATION_PROJECTION_SCHEMA_V4 : sessionKey === "agent:main:*"
    ? MEMORY_OBSERVATION_PROJECTION_SCHEMA_V3
    : MEMORY_OBSERVATION_PROJECTION_SCHEMA_V2;
  projection.evaluation = {
    mode: "batch-cron",
    policyDigest: deriveBatchEvaluationPolicyDigest({
      workspaceId,
      sessionKey,
      scopeId,
      model: inferenceModel,
      pluginDigest: bundle.digest,
      batch,
    }),
    batch,
  };
}

if (canaryCommand) {
  if (projection.limits.maxInferenceCalls !== 1) throw new Error("daily-note canary requires --max-inference-calls 1");
  const timezone = typeof options["daily-note-timezone"] === "string"
    ? String(options["daily-note-timezone"]).trim()
    : "Europe/Moscow";
  try { new Intl.DateTimeFormat("sv-SE", { timeZone: timezone }).format(new Date()); }
  catch { throw new Error("--daily-note-timezone must be a valid IANA timezone"); }
  projection.mode = "canary";
  projection.consumers = {
    dailyNote: {
      mode: "canary",
      applyAfter: new Date(effectiveAfter).toISOString(),
      timezone,
      allowedObservationClasses: ownershipCommand
        ? ["episodic.event", "episodic.decision"]
        : ["episodic.event"],
      maxAppliesPerWake: 1,
    },
  };
  if (ownershipCommand) {
    projection.captureOwnership = {
      owner: "observer",
      effectiveAfter: new Date(effectiveAfter).toISOString(),
      foregroundDailyNoteCapture: "disabled",
    };
  }
}

const qmdCollection = typeof options["qmd-collection"] === "string" ? String(options["qmd-collection"]).trim() : "";
const qmdManifestPath = typeof options["qmd-manifest"] === "string" ? String(options["qmd-manifest"]).trim() : "";
if (canaryCommand && (topicBindings || sessionKey.endsWith(":*")) && !qmdManifestPath) {
  throw new Error("family canary requires --qmd-manifest for exact-session QMD coverage");
}
if (canaryCommand && (qmdCollection || qmdManifestPath)) {
  const context = resolveQmdContext({ value: workspace, source: "explicit" });
  if (topicBindings || sessionKey.endsWith(":*")) {
    if (qmdCollection || !qmdManifestPath) throw new Error("family canary QMD handoff requires only --qmd-manifest");
    projection.consumers!.dailyNote.qmdBinding = defineCanaryQmdRuntimeResolver({
      workspace,
      workspaceId,
      manifestPath: qmdManifestPath,
      context,
    });
    if (topicBindings) for (const binding of topicBindings) {
      resolveCanaryQmdRuntimeBinding({ workspace, runtimeSessionKey: binding.runtimeSessionKey,
        timezone: projection.consumers!.dailyNote.timezone, destinationAt: effectiveAfter,
        resolver: projection.consumers!.dailyNote.qmdBinding as any, context });
    }
  } else {
    if (!qmdCollection || !qmdManifestPath) throw new Error("--qmd-collection and --qmd-manifest must be paired for an exact canary");
    const manifest = json(qmdManifestPath);
    const binding = preflightCanaryQmdBinding({
      workspace,
      runtimeSessionKey: sessionKey,
      qmdCollection,
      timezone: projection.consumers!.dailyNote.timezone,
      applyAfter: projection.consumers!.dailyNote.applyAfter,
      manifest,
      context,
    });
    projection.consumers!.dailyNote.qmdBinding = { collection: binding.collection };
  }
}

if (command === "plan" || command === "plan-canary" || command === "plan-ownership" || command === "plan-batch-canary") {
  console.log(JSON.stringify({
    schema: "engram.memory-observation-plan.v1",
    status: batchCommand ? "planned-batch-canary" : ownershipCommand ? "planned-ownership" : canaryCommand ? "planned-canary" : "planned",
    mutatesRuntime: false,
    projectionPath,
    pluginDigest: bundle.digest,
    projection,
    hostBoundary: hostInferenceBoundary(projection),
  }, null, 2));
  process.exit(0);
}

acknowledged(options, "ack-loaded-plugin-readback");
if (canaryCommand) {
  acknowledged(options, "ack-canary");
  if (ownershipCommand) {
    acknowledged(options, "ack-foreground-offload");
    acknowledged(options, "ack-decision-sidecars");
    if (batchCommand) {
      acknowledged(options, "ack-batch-cron");
      acknowledged(options, "ack-immediate-evaluator-off");
    }
  } else acknowledged(options, "ack-event-only");
  acknowledged(options, "ack-kill-switch");
} else {
  acknowledged(options, "ack-shadow");
}
const plugin = inspectPlugin();
if (!plugin.installed || !plugin.enabled || plugin.status !== "loaded" || plugin.digest !== bundle.digest || plugin.diagnostics.length > 0) {
  throw new Error("installed plugin is not loaded with the planned bytes and clean diagnostics");
}
if (!hostInferenceBoundary(projection).active) {
  throw new Error("host inference boundary read-back failed");
}
if (existsSync(projectionPath)) {
  const current = json(projectionPath);
  const sameAuthority = current.workspaceId === projection.workspaceId
    && JSON.stringify(current.bindings) === JSON.stringify(projection.bindings);
  const explicitlyDisabled = current.workspaceId === projection.workspaceId
    && current.enabled === false
    && typeof current.disabledBy === "string"
    && typeof current.disabledAt === "string"
    && Number.isFinite(Date.parse(current.disabledAt));
  if (!sameAuthority && !explicitlyDisabled) {
    throw new Error("existing projection has different authority; disable and review it before replacement");
  }
}
atomicWrite(projectionPath, projection);
const readBack = json(projectionPath);
if (JSON.stringify(readBack) !== JSON.stringify(projection)) throw new Error("projection read-back mismatch");
console.log(JSON.stringify({
  schema: "engram.memory-observation-activation.v1",
  status: batchCommand ? "enabled-batch-canary" : ownershipCommand ? "enabled-ownership" : canaryCommand ? "enabled-canary" : "enabled-shadow",
  workspaceId,
  projectionPath,
  pluginDigest: bundle.digest,
  plugin,
  readBack: true,
}, null, 2));
