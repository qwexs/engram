#!/usr/bin/env bun
/**
 * Engram config loader.
 * Reads engram.json from workspace root (WORKSPACE).
 * Falls back to defaults if file is missing.
 *
 * Resolution order for `qmd.command`:
 *   1. process.env.ENGRAM_QMD        (explicit override, e.g. cron jobs)
 *   2. engram.json -> qmd.command    (per-workspace config)
 *   3. platform default: "qmd.cmd" on win32, "qmd" elsewhere
 *      (npm shebang-wrappers install as `qmd.cmd` on Windows;
 *      `bun`/`Bun.spawn` cannot exec the wrapper without the extension)
 *
 * Resolution order for subagent models (e.g. `hb-domains`, `hb-rethink`):
 *   1. process.env.ENGRAM_MODEL_<PHASE_UPPER>  (explicit override)
 *   2. engram.json -> models.heartbeat.subagents[phase]
 *   3. deployment profile overlay -> models.heartbeat.subagents[phase]
 *   4. engram.json -> models.default  (grinding phases only)
 *   5. engram.json -> models.subagents_default  (legacy alias, grinding only)
 *   6. hardcoded fallback: "sonnet-4-6"  (grinding phases only)
 *
 * Full-reasoning phases never fall back to a workspace default. A missing or
 * invalid exact phase mapping fails before dispatch.
 */

import { join } from "path";
import { existsSync, readFileSync } from "fs";

const DEFAULTS = {
  agent: "agent-main",
  qmd: {
    command: process.env.ENGRAM_QMD
      || (process.platform === "win32" ? "qmd.cmd" : "qmd"),
  },
};

let _cache = null;
let _cachedWorkspace = null;

export function loadEngramConfig(workspace) {
  if (_cache && _cachedWorkspace === workspace) return _cache;
  
  try {
    const raw = readFileSync(join(workspace, "engram.json"), "utf-8");
    const userParsed = JSON.parse(raw);
    const parsed = { ...DEFAULTS, ...userParsed };
    // Deep-merge qmd so partial engram.json still gets platform default for unset fields
    parsed.qmd = { ...DEFAULTS.qmd, ...(userParsed.qmd || {}) };
    // env override wins over engram.json
    if (process.env.ENGRAM_QMD) parsed.qmd.command = process.env.ENGRAM_QMD;
    // Normalize: ensure agent always has "agent-" prefix
    if (parsed.agent && !parsed.agent.startsWith("agent-")) {
      parsed.agent = `agent-${parsed.agent}`;
    }
    _cache = parsed;
  } catch {
    _cache = { ...DEFAULTS };
    if (process.env.ENGRAM_QMD) _cache.qmd.command = process.env.ENGRAM_QMD;
  }
  _cachedWorkspace = workspace;
  return _cache;
}

export function getAgentDir(workspace) {
  const config = loadEngramConfig(workspace);
  return config.agent;
}

/**
 * Resolve the qmd executable name for a workspace.
 * Always non-empty string; falls back to platform default.
 */
export function resolveQmdCommand(workspace) {
  const cmd = loadEngramConfig(workspace).qmd?.command;
  return String(cmd || (process.platform === "win32" ? "qmd.cmd" : "qmd"));
}

/**
 * Known heartbeat subagent labels and their reasoning class.
 * The actual model ids are NOT hardcoded here — they come from engram.json.
 */
const HB_SUBAGENT_PHASES = [
  "hb-synthesis",
  "hb-domains",
  "hb-domains-write",
  "hb-rethink",
  "hb-rethink2",
  "hb-autoresearch",
];

// Labels that require full-reasoning (capable model). All others default to
// the cheaper model. This classification is task-intrinsic: synthesis/OLL
// needs reasoning; extract/domains/autoresearch are grinding/regex.
const FULL_REASONING_LABELS = new Set([
  "hb-synthesis",
  "hb-rethink",
  "hb-rethink2",
]);

// OSS fallback — only used if engram.json has no model config at all.
// This ensures a fresh OSS install (without engram.json) still works.
const OSS_FALLBACK_MODEL = "sonnet-4-6";
const WORKSPACE_ID_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const PROFILE_RE = /^[a-z][a-z0-9_-]{0,63}$/;
export const LEGACY_OLL_PHASES = Object.freeze([
  "hb-rethink",
  "hb-rethink2",
  "hb-autoresearch",
]);

export class SubagentModelResolutionError extends Error {
  constructor(phase, reason) {
    super(`subagent model resolution failed for ${phase || "(empty)"}: ${reason}`);
    this.name = "SubagentModelResolutionError";
    this.code = "ENGRAM_MODEL_RESOLUTION";
    this.phase = phase || null;
    this.reason = reason;
  }
}

export class WorkspaceIdentityError extends Error {
  constructor(reason) {
    super(`workspace identity resolution failed: ${reason}`);
    this.name = "WorkspaceIdentityError";
    this.code = "ENGRAM_WORKSPACE_IDENTITY";
    this.reason = reason;
  }
}

function validModelId(value) {
  return typeof value === "string" && value.trim().length > 0 && !/[\s\u0000-\u001f]/.test(value);
}

function exactModel(value, phase, source) {
  if (value === undefined || value === null) return null;
  if (!validModelId(value)) {
    throw new SubagentModelResolutionError(phase, `${source} contains an invalid model id`);
  }
  return String(value).trim();
}

function deploymentProfileName(config) {
  const raw = process.env.ENGRAM_DEPLOYMENT_PROFILE || config?.deployment?.profile || null;
  if (!raw) return null;
  const profile = String(raw).trim();
  if (!PROFILE_RE.test(profile)) {
    throw new SubagentModelResolutionError(null, `invalid deployment profile ${JSON.stringify(profile)}`);
  }
  return profile;
}

function loadDeploymentOverlay(config) {
  const profile = deploymentProfileName(config);
  if (!profile) return null;
  const profilesRoot = process.env.ENGRAM_DEPLOYMENT_PROFILES_DIR;
  if (!profilesRoot) {
    throw new SubagentModelResolutionError(null, "deployment profiles are external; ENGRAM_DEPLOYMENT_PROFILES_DIR is required");
  }
  const path = join(profilesRoot, profile, "engram.overlay.json");
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new SubagentModelResolutionError(
      null,
      `deployment profile ${profile} is unavailable or invalid at ${path}: ${error?.message || error}`,
    );
  }
  if (parsed?.schema !== "engram.deployment-overlay.v1") {
    throw new SubagentModelResolutionError(null, `deployment profile ${profile} has an unsupported schema`);
  }
  return parsed;
}

/**
 * Resolve the model name for a heartbeat subagent by canonical phase.
 * Resolution order (no hardcoded deployment model ids):
 *
 *   1. process.env.ENGRAM_MODEL_<PHASE_UPPER>  (explicit env override)
 *   2. engram.json -> models.heartbeat.subagents[phase]  (per-phase)
 *   3. deployment overlay -> models.heartbeat.subagents[phase]
 *   4. engram.json -> models.default  (grinding phases only)
 *   5. engram.json -> models.subagents_default  (grinding phases only)
 *   6. OSS_FALLBACK_MODEL  (grinding phases only)
 *
 * A fresh install may use `models.default` (or `models.subagents_default`)
 * for grinding phases. Every full-reasoning phase requires an exact mapping
 * from environment, workspace config, or a deployment overlay.
 */
export function resolveSubagentModel(workspace, phase) {
  if (!HB_SUBAGENT_PHASES.includes(phase)) {
    throw new SubagentModelResolutionError(phase, "unknown canonical phase");
  }

  // 1. explicit env override: ENGRAM_MODEL_HB_EXTRACT, ENGRAM_MODEL_HB_RETHINK, ...
  const envKey = `ENGRAM_MODEL_${String(phase).toUpperCase().replace(/-/g, "_")}`;
  if (Object.prototype.hasOwnProperty.call(process.env, envKey)) {
    return exactModel(process.env[envKey], phase, envKey);
  }

  // 2. engram.json per-phase override
  const config = loadEngramConfig(workspace);
  const configured = config?.models?.heartbeat?.subagents?.[phase];
  if (configured !== undefined && configured !== null) {
    return exactModel(configured, phase, `engram.json models.heartbeat.subagents.${phase}`);
  }

  // 3. deployment overlay per-phase default. Workspace config remains the
  // intentional local override, while environment remains the operator override.
  const overlay = loadDeploymentOverlay(config);
  const fromOverlay = overlay?.models?.heartbeat?.subagents?.[phase];
  if (fromOverlay !== undefined && fromOverlay !== null) {
    return exactModel(fromOverlay, phase, `deployment overlay models.heartbeat.subagents.${phase}`);
  }

  if (FULL_REASONING_LABELS.has(phase)) {
    throw new SubagentModelResolutionError(phase, "exact full-reasoning phase mapping is required");
  }

  // 4. engram.json -> models.default (grinding phases only)
  const modelsDefault = config?.models?.default;
  if (modelsDefault !== undefined && modelsDefault !== null) {
    return exactModel(modelsDefault, phase, "engram.json models.default");
  }

  // 5. engram.json -> models.subagents_default (legacy alias, grinding only)
  const subagentsDefault = config?.models?.subagents_default;
  if (subagentsDefault !== undefined && subagentsDefault !== null) {
    return exactModel(subagentsDefault, phase, "engram.json models.subagents_default");
  }

  // 6. OSS fallback for grinding phases only.
  return OSS_FALLBACK_MODEL;
}

/** Resolve the explicit canonical workspace id, with an opt-in legacy bridge. */
export function resolveWorkspaceId(workspace, { allowAgentFallback = false } = {}) {
  const config = loadEngramConfig(workspace);
  const explicit = config?.workspace?.id;
  if (explicit !== undefined && explicit !== null) {
    const id = String(explicit).trim();
    if (!WORKSPACE_ID_RE.test(id)) {
      throw new WorkspaceIdentityError(`invalid workspace.id ${JSON.stringify(id)}`);
    }
    return id;
  }
  if (allowAgentFallback) {
    const fallback = String(config?.agent || "").replace(/^agent-/, "").trim();
    if (WORKSPACE_ID_RE.test(fallback)) return fallback;
  }
  throw new WorkspaceIdentityError("engram.json workspace.id is required");
}

/**
 * Live cutover guard for the legacy heartbeat-owned OLL lifecycle.
 *
 * This intentionally bypasses the config cache: a heartbeat process that was
 * already running when the fleet cutover marker was written must observe the
 * new boundary before it can queue or apply another legacy OLL artifact.
 */
export function legacyOllAdmissionState(workspace) {
  const marker = join(workspace, "memory-state", "oll", "legacy-admission-disabled.json");
  if (existsSync(marker)) {
    return { enabled: false, reason: "cutover-marker", marker };
  }
  try {
    const config = JSON.parse(readFileSync(join(workspace, "engram.json"), "utf8"));
    if (config?.oll?.scheduleOwner === "nightly") {
      return { enabled: false, reason: "schedule-owner-nightly", marker: null };
    }
  } catch {
    // Invalid/missing configuration is handled by validators. Preserve the
    // pre-cutover runtime only when no durable cutover marker exists.
  }
  return { enabled: true, reason: "legacy-heartbeat-owner", marker: null };
}

export function isLegacyOllAdmissionEnabled(workspace) {
  return legacyOllAdmissionState(workspace).enabled;
}

export function isLegacyOllPhase(phase) {
  return LEGACY_OLL_PHASES.includes(String(phase));
}

/**
 * Returns the list of known heartbeat subagent labels.
 * Useful for validation, templates, and init scripts.
 */
export function getHbSubagentLabels() {
  return [...HB_SUBAGENT_PHASES];
}

export function getHbSubagentPhases() {
  return [...HB_SUBAGENT_PHASES];
}

/**
 * Backward-compatible alias for callers that still use the old terminology.
 */
export function isFullReasoningLabel(label) {
  return FULL_REASONING_LABELS.has(label);
}

export function isFullReasoningPhase(phase) {
  return FULL_REASONING_LABELS.has(phase);
}
