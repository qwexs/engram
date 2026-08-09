#!/usr/bin/env bun
/**
 * Provision a deterministic OpenClaw command cron for global QMD maintenance.
 *
 * The coordinator is already a Bun program. Wrapping it in an agentTurn makes
 * a model decide whether to run one fixed command, which is both costly and
 * unreliable. This installer intentionally creates payload.kind=command.
 */

import { parseArgs } from "node:util";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

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
    "dry-run": { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
  strict: true,
});

const action = args.action ?? "install";
const skillRoot = dirname(dirname(fileURLToPath(import.meta.url)));

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
  --disabled             Create or update the job disabled
  --dry-run              Print the desired command-job spec only
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
if (!["install", "status", "uninstall"].includes(action)) fail(`Unknown action: ${action}`);
if (!args.manifest) fail("--manifest is required");
if (!args.workspace) fail("--workspace is required");

const manifest = canonical(args.manifest);
const workspace = canonical(args.workspace);
const cronName = args["cron-name"];
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
    payload: {
      kind: "command",
      argv: [
        "bun",
        "./skills/engram/scripts/qmd-maintenance-coordinator.ts",
        "--manifest", manifest,
        "--workspace", workspace,
        "--timeout-ms", String(timeoutMs),
      ],
      cwd: workspace,
      // OpenClaw 2026.7.2-beta.7 serializes an omitted repeatable
      // --command-env as [], which the gateway rightly rejects because a
      // command env must be an object. A harmless marker keeps the CLI and
      // gateway contract unambiguous across that version.
      env: { ENGRAM_CRON_MANAGED: "1" },
      timeoutSeconds: Math.ceil(timeoutMs / 1000) + 60,
    },
    delivery: { mode: "none" },
    enabled: !args.disabled,
  };
}

function openclaw(argv) {
  const binary = process.env.ENGRAM_OPENCLAW || Bun.which("openclaw");
  if (!binary) fail("openclaw binary not found on PATH");
  const result = spawnSync(binary, argv, { encoding: "utf8" });
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
  return (parseJson(openclaw(["cron", "list", "--all", "--json"]))?.jobs || [])
    .find((job) => job.name === cronName) ?? null;
}

function commandArgv(spec) {
  return JSON.stringify(spec.payload.argv);
}

function install() {
  const spec = buildSpec();
  if (args["dry-run"]) {
    console.log(JSON.stringify(spec, null, 2));
    return;
  }
  const existing = existingJob();
  if (existing) {
    const edit = [
      "cron", "edit", existing.id,
      "--name", spec.name,
      "--description", spec.description,
      "--command-argv", commandArgv(spec),
      "--command-cwd", spec.payload.cwd,
      "--command-env", "ENGRAM_CRON_MANAGED=1",
      "--timeout-seconds", String(spec.payload.timeoutSeconds),
      "--cron", spec.schedule.expr,
      "--tz", spec.schedule.tz,
      "--exact", "--no-deliver",
    ];
    edit.push(args.disabled ? "--disable" : "--enable");
    openclaw(edit);
    console.log(`✅ updated deterministic QMD maintenance cron ${existing.id}`);
    return;
  }
  const add = [
    "cron", "add",
    "--name", spec.name,
    "--description", spec.description,
    "--command-argv", commandArgv(spec),
    "--command-cwd", spec.payload.cwd,
    "--command-env", "ENGRAM_CRON_MANAGED=1",
    "--timeout-seconds", String(spec.payload.timeoutSeconds),
    "--cron", spec.schedule.expr,
    "--tz", spec.schedule.tz,
    "--exact", "--session", "isolated", "--no-deliver", "--json",
  ];
  if (args.disabled) add.push("--disabled");
  const created = parseJson(openclaw(add));
  console.log(`✅ created deterministic QMD maintenance cron ${created.id ?? "<unknown>"}`);
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
