#!/usr/bin/env bun
/**
 * Engram config loader.
 * Reads engram.json from workspace root (WORKSPACE).
 * Falls back to defaults if file is missing.
 */

import { join } from "path";
import { readFileSync } from "fs";

const DEFAULTS = {
  agent: "agent-main",
};

let _cache = null;
let _cachedWorkspace = null;

export function loadEngramConfig(workspace) {
  if (_cache && _cachedWorkspace === workspace) return _cache;
  
  try {
    const raw = readFileSync(join(workspace, "engram.json"), "utf-8");
    _cache = { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    _cache = { ...DEFAULTS };
  }
  _cachedWorkspace = workspace;
  return _cache;
}

export function getAgentDir(workspace) {
  const config = loadEngramConfig(workspace);
  return config.agent;
}
