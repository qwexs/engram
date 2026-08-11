#!/usr/bin/env bun

import { mkdirSync, renameSync } from "node:fs";
import { access, open, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

const TERMINAL_STATUSES = new Set(["done", "failed"]);
const SAFE_RUN_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_MS = 10;
const LOCK_RETRIES = 100;

export function runtimeSpawnLabel(label, runId) {
  const base = String(label || "hb").replace(/[^a-zA-Z0-9._-]+/g, "-");
  // Target identity contract requires a complete UUID suffix. Legacy queue
  // records may carry timestamp-shaped run IDs; generate a fresh runtime UUID
  // for them rather than preserving the old collision-prone short suffix.
  const candidate = String(runId || "");
  const suffix = UUID_RE.test(candidate) ? candidate.toLowerCase() : randomUUID();
  return `${base}-${suffix}`;
}

async function atomicJsonWrite(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${randomUUID()}`;
  await writeFile(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRecordLock(recordPath, fn) {
  const lockPath = `${recordPath}.lock`;
  mkdirSync(dirname(lockPath), { recursive: true });
  let handle = null;
  for (let attempt = 0; attempt < LOCK_RETRIES; attempt++) {
    try {
      handle = await open(lockPath, "wx");
      await handle.writeFile(JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }) + "\n");
      break;
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
      try {
        const info = await stat(lockPath);
        if (Date.now() - info.mtimeMs > LOCK_STALE_MS) {
          await unlink(lockPath);
          continue;
        }
      } catch (lockErr) {
        if (lockErr?.code === "ENOENT") continue;
        throw lockErr;
      }
      await sleep(LOCK_RETRY_MS);
    }
  }
  if (!handle) return { ok: false, error: "record-lock-timeout", recordPath };
  try {
    return await fn();
  } finally {
    await handle.close().catch(() => {});
    await unlink(lockPath).catch((err) => {
      if (err?.code !== "ENOENT") throw err;
    });
  }
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
  return withRecordLock(recordPath, async () => {
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
  });
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
