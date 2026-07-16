#!/usr/bin/env bun

import { mkdirSync, renameSync } from "node:fs";
import { access, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

const TERMINAL_STATUSES = new Set(["done", "failed"]);
const SAFE_RUN_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export function runtimeSpawnLabel(label, runId) {
  const base = String(label || "hb").replace(/[^a-zA-Z0-9._-]+/g, "-");
  const suffix = String(runId || randomUUID()).split("-").at(-1);
  return `${base}-${suffix}`;
}

async function atomicJsonWrite(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${randomUUID()}`;
  await writeFile(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
}

export async function transitionSpawnRecord({
  spawnsDir,
  runId,
  phase = null,
  status,
  handoffPath = null,
  error = null,
  now = new Date().toISOString(),
}) {
  if (!SAFE_RUN_ID.test(String(runId || ""))) {
    return { ok: false, error: "invalid-run-id" };
  }
  if (!TERMINAL_STATUSES.has(status)) {
    return { ok: false, error: `invalid terminal status: ${status}` };
  }
  const recordPath = join(spawnsDir, "done", `${runId}.json`);
  let record;
  try {
    record = JSON.parse(await readFile(recordPath, "utf8"));
  } catch (err) {
    return { ok: false, error: err?.code === "ENOENT" ? "record-not-found" : `record-read: ${err?.message || err}`, recordPath };
  }
  if (record.runId !== runId) return { ok: false, error: "run-id-mismatch", recordPath };
  if (phase && record.phase !== phase) return { ok: false, error: "phase-mismatch", recordPath };
  if (TERMINAL_STATUSES.has(record.status)) {
    return record.status === status
      ? { ok: true, changed: false, record, recordPath }
      : { ok: false, error: `already-terminal:${record.status}`, recordPath };
  }
  record.status = status;
  record.completedAt = now;
  if (handoffPath) record.handoffPath = String(handoffPath).replace(/\\/g, "/");
  if (error) record.error = String(error);
  await atomicJsonWrite(recordPath, record);
  return { ok: true, changed: true, record, recordPath };
}

export async function reconcileStrandedSpawnRecords({
  spawnsDir,
  olderThanMs = 2 * 60 * 60 * 1000,
  nowMs = Date.now(),
  apply = false,
}) {
  const doneDir = join(spawnsDir, "done");
  const handoffDir = join(spawnsDir, "handoff");
  let names = [];
  try { names = await readdir(doneDir); } catch (err) {
    if (err?.code !== "ENOENT") throw err;
  }
  const summary = { scanned: 0, spawned: 0, pending: 0, stranded: 0, failed: 0, errors: [] };
  for (const name of names.filter((n) => n.endsWith(".json")).sort()) {
    summary.scanned++;
    const recordPath = join(doneDir, name);
    let record;
    try { record = JSON.parse(await readFile(recordPath, "utf8")); }
    catch (err) { summary.errors.push(`${name}: ${err?.message || err}`); continue; }
    if (record?.status !== "spawned") continue;
    summary.spawned++;
    const runId = record.runId || name.slice(0, -5);
    if (!SAFE_RUN_ID.test(String(runId))) {
      summary.errors.push(`${name}: invalid-run-id`);
      continue;
    }
    try {
      const handoffPath = join(handoffDir, `${runId}.md`);
      await access(handoffPath);
      const handoff = await readFile(handoffPath, "utf8");
      if (/=== HB-\w+ HANDOFF ===[\s\S]*?=== END ===/.test(handoff)) {
        summary.pending++;
        continue;
      }
    } catch { /* no durable result yet */ }
    const startedMs = Date.parse(record.spawnedAt || record.createdAt || "");
    if (!Number.isFinite(startedMs) || nowMs - startedMs < olderThanMs) {
      summary.pending++;
      continue;
    }
    summary.stranded++;
    if (!apply) continue;
    const result = await transitionSpawnRecord({
      spawnsDir,
      runId,
      phase: record.phase || null,
      status: "failed",
      error: "legacy-missing-handoff",
      now: new Date(nowMs).toISOString(),
    });
    if (result.ok) summary.failed++;
    else summary.errors.push(`${name}: ${result.error}`);
  }
  return summary;
}
