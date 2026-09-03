import { existsSync, lstatSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { splitCanonicalSessionKey } from "../session-key.ts";
import { auditQmdGlobalRegistry, type QmdGlobalRegistry } from "../qmd/global-registry.ts";

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

function fail(message: string): never { throw new Error(message); }
function nonEmpty(value: unknown, label: string): string { if (typeof value !== "string" || !value.trim()) fail(`${label} is required`); return value.trim(); }
function dateInTimezone(instant: string, timezone: string): string { return new Intl.DateTimeFormat("sv-SE", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(instant)); }
function isSymlink(path: string): boolean { try { return lstatSync(path).isSymbolicLink(); } catch { return false; } }

function normalizeManifest(input: QmdRegistryManifestInput): QmdGlobalRegistry {
  const registry = "registry" in input ? input.registry : input;
  const audit = auditQmdGlobalRegistry(registry);
  if (!audit.ok) fail(`registry invalid: ${audit.findings.map((f) => f.code).join(",")}`);
  return registry;
}

export function preflightCanaryQmdBinding(input: QmdBindingPreflightInput): QmdBindingPreflightResult {
  const workspace = resolve(input.workspace);
  if (resolve(input.context.workspace) !== workspace) fail("workspace mismatch");
  const registry = normalizeManifest(input.manifest);
  if (input.context.selector.kind !== "named" || input.context.selector.name !== registry.index.name) fail("wrong index");
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
