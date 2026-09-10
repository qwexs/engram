/** Read-only host observations. Missing visibility is never evidence of absence. */
import { readFileSync } from "node:fs";
import { join, isAbsolute, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { assertGroupHostRoutes, isGroupProjectionSchema } from "../../src/memory-observation/group-bindings.ts";
import { configuredMemoryAgentIds } from "../../src/memory-observation/configured-agents.ts";

export function payloadText(job) {
  const p = job?.payload ?? {};
  return Array.isArray(p.argv) ? p.argv.map(String).join(" ") : String(p.script ?? p.source ?? p.message ?? "");
}

export function normalizeCronInventory(value, { authoritative = false } = {}) {
  const jobs = Array.isArray(value) ? value : value?.jobs;
  if (!Array.isArray(jobs) || jobs.some(job => !job || typeof job !== "object"))
    return { jobs: [], available: false, complete: false, authoritative: false, reason: "invalid-envelope" };
  const complete = !value?.hasMore && !(Number.isFinite(value?.total) && value.total > jobs.length);
  return { jobs, available: true, complete, authoritative: authoritative && complete,
    reason: complete ? "caller-scoped-inventory" : "partial-inventory" };
}

function cliJson(argv, cwd) {
  const r = spawnSync("openclaw", argv, { cwd, encoding: "utf8", timeout: 30000, maxBuffer: 8 * 1024 * 1024, shell: false });
  if (r.error || r.status !== 0) return null;
  try { return JSON.parse(r.stdout); } catch { return null; }
}

export function collectWatchdogRuntime(workspace, { plugin = true } = {}) {
  // The CLI currently exposes no pagination flags or proof of global visibility.
  const cron = normalizeCronInventory(cliJson(["cron", "list", "--all", "--json"], workspace));
  // The on-disk root may contain includes; only the effective host configuration
  // can verify routes. Read the minimal non-credential sections, never full config.
  const entries = cliJson(["config", "get", "agents.entries"], workspace);
  const groups = cliJson(["config", "get", "channels.telegram.groups"], workspace);
  const bindings = cliJson(["config", "get", "bindings"], workspace);
  const config = entries && groups && bindings ? { agents: { entries }, channels: { telegram: { groups } }, bindings } : null;
  let observedPlugin = null;
  if (plugin) {
    const value = cliJson(["plugins", "inspect", "engram-memory-observation", "--json", "--runtime"], workspace);
    if (value) {
      const p = value.plugin ?? value;
      let installedDigest = null;
      if (typeof p.source === "string" && isAbsolute(p.source)) {
        try { installedDigest = "sha256:" + createHash("sha256").update(readFileSync(p.source)).digest("hex"); } catch {}
      }
      observedPlugin = { enabled: p.enabled, status: p.status, installedDigest,
        // Do not present hashing installed bytes as proof of resident bytes.
        loadedDigest: p.loadedDigest ?? p.runtimeDigest ?? null,
        diagnosticCount: (value.diagnostics ?? p.diagnostics ?? []).length };
    }
  }
  return { cron, plugin: observedPlugin, config, observedAt: new Date().toISOString() };
}

function finding(code, level, message, details = {}, path) {
  return { code, level, message, ...(path ? { path } : {}), fixable: false, details };
}

export function auditHeartbeatScheduler(engram, inventory) {
  const findings = [];
  if (!inventory?.available) return [finding("WD-CRON-UNVERIFIED", "warn", "Heartbeat scheduler inventory unavailable; cron checks were not verified")];
  if (!inventory.complete) findings.push(finding("WD-CRON-UNVERIFIED", "warn", "Cron inventory is partial; unseen jobs cannot be classified as missing"));
  const name = engram?.cron?.expectedJobName;
  const id = engram?.cron?.expectedJobId;
  if (!name && !id) return findings;
  const jobs = inventory.jobs.filter(job => id ? job.id === id : job.name === name);
  if (!jobs.length) return [...findings, finding("WD-CRON-UNVERIFIED", "warn", "Expected heartbeat was not visible in caller inventory", { expectedName: name })];
  if (jobs.length > 1) findings.push(finding("WD-CRON-DUPLICATE", "error", "Multiple heartbeat jobs share the expected identity", { expectedName: name, count: jobs.length }));
  for (const job of jobs) {
    if (job.enabled !== true) findings.push(finding("WD-CRON-DISABLED", "warn", "Expected heartbeat is disabled", { jobId: job.id }));
    if (id && name && job.name !== name) findings.push(finding("WD-CRON-NAME", "warn", "Heartbeat name differs from pinned job", { jobId: job.id, expectedName: name }));
    const expected = engram?.cron?.expectedSchedule;
    if (expected && ["kind", "expr", "tz", "staggerMs"].some(key => expected[key] !== job.schedule?.[key]))
      findings.push(finding("WD-CRON-SCHEDULE", "error", "Heartbeat schedule differs from declaration", { jobId: job.id, expected, actual: job.schedule }));
    const payload = payloadText(job);
    const pinned = engram?.cron?.expectedPayloadSha256;
    const payloadMatches = typeof pinned === "string" && pinned === createHash("sha256").update(JSON.stringify(job.payload)).digest("hex");
    if (pinned && !payloadMatches) findings.push(finding("WD-CRON-PAYLOAD-DRIFT", "error", "Heartbeat payload differs from reviewed declaration", { jobId: job.id }));
    const admitted = job.payload?.kind === "agentTurn" && payloadMatches
      && ["heartbeat-runner.js", "spawn-claim.js", "spawn-ack.js", "Gateway"].every(part => payload.includes(part))
      && (payload.includes("nightly") || payload.includes("Do not dispatch hb-rethink/hb-rethink2/hb-autoresearch"));
    const nightly = engram?.oll?.scheduleOwner === "nightly";
    const legacy = ["--spawn-rethink", "--spawn-rethink2", "--spawn-autoresearch", "--recover-stale-oll-locks"].some(flag => payload.includes(flag));
    const deterministic = job.payload?.kind === "command"
      ? Array.isArray(job.payload.argv) && job.payload.argv.some(arg => /(?:^|\/)heartbeat-runner\.js$/.test(arg))
      : admitted || payload.includes("Generated by install-deterministic-heartbeat-cron.js");
    if (!payload || (nightly ? !deterministic || legacy : !payload.includes("Forward OLL rethink alerts")))
      findings.push(finding("WD-CRON-007", "warn", "Heartbeat payload does not match its declared scheduling ownership", { jobId: job.id, nightlyOwned: nightly }));
  }
  return findings;
}

function argument(job, flag) {
  const argv = job.payload?.argv;
  if (Array.isArray(argv)) { const i = argv.indexOf(flag); return i >= 0 && typeof argv[i + 1] === "string" ? argv[i + 1] : null; }
  // Legacy scripts are code, not safely tokenizable commands. Never execute/eval them.
  return null;
}

/** Detect an expected projection even when the projection itself was lost. */
export function auditMissingWorkerProjection(workspace, runtime) {
  const expectedBy = [];
  for (const job of runtime?.cron?.jobs ?? []) {
    if (job.enabled !== true) continue;
    const payload = payloadText(job);
    if (payload.includes("memory-observation-batch-worker.ts") && argument(job, "--workspace") === resolve(workspace)) expectedBy.push(job.id);
    if (payload.includes("memory-observation-group-fleet.ts")) {
      const path = argument(job, "--manifest");
      if (path && isAbsolute(path)) {
        try {
          const manifest = JSON.parse(readFileSync(path, "utf8"));
          if (manifest.schema === "engram.memory-topic-fleet.v1" && Array.isArray(manifest.workspaces)
            && manifest.workspaces.some(entry => entry.path === resolve(workspace))) expectedBy.push(job.id);
        } catch { /* No validated evidence of membership. */ }
      }
    }
  }
  return expectedBy.length ? [finding("WD-MW-PROJECTION-MISSING", "error", "Enabled worker scheduler targets this workspace but its projection is absent", { jobIds: [...new Set(expectedBy)] })] : [];
}

export function schedulerCadenceSeconds(schedule) {
  if (schedule?.kind !== "cron") return null;
  const parts = String(schedule.expr ?? "").trim().split(/\s+/);
  if (parts.length !== 5 || parts.slice(1).some(p => p !== "*")) return null;
  let minutes;
  if (parts[0] === "*") minutes = Array.from({ length: 60 }, (_, i) => i);
  else if (/^\*\/[1-9][0-9]*$/.test(parts[0])) {
    const step = Number(parts[0].slice(2));
    if (step > 59) return null;
    minutes = Array.from({ length: Math.ceil(60 / step) }, (_, i) => i * step);
  } else if (/^\d+(?:,\d+)*$/.test(parts[0])) minutes = [...new Set(parts[0].split(",").map(Number))].sort((a, b) => a - b);
  else return null;
  if (!minutes.length || minutes.some(n => n < 0 || n > 59)) return null;
  return Math.max(...minutes.map((m, i) => ((minutes[i + 1] ?? minutes[0] + 60) - m))) * 60;
}

export function auditMemoryWorkerRuntime(workspace, projection, runtime, { now = new Date() } = {}) {
  if (!projection?.enabled || projection.mode !== "canary") return [];
  if (Date.parse(projection.captureOwnership?.effectiveAfter ?? "") > now.getTime())
    return [finding("WD-MW-RUNTIME-PREACTIVATION", "info", "Observer ownership is scheduled for the future; runtime readiness is not treated as an active capture outage")];
  const out = [], id = projection.workspaceId, group = isGroupProjectionSchema(projection.schema);
  const add = (code, level, message, details, path) => out.push(finding(code, level, message, details, path));
  const plugin = runtime?.plugin;
  if (!plugin) add("WD-MW-PLUGIN-UNVERIFIED", "warn", "Memory Worker plugin runtime could not be inspected");
  else {
    if (plugin.enabled !== true || plugin.status !== "loaded" || plugin.diagnosticCount > 0)
      add("WD-MW-PLUGIN", "error", "Observer capture is active but plugin is not enabled, loaded and diagnostic-free", { enabled: plugin.enabled, status: plugin.status, diagnosticCount: plugin.diagnosticCount });
    if (!plugin.installedDigest) add("WD-MW-PLUGIN-UNVERIFIED", "warn", "Installed plugin bytes could not be verified");
    else if (plugin.installedDigest !== projection.pluginDigest) add("WD-MW-PLUGIN-DIGEST", "error", "Projection digest differs from installed plugin bytes");
    if (!plugin.loadedDigest) add("WD-MW-LOADED-BYTES-UNVERIFIED", "info", "Host reports plugin state but does not expose resident byte digest; loaded-byte identity is unverified");
    else if (plugin.loadedDigest !== projection.pluginDigest) add("WD-MW-LOADED-DIGEST", "error", "Projection digest differs from resident plugin bytes");
  }
  if (!runtime?.config) add("WD-MW-ROUTE-UNVERIFIED", "warn", "Host agent and route configuration could not be verified");
  else {
    if (!configuredMemoryAgentIds(runtime.config).includes(id)) add("WD-MW-AGENT", "error", "Worker workspace is absent from configured producer agents", { workspaceId: id });
    if (group) { try { assertGroupHostRoutes(runtime.config, workspace, id, projection.bindings); }
      catch { add("WD-MW-ROUTE", "error", "Active group projection no longer matches canonical host routes/workspace"); } }
  }
  const inventory = runtime?.cron, schedulerId = projection.evaluation?.batch?.schedulerId;
  if (!inventory?.available) { add("WD-MW-SCHEDULER-UNVERIFIED", "warn", "Worker scheduler inventory is unavailable"); return out; }
  let jobs = inventory.jobs.filter(j => j.declarationKey === schedulerId || j.id === schedulerId);
  if (!jobs.length && !group) {
    const candidates = inventory.jobs.filter(j => payloadText(j).includes("memory-observation-batch-worker.ts")
      && argument(j, "--workspace") === resolve(workspace));
    if (candidates.length) {
      add("WD-MW-SCHEDULER-IDENTITY-UNVERIFIED", "warn", "Exact-target worker commands are visible, but their scheduler identity differs from the projection", {
        schedulerId, candidates: candidates.map(j => ({ jobId: j.id, declarationKey: j.declarationKey, enabled: j.enabled })) });
      jobs = candidates;
    }
  }
  if (!jobs.length) {
    add(inventory.authoritative ? "WD-MW-SCHEDULER-MISSING" : "WD-MW-SCHEDULER-UNVERIFIED", inventory.authoritative ? "error" : "warn",
      "Active worker scheduler was not found in available inventory", { schedulerId, visibility: inventory.reason });
    return out;
  }
  if (jobs.length !== 1) add("WD-MW-SCHEDULER-DUPLICATE", "error", "Worker scheduler identity is ambiguous", { schedulerId, count: jobs.length });
  for (const job of jobs) {
    const payload = payloadText(job), detail = { schedulerId, jobId: job.id };
    if (job.enabled !== true) add("WD-MW-SCHEDULER-DISABLED", "error", "Observer-owned capture has a disabled worker scheduler", detail);
    if (job.schedule?.kind !== "cron" || job.schedule?.tz !== "UTC" || job.schedule?.staggerMs !== 0)
      add("WD-MW-SCHEDULE", "warn", "Worker schedule does not match cron/UTC/staggerMs=0 contract", detail);
    const expected = group ? "memory-observation-group-fleet.ts" : "memory-observation-batch-worker.ts";
    if (!payload.includes(expected)) add("WD-MW-PAYLOAD", "error", "Worker scheduler invokes an unexpected entrypoint", detail);
    let budget = 300;
    if (group) {
      const path = argument(job, "--manifest");
      if (!path || !isAbsolute(path)) add("WD-MW-FLEET-UNVERIFIED", "warn", "Fleet manifest path cannot be verified from structured command arguments", detail);
      else {
        try {
          const manifest = JSON.parse(readFileSync(path, "utf8"));
          if (manifest.schema !== "engram.memory-topic-fleet.v1" || manifest.schedulerId !== schedulerId || !Array.isArray(manifest.workspaces)
            || !manifest.workspaces.length || manifest.workspaces.length > 20
            || new Set(manifest.workspaces.map(w => w.id)).size !== manifest.workspaces.length
            || new Set(manifest.workspaces.map(w => w.path)).size !== manifest.workspaces.length) throw new Error("invalid manifest");
          if (manifest.workspaces.filter(w => w.id === id && w.path === resolve(workspace)).length !== 1)
            add("WD-MW-FLEET-MEMBERSHIP", "error", "Active group workspace is missing or mismatched in worker fleet", detail, path);
          budget = manifest.workspaces.length * 300 + 60;
        } catch { add("WD-MW-FLEET-MANIFEST", "error", "Worker fleet manifest is missing or invalid", detail, path); }
      }
    } else {
      const target = argument(job, "--workspace");
      if (target === null) add("WD-MW-PAYLOAD-UNVERIFIED", "warn", "Worker workspace target cannot be verified from structured command arguments", detail);
      else if (target !== resolve(workspace)) add("WD-MW-PAYLOAD-WORKSPACE", "error", "Worker command targets another workspace", detail);
    }
    if (!Number.isFinite(job.payload?.timeoutSeconds) || job.payload.timeoutSeconds < budget)
      add("WD-MW-TIMEOUT", "warn", "Scheduler timeout is below the bounded worker/fleet execution budget", { ...detail, requiredSeconds: budget, actualSeconds: job.payload?.timeoutSeconds });
    const cadence = schedulerCadenceSeconds(job.schedule);
    if (cadence === null) add("WD-MW-CADENCE-UNVERIFIED", "info", "Schedule is not an hourly minute-list expression; automatic freshness bound is unverified", detail);
    else {
      const last = job.state?.lastRunAtMs ?? job.lastRunAtMs;
      const start = Date.parse(projection.captureOwnership?.effectiveAfter ?? "");
      const age = (now.getTime() - (Number.isFinite(last) ? last : start)) / 1000;
      if (age > cadence * 2 + budget) add("WD-MW-SCHEDULER-STALE", "warn", "No recent completed worker schedule activity within cadence and execution allowance", { ...detail, ageSeconds: Math.round(age), allowanceSeconds: cadence * 2 + budget });
    }
    const status = job.state?.lastRunStatus ?? job.lastRunStatus;
    if (Number.isFinite(job.state?.runningAtMs) && now.getTime() - job.state.runningAtMs > (Number(job.payload?.timeoutSeconds) + 60) * 1000)
      add("WD-MW-EXECUTION-STALE", "warn", "Worker execution is still marked running beyond its timeout allowance", detail);
    if (status && !["ok", "success"].includes(status)) add("WD-MW-EXECUTION", "warn", "Most recent worker scheduler execution was not successful (separate from memory health)", { ...detail, status });
  }
  return out;
}
