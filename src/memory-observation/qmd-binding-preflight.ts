import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { splitCanonicalSessionKey } from "../session-key.ts";
import { auditQmdGlobalRegistry, type QmdGlobalRegistry } from "../qmd/global-registry.ts";
import type { MemoryObservationQmdResolverV1 } from "./projection.ts";

export type QmdRegistryManifestWrapper = { registry: QmdGlobalRegistry };
export type QmdRegistryManifestInput = QmdGlobalRegistry | QmdRegistryManifestWrapper;

export type QmdContextLike = {
  workspace: string;
  physicalIndex: { path: string; key: string; exists: boolean };
  selector: { kind: "local" | "global" | "named"; name?: string };
  policy: { ownedCollections: string[]; readableCollections: string[] };
};

export type QmdBindingPreflightInput = {
  workspace: string;
  runtimeSessionKey: string;
  qmdCollection: string;
  timezone: string;
  applyAfter: string;
  manifest: QmdRegistryManifestInput;
  context: QmdContextLike;
};

export type QmdBindingPreflightResult = { collection: string; destinationDir: string; destinationFile: string; date: string };
export type RuntimeQmdBindingResult = QmdBindingPreflightResult & {
  bindingDigest: `sha256:${string}`;
  canonicalRoot: string;
  indexName: string;
  indexKey: string;
  workspaceRegistryDigest: `sha256:${string}`;
};

function fail(message: string): never { throw new Error(message); }
function nonEmpty(value: unknown, label: string): string { if (typeof value !== "string" || !value.trim()) fail(`${label} is required`); return value.trim(); }
function dateInTimezone(instant: string, timezone: string): string { return new Intl.DateTimeFormat("sv-SE", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(instant)); }
function isSymlink(path: string): boolean { try { return lstatSync(path).isSymbolicLink(); } catch { return false; } }
function digest(value: string | Uint8Array): `sha256:${string}` { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }
function indexKey(path: string): string { return createHash("sha256").update(realpathSync(path)).digest("hex"); }
function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path !== "" && !path.startsWith("..") && !isAbsolute(path);
}

function normalizeManifest(input: QmdRegistryManifestInput): QmdGlobalRegistry {
  const registry = "registry" in input ? input.registry : input;
  const audit = auditQmdGlobalRegistry(registry);
  if (!audit.ok) fail(`registry invalid: ${audit.findings.map((f) => f.code).join(",")}`);
  return registry;
}

function registrySliceDigest(registry: QmdGlobalRegistry, workspaceId: string): `sha256:${string}` {
  const workspace = registry.workspaces.find((entry) => entry.id === workspaceId);
  if (!workspace) fail("workspace is missing from registry");
  const slice = {
    schema: "engram.qmd.workspace-registry-slice.v1",
    index: { name: registry.index.name },
    workspace: {
      id: workspace.id,
      path: realpathSync(workspace.path),
      kind: workspace.kind,
      parents: [...workspace.parents].sort(),
      readableCollections: [...workspace.readableCollections].sort(),
    },
    collections: registry.collections.filter((entry) => entry.owner === workspaceId)
      .map((entry) => ({ name: entry.name, owner: entry.owner, path: realpathSync(entry.path), mask: entry.mask }))
      .sort((left, right) => left.name.localeCompare(right.name) || left.path.localeCompare(right.path)),
  };
  return digest(JSON.stringify(slice));
}

export function preflightCanaryQmdBinding(input: QmdBindingPreflightInput): QmdBindingPreflightResult {
  const workspace = resolve(input.workspace);
  if (resolve(input.context.workspace) !== workspace) fail("workspace mismatch");
  const registry = normalizeManifest(input.manifest);
  if (input.context.selector.kind !== "named" || input.context.selector.name !== registry.index.name) fail("wrong index");
  if (!input.context.physicalIndex.exists
    || !existsSync(input.context.physicalIndex.path)
    || isSymlink(input.context.physicalIndex.path)
    || input.context.physicalIndex.key !== indexKey(input.context.physicalIndex.path)) fail("wrong physical index");
  const collection = nonEmpty(input.qmdCollection, "qmdCollection");
  if (!input.context.policy.ownedCollections.includes(collection) || !input.context.policy.readableCollections.includes(collection)) fail("unowned or unreadable collection");
  const matches = registry.collections.filter((entry) => entry.name === collection);
  if (matches.length !== 1) fail(matches.length === 0 ? "missing collection" : "duplicate collection");
  const entry = matches[0]!;
  const matchingWorkspace = registry.workspaces.find((workspaceEntry) => workspaceEntry.id === entry.owner);
  if (!matchingWorkspace) fail("wrong owner/workspace");
  if (realpathSync(matchingWorkspace.path) !== realpathSync(workspace)) fail("wrong owner/workspace");
  if (!input.context.policy.ownedCollections.includes(collection) || !matchingWorkspace.readableCollections.includes(collection)) fail("collection not readable/owned");
  if (entry.mask !== "*.md") fail("wrong mask");
  if (!existsSync(entry.path) || isSymlink(entry.path)) fail("symlink root escape");
  const split = splitCanonicalSessionKey(nonEmpty(input.runtimeSessionKey, "runtimeSessionKey"));
  if (!split) fail("invalid runtimeSessionKey");
  if (split.agentId !== matchingWorkspace.id) fail("wrong owner/workspace");
  const canonicalRoot = realpathSync(entry.path);
  const expectedRoot = join(workspace, "memory", `agent-${split.agentId}`, split.sessionKey);
  if (canonicalRoot !== realpathSync(expectedRoot)) fail("wrong root");
  const date = dateInTimezone(input.applyAfter, input.timezone);
  const destinationDir = canonicalRoot;
  const destinationFile = join(destinationDir, `${date}.md`);
  if (!resolve(destinationFile).startsWith(resolve(canonicalRoot) + sep)) fail("destination escapes collection root");
  if (existsSync(destinationFile) && isSymlink(destinationFile)) fail("symlink file escape");
  return { collection, destinationDir, destinationFile, date };
}

function readPinnedManifest(
  workspace: string,
  workspaceId: string,
  resolver: MemoryObservationQmdResolverV1,
): { manifest: QmdRegistryManifestInput; workspaceRegistryDigest: `sha256:${string}` } {
  const root = realpathSync(resolve(workspace));
  const manifestPath = resolve(resolver.manifestPath);
  if (!inside(root, manifestPath) || !existsSync(manifestPath) || isSymlink(manifestPath)) fail("manifest is outside workspace or unavailable");
  if (!statSync(manifestPath).isFile() || realpathSync(manifestPath) !== manifestPath) fail("manifest is not a canonical regular file");
  const raw = readFileSync(manifestPath);
  let manifest: unknown;
  try { manifest = JSON.parse(raw.toString("utf8")); }
  catch { fail("manifest is unreadable"); }
  const registry = normalizeManifest(manifest as QmdRegistryManifestInput);
  const workspaceRegistryDigest = registrySliceDigest(registry, workspaceId);
  if (workspaceRegistryDigest !== resolver.workspaceRegistryDigest) fail("workspace registry digest mismatch");
  return { manifest: manifest as QmdRegistryManifestInput, workspaceRegistryDigest };
}

export function defineCanaryQmdRuntimeResolver(input: {
  workspace: string;
  workspaceId: string;
  manifestPath: string;
  context: QmdContextLike;
}): MemoryObservationQmdResolverV1 {
  const workspace = realpathSync(resolve(input.workspace));
  const manifestPath = resolve(input.manifestPath);
  if (!inside(workspace, manifestPath) || !existsSync(manifestPath) || isSymlink(manifestPath)) fail("manifest is outside workspace or unavailable");
  const raw = readFileSync(manifestPath);
  const manifest = JSON.parse(raw.toString("utf8")) as QmdRegistryManifestInput;
  const registry = normalizeManifest(manifest);
  if (resolve(input.context.workspace) !== workspace
    || input.context.selector.kind !== "named"
    || input.context.selector.name !== registry.index.name
    || !input.context.physicalIndex.exists
    || !existsSync(input.context.physicalIndex.path)
    || isSymlink(input.context.physicalIndex.path)
    || input.context.physicalIndex.key !== indexKey(input.context.physicalIndex.path)) fail("runtime QMD context does not match the registry");
  const owner = registry.workspaces.filter((entry) => entry.id === input.workspaceId && realpathSync(entry.path) === workspace);
  if (owner.length !== 1) fail("runtime resolver requires one exact workspace owner");
  return {
    resolver: "exact-session-registry",
    manifestPath,
    workspaceRegistryDigest: registrySliceDigest(registry, input.workspaceId),
  };
}

export function resolveCanaryQmdRuntimeBinding(input: {
  workspace: string;
  runtimeSessionKey: string;
  timezone: string;
  destinationAt: string;
  resolver: MemoryObservationQmdResolverV1;
  context: QmdContextLike;
}): RuntimeQmdBindingResult {
  const workspace = realpathSync(resolve(input.workspace));
  if (input.runtimeSessionKey.includes("*")) fail("runtimeSessionKey must be exact");
  const split = splitCanonicalSessionKey(nonEmpty(input.runtimeSessionKey, "runtimeSessionKey"));
  if (!split) fail("invalid runtimeSessionKey");
  const { manifest, workspaceRegistryDigest } = readPinnedManifest(workspace, split.agentId, input.resolver);
  const registry = normalizeManifest(manifest);
  const expectedRoot = join(workspace, "memory", `agent-${split.agentId}`, split.sessionKey);
  if (!existsSync(expectedRoot) || isSymlink(expectedRoot)) fail("exact session root is unavailable");
  const canonicalRoot = realpathSync(expectedRoot);
  const candidates = registry.collections.filter((entry) => entry.owner === split.agentId
    && entry.mask === "*.md"
    && existsSync(entry.path)
    && !isSymlink(entry.path)
    && realpathSync(entry.path) === canonicalRoot);
  if (candidates.length !== 1) fail(candidates.length === 0 ? "missing exact-session collection" : "ambiguous exact-session collection");
  const result = preflightCanaryQmdBinding({
    workspace,
    runtimeSessionKey: input.runtimeSessionKey,
    qmdCollection: candidates[0]!.name,
    timezone: input.timezone,
    applyAfter: input.destinationAt,
    manifest,
    context: input.context,
  });
  return {
    ...result,
    canonicalRoot,
    indexName: registry.index.name,
    indexKey: input.context.physicalIndex.key,
    workspaceRegistryDigest,
    bindingDigest: digest([
      "engram.memory-observation-qmd-binding.v1",
      workspaceRegistryDigest,
      registry.index.name,
      input.context.physicalIndex.key,
      result.collection,
      canonicalRoot,
      input.runtimeSessionKey,
    ].join("\0")),
  };
}
