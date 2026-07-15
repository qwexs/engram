#!/usr/bin/env bun
/**
 * Engram Watchdog — read-only workspace auditor.
 *
 * No fixes, migrations, cron writes, or filesystem changes are performed.
 */

import { parseArgs } from "node:util";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { auditWorkspace, discoverWorkspaces, mergeReports } from "./_lib/workspace-watchdog.js";

const rawArgv = process.argv.slice(2);
const repeatedWorkspaces = [];
for (let i = 0; i < rawArgv.length; i++) {
  if (rawArgv[i] === "--workspace" && rawArgv[i + 1]) {
    repeatedWorkspaces.push(rawArgv[i + 1]);
    i++;
  } else if (rawArgv[i].startsWith("--workspace=")) {
    repeatedWorkspaces.push(rawArgv[i].slice("--workspace=".length));
  }
}

const { values: args } = parseArgs({
  args: rawArgv,
  options: {
    "workspace": { type: "string" },
    "all": { type: "boolean", default: false },
    "workspaces-dir": { type: "string" },
    "json": { type: "boolean", default: false },
    "output": { type: "string" },
    "no-core": { type: "boolean", default: false },
    "no-qmd": { type: "boolean", default: false },
    "exit-zero-on-warn": { type: "boolean", default: false },
    "help": { type: "boolean", short: "h", default: false },
  },
  strict: false,
});

if (args.help) {
  console.log(`
watchdog — Read-only Engram workspace auditor

Usage:
  bun skills/engram/scripts/watchdog.js --workspace <path> [--json]
  bun skills/engram/scripts/watchdog.js --workspace <a> --workspace <b> --json
  bun skills/engram/scripts/watchdog.js --all --workspaces-dir <path> [--json]

Options:
  --workspace <path>       Workspace to audit. Can be repeated.
  --all                    Audit every workspace under --workspaces-dir.
  --workspaces-dir <path>  Directory used by --all (or ENGRAM_WORKSPACES_DIR).
  --json                   Print machine-readable report.
  --output <path>          Write report to file (JSON if --json, text otherwise).
  --no-core                Skip validate.js wrapper check.
  --no-qmd                 Skip QMD collection checks.
  --exit-zero-on-warn      Exit 0 for warnings-only reports (useful for cron).
  -h, --help               Show this help.

Exit codes:
  0  Clean, or warnings-only with --exit-zero-on-warn
  1  Errors found
  2  Warnings only
  3  Invalid args / no workspace

Read-only guarantee:
  This auditor never writes to workspace files, QMD, cron, or KG.
`);
  process.exit(0);
}

const unknown = Object.keys(args).filter((k) => ![
  "workspace", "all", "workspaces-dir", "json", "output", "no-core", "no-qmd", "exit-zero-on-warn", "help", "_",
].includes(k));
if (unknown.length) {
  console.error(`❌ Unknown option(s): ${unknown.map((k) => `--${k}`).join(", ")}`);
  process.exit(3);
}

let workspaces = [...repeatedWorkspaces];
if (!workspaces.length && args.workspace) workspaces.push(args.workspace);

if (args.all) {
  const root = args["workspaces-dir"] || process.env.ENGRAM_WORKSPACES_DIR;
  if (!root) {
    console.error("❌ --all requires --workspaces-dir <path> or ENGRAM_WORKSPACES_DIR");
    process.exit(3);
  }
  workspaces.push(...discoverWorkspaces(root));
}

workspaces = [...new Set(workspaces.map((w) => resolve(w)))];
if (!workspaces.length) {
  console.error("❌ No workspace specified. Use --workspace <path> or --all --workspaces-dir <path>.");
  process.exit(3);
}

const options = {
  core: !args["no-core"],
  qmd: !args["no-qmd"],
};
const reports = workspaces.map((workspace) => auditWorkspace(workspace, options));
const report = reports.length === 1 ? reports[0] : mergeReports(reports);

function renderHuman(report) {
  const lines = [];
  if (report.reports) {
    lines.push(`Engram Watchdog — ${report.summary.workspaces} workspace(s)`);
  } else {
    lines.push(`Engram Watchdog — ${report.workspace}`);
  }
  lines.push(`Status: ${report.status.toUpperCase()}`);
  lines.push(`Summary: ${report.summary.errors} error(s), ${report.summary.warnings} warning(s), ${report.summary.findings} finding(s), read-only`);
  lines.push("");

  const findings = report.reports
    ? report.reports.flatMap((r) => r.findings.map((f) => ({ ...f, workspace: r.workspace })))
    : report.findings;

  if (!findings.length) {
    lines.push("No findings.");
  } else {
    for (const f of findings) {
      const where = f.workspace ? ` (${f.workspace})` : "";
      lines.push(`[${f.level.toUpperCase()}] ${f.code} ${f.message}${where}`);
      if (f.path) lines.push(`        path: ${f.path}`);
      if (f.details?.candidate) lines.push(`        candidate: ${f.details.candidate}`);
    }
  }
  return lines.join("\n") + "\n";
}

const output = args.json ? JSON.stringify(report, null, 2) + "\n" : renderHuman(report);
if (args.output) writeFileSync(args.output, output);
process.stdout.write(output);

if (report.summary.errors > 0) process.exit(1);
if (report.summary.warnings > 0) process.exit(args["exit-zero-on-warn"] ? 0 : 2);
process.exit(0);
