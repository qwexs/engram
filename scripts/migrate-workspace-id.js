#!/usr/bin/env bun

import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const WORKSPACE_ID_RE = /^[a-z][a-z0-9_-]{0,63}$/;

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
    } else {
      opts[key] = true;
    }
  }
  return opts;
}

export function migrateWorkspaceIdentity(config, requestedId = null) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("engram.json must contain an object");
  }
  if (config.schemaVersion !== undefined && config.schemaVersion !== 1) {
    throw new Error(`unsupported schemaVersion ${JSON.stringify(config.schemaVersion)}`);
  }

  const derived = requestedId || String(config.agent || "").replace(/^agent-/, "");
  const workspaceId = String(derived || "").trim();
  if (!WORKSPACE_ID_RE.test(workspaceId)) {
    throw new Error(`invalid workspace id ${JSON.stringify(workspaceId)}`);
  }

  const existing = config?.workspace?.id;
  if (existing !== undefined && existing !== null) {
    if (existing !== workspaceId) {
      throw new Error(`workspace.id conflict: existing=${JSON.stringify(existing)} requested=${JSON.stringify(workspaceId)}`);
    }
    return { changed: false, workspaceId, config };
  }
  if (config.workspace !== undefined && (typeof config.workspace !== "object" || Array.isArray(config.workspace))) {
    throw new Error("workspace must be an object");
  }

  const migrated = {
    schemaVersion: 1,
    workspace: { ...(config.workspace || {}), id: workspaceId },
    ...config,
  };
  migrated.schemaVersion = 1;
  migrated.workspace = { ...(config.workspace || {}), id: workspaceId };
  return { changed: true, workspaceId, config: migrated };
}

function emit(report, json) {
  console.log(json ? JSON.stringify(report) : JSON.stringify(report, null, 2));
}

if (import.meta.main) {
  const opts = parseArgs(process.argv);
  if (opts.help || opts.h) {
    console.log(`migrate-workspace-id.js

Adds schemaVersion=1 and the canonical workspace.id to engram.json.

Usage:
  bun skills/engram/scripts/migrate-workspace-id.js \\
    --workspace /path/to/workspace [--workspace-id managers] [--dry-run] [--json]
`);
    process.exit(0);
  }

  const workspace = resolve(opts.workspace || process.env.ENGRAM_WORKSPACE || process.cwd());
  const configPath = resolve(workspace, "engram.json");
  try {
    const source = readFileSync(configPath, "utf8");
    const current = JSON.parse(source);
    const result = migrateWorkspaceIdentity(current, opts["workspace-id"] || null);
    const report = {
      schema: "engram.workspace-id-migration.v1",
      workspace,
      workspaceId: result.workspaceId,
      mode: opts["dry-run"] ? "dry-run" : "apply",
      status: result.changed ? "migrated" : "unchanged",
      changed: result.changed,
    };
    if (result.changed && !opts["dry-run"]) {
      const temporary = resolve(dirname(configPath), `.engram.json.tmp-${randomUUID()}`);
      writeFileSync(temporary, JSON.stringify(result.config, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
      renameSync(temporary, configPath);
    }
    emit(report, Boolean(opts.json));
  } catch (error) {
    const report = {
      schema: "engram.workspace-id-migration.v1",
      workspace,
      status: "error",
      error: error?.message || String(error),
    };
    emit(report, Boolean(opts.json));
    process.exit(1);
  }
}
