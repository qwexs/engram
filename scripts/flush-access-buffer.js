#!/usr/bin/env bun
// Apply buffered fact-use events in one sequential maintenance pass.

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { markWorkspaceQmdDirty } from "../src/qmd/maintenance-integration.ts";
import { legacyKgMutationState } from "./_lib/kg-v3-authority.ts";

function parseArgs(argv) {
  const opts = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      opts[key] = next;
      i++;
    } else opts[key] = true;
  }
  return opts;
}

function normalizeFact(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toLocaleLowerCase("ru-RU");
}

const opts = parseArgs(process.argv);
const workspace = resolve(opts.workspace || process.env.ENGRAM_WORKSPACE || process.cwd());
const dryRun = Boolean(opts["dry-run"]);
const TZ = process.env.ENGRAM_TZ || process.env.TZ || "Europe/Moscow";
const today = new Date().toLocaleDateString("sv-SE", { timeZone: TZ });
const stateDir = join(workspace, "workspace", "memory-state");
const bufferPath = join(stateDir, "access-buffer.jsonl");
const report = {
  schema: "engram.access-flush.v1",
  workspace,
  mode: dryRun ? "dry-run" : "write",
  read: 0,
  applied: 0,
  unresolved: 0,
  invalid: 0,
  entities: [],
  summaryErrors: 0,
};

function output(code = 0) {
  console.log(opts.json ? JSON.stringify(report) : JSON.stringify(report, null, 2));
  process.exit(code);
}

const authority = legacyKgMutationState(workspace);
if (!dryRun && !authority.allowed) {
  report.mode = "retired";
  report.reason = "KG_V3_AUTHORITY_ACTIVE";
  report.authorityMode = authority.mode;
  output();
}

if (!existsSync(bufferPath)) output();

let processingPath = bufferPath;
if (!dryRun) {
  processingPath = join(stateDir, `access-buffer.processing-${Date.now()}-${process.pid}.jsonl`);
  renameSync(bufferPath, processingPath);
}

let lines;
try {
  lines = readFileSync(processingPath, "utf8").split("\n").filter(Boolean);
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  output(1);
}

const entities = new Map();
const unresolved = [];
for (const line of lines) {
  report.read++;
  let event;
  try { event = JSON.parse(line); } catch { report.invalid++; unresolved.push({ reason: "invalid-json", line }); continue; }
  const entity = String(event.entity || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!entity || entity.split("/").includes("..") || (!event.id && !event.fact) || (event.id && event.fact)) {
    report.invalid++; unresolved.push({ reason: "invalid-event", event }); continue;
  }
  let entry = entities.get(entity);
  if (!entry) {
    try {
      const itemsPath = join(workspace, "life", entity, "items.json");
      entry = { entity, itemsPath, data: JSON.parse(readFileSync(itemsPath, "utf8")), changed: false, applied: 0 };
      entities.set(entity, entry);
    } catch { unresolved.push({ reason: "entity-not-found", event }); continue; }
  }
  const active = (entry.data.facts || []).filter((fact) => fact.status === "active");
  const matches = event.id
    ? active.filter((fact) => fact.id === event.id)
    : active.filter((fact) => normalizeFact(fact.fact || fact.text) === normalizeFact(event.fact));
  if (matches.length !== 1) {
    unresolved.push({ reason: matches.length ? "ambiguous-fact" : "fact-not-found", event });
    continue;
  }
  const fact = matches[0];
  fact.accessCount = (fact.accessCount || 0) + 1;
  fact.lastAccessed = today;
  entry.changed = true;
  entry.applied++;
  report.applied++;
}

for (const entry of entities.values()) {
  if (!entry.changed) continue;
  report.entities.push({ entity: entry.entity, applied: entry.applied });
  if (dryRun) continue;
  writeFileSync(entry.itemsPath, JSON.stringify(entry.data, null, 2) + "\n", "utf8");
  const proc = Bun.spawn(
    ["bun", join(import.meta.dir, "rebuild-summaries.js"), "--entity", entry.entity, "--apply-decay", "--json"],
    { cwd: workspace, stdout: "pipe", stderr: "pipe" },
  );
  const stderr = await new Response(proc.stderr).text();
  await proc.exited;
  if (proc.exitCode !== 0) {
    report.summaryErrors++;
    unresolved.push({ reason: "summary-rebuild-failed", entity: entry.entity, error: stderr.slice(0, 500) });
  }
}

report.unresolved = unresolved.length;
if (!dryRun) {
  const auditDir = join(workspace, "workspace", "ops", "access-buffer");
  mkdirSync(auditDir, { recursive: true });
  appendFileSync(join(auditDir, `applied-${today}.jsonl`), lines.join("\n") + "\n", "utf8");
  if (unresolved.length) appendFileSync(join(auditDir, `unresolved-${today}.jsonl`), unresolved.map((item) => JSON.stringify(item)).join("\n") + "\n", "utf8");
  await markWorkspaceQmdDirty({ workspace, collectionRole: "knowledge-graph", reason: "access-buffer:flush" });
  rmSync(processingPath, { force: true });
}
output(report.summaryErrors ? 1 : 0);
