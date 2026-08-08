import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

type UnknownRecord = Record<string, unknown>;

export type QmdRegistryWorkspaceKind = "technical" | "business";

export type QmdRegistryWorkspace = {
  id: string;
  path: string;
  kind: QmdRegistryWorkspaceKind;
  parents: string[];
  readableCollections: string[];
};

export type QmdRegistryCollection = {
  name: string;
  path: string;
  owner: string;
  mask: string;
};

export type QmdGlobalRegistry = {
  schema: "engram.qmd.global-registry.v1";
  index: { name: string };
  workspaces: QmdRegistryWorkspace[];
  collections: QmdRegistryCollection[];
};

export type QmdRegistryFindingCode =
  | "INVALID_SCHEMA"
  | "INVALID_INDEX"
  | "INVALID_WORKSPACE"
  | "DUPLICATE_WORKSPACE"
  | "DUPLICATE_WORKSPACE_PATH"
  | "UNKNOWN_PARENT"
  | "WORKSPACE_CYCLE"
  | "INVALID_COLLECTION"
  | "DUPLICATE_COLLECTION"
  | "DUPLICATE_COLLECTION_PATH"
  | "OVERLAPPING_COLLECTION_PATH"
  | "UNKNOWN_OWNER"
  | "COLLECTION_OUTSIDE_OWNER"
  | "UNKNOWN_READABLE_COLLECTION"
  | "OWN_COLLECTION_NOT_READABLE"
  | "TECHNICAL_SCOPE_ESCAPE"
  | "HORIZONTAL_OR_UPWARD_ACCESS"
  | "LEGACY_DUPLICATE_COLLECTION_CLAIM";

export type QmdRegistryFinding = {
  severity: "error" | "warning";
  code: QmdRegistryFindingCode;
  message: string;
  details?: Record<string, unknown>;
};

export type QmdRegistryAuditResult = {
  schema: "engram.qmd.global-registry-audit.v1";
  ok: boolean;
  findings: QmdRegistryFinding[];
  summary: {
    workspaces: number;
    collections: number;
    errors: number;
    warnings: number;
  };
};

export type LegacyWorkspaceClaim = {
  workspace: string;
  collections: string[];
};

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) {
    return undefined;
  }
  return value.map((item) => (item as string).trim());
}

function canonicalPath(path: string): string {
  const absolute = resolve(path);
  if (existsSync(absolute)) return realpathSync(absolute);
  const parent = dirname(absolute);
  return parent === absolute
    ? absolute
    : resolve(canonicalPath(parent), absolute.slice(parent.length + (parent.endsWith("/") ? 0 : 1)));
}

function isDescendantPath(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path !== "" && !path.startsWith("..") && !isAbsolute(path);
}

function isWithinPath(parent: string, child: string): boolean {
  return parent === child || isDescendantPath(parent, child);
}

function finding(
  code: QmdRegistryFindingCode,
  message: string,
  details?: Record<string, unknown>,
  severity: QmdRegistryFinding["severity"] = "error",
): QmdRegistryFinding {
  return { severity, code, message, ...(details ? { details } : {}) };
}

function parseWorkspace(value: unknown, index: number, findings: QmdRegistryFinding[]): QmdRegistryWorkspace | undefined {
  if (!isRecord(value)
    || typeof value.id !== "string" || value.id.trim() === ""
    || typeof value.path !== "string" || !isAbsolute(value.path)
    || (value.kind !== "technical" && value.kind !== "business")) {
    findings.push(finding("INVALID_WORKSPACE", "Registry workspace is malformed.", { index }));
    return undefined;
  }
  const parents = stringArray(value.parents);
  const readableCollections = stringArray(value.readableCollections);
  if (!parents || !readableCollections) {
    findings.push(finding("INVALID_WORKSPACE", "Workspace parents/readableCollections must be string arrays.", {
      index,
      workspace: value.id,
    }));
    return undefined;
  }
  return {
    id: value.id.trim(),
    path: canonicalPath(value.path),
    kind: value.kind,
    parents: [...new Set(parents)],
    readableCollections: [...new Set(readableCollections)],
  };
}

function parseCollection(value: unknown, index: number, findings: QmdRegistryFinding[]): QmdRegistryCollection | undefined {
  if (!isRecord(value)
    || typeof value.name !== "string" || value.name.trim() === ""
    || typeof value.path !== "string" || !isAbsolute(value.path)
    || typeof value.owner !== "string" || value.owner.trim() === ""
    || typeof value.mask !== "string" || value.mask.trim() === "") {
    findings.push(finding("INVALID_COLLECTION", "Registry collection is malformed.", { index }));
    return undefined;
  }
  return {
    name: value.name.trim(),
    path: canonicalPath(value.path),
    owner: value.owner.trim(),
    mask: value.mask.trim(),
  };
}

function descendantsOf(workspace: string, children: Map<string, Set<string>>): Set<string> {
  const descendants = new Set<string>();
  const pending = [...(children.get(workspace) ?? [])];
  while (pending.length > 0) {
    const child = pending.pop()!;
    if (descendants.has(child)) continue;
    descendants.add(child);
    pending.push(...(children.get(child) ?? []));
  }
  return descendants;
}

export function auditQmdGlobalRegistry(input: unknown): QmdRegistryAuditResult {
  const findings: QmdRegistryFinding[] = [];
  if (!isRecord(input) || input.schema !== "engram.qmd.global-registry.v1") {
    findings.push(finding("INVALID_SCHEMA", "Registry schema must be engram.qmd.global-registry.v1."));
  }
  const index = isRecord(input) && isRecord(input.index) ? input.index : {};
  if (typeof index.name !== "string" || index.name.trim() === "" || /[\\/]/.test(index.name)) {
    findings.push(finding("INVALID_INDEX", "Global registry requires one non-path named index."));
  }

  const rawWorkspaces = isRecord(input) && Array.isArray(input.workspaces) ? input.workspaces : [];
  const rawCollections = isRecord(input) && Array.isArray(input.collections) ? input.collections : [];
  if (rawWorkspaces.length === 0) {
    findings.push(finding("INVALID_WORKSPACE", "Registry must declare at least one workspace."));
  }
  if (rawCollections.length === 0) {
    findings.push(finding("INVALID_COLLECTION", "Registry must declare at least one collection."));
  }
  const workspaces = rawWorkspaces
    .map((value, itemIndex) => parseWorkspace(value, itemIndex, findings))
    .filter((value): value is QmdRegistryWorkspace => Boolean(value));
  const collections = rawCollections
    .map((value, itemIndex) => parseCollection(value, itemIndex, findings))
    .filter((value): value is QmdRegistryCollection => Boolean(value));

  const workspaceMap = new Map<string, QmdRegistryWorkspace>();
  const workspacePathMap = new Map<string, QmdRegistryWorkspace>();
  for (const workspace of workspaces) {
    if (workspaceMap.has(workspace.id)) {
      findings.push(finding("DUPLICATE_WORKSPACE", "Workspace id is declared more than once.", {
        workspace: workspace.id,
      }));
    } else {
      workspaceMap.set(workspace.id, workspace);
    }
    const samePath = workspacePathMap.get(workspace.path);
    if (samePath) {
      findings.push(finding("DUPLICATE_WORKSPACE_PATH", "Two workspace ids resolve to the same canonical path.", {
        workspace: workspace.id,
        otherWorkspace: samePath.id,
        path: workspace.path,
      }));
    } else {
      workspacePathMap.set(workspace.path, workspace);
    }
  }

  const children = new Map<string, Set<string>>();
  for (const workspace of workspaceMap.values()) {
    if (workspace.kind === "technical" && workspace.parents.length > 0) {
      findings.push(finding("INVALID_WORKSPACE", "Technical workspaces cannot join the business hierarchy.", {
        workspace: workspace.id,
      }));
    }
    for (const parent of workspace.parents) {
      if (!workspaceMap.has(parent)) {
        findings.push(finding("UNKNOWN_PARENT", "Workspace parent is not registered.", {
          workspace: workspace.id,
          parent,
        }));
        continue;
      }
      const entries = children.get(parent) ?? new Set<string>();
      entries.add(workspace.id);
      children.set(parent, entries);
    }
  }
  for (const workspace of workspaceMap.keys()) {
    if (descendantsOf(workspace, children).has(workspace)) {
      findings.push(finding("WORKSPACE_CYCLE", "Workspace hierarchy contains a cycle.", { workspace }));
    }
  }

  const collectionMap = new Map<string, QmdRegistryCollection>();
  const collectionPathMap = new Map<string, QmdRegistryCollection>();
  for (const collection of collections) {
    if (collectionMap.has(collection.name)) {
      findings.push(finding("DUPLICATE_COLLECTION", "Collection name is not globally unique.", {
        collection: collection.name,
      }));
    } else {
      collectionMap.set(collection.name, collection);
    }
    const samePath = collectionPathMap.get(collection.path);
    if (samePath) {
      findings.push(finding("DUPLICATE_COLLECTION_PATH", "Two collections index the same canonical path.", {
        collection: collection.name,
        otherCollection: samePath.name,
        path: collection.path,
      }));
    } else {
      collectionPathMap.set(collection.path, collection);
    }
    if (!workspaceMap.has(collection.owner)) {
      findings.push(finding("UNKNOWN_OWNER", "Collection owner workspace is not registered.", {
        collection: collection.name,
        owner: collection.owner,
      }));
    } else {
      const owner = workspaceMap.get(collection.owner)!;
      if (!isWithinPath(owner.path, collection.path)) {
        findings.push(finding("COLLECTION_OUTSIDE_OWNER", "Collection path must be inside its owner workspace.", {
          collection: collection.name,
          path: collection.path,
          owner: owner.id,
          ownerPath: owner.path,
        }));
      }
    }
  }

  for (let left = 0; left < collections.length; left += 1) {
    for (let right = left + 1; right < collections.length; right += 1) {
      const a = collections[left]!;
      const b = collections[right]!;
      if (a.path === b.path) continue;
      if (isDescendantPath(a.path, b.path) || isDescendantPath(b.path, a.path)) {
        findings.push(finding("OVERLAPPING_COLLECTION_PATH", "Collection roots overlap; QMD reuses vectors by content hash, but documents/search hits may be duplicated.", {
          collection: a.name,
          path: a.path,
          otherCollection: b.name,
          otherPath: b.path,
        }, "warning"));
      }
    }
  }

  for (const workspace of workspaceMap.values()) {
    const descendants = descendantsOf(workspace.id, children);
    const ownCollections = collections
      .filter((collection) => collection.owner === workspace.id)
      .map((collection) => collection.name);
    for (const own of ownCollections) {
      if (!workspace.readableCollections.includes(own)) {
        findings.push(finding("OWN_COLLECTION_NOT_READABLE", "Owner cannot omit its own collection from readable scope.", {
          workspace: workspace.id,
          collection: own,
        }));
      }
    }
    for (const name of workspace.readableCollections) {
      const collection = collectionMap.get(name);
      if (!collection) {
        findings.push(finding("UNKNOWN_READABLE_COLLECTION", "Readable scope references an unknown collection.", {
          workspace: workspace.id,
          collection: name,
        }));
        continue;
      }
      if (collection.owner === workspace.id) continue;
      if (workspace.kind === "technical") {
        findings.push(finding("TECHNICAL_SCOPE_ESCAPE", "Technical workspace cannot read business workspace collections.", {
          workspace: workspace.id,
          collection: name,
          owner: collection.owner,
        }));
      } else if (!descendants.has(collection.owner)) {
        findings.push(finding("HORIZONTAL_OR_UPWARD_ACCESS", "Business workspace can read only its own or descendant workspace collections.", {
          workspace: workspace.id,
          collection: name,
          owner: collection.owner,
        }));
      }
    }
  }

  const errors = findings.filter((entry) => entry.severity === "error").length;
  const warnings = findings.length - errors;
  return {
    schema: "engram.qmd.global-registry-audit.v1",
    ok: errors === 0,
    findings,
    summary: { workspaces: workspaceMap.size, collections: collectionMap.size, errors, warnings },
  };
}

export function readQmdGlobalRegistry(path: string): unknown {
  return JSON.parse(readFileSync(resolve(path), "utf8")) as unknown;
}

export function readLegacyWorkspaceClaim(workspacePath: string): LegacyWorkspaceClaim {
  const workspace = canonicalPath(workspacePath);
  const config = JSON.parse(readFileSync(resolve(workspace, "engram.json"), "utf8")) as unknown;
  const qmd = isRecord(config) && isRecord(config.qmd) ? config.qmd : {};
  const configured = stringArray(qmd.collections);
  const primary = typeof qmd.collection === "string" && qmd.collection.trim() !== ""
    ? [qmd.collection.trim()]
    : [];
  return { workspace, collections: [...new Set(configured ?? primary)] };
}

export function auditLegacyCollectionClaims(claims: LegacyWorkspaceClaim[]): QmdRegistryFinding[] {
  const owners = new Map<string, Set<string>>();
  for (const claim of claims) {
    for (const collection of claim.collections) {
      const workspaces = owners.get(collection) ?? new Set<string>();
      workspaces.add(canonicalPath(claim.workspace));
      owners.set(collection, workspaces);
    }
  }
  return [...owners.entries()]
    .filter(([, workspaces]) => workspaces.size > 1)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([collection, workspaces]) => finding(
      "LEGACY_DUPLICATE_COLLECTION_CLAIM",
      "Legacy workspace configs claim the same collection name; rename before global-index migration.",
      { collection, workspaces: [...workspaces].sort() },
    ));
}
