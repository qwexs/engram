#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { KgV3Core, KgV3Reader } from "../src/kg-v3/index.ts";
import type { KgRetractionRequest, KgWriteRequest, TrustedKgCallerContext } from "../src/kg-v3/index.ts";

// Operator/test harness only. --context is not a trusted agent ingress
// boundary: production activation must inject TrustedKgCallerContext from its
// runtime adapter, after verifying inbound metadata, and call KgV3Core directly.

function args(argv: string[]): Record<string, string | boolean> {
  const result: Record<string, string | boolean> = {};
  for (let index = 2; index < argv.length; index += 1) {
    const current = argv[index];
    if (!current.startsWith("--")) continue;
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) { result[current.slice(2)] = next; index += 1; }
    else result[current.slice(2)] = true;
  }
  return result;
}

function jsonFile<T>(value: string | boolean | undefined, label: string): T {
  if (typeof value !== "string") throw new Error(`--${label} is required`);
  return JSON.parse(readFileSync(resolve(value), "utf8")) as T;
}

const options = args(process.argv);
const command = String(options.command || "");
const workspace = resolve(String(options.workspace || process.env.ENGRAM_WORKSPACE || process.cwd()));
const workspaceId = String(options["workspace-id"] || "");
if (!workspaceId) throw new Error("--workspace-id is required");
const coreOptions = {
  workspace,
  workspaceId,
  ...(typeof options.registry === "string" ? { registryPath: resolve(options.registry) } : {}),
  ...(typeof options.authority === "string" ? { authorityPath: resolve(options.authority) } : {}),
};

let output: unknown;
if (command === "write") {
  output = new KgV3Core(coreOptions).write(
    jsonFile<KgWriteRequest>(options.request, "request"),
    jsonFile<TrustedKgCallerContext>(options.context, "context"),
  );
} else if (command === "retract") {
  output = new KgV3Core(coreOptions).retract(
    jsonFile<KgRetractionRequest>(options.request, "request"),
    jsonFile<TrustedKgCallerContext>(options.context, "context"),
  );
} else if (command === "current") {
  output = new KgV3Reader(coreOptions).current();
} else if (command === "historical-v2") {
  if (typeof options.entity !== "string") throw new Error("--entity is required");
  output = new KgV3Reader(coreOptions).historicalV2(options.entity);
} else if (command === "recover") {
  output = new KgV3Core(coreOptions).recover();
} else {
  throw new Error("--command must be write, retract, current, historical-v2, or recover");
}
console.log(JSON.stringify(output));