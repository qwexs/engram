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
 *   3. SUBAGENT_MODEL_DEFAULTS[label]  (per-label sensible default)
 *   4. generic fallback: "sonnet-4-6"
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
 * Sensible defaults for known heartbeat subagent labels. The OSS default is
 * `sonnet-4-6` for every phase; deployments can override per-label via
 * `engram.json` -> `models.heartbeat.subagents.<label>` or the
 * `ENGRAM_MODEL_<LABEL_UPPER>` env var.
 */
const SUBAGENT_MODEL_DEFAULTS = {
  "hb-extract": "sonnet-4-6",
  "hb-synthesis": "sonnet-4-6",
  "hb-domains": "sonnet-4-6",
  "hb-rethink": "sonnet-4-6",
  "hb-autoresearch": "sonnet-4-6",
  "hb-rethink2": "sonnet-4-6",
};

/**
 * Resolve the model name for a heartbeat subagent by its spawn label.
 * Always non-empty string; falls back to SUBAGENT_MODEL_DEFAULTS[label]
 * or "sonnet-4-6" for unknown labels.
 */
export function resolveSubagentModel(workspace, label) {
  if (!label) return "sonnet-4-6";
  // 1. explicit env override: ENGRAM_MODEL_HB_EXTRACT, ENGRAM_MODEL_HB_RETHINK, ...
  const envKey = `ENGRAM_MODEL_${String(label).toUpperCase().replace(/-/g, "_")}`;
  if (process.env[envKey]) return String(process.env[envKey]);
  // 2. engram.json override
  const config = loadEngramConfig(workspace);
  const fromConfig = config?.models?.heartbeat?.subagents?.[label];
  if (fromConfig) return String(fromConfig);
  // 3. per-label default
  return SUBAGENT_MODEL_DEFAULTS[label] || "sonnet-4-6";
}
