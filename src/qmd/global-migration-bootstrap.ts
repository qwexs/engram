import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { resolveQmdContext } from "./context.ts";
import type { QmdGlobalMigrationManifest, QmdMigrationWorkspace } from "./global-migration.ts";
import {
  auditQmdGlobalRegistry,
  type QmdGlobalRegistry,
  type QmdRegistryCollection,
  type QmdRegistryWorkspace,
} from "./global-registry.ts";

type RawWorkspace = { id: string; path: string; kind: "technical" | "business"; parents: string[] };
export type QmdMigrationTopology = {
  schema: "engram.qmd.global-migration-topology.v1";
  index: { name: string; path: string };
  workspaces: RawWorkspace[];
};

const hash = (source: string) => createHash("sha256").update(source).digest("hex");
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected object");
  return value as Record<string, unknown>;
};

function descendants(id: string, workspaces: RawWorkspace[]): Set<string> {
  const result = new Set<string>();
  const pending = workspaces.filter((entry) => entry.parents.includes(id)).map((entry) => entry.id);
  while (pending.length > 0) {
    const child = pending.pop()!;
    if (result.has(child)) continue;
    result.add(child);
    pending.push(...workspaces.filter((entry) => entry.parents.includes(child)).map((entry) => entry.id));
  }
  return result;
}

export function readQmdMigrationTopology(path: string): QmdMigrationTopology {
  const raw = record(JSON.parse(readFileSync(resolve(path), "utf8")));
  if (raw.schema !== "engram.qmd.global-migration-topology.v1") throw new Error("invalid topology schema");
  const index = record(raw.index);
  if (typeof index.name !== "string" || typeof index.path !== "string" || !isAbsolute(index.path)) {
    throw new Error("topology requires a named index and absolute path");
  }
  if (!Array.isArray(raw.workspaces)) throw new Error("topology workspaces must be an array");
  return raw as QmdMigrationTopology;
}

export function bootstrapQmdGlobalMigration(topology: QmdMigrationTopology): QmdGlobalMigrationManifest {
  const rawCollections: Array<QmdRegistryCollection & { legacyName: string }> = [];
  const configs = new Map<string, { source: string; qmd: Record<string, unknown>; domainHash?: string }>();
  for (const workspace of topology.workspaces) {
    const configPath = join(workspace.path, "engram.json");
    const source = readFileSync(configPath, "utf8");
    const config = record(JSON.parse(source));
    const qmd = record(config.qmd ?? {});
    const names = Array.isArray(qmd.collections) ? qmd.collections.map(String) : [String(qmd.collection ?? "")].filter(Boolean);
    const context = resolveQmdContext({ value: workspace.path, source: "explicit" });
    if (!context.physicalIndex.exists) throw new Error(`${workspace.id}: current physical index is missing`);
    const db = new Database(context.physicalIndex.path, { readonly: true });
    try {
      for (const name of names) {
        const row = db.query("SELECT path, pattern FROM store_collections WHERE name = ?").get(name) as { path?: string; pattern?: string } | null;
        if (!row?.path) throw new Error(`${workspace.id}: owned collection is not registered: ${name}`);
        rawCollections.push({ name, legacyName: name, path: resolve(row.path), owner: workspace.id, mask: row.pattern || "**/*.md" });
      }
    } finally {
      db.close();
    }
    const domainPath = join(workspace.path, "memory", "domains", "registry.json");
    configs.set(workspace.id, {
      source,
      qmd,
      ...(existsSync(domainPath) ? { domainHash: hash(readFileSync(domainPath, "utf8")) } : {}),
    });
  }

  const counts = new Map<string, number>();
  for (const item of rawCollections) counts.set(item.name, (counts.get(item.name) ?? 0) + 1);
  const renamed = rawCollections.map((item) => ({
    ...item,
    name: (counts.get(item.name) ?? 0) > 1 ? `${item.owner}-${item.name}` : item.name,
  }));
  const ownedBy = (id: string) => renamed.filter((entry) => entry.owner === id);
  const registryWorkspaces: QmdRegistryWorkspace[] = topology.workspaces.map((workspace) => {
    const readableOwners = workspace.kind === "technical"
      ? new Set([workspace.id])
      : new Set([workspace.id, ...descendants(workspace.id, topology.workspaces)]);
    return {
      ...workspace,
      path: resolve(workspace.path),
      readableCollections: renamed.filter((entry) => readableOwners.has(entry.owner)).map((entry) => entry.name).sort(),
    };
  });
  const collections: QmdRegistryCollection[] = renamed.map(({ legacyName: _legacyName, ...entry }) => entry);
  const migrationWorkspaces: QmdMigrationWorkspace[] = topology.workspaces.map((workspace) => {
    const config = configs.get(workspace.id)!;
    const owned = ownedBy(workspace.id);
    const rename = Object.fromEntries(owned.filter((entry) => entry.name !== entry.legacyName).map((entry) => [entry.legacyName, entry.name]));
    const primaryLegacy = String(config.qmd.collection ?? "");
    const primary = owned.find((entry) => entry.legacyName === primaryLegacy)?.name;
    if (!primary) throw new Error(`${workspace.id}: primary collection is not owned`);
    const kg = owned.find((entry) => entry.legacyName === "life")?.name;
    const ops = owned.find((entry) => entry.legacyName === "ops")?.name;
    return {
      id: workspace.id,
      primaryCollection: primary,
      ...(kg ? { kgCollection: kg } : {}),
      ...(ops ? { opsCollection: ops } : {}),
      ...(Object.keys(rename).length ? { collectionRenames: rename } : {}),
      expectedSha256: {
        engramConfig: hash(config.source),
        ...(config.domainHash ? { domainRegistry: config.domainHash } : {}),
      },
    };
  });
  const registry: QmdGlobalRegistry = {
    schema: "engram.qmd.global-registry.v1",
    index: { name: topology.index.name },
    workspaces: registryWorkspaces,
    collections,
  };
  const audit = auditQmdGlobalRegistry(registry);
  if (!audit.ok) throw new Error(`bootstrapped registry is invalid: ${JSON.stringify(audit.findings)}`);
  return {
    schema: "engram.qmd.global-migration.v1",
    registry,
    indexPath: topology.index.path,
    workspaces: migrationWorkspaces,
  };
}
