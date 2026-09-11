#!/usr/bin/env bun
/** Provision one deterministic script -> managed Gateway exec QMD coordinator. */

import { parseArgs, isDeepStrictEqual } from "node:util";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { buildQmdMaintenancePayload, QMD_SCHEDULER_KEY } from "./_lib/qmd-scheduler.js";

const { values: args } = parseArgs({
  options: {
    action: { type: "string" },
    manifest: { type: "string" },
    workspace: { type: "string" },
    schedule: { type: "string", default: "33 * * * *" },
    tz: { type: "string", default: "UTC" },
    "cron-name": { type: "string", default: "Engram QMD global maintenance" },
    "timeout-ms": { type: "string", default: "600000" },
    disabled: { type: "boolean", default: false },
    enabled: { type: "boolean", default: false },
    report: { type: "string" },
    declaration: { type: "string" },
    "dry-run": { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
  strict: true,
});

const action = args.action ?? "install";

function usage(exitCode = 0) {
  console.log(`install-qmd-maintenance-cron

Usage:
  bun skills/engram/scripts/install-qmd-maintenance-cron.js [--action install|status|uninstall] \\
    --manifest <migration-or-registry.json> --workspace <coordinator-workspace> [options]

Options:
  --schedule <cron>      Cron expression (default: "33 * * * *")
  --tz <iana>            Cron timezone (default: UTC)
  --cron-name <name>     Managed job name
  --timeout-ms <n>       Coordinator timeout, milliseconds (default: 600000)
  --disabled             Create or update the job disabled (fresh default)
  --enabled              Explicit activation after fleet/backfill/environment preflight
  --report <path>        Coordinator JSON output (default: beside manifest)
  --declaration <path>   Scheduler read-back (default: maintenance-scheduler.json beside manifest)
  --dry-run              Print the desired deterministic script-job spec only
`);
  process.exit(exitCode);
}

function canonical(path) {
  const absolute = resolve(path);
  try { return realpathSync(absolute); } catch { return absolute; }
}

function fail(message) {
  console.error(`❌ ${message}`);
  process.exit(2);
}

if (args.help) usage();
if (args.enabled && args.disabled) fail("--enabled and --disabled are mutually exclusive");
if (!["install", "status", "uninstall"].includes(action)) fail(`Unknown action: ${action}`);
if (!args.manifest) fail("--manifest is required");
if (!args.workspace) fail("--workspace is required");

const manifest = canonical(args.manifest);
const workspace = canonical(args.workspace);
const cronName = args["cron-name"];
const report = canonical(args.report ?? resolve(dirname(manifest), "maintenance-last-run.json"));
const declaration = canonical(args.declaration ?? resolve(dirname(manifest), "maintenance-scheduler.json"));
if ([manifest, resolve(workspace, "engram.json"), declaration].includes(report) || [manifest, resolve(workspace, "engram.json")].includes(declaration)) fail("Report/declaration must not overwrite configuration or each other");
const timeoutMs = Number(args["timeout-ms"]);
if (!existsSync(manifest)) fail(`Manifest does not exist: ${manifest}`);
if (!existsSync(resolve(workspace, "engram.json"))) fail(`Workspace does not contain engram.json: ${workspace}`);
if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) fail("--timeout-ms must be a positive integer");
try {
  const document = JSON.parse(readFileSync(manifest, "utf8"));
  const registry = document?.schema === "engram.qmd.global-registry.v1"
    ? document
    : document?.schema === "engram.qmd.global-migration.v1"
      ? document.registry
      : null;
  if (registry?.schema !== "engram.qmd.global-registry.v1") {
    fail("--manifest must be an engram.qmd.global-registry.v1 document or an engram.qmd.global-migration.v1 wrapper");
  }
} catch (error) {
  if (error?.message?.startsWith("--manifest must")) throw error;
  fail(`Cannot parse --manifest JSON: ${error.message}`);
}

function buildSpec() {
  return {
    name: cronName,
    description: "Single physical-index QMD maintenance coordinator. Managed by install-qmd-maintenance-cron.js.",
    schedule: { kind: "cron", expr: args.schedule, tz: args.tz, staggerMs: 0 },
    sessionTarget: "isolated",
    payload: buildQmdMaintenancePayload({ workspace, manifest, report, timeoutMs }),
    delivery: { mode: "none" },
    enabled: args.enabled,
  };
}

function openclaw(argv, input) {
  const binary = process.env.ENGRAM_OPENCLAW || Bun.which("openclaw");
  if (!binary) fail("openclaw binary not found on PATH");
  const result = spawnSync(binary, argv, { encoding: "utf8", input, timeout: 30000 });
  if (result.error || result.status !== 0) {
    console.error(result.stderr || result.error?.message || `openclaw exited ${result.status}`);
    process.exit(1);
  }
  return result.stdout || "";
}

function parseJson(output) {
  const start = output.indexOf("{");
  if (start < 0) throw new Error("OpenClaw returned no JSON");
  return JSON.parse(output.slice(start));
}

function existingJob() {
  const jobs = parseJson(openclaw(["cron", "list", "--all", "--json"]));
  if (!Array.isArray(jobs.jobs) || jobs.hasMore || (jobs.total != null && jobs.total > jobs.jobs.length)) fail("Complete cron inventory required; refusing a duplicate coordinator");
  let pin = null;
  if (existsSync(declaration)) {
    try { pin = JSON.parse(readFileSync(declaration, "utf8")); } catch { fail("Invalid existing scheduler declaration"); }
    if (pin.schema !== "engram.qmd.global-maintenance-scheduler.v1") fail("Invalid scheduler declaration schema");
  }
  const matches = jobs.jobs.filter(job => job.id === pin?.jobId || job.name === cronName || job.declarationKey === QMD_SCHEDULER_KEY);
  if (matches.length > 1) fail("Ambiguous QMD scheduler identity; refusing to create/edit duplicates");
  if (pin?.jobId && (!matches.length || matches[0].id !== pin.jobId)) fail("Pinned scheduler is not visible; refusing to replace it");
  return matches[0] ?? null;
}

function install() {
  const spec = buildSpec();
  if (args["dry-run"]) {
    console.log(JSON.stringify(spec, null, 2));
    return;
  }
  if (!existsSync(dirname(report)) || !existsSync(dirname(declaration))) fail("Report/declaration parent directories must exist");
  const existing = existingJob();
  // Fresh install is disabled; an update preserves activation unless explicitly changed.
  spec.enabled = args.enabled ? true : args.disabled ? false : existing?.enabled === true;
  const verb = existing ? "edit" : "add";
  const help = openclaw(["cron", verb, "--help"]);
  if (!["--script", "--script-timeout-seconds", "--script-tool-budget", "--tools"].every(flag => help.includes(flag)))
    fail("Host CLI lacks managed script support; no command/agentTurn fallback is allowed");
  const argv = ["cron", verb, ...(existing ? [existing.id] : []),
    "--name", spec.name, "--description", spec.description,
    "--script", "-", "--script-tool-budget", "1", "--tools", "exec",
    "--script-timeout-seconds", String(spec.payload.timeoutSeconds),
    "--cron", spec.schedule.expr, "--tz", spec.schedule.tz,
    "--exact", "--session", "isolated", "--no-deliver", "--json"];
  if (existing) argv.push(spec.enabled ? "--enable" : "--disable");
  else if (!spec.enabled) argv.push("--disabled");
  const result = parseJson(openclaw(argv, spec.payload.script));
  const id = existing?.id ?? result.id ?? result.job?.id;
  const readback = existingJob();
  if (!id || readback?.id !== id || ["payload", "schedule", "enabled", "sessionTarget", "delivery"]
    .some(key => !isDeepStrictEqual(readback[key], spec[key])))
    fail("Scheduler read-back differs from requested spec; inspect live job before retrying");
  const previous = existsSync(declaration) ? JSON.parse(readFileSync(declaration, "utf8")) : {};
  writeFileSync(declaration, JSON.stringify({ ...previous,
    schema: "engram.qmd.global-maintenance-scheduler.v1", jobId: id,
    declarationKey: QMD_SCHEDULER_KEY, ...spec,
    ...(readback.owner ? { owner: readback.owner } : {}),
    activationGate: { requiresAllWorkspaceModes: "coordinated", requiresInitialVectorBackfill: true, requiresOperatorApproval: true },
  }, null, 2) + "\n", { mode: 0o600 });
  console.log(`✅ verified deterministic QMD maintenance cron ${id}; declaration ${declaration}`);
}

function status() {
  const job = existingJob();
  console.log(job ? JSON.stringify(job, null, 2) : "no managed QMD maintenance cron found");
}

function uninstall() {
  if (args["dry-run"]) return;
  const job = existingJob();
  if (!job) return console.log("no managed QMD maintenance cron found");
  openclaw(["cron", "rm", job.id]);
  console.log(`✅ removed QMD maintenance cron ${job.id}`);
}

if (action === "install") install();
if (action === "status") status();
if (action === "uninstall") uninstall();

export { buildSpec };
