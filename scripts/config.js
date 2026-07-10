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
 * Resolution order for subagent models (e.g. `hb-extract`, `hb-synthesis`):
 *   1. process.env.ENGRAM_MODEL_<LABEL_UPPER>  (explicit override)
 *   2. engram.json -> models.heartbeat.subagents[label]
 *   3. engram.json -> models.default  (workspace-wide default)
 *   4. engram.json -> models.subagents_default  (legacy alias)
 *   5. hardcoded fallback: "sonnet-4-6"  (OSS default, last resort)
 */

import { join } from "path";
import { readFileSync } from "fs";

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
const HB_SUBAGENT_LABELS = [
  "hb-extract",
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

/**
 * Resolve the model name for a heartbeat subagent by its spawn label.
 * Resolution order (no hardcoded deployment model ids):
 *
 *   1. process.env.ENGRAM_MODEL_<LABEL_UPPER>  (explicit env override)
 *   2. engram.json -> models.heartbeat.subagents[label]  (per-label)
 *   3. engram.json -> models.default  (workspace-wide default for all subagents)
 *   4. engram.json -> models.subagents_default  (legacy alias for models.default)
 *   5. OSS_FALLBACK_MODEL  ("sonnet-4-6", last resort)
 *
 * A fresh install only needs `models.default` (or `models.subagents_default`)
 * in engram.json — per-label overrides in `models.heartbeat.subagents` are
 * optional and only needed when some labels should use a different model.
 */
export function resolveSubagentModel(workspace, label) {
  if (!label) return OSS_FALLBACK_MODEL;

  // 1. explicit env override: ENGRAM_MODEL_HB_EXTRACT, ENGRAM_MODEL_HB_RETHINK, ...
  const envKey = `ENGRAM_MODEL_${String(label).toUpperCase().replace(/-/g, "_")}`;
  if (process.env[envKey]) return String(process.env[envKey]);

  // 2. engram.json per-label override
  const config = loadEngramConfig(workspace);
  const fromConfig = config?.models?.heartbeat?.subagents?.[label];
  if (fromConfig) return String(fromConfig);

  // 3. engram.json -> models.default (workspace-wide default for all subagents)
  const modelsDefault = config?.models?.default;
  if (modelsDefault) return String(modelsDefault);

  // 4. engram.json -> models.subagents_default (legacy alias)
  const subagentsDefault = config?.models?.subagents_default;
  if (subagentsDefault) return String(subagentsDefault);

  // 5. OSS fallback
  return OSS_FALLBACK_MODEL;
}

/**
 * Returns the list of known heartbeat subagent labels.
 * Useful for validation, templates, and init scripts.
 */
export function getHbSubagentLabels() {
  return [...HB_SUBAGENT_LABELS];
}

/**
 * Returns whether a label requires full-reasoning (capable model).
 */
export function isFullReasoningLabel(label) {
  return FULL_REASONING_LABELS.has(label);
}
