#!/usr/bin/env bun

import { readFileSync } from "fs";
import {
  applyHandoff,
  defaultHandoffHandlers,
  parseHandoff,
} from "./process-handoff-core.js";

function getArg(name) {
  const argv = process.argv.slice(2);
  const idx = argv.indexOf(`--${name}`);
  if (idx !== -1 && argv[idx + 1] && !argv[idx + 1].startsWith("--")) return argv[idx + 1];
  return null;
}

const session = getArg("session") ?? "main";
const date = getArg("date") ?? new Date().toLocaleDateString("sv-SE");
const workspace = getArg("workspace") ?? process.env.ENGRAM_WORKSPACE ?? process.env.CLAWD_WORKSPACE ?? null;
const domainsWrite = process.argv.includes("--domains-write");
const domainsDryRun = process.argv.includes("--domains-dry-run");
const selectedDomain = getArg("domain");

const input = readFileSync(0, "utf-8");
const handoff = parseHandoff(input);

if (!handoff.ok) {
  console.error(`[process-handoff] ERROR: No handoff block found in input. Subagent output preview: ${handoff.preview}`);
  process.exit(1);
}

const handlers = defaultHandoffHandlers({
  ...(workspace ? { workspace } : {}),
  session,
  date,
  domainsWrite,
  domainsDryRun,
  selectedDomain,
});

const result = await applyHandoff(handoff, handlers);

for (const line of result.logs ?? []) {
  console.log(line);
}

if (result.status === "error") {
  console.error(`[process-handoff] ${result.error ?? "Handoff processing failed"}`);
  process.exit(1);
}

if (Array.isArray(result.alerts) && result.alerts.length > 0) {
  for (const alert of result.alerts) {
    console.log(`[ALERT] ${String(alert).replace(/^\[ALERT\]\s*/i, "")}`);
  }
  process.exit(2);
}

console.log("[SILENT] Handoff processed — no user-facing output required");
process.exit(0);
