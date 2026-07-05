#!/usr/bin/env bun
/**
 * heartbeat-state.js — atomic update of heartbeat-state.json
 *
 * Usage:
 *   bun scripts/heartbeat-state.js --set lastDailyNoteCreated.main 2026-02-22
 *   bun scripts/heartbeat-state.js --set lastExtraction.main 2026-02-22T01:44:00.000Z
 *   bun scripts/heartbeat-state.js --set lastDomainScan 2026-02-22T01:44:00.000Z
 *   bun scripts/heartbeat-state.js --set lastChecks.email null
 *   bun scripts/heartbeat-state.js --get lastDailyNoteCreated.main
 *   bun scripts/heartbeat-state.js --get-all
 *
 * Workspace resolution order:
 *   1. --workspace <path>
 *   2. CLAWD_WORKSPACE env variable
 *   3. parent of script directory (engram repo root)
 */

import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const DEFAULT_STATE = {
  lastDailyNoteCreated: {},
  lastChecks: { email: null, calendar: null, weather: null },
  heartbeatInProgress: false,
  heartbeatLockedAt: null,
  subagentExtraction: false,
  extractionModel: "minimax",
  lastExtraction: {},
  lastDomainScan: null,
  lastWeeklySynthesis: null,
  pendingObservations: 0,
  pendingTensions: 0,
  rethinkInProgress: false,
  rethinkStartedAt: null,
  lastRethink: null,
  lastRethinkScore: null,
  rethinkCount: 0,
  autoresearchInProgress: false,
  autoresearchStartedAt: null,
  currentExperiment: null,
  lastAutoresearch: null,
  pendingRethink2: null,
  // 2026-07-05: throttle для auto-seed observation из validate maintenance
  lastAutoSeedAt: null,
  subagentRuns: {},
};

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--") && args[i + 1] && !args[i + 1].startsWith("--")) {
      opts[args[i].slice(2)] = args[i + 1];
      i++;
    } else if (args[i].startsWith("--")) {
      opts[args[i].slice(2)] = true;
    }
  }
  return opts;
}

const opts = parseArgs(process.argv);

const WORKSPACE =
  opts.workspace ||
  process.env.ENGRAM_WORKSPACE ||
  process.env.CLAWD_WORKSPACE ||
  process.cwd() ||
  join(__dirname, "..", "..", "..");

const STATE_FILE = join(WORKSPACE, "memory", "heartbeat-state.json");

async function readState() {
  try {
    const raw = await Bun.file(STATE_FILE).text();
    return JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  } catch {
    return structuredClone(DEFAULT_STATE);
  }
}

async function writeState(state) {
  await Bun.write(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
}

function getPath(obj, path) {
  return path.split(".").reduce((cur, key) => cur?.[key], obj);
}

function setPath(obj, path, value) {
  const keys = path.split(".");
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (cur[keys[i]] == null || typeof cur[keys[i]] !== "object") {
      cur[keys[i]] = {};
    }
    cur = cur[keys[i]];
  }
  cur[keys[keys.length - 1]] = value;
}

function parseValue(raw) {
  if (raw === "null") return null;
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw.trim() !== "" && !isNaN(raw)) return Number(raw);
  if ((raw.startsWith("{") && raw.endsWith("}")) || (raw.startsWith("[") && raw.endsWith("]"))) {
    try { return JSON.parse(raw); } catch {}
  }
  return raw;
}

// --- main ---
const cmd = process.argv[2];

if (!cmd || cmd === "--help" || cmd === "-h") {
  console.log(`heartbeat-state.js — atomic update of heartbeat-state.json

Usage:
  bun scripts/heartbeat-state.js [--workspace /path] --set <dotted.path> <value>
  bun scripts/heartbeat-state.js [--workspace /path] --get <dotted.path>
  bun scripts/heartbeat-state.js [--workspace /path] --get-all

Commands:
  --set <dotted.path> <value>   Set a field ("null" → JSON null)
  --get <dotted.path>           Get a field value
  --get-all                     Dump full state

Options:
  --workspace <path>            Override workspace root (default: parent of scripts/)

Examples:
  --set lastDailyNoteCreated.main 2026-02-22
  --set lastDailyNoteCreated.telegram-3382546134 2026-02-22
  --set lastExtraction.main 2026-02-22T01:44:00.000Z
  --set lastDomainScan 2026-02-22T01:44:00.000Z
  --set lastChecks.email null
  --get lastDailyNoteCreated.main

State file: ${STATE_FILE}`);
  process.exit(0);
}

if (cmd === "--get-all") {
  console.log(JSON.stringify(await readState(), null, 2));
  process.exit(0);
}

if (cmd === "--get") {
  const path = opts.get;
  if (!path || typeof path !== "string") { console.error("Missing path"); process.exit(1); }
  const val = getPath(await readState(), path);
  console.log(val === undefined ? "(not found)" : JSON.stringify(val));
  process.exit(0);
}

if (cmd === "--set") {
  const path = opts.set;
  const setIdx = process.argv.indexOf("--set");
  const rawValue = process.argv[setIdx + 2];
  if (!path || rawValue === undefined) {
    console.error("Usage: --set <dotted.path> <value>");
    process.exit(1);
  }
  const state = await readState();
  const value = parseValue(rawValue);
  setPath(state, path, value);
  await writeState(state);
  console.log(`✓ ${path} = ${JSON.stringify(value)}`);
  process.exit(0);
}

console.error(`Unknown command: ${cmd}`);
process.exit(1);
