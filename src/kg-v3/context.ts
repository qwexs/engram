import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { KG_V3_SCHEMA_DIGEST } from "./core.ts";
import { KG_V3_AUTHORITY_SCHEMA, type KgAuthorityMarkerV1 } from "./types.ts";
import { defaultContextArchiveLeakage } from "./benchmark.ts";

export interface KgDefaultContextV1 {
  schema: "engram.kg-v3-default-context.v1";
  workspaceId: string;
  releaseDigest: `sha256:${string}`;
  mode: "v2-current" | "v3-current";
  sources: string[];
  embeddedBodies?: string[];
  archiveIncludedInDefault: boolean;
  switchedAt: string;
}

/** Runtime bootstrap consumer: resolves only guarded manifest sources. */
export function resolveKgDefaultContext(options: { workspace: string; workspaceId: string }): { mode: "v2-current" | "v3-current"; sources: string[]; archiveIncludedInDefault: boolean } {
  const workspace = resolve(options.workspace);
  const state = join(workspace, "memory-state", "kg-v3");
  const contextPath = join(state, "default-context.json");
  const authorityPath = join(state, "authority.json");
  if (!existsSync(contextPath)) return { mode: "v2-current", sources: ["life/_derived/facts-active.md"], archiveIncludedInDefault: true };
  if (!existsSync(authorityPath)) throw new Error("KG v3 default-context manifest has no authority marker");
  const context = JSON.parse(readFileSync(contextPath, "utf8")) as KgDefaultContextV1;
  const marker = JSON.parse(readFileSync(authorityPath, "utf8")) as KgAuthorityMarkerV1;
  if (context.schema !== "engram.kg-v3-default-context.v1" || context.workspaceId !== options.workspaceId || context.mode !== "v3-current" || !/^sha256:[a-f0-9]{64}$/.test(context.releaseDigest)) throw new Error("invalid KG v3 default-context manifest");
  if (marker.schema !== KG_V3_AUTHORITY_SCHEMA || marker.workspaceId !== options.workspaceId || !["canary", "enabled"].includes(marker.mode) || marker.releaseDigest !== context.releaseDigest || marker.schemaDigest !== KG_V3_SCHEMA_DIGEST) throw new Error("KG v3 default-context authority mismatch");
  if (defaultContextArchiveLeakage(context)) throw new Error("KG v3 default-context archive leakage");
  if (context.sources.length !== 1 || context.sources[0] !== "life/v3/current-summary.md") throw new Error("KG v3 default-context source is not canonical current projection");
  return { mode: "v3-current", sources: [...context.sources], archiveIncludedInDefault: false };
}
