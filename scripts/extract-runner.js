#!/usr/bin/env bun
/**
 * Retired automatic extraction phase.
 *
 * KG v3 admits durable assertions only inside the trusted source turn. The
 * heartbeat keeps daily/session cursors current for backward-compatible state
 * and reporting, but it never reads conversation bodies for classification and
 * never mutates the Knowledge Graph.
 */

import { existsSync, mkdirSync, readdirSync, renameSync, statSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { loadEngramConfig } from "./config.js";
import { parseHandoff } from "./process-handoff-core.js";

function parseArgs(argv) {
  const opts = {};
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith("--")) continue;
    const key = args[i].slice(2);
    const next = args[i + 1];
    if (next && !next.startsWith("--")) {
      opts[key] = next;
      i++;
    } else {
      opts[key] = true;
    }
  }
  return opts;
}

const opts = parseArgs(process.argv);
const workspace = resolve(opts.workspace || process.env.ENGRAM_WORKSPACE || process.cwd());
process.env.ENGRAM_WORKSPACE = workspace;
const config = loadEngramConfig(workspace);
const agentId = String(opts["agent-id"] || config.agent.replace(/^agent-/, "") || "main").replace(/^agent-/, "");
const agentDir = "agent-" + agentId;
const session = opts.session || "main";
const tz = process.env.ENGRAM_TZ || process.env.TZ || "Europe/Moscow";
const date = opts.date || new Date().toLocaleDateString("sv-SE", { timeZone: tz });
const noWrite = Boolean(opts["no-write"]);
const advanceWatermarkOnNoWrite = Boolean(opts["advance-watermark-on-no-write"]);

function localIso() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const offsetMin = -now.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  return now.getFullYear() + "-" + pad(now.getMonth() + 1) + "-" + pad(now.getDate()) +
    "T" + pad(now.getHours()) + ":" + pad(now.getMinutes()) + ":" + pad(now.getSeconds()) +
    sign + pad(Math.floor(abs / 60)) + ":" + pad(abs % 60);
}

async function atomicWrite(path, content) {
  const tmp = path + ".tmp-" + process.pid + "-" + Date.now();
  await writeFile(tmp, content);
  renameSync(tmp, path);
}

function lineCount(text) {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return normalized.endsWith("\n")
    ? normalized.slice(0, -1).split("\n").length
    : normalized.split("\n").length;
}

export function extractLastWatermark(content) {
  const lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  let last = null;
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^<!--\s*extracted:L(\d+):([^>]+)-->\s*$/);
    if (match) last = { line: i + 1, watermark: Number(match[1]), timestamp: match[2] };
  }
  return last;
}

function removeWatermarks(content) {
  return content
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .filter((line) => !/^<!--\s*extracted:L\d+:[^>]+-->\s*$/.test(line))
    .join("\n")
    .replace(/\n*$/, "\n");
}

function parseSessionTimestamp(path) {
  try {
    const match = basename(path).match(/^(\d{4}-\d{2}-\d{2})-(\d{2})(\d{2})(\d{2})(?:-|\.)/);
    if (match) return Date.parse(`${match[1]}T${match[2]}:${match[3]}:${match[4]}Z`);
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

function isServiceSessionFile(path) {
  const name = basename(path).toLowerCase();
  return name.startsWith("cron-") || name.includes("-cron-");
}

export function collectSessionFiles({ workspace, agentDir, session, lastSessionExtracted }) {
  const sessionsDir = join(workspace, "memory", agentDir, session, "sessions");
  if (!existsSync(sessionsDir)) return { files: [], sessionsDir };

  const files = readdirSync(sessionsDir)
    .filter((name) => name.endsWith(".md"))
    .map((name) => ({ name, path: join(sessionsDir, name) }))
    .filter((file) => !isServiceSessionFile(file.path))
    .map((file) => ({ ...file, ts: parseSessionTimestamp(file.path) }))
    .sort((a, b) => a.ts - b.ts || a.name.localeCompare(b.name));

  const last = lastSessionExtracted
    ? files.find((file) => file.name === lastSessionExtracted)
    : null;
  return {
    sessionsDir,
    files: last ? files.filter((file) => file.ts > last.ts) : files,
  };
}

async function updateWatermark(notePath, processedLine) {
  const raw = await readFile(notePath, "utf8");
  const body = removeWatermarks(raw).trimEnd() + "\n";
  const lastLine = Math.max(processedLine, lineCount(body));
  await atomicWrite(notePath, body + `<!-- extracted:L${lastLine}:${localIso()} -->\n`);
  return lastLine;
}

function handoffBlock(stats) {
  return [
    "=== HB-EXTRACT HANDOFF ===",
    "Status: ok",
    `Summary: automatic KG extraction retired; cursors ${stats.previous_watermark}->${stats.new_watermark}, sessions ${stats.sessions_processed}`,
    `Stats: ${JSON.stringify(stats)}`,
    "Flags: []",
    "Tensions: []",
    "Alerts: []",
    "=== END ===",
  ].join("\n");
}

export async function runExtraction() {
  const notePath = join(workspace, "memory", agentDir, session, date + ".md");
  if (!existsSync(notePath)) {
    mkdirSync(dirname(notePath), { recursive: true });
    await writeFile(notePath, `# ${date}\n\n## Events\n\n## Decisions\n\n## Learnings\n\n## Active Threads\n\n## Next\n`);
  }

  const statePath = join(workspace, "memory", "heartbeat-state.json");
  let state = {};
  try { state = JSON.parse(await readFile(statePath, "utf8")); } catch {}
  const lastSessionExtracted = opts["last-session-extracted"] || state.lastSessionExtracted?.[session] || null;
  const sessions = collectSessionFiles({ workspace, agentDir, session, lastSessionExtracted });
  const lastSessionFile = sessions.files.at(-1)?.name ?? null;

  const dailyContent = await readFile(notePath, "utf8");
  const watermark = extractLastWatermark(dailyContent);
  const dailyBodyLastLine = lineCount(removeWatermarks(dailyContent));
  const watermarkAdvanced = !noWrite || advanceWatermarkOnNoWrite;
  const targetWatermark = Math.max(watermark?.watermark ?? 0, dailyBodyLastLine);
  const newWatermark = watermarkAdvanced
    ? await updateWatermark(notePath, targetWatermark)
    : (watermark?.watermark ?? 0);

  const stats = {
    facts_written: 0,
    facts_skipped_dedup: 0,
    facts_planned: 0,
    kg_extract: false,
    automatic_ingress: "retired",
    new_watermark: `L${newWatermark}`,
    previous_watermark: `L${watermark?.watermark ?? 0}`,
    last_session_file: watermarkAdvanced ? lastSessionFile : null,
    sessions_processed: sessions.files.length,
    dry_run: noWrite,
    watermark_advanced: watermarkAdvanced,
  };
  const block = handoffBlock(stats);
  return { handoff: parseHandoff(block), block };
}

if (import.meta.main) {
  runExtraction().then(({ handoff, block }) => {
    if (!handoff.ok) {
      console.error("[extract-runner] failed to build handoff");
      process.exit(1);
    }
    console.log(block);
    process.exit(handoff.status === "ok" ? 0 : 1);
  }).catch((error) => {
    console.error("[extract-runner] " + (error?.stack || error?.message || String(error)));
    process.exit(1);
  });
}
