#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { compileMemoryCandidateReportV2 } from "../src/oll/memory-candidate-compiler-v2";
import type { CandidateScopeRegistryV1, CandidateSourcePolicyV2 } from "../src/oll/memory-candidate-contracts-v2";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    workspace: { type: "string" },
    "snapshot-at": { type: "string" },
    "batch-id": { type: "string" },
    "policy-file": { type: "string" },
    "scope-registry-file": { type: "string" },
  },
  strict: true,
});

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(resolve(path), "utf8"));
}

try {
  if (!values.workspace) throw new Error("--workspace is required");
  const workspace = resolve(values.workspace);
  const config = readJson(resolve(workspace, "engram.json")) as Record<string, any>;
  const workspaceId = String(config?.workspace?.id || "");
  const policy = (values["policy-file"] ? readJson(values["policy-file"]) : config?.oll?.candidateCompiler) as CandidateSourcePolicyV2 | undefined;
  const scopeRegistry = (values["scope-registry-file"] ? readJson(values["scope-registry-file"]) : config?.oll?.candidateScopeRegistry) as CandidateScopeRegistryV1 | undefined;
  if (!policy) throw new Error("candidate policy is required via --policy-file or engram.json");
  if (!scopeRegistry) throw new Error("trusted scope registry is required via --scope-registry-file or engram.json");
  const snapshotAt = values["snapshot-at"] || new Date().toISOString();
  const batchId = values["batch-id"] || `report-only:${snapshotAt}`;
  const report = compileMemoryCandidateReportV2({ workspace, workspaceId, policy, scopeRegistry, snapshotAt, batchId });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} catch (error) {
  const message = String((error as Error)?.message || error)
    .replace(/\/(?:[^\s:"']+\/)+[^\s:"']*/g, "<private-path>");
  process.stderr.write(`${JSON.stringify({ schema: "oll.memory-candidate-cli-error.v1", status: "error", error: message })}\n`);
  process.exitCode = 1;
}
