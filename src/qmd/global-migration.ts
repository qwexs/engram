import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  auditQmdGlobalRegistry,
  type QmdGlobalRegistry,
  type QmdRegistryCollection,
} from "./global-registry.ts";

type JsonObject = Record<string, unknown>;

export type QmdMigrationWorkspace = {
  id: string;
  primaryCollection: string;
  kgCollection?: string;
  opsCollection?: string;
  collectionRenames?: Record<string, string>;
  expectedSha256: {
    engramConfig: string;
    domainRegistry?: string;
  };
};

export type QmdGlobalMigrationManifest = {
  schema: "engram.qmd.global-migration.v1";
  registry: QmdGlobalRegistry;
  indexPath: string;
  workspaces: QmdMigrationWorkspace[];
};

export type QmdMigrationFilePlan = {
  workspace: string;
  workspaceRoot: string;
  kind: "engram-config" | "domain-registry";
  path: string;
  beforeSha256: string;
  afterSha256: string;
  changed: boolean;
  content: string;
};

export type QmdMigrationPlan = {
  schema: "engram.qmd.global-migration-plan.v1";
  index: string;
  dryRun: true;
  files: QmdMigrationFilePlan[];
  summary: { workspaces: number; files: number; changed: number };
};

export type QmdMigrationBackupManifest = {
  schema: "engram.qmd.global-migration-backup.v1";
  index: string;
  createdAt: string;
  files: Array<{
    workspaceRoot: string;
    kind: QmdMigrationFilePlan["kind"];
    target: string;
    backup: string;
    beforeSha256: string;
    afterSha256: string;
  }>;
};

function object(value: unknown, label: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonObject;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function readJson(path: string): { value: JsonObject; source: string; sha256: string } {
  const source = readFileSync(path, "utf8");
  return { value: object(JSON.parse(source), path), source, sha256: sha256(source) };
}

function atomicWrite(path: string, content: string): void {
  const temp = join(dirname(path), `.${randomUUID()}.tmp`);
  const mode = existsSync(path) ? statSync(path).mode : 0o600;
  writeFileSync(temp, content, { mode });
  renameSync(temp, path);
}

function inside(parent: string, child: string): boolean {
  const value = relative(resolve(parent), resolve(child));
  return value === "" || (!value.startsWith("..") && !isAbsolute(value));
}

function mapped(value: unknown, renames: Record<string, string>): unknown {
  return typeof value === "string" ? (renames[value] ?? value) : value;
}

function mappedList(value: unknown, renames: Record<string, string>): unknown {
  if (!Array.isArray(value)) return value;
  return [...new Set(value.map((entry) => mapped(entry, renames)))];
}

function rewriteMetaDomains(root: JsonObject, readable: string[]): void {
  if (!root.domains || typeof root.domains !== "object" || Array.isArray(root.domains)) return;
  for (const raw of Object.values(root.domains as JsonObject)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const domain = raw as JsonObject;
    if (domain.type === "meta-domain" || domain.metaDomain === true) {
      domain.qmdCollections = [...readable];
    }
  }
}

function proposal(
  input: JsonObject,
  workspace: QmdGlobalRegistry["workspaces"][number],
  collections: QmdRegistryCollection[],
  spec: QmdMigrationWorkspace,
  index: string,
  indexPath: string,
): JsonObject {
  const output = structuredClone(input);
  const qmd = output.qmd && typeof output.qmd === "object" && !Array.isArray(output.qmd)
    ? output.qmd as JsonObject
    : {};
  const renames = spec.collectionRenames ?? {};
  qmd.collection = spec.primaryCollection;
  qmd.collections = collections.filter((entry) => entry.owner === workspace.id).map((entry) => entry.name).sort();
  qmd.index = index;
  qmd.localIndex = false;
  if (spec.kgCollection) qmd.workspaceKgCollection = spec.kgCollection;
  if (spec.opsCollection) qmd.opsCollection = spec.opsCollection;
  const maintenance = qmd.maintenance && typeof qmd.maintenance === "object" && !Array.isArray(qmd.maintenance)
    ? qmd.maintenance as JsonObject
    : {};
  // Raw workspace maintenance is removed before this migration. Once all
  // configs share the named index, heartbeats must delegate rather than retain
  // a per-workspace legacy execution path. The global coordinator remains
  // separately disabled until its explicit embedding gate is approved.
  maintenance.mode = "coordinated";
  qmd.maintenance = maintenance;
  const external = workspace.readableCollections.filter((name) =>
    !collections.some((entry) => entry.owner === workspace.id && entry.name === name));
  qmd.verticalAccess = external.length === 0 ? { enabled: false } : {
    enabled: true,
    indexPath,
    collections: Object.fromEntries(external.map((name) => {
      const collection = collections.find((entry) => entry.name === name)!;
      return [name, { path: collection.path }];
    })),
    requireMetaDomainReference: false,
    checkEmbeddings: false,
  };
  qmd.collection = mapped(qmd.collection, renames);
  qmd.collections = mappedList(qmd.collections, renames);
  output.qmd = qmd;
  rewriteMetaDomains(output, workspace.readableCollections);
  return output;
}

export function readQmdGlobalMigrationManifest(path: string): QmdGlobalMigrationManifest {
  const raw = object(JSON.parse(readFileSync(resolve(path), "utf8")), "migration manifest");
  if (raw.schema !== "engram.qmd.global-migration.v1") throw new Error("invalid migration manifest schema");
  const registry = raw.registry as QmdGlobalRegistry;
  const audit = auditQmdGlobalRegistry(registry);
  if (!audit.ok) throw new Error(`global registry is invalid: ${JSON.stringify(audit.findings)}`);
  if (typeof raw.indexPath !== "string" || !isAbsolute(raw.indexPath)) {
    throw new Error("migration indexPath must be absolute");
  }
  if (!Array.isArray(raw.workspaces)) throw new Error("migration workspaces must be an array");
  return raw as QmdGlobalMigrationManifest;
}

export function planQmdGlobalMigration(manifest: QmdGlobalMigrationManifest): QmdMigrationPlan {
  const specs = new Map(manifest.workspaces.map((entry) => [entry.id, entry]));
  if (specs.size !== manifest.registry.workspaces.length) throw new Error("migration must cover every registry workspace exactly once");
  const files: QmdMigrationFilePlan[] = [];
  for (const workspace of manifest.registry.workspaces) {
    const spec = specs.get(workspace.id);
    if (!spec) throw new Error(`missing migration workspace: ${workspace.id}`);
    const owned = manifest.registry.collections.filter((entry) => entry.owner === workspace.id).map((entry) => entry.name);
    if (!owned.includes(spec.primaryCollection)) throw new Error(`${workspace.id}: primary collection is not owned`);
    for (const optional of [spec.kgCollection, spec.opsCollection].filter(Boolean) as string[]) {
      if (!owned.includes(optional)) throw new Error(`${workspace.id}: special collection is not owned: ${optional}`);
    }
    const configPath = join(workspace.path, "engram.json");
    const config = readJson(configPath);
    if (config.sha256 !== spec.expectedSha256.engramConfig) throw new Error(`${workspace.id}: engram.json hash drift`);
    const nextConfig = json(proposal(config.value, workspace, manifest.registry.collections, spec, manifest.registry.index.name, manifest.indexPath));
    files.push({
      workspace: workspace.id,
      workspaceRoot: workspace.path,
      kind: "engram-config",
      path: configPath,
      beforeSha256: config.sha256,
      afterSha256: sha256(nextConfig),
      changed: config.source !== nextConfig,
      content: nextConfig,
    });

    const registryPath = join(workspace.path, "memory", "domains", "registry.json");
    if (existsSync(registryPath)) {
      const domainRegistry = readJson(registryPath);
      if (!spec.expectedSha256.domainRegistry || domainRegistry.sha256 !== spec.expectedSha256.domainRegistry) {
        throw new Error(`${workspace.id}: domain registry hash drift`);
      }
      const nextRegistry = structuredClone(domainRegistry.value);
      rewriteMetaDomains(nextRegistry, workspace.readableCollections);
      const content = json(nextRegistry);
      files.push({
        workspace: workspace.id,
        workspaceRoot: workspace.path,
        kind: "domain-registry",
        path: registryPath,
        beforeSha256: domainRegistry.sha256,
        afterSha256: sha256(content),
        changed: domainRegistry.source !== content,
        content,
      });
    } else if (spec.expectedSha256.domainRegistry) {
      throw new Error(`${workspace.id}: expected domain registry is missing`);
    }
  }
  const changed = files.filter((entry) => entry.changed).length;
  return {
    schema: "engram.qmd.global-migration-plan.v1",
    index: manifest.registry.index.name,
    dryRun: true,
    files,
    summary: { workspaces: manifest.registry.workspaces.length, files: files.length, changed },
  };
}

export function applyQmdGlobalMigration(
  plan: QmdMigrationPlan,
  backupDirectory: string,
  confirmedIndex: string,
): QmdMigrationBackupManifest {
  if (confirmedIndex !== plan.index) throw new Error("confirmed index does not match migration plan");
  const backupRoot = resolve(backupDirectory);
  if (existsSync(backupRoot)) throw new Error("backup directory must not already exist");
  const workspaceRoots = plan.files
    .filter((file) => file.kind === "engram-config")
    .map((file) => file.workspaceRoot);
  if (workspaceRoots.some((workspace) => inside(workspace, backupRoot))) {
    throw new Error("backup directory must be outside workspace content");
  }
  for (const file of plan.files) {
    if (sha256(readFileSync(file.path)) !== file.beforeSha256) throw new Error(`source hash drift: ${file.path}`);
  }
  mkdirSync(join(backupRoot, "files"), { recursive: true, mode: 0o700 });
  const changed = plan.files.filter((entry) => entry.changed);
  const manifest: QmdMigrationBackupManifest = {
    schema: "engram.qmd.global-migration-backup.v1",
    index: plan.index,
    createdAt: new Date().toISOString(),
    files: changed.map((entry, position) => ({
      workspaceRoot: entry.workspaceRoot,
      kind: entry.kind,
      target: entry.path,
      backup: join(backupRoot, "files", `${String(position).padStart(3, "0")}.json`),
      beforeSha256: entry.beforeSha256,
      afterSha256: entry.afterSha256,
    })),
  };
  try {
    for (const file of manifest.files) copyFileSync(file.target, file.backup);
    atomicWrite(join(backupRoot, "manifest.json"), json(manifest));
    for (const entry of changed) atomicWrite(entry.path, entry.content);
  } catch (error) {
    for (const file of manifest.files) {
      if (existsSync(file.backup)) copyFileSync(file.backup, file.target);
    }
    throw error;
  }
  return manifest;
}

export function rollbackQmdGlobalMigration(manifestPath: string): QmdMigrationBackupManifest {
  const path = resolve(manifestPath);
  const manifest = JSON.parse(readFileSync(path, "utf8")) as QmdMigrationBackupManifest;
  if (manifest.schema !== "engram.qmd.global-migration-backup.v1" || !Array.isArray(manifest.files)) {
    throw new Error("invalid migration backup manifest");
  }
  const backupRoot = dirname(path);
  const targets = new Set<string>();
  for (const [position, file] of manifest.files.entries()) {
    const workspaceRoot = resolve(file.workspaceRoot);
    const expectedTarget = file.kind === "engram-config"
      ? join(workspaceRoot, "engram.json")
      : file.kind === "domain-registry"
        ? join(workspaceRoot, "memory", "domains", "registry.json")
        : undefined;
    const expectedBackup = join(backupRoot, "files", `${String(position).padStart(3, "0")}.json`);
    if (!expectedTarget || resolve(file.target) !== expectedTarget || resolve(file.backup) !== expectedBackup) {
      throw new Error("backup manifest contains an unauthorized restore path");
    }
    if (targets.has(expectedTarget)) throw new Error("backup manifest contains a duplicate restore target");
    targets.add(expectedTarget);
    if (!existsSync(file.backup) || sha256(readFileSync(file.backup)) !== file.beforeSha256) {
      throw new Error(`backup hash mismatch: ${file.backup}`);
    }
    if (!existsSync(file.target) || sha256(readFileSync(file.target)) !== file.afterSha256) {
      throw new Error(`target changed since migration: ${file.target}`);
    }
  }
  for (const file of manifest.files) copyFileSync(file.backup, file.target);
  return manifest;
}
