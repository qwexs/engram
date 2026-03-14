#!/usr/bin/env bun
/**
 * heartbeat-report.js
 * Update (or create) the ## Heartbeat Report section in a daily note.
 *
 * Usage:
 *   bun scripts/heartbeat-report.js [--date YYYY-MM-DD] [--session main] \
 *     [--extraction "spawned (result pending)"] \
 *     [--synthesis "skipped (not Monday)"] \
 *     [--domains "skipped (no templates)"] \
 *     [--maintenance "ok — validate-kg.js: 0 errors"]
 *
 * Fields not provided are preserved from existing section (or set to "—" if new).
 * Exits 0 on success, 1 on error.
 */

import { join } from "path";
import { getAgentDir } from "./config.js";

const WORKSPACE = process.env.ENGRAM_WORKSPACE || join(import.meta.dir, "..", "..", "..");
const AGENT_DIR = getAgentDir(WORKSPACE);

// --- Arg parsing ---
const args = process.argv.slice(2);
function getArg(name) {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1) return null;
  return args[idx + 1] ?? null;
}

const date    = getArg("date")    ?? new Date().toLocaleDateString("sv-SE");
const session = getArg("session") ?? "main";

const provided = {
  extraction:  getArg("extraction"),
  synthesis:   getArg("synthesis"),
  domains:     getArg("domains"),
  maintenance: getArg("maintenance"),
};

// --- Resolve path ---
const notePath = join(WORKSPACE, "memory", AGENT_DIR, session, `${date}.md`);

// --- Read file ---
let content = "";
try {
  content = await Bun.file(notePath).text();
} catch {
  console.error(`[heartbeat-report] File not found: ${notePath}`);
  process.exit(1);
}

// --- Split content around Heartbeat Report section ---
const HEADER = "## Heartbeat Report";
const headerIdx = content.indexOf(HEADER);

let prefix, suffix, sectionBody;

if (headerIdx !== -1) {
  prefix = content.slice(0, headerIdx);
  const afterHeader = content.slice(headerIdx + HEADER.length);

  // Find where section ends: next ## heading, <!-- comment, or end of string
  const endMatch = afterHeader.match(/\n(?=## |<!)/);
  if (endMatch) {
    sectionBody = afterHeader.slice(0, endMatch.index);
    suffix = afterHeader.slice(endMatch.index);
  } else {
    sectionBody = afterHeader;
    suffix = "";
  }
} else {
  prefix = content.trimEnd() + "\n\n";
  sectionBody = "";
  suffix = "";
}

// --- Parse existing field values from sectionBody ---
const defaults = { extraction: "—", synthesis: "—", domains: "—", maintenance: "—" };
const existing = { ...defaults };

function parseField(body, key) {
  const m = body.match(new RegExp(`\\*\\*${key}\\*\\*:\\s*(.+)`));
  return m ? m[1].trim() : null;
}

existing.extraction  = parseField(sectionBody, "Extraction")  ?? defaults.extraction;
existing.synthesis   = parseField(sectionBody, "Synthesis")   ?? defaults.synthesis;
existing.domains     = parseField(sectionBody, "Domains")     ?? defaults.domains;
existing.maintenance = parseField(sectionBody, "Maintenance") ?? defaults.maintenance;

// --- Merge: provided wins, fall back to existing ---
const final = {
  extraction:  provided.extraction  ?? existing.extraction,
  synthesis:   provided.synthesis   ?? existing.synthesis,
  domains:     provided.domains     ?? existing.domains,
  maintenance: provided.maintenance ?? existing.maintenance,
};

// --- Build new section ---
const newSection = `${HEADER}

- **Extraction**: ${final.extraction}
- **Synthesis**: ${final.synthesis}
- **Domains**: ${final.domains}
- **Maintenance**: ${final.maintenance}`;

// --- Assemble and write ---
const updated = prefix + newSection + (suffix || "\n");
await Bun.write(notePath, updated);

console.log(`[heartbeat-report] Updated: ${notePath}`);
console.log(`  extraction:  ${final.extraction}`);
console.log(`  synthesis:   ${final.synthesis}`);
console.log(`  domains:     ${final.domains}`);
console.log(`  maintenance: ${final.maintenance}`);
