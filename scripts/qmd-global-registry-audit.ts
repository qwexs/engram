#!/usr/bin/env bun
import {
  auditLegacyCollectionClaims,
  auditQmdGlobalRegistry,
  readLegacyWorkspaceClaim,
  readQmdGlobalRegistry,
} from "../src/qmd/global-registry.ts";

function values(argv: string[], flag: string): string[] {
  const result: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === flag && argv[index + 1]) {
      result.push(argv[index + 1]!);
      index += 1;
    }
  }
  return result;
}

const args = process.argv.slice(2);
const registryPath = values(args, "--registry")[0];
const workspaces = values(args, "--workspace");
const json = args.includes("--json");

if (!registryPath && workspaces.length === 0) {
  console.error("Usage: qmd-global-registry-audit.ts [--registry <file>] [--workspace <path> ...] [--json]");
  process.exit(2);
}

try {
  const input = registryPath ? readQmdGlobalRegistry(registryPath) : undefined;
  const candidate = input
    && typeof input === "object"
    && !Array.isArray(input)
    && (input as Record<string, unknown>).schema === "engram.qmd.global-migration.v1"
    ? (input as Record<string, unknown>).registry
    : input;
  const registry = candidate ? auditQmdGlobalRegistry(candidate) : undefined;
  const legacyFindings = auditLegacyCollectionClaims(workspaces.map(readLegacyWorkspaceClaim));
  const errors = (registry?.summary.errors ?? 0) + legacyFindings.length;
  const output = {
    schema: "engram.qmd.global-registry-preflight.v1",
    ok: errors === 0,
    registry: registry ?? null,
    legacy: {
      workspaces: workspaces.length,
      findings: legacyFindings,
    },
  };
  if (json) console.log(JSON.stringify(output, null, 2));
  else {
    console.log(`Global QMD registry preflight: ${output.ok ? "ok" : "blocked"}`);
    if (registry) console.log(`Registry: ${registry.summary.workspaces} workspaces, ${registry.summary.collections} collections, ${registry.summary.errors} errors`);
    console.log(`Legacy claims: ${workspaces.length} workspaces, ${legacyFindings.length} collisions`);
    for (const entry of [...(registry?.findings ?? []), ...legacyFindings]) {
      console.log(`- ${entry.code}: ${entry.message}`);
    }
  }
  process.exit(output.ok ? 0 : 2);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (json) console.log(JSON.stringify({ schema: "engram.qmd.global-registry-preflight.v1", ok: false, error: message }));
  else console.error(`Global QMD registry preflight failed: ${message}`);
  process.exit(2);
}
