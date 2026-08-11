#!/usr/bin/env bun

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const SAFE_RUN_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

function parseArgs(argv) {
  const opts = {};
  for (let index = 2; index < argv.length; index++) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      opts[key] = next;
      index += 1;
    } else opts[key] = true;
  }
  return opts;
}

function atomicJson(path, value) {
  const temporary = join(dirname(path), `.${path.split(/[\\/]/).at(-1)}.tmp-${randomUUID()}`);
  writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
  renameSync(temporary, path);
}

export function recordDispatchAcknowledgement({
  workspace,
  runId,
  accepted,
  dispatchRef,
  acknowledgedAt = new Date().toISOString(),
}) {
  if (!SAFE_RUN_ID.test(String(runId || ""))) throw new Error("invalid run id");
  if (typeof accepted !== "boolean") throw new Error("accepted must be boolean");
  if (!dispatchRef) throw new Error("dispatchRef is required");

  const root = resolve(workspace);
  const spawnsDir = join(root, "workspace", "ops", "heartbeat-spawns");
  const recordPath = join(spawnsDir, "done", `${runId}.json`);
  const record = JSON.parse(readFileSync(recordPath, "utf8"));
  if (record.runId !== runId) throw new Error("run id mismatch");
  if (!record.runtimeLabel || !record.model || !record.phase) {
    throw new Error("spawn record is missing phase/runtimeLabel/model identity");
  }

  const acknowledgement = {
    schema: "oll.dispatch-ack.v1",
    runId,
    accepted,
    acknowledgedAt,
    runtimeLabel: record.runtimeLabel,
    resolvedModel: record.model,
    dispatchRef: String(dispatchRef),
  };
  const existing = record.dispatchAcknowledgement || null;
  if (existing) {
    const same = existing.runId === acknowledgement.runId
      && existing.accepted === acknowledgement.accepted
      && existing.runtimeLabel === acknowledgement.runtimeLabel
      && existing.resolvedModel === acknowledgement.resolvedModel
      && existing.dispatchRef === acknowledgement.dispatchRef;
    if (!same) throw new Error("conflicting dispatch acknowledgement");
    return { changed: false, recordPath, acknowledgement: existing };
  }

  record.dispatchAcknowledgement = acknowledgement;
  atomicJson(recordPath, record);

  const statePath = join(root, "memory", "heartbeat-state.json");
  if (existsSync(statePath)) {
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    const run = state?.subagentRuns?.[record.phase];
    if (run?.runId === runId) {
      run.dispatchAcknowledgement = acknowledgement;
      atomicJson(statePath, state);
    }
  }
  return { changed: true, recordPath, acknowledgement };
}

if (import.meta.main) {
  const opts = parseArgs(process.argv);
  if (opts.help || opts.h) {
    console.log(`spawn-ack.js

Persists the sessions_spawn dispatch acknowledgement for a claimed record.

Usage:
  bun skills/engram/scripts/spawn-ack.js --workspace /path --run-id UUID \\
    --accepted true --dispatch-ref-uri <encodeURIComponent(ref)> --json
`);
    process.exit(0);
  }
  try {
    const workspace = resolve(opts.workspace || process.env.ENGRAM_WORKSPACE || process.cwd());
    const accepted = opts.accepted === "true" ? true : opts.accepted === "false" ? false : null;
    const dispatchRef = decodeURIComponent(String(opts["dispatch-ref-uri"] || ""));
    const result = recordDispatchAcknowledgement({
      workspace,
      runId: String(opts["run-id"] || ""),
      accepted,
      dispatchRef,
    });
    console.log(JSON.stringify({ schema: "oll.dispatch-ack-write.v1", status: "ok", ...result }));
  } catch (error) {
    console.error(JSON.stringify({ schema: "oll.dispatch-ack-write.v1", status: "error", error: error?.message || String(error) }));
    process.exit(1);
  }
}
