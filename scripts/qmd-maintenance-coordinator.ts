#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { auditQmdGlobalRegistry, type QmdGlobalRegistry } from "../src/qmd/global-registry.ts";
import { markGlobalQmdBackfill, runGlobalQmdMaintenance } from "../src/qmd/maintenance-adapter.ts";

type Options = Record<string, string | boolean>;

function parseArgs(argv: string[]): Options {
  const options: Options = {};
  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith("--")) throw new Error(`unexpected argument: ${token}`);
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      options[key] = next;
      index += 1;
    } else {
      options[key] = true;
    }
  }
  return options;
}

function required(options: Options, key: string): string {
  const value = options[key];
  if (typeof value !== "string" || value.trim() === "") throw new Error(`--${key} is required`);
  return value;
}

function readRegistry(path: string): QmdGlobalRegistry {
  const parsed = JSON.parse(readFileSync(resolve(path), "utf8")) as Record<string, unknown>;
  const registry = parsed.schema === "engram.qmd.global-registry.v1"
    ? parsed as unknown as QmdGlobalRegistry
    : parsed.registry as QmdGlobalRegistry;
  const audit = auditQmdGlobalRegistry(registry);
  if (!audit.ok) throw new Error(`global registry is invalid: ${JSON.stringify(audit.findings)}`);
  return registry;
}

function selectedCollections(options: Options, registry: QmdGlobalRegistry): string[] {
  const requested = typeof options.collections === "string"
    ? options.collections.split(",").map((value) => value.trim()).filter(Boolean)
    : registry.collections.map((entry) => entry.name);
  const collections = [...new Set(requested)].sort();
  if (collections.length === 0) throw new Error("--collections must contain at least one collection");
  const allowed = new Set(registry.collections.map((entry) => entry.name));
  const unknown = collections.filter((collection) => !allowed.has(collection));
  if (unknown.length > 0) throw new Error(`--collections contains names outside the registry: ${unknown.join(", ")}`);
  return collections;
}

const options = parseArgs(process.argv);
if (options.help || options.h) {
  console.log(`qmd-maintenance-coordinator

Usage:
  bun scripts/qmd-maintenance-coordinator.ts --manifest <path> --workspace <path> [--collections <a,b,...>] [--initial-backfill] [--allow-partial-dirty-scope] [--state-root <path>] [--timeout-ms <ms>]

The manifest may be a global registry or a migration/provisioning manifest
containing a registry. This command is the only coordinated execution entry
point; workspace heartbeats delegate when maintenance.mode=coordinated.

Without --collections, routine maintenance uses the full registry. An
--initial-backfill requires an explicit --collections subset and marks only
that subset vector-dirty before the pass; it never implies a full-index run.`);
  process.exit(0);
}

try {
  const registry = readRegistry(required(options, "manifest"));
  const timeoutRaw = options["timeout-ms"];
  const timeoutMs = typeof timeoutRaw === "string" ? Number(timeoutRaw) : undefined;
  if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)) {
    throw new Error("--timeout-ms must be a positive integer");
  }
  if (options["initial-backfill"] && typeof options.collections !== "string") {
    throw new Error("--initial-backfill requires an explicit --collections subset");
  }
  if (options["allow-partial-dirty-scope"] && typeof options.collections !== "string") {
    throw new Error("--allow-partial-dirty-scope requires an explicit --collections subset");
  }
  const workspace = required(options, "workspace");
  const collections = selectedCollections(options, registry);
  const stateRoot = typeof options["state-root"] === "string" ? resolve(options["state-root"]) : undefined;
  const backfill = options["initial-backfill"]
    ? await markGlobalQmdBackfill({ workspace, collections, expectedIndex: registry.index.name, stateRoot })
    : undefined;
  const result = await runGlobalQmdMaintenance({
    workspace,
    collections,
    expectedIndex: registry.index.name,
    stateRoot,
    timeoutMs,
    allowPartialDirtyScope: options["allow-partial-dirty-scope"] === true,
  });
  console.log(JSON.stringify({ ...result, ...(backfill ? { backfill } : {}) }));
  process.exit(result.status === "error" || result.status === "partial" ? 1 : 0);
} catch (error) {
  console.error(JSON.stringify({
    schema: "engram.qmd.maintenance-cli-error.v1",
    error: error instanceof Error ? error.message : String(error),
  }));
  process.exit(1);
}
