import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { buildQmdInvocation } from "./invocation.ts";
import { authorizeQmdInvocation } from "./policy.ts";
import { resolveNamedQmdIndexPath, resolveQmdContext } from "./context.ts";
import { runQmdInvocation } from "./runner.ts";
import type { QmdGlobalMigrationManifest } from "./global-migration.ts";
import type { QmdCallerContext, QmdContext, QmdRunResult } from "./types.ts";

export type QmdProvisionAction = {
  status: "add" | "present";
  name: string;
  path: string;
  mask: string;
};

export type QmdProvisionPlan = {
  schema: "engram.qmd.global-provision-plan.v1";
  dryRun: true;
  index: string;
  indexPath: string;
  targetExists: boolean;
  actions: QmdProvisionAction[];
  summary: { collections: number; add: number; present: number };
};

export type QmdProvisionBackupManifest = {
  schema: "engram.qmd.global-provision-backup.v1";
  status: "prepared" | "applied";
  index: string;
  indexPath: string;
  createdAt: string;
  targetExisted: boolean;
  snapshot: string | null;
  beforeSha256: string | null;
  afterSha256: string | null;
  addedCollections: string[];
};

type RegisteredCollection = { path: string; mask: string };

export type QmdProvisionRuntime = {
  resolveContext: typeof resolveQmdContext;
  resolveNamedIndexPath: typeof resolveNamedQmdIndexPath;
  run: typeof runQmdInvocation;
  env?: Record<string, string | undefined>;
};

const defaultRuntime: QmdProvisionRuntime = {
  resolveContext: resolveQmdContext,
  resolveNamedIndexPath: resolveNamedQmdIndexPath,
  run: runQmdInvocation,
};

const hashFile = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

function atomicWrite(path: string, value: unknown): void {
  const temp = join(dirname(path), `.${randomUUID()}.tmp`);
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

function inside(parent: string, child: string): boolean {
  const value = relative(resolve(parent), resolve(child));
  return value === "" || (!value.startsWith("..") && !isAbsolute(value));
}

function registeredCollections(indexPath: string): Map<string, RegisteredCollection> {
  if (!existsSync(indexPath)) return new Map();
  const db = new Database(indexPath, { readonly: true });
  try {
    const table = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'store_collections'").get();
    if (!table) return new Map();
    const rows = db.query("SELECT name, path, pattern FROM store_collections").all() as Array<{
      name: string;
      path: string;
      pattern: string;
    }>;
    return new Map(rows.map((row) => [String(row.name), {
      path: resolve(String(row.path)),
      mask: String(row.pattern || "**/*.md"),
    }]));
  } finally {
    db.close();
  }
}

function checkpoint(indexPath: string): void {
  if (!existsSync(indexPath)) return;
  const db = new Database(indexPath);
  try {
    db.run("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    db.close();
  }
}

function snapshot(indexPath: string, destination: string): void {
  const db = new Database(indexPath);
  try {
    db.run("VACUUM INTO ?", [destination]);
  } finally {
    db.close();
  }
}

function targetContext(manifest: QmdGlobalMigrationManifest, runtime: QmdProvisionRuntime): QmdContext {
  const workspace = manifest.registry.workspaces[0];
  if (!workspace) throw new Error("provisioning requires at least one workspace");
  const base = runtime.resolveContext({ value: workspace.path, source: "explicit" });
  return {
    ...base,
    topology: "shared",
    selector: { kind: "named", name: manifest.registry.index.name },
    physicalIndex: {
      path: resolve(manifest.indexPath),
      key: createHash("sha256").update(resolve(manifest.indexPath)).digest("hex"),
      exists: existsSync(manifest.indexPath),
    },
    policy: {
      ownedCollections: manifest.registry.collections.map((entry) => entry.name),
      readableCollections: manifest.registry.collections.map((entry) => entry.name),
    },
  };
}

export function planQmdGlobalProvisioning(manifest: QmdGlobalMigrationManifest): QmdProvisionPlan {
  const indexPath = resolve(manifest.indexPath);
  const registered = registeredCollections(indexPath);
  const declared = new Set(manifest.registry.collections.map((entry) => entry.name));
  const unmanaged = [...registered.keys()].filter((name) => !declared.has(name)).sort();
  if (unmanaged.length > 0) throw new Error(`target index contains unmanaged collections: ${unmanaged.join(", ")}`);
  const actions: QmdProvisionAction[] = manifest.registry.collections.map((collection) => {
    const current = registered.get(collection.name);
    if (!current) return { status: "add", name: collection.name, path: collection.path, mask: collection.mask };
    if (current.path !== resolve(collection.path) || current.mask !== collection.mask) {
      throw new Error(`collection drift: ${collection.name}`);
    }
    return { status: "present", name: collection.name, path: collection.path, mask: collection.mask };
  });
  return {
    schema: "engram.qmd.global-provision-plan.v1",
    dryRun: true,
    index: manifest.registry.index.name,
    indexPath,
    targetExists: existsSync(indexPath),
    actions,
    summary: {
      collections: actions.length,
      add: actions.filter((entry) => entry.status === "add").length,
      present: actions.filter((entry) => entry.status === "present").length,
    },
  };
}

function restoreProvisionTarget(backup: QmdProvisionBackupManifest): void {
  for (const suffix of ["-wal", "-shm"]) rmSync(`${backup.indexPath}${suffix}`, { force: true });
  if (backup.targetExisted) {
    if (!backup.snapshot) throw new Error("existing target backup has no snapshot");
    copyFileSync(backup.snapshot, backup.indexPath);
  } else {
    rmSync(backup.indexPath, { force: true });
  }
}

export async function applyQmdGlobalProvisioning(
  manifest: QmdGlobalMigrationManifest,
  backupDirectory: string,
  confirmedIndex: string,
  runtime: QmdProvisionRuntime = defaultRuntime,
): Promise<QmdProvisionBackupManifest> {
  const plan = planQmdGlobalProvisioning(manifest);
  if (confirmedIndex !== plan.index) throw new Error("confirmed index does not match provisioning plan");
  const resolvedNamedPath = runtime.resolveNamedIndexPath(plan.index);
  if (resolve(resolvedNamedPath) !== plan.indexPath) {
    throw new Error("named index resolves to a different physical SQLite than the provisioning manifest");
  }
  const backupRoot = resolve(backupDirectory);
  if (existsSync(backupRoot)) throw new Error("backup directory must not already exist");
  if (manifest.registry.workspaces.some((workspace) => inside(workspace.path, backupRoot))) {
    throw new Error("backup directory must be outside workspace content");
  }
  mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
  mkdirSync(dirname(plan.indexPath), { recursive: true, mode: 0o700 });
  const lockPath = `${plan.indexPath}.engram-provision.lock`;
  let lock: number | undefined;
  const targetExisted = existsSync(plan.indexPath);
  const snapshotPath = targetExisted ? join(backupRoot, "index.sqlite") : null;
  let canRestore = false;
  const backup: QmdProvisionBackupManifest = {
    schema: "engram.qmd.global-provision-backup.v1",
    status: "prepared",
    index: plan.index,
    indexPath: plan.indexPath,
    createdAt: new Date().toISOString(),
    targetExisted,
    snapshot: snapshotPath,
    beforeSha256: null,
    afterSha256: null,
    addedCollections: plan.actions.filter((entry) => entry.status === "add").map((entry) => entry.name),
  };
  try {
    lock = openSync(lockPath, "wx", 0o600);
    writeFileSync(lock, `${JSON.stringify({ pid: process.pid, index: plan.index })}\n`);
    canRestore = !targetExisted;
    if (targetExisted) {
      checkpoint(plan.indexPath);
      snapshot(plan.indexPath, snapshotPath!);
      backup.beforeSha256 = hashFile(snapshotPath!);
      canRestore = true;
    }
    atomicWrite(join(backupRoot, "manifest.json"), backup);
    const context = targetContext(manifest, runtime);
    const caller: QmdCallerContext = {
      kind: "provisioning",
      allowedCollections: manifest.registry.collections.map((entry) => entry.name),
      capabilities: ["provisioning"],
    };
    for (const action of plan.actions.filter((entry) => entry.status === "add")) {
      const invocation = buildQmdInvocation(context, {
        operation: "collection-add",
        collection: action.name,
        path: action.path,
        mask: action.mask,
        timeoutMs: 30_000,
      });
      const decision = authorizeQmdInvocation(context, invocation, caller);
      const result: QmdRunResult = await runtime.run(context, invocation, { caller, decision, env: runtime.env });
      if (!result.ok) throw new Error(`collection add failed: ${action.name}: ${result.stderr || result.spawnError?.message || result.exitCode}`);
    }
    const verified = planQmdGlobalProvisioning(manifest);
    if (verified.summary.add !== 0) throw new Error("provisioning verification found missing collections");
    checkpoint(plan.indexPath);
    backup.afterSha256 = hashFile(plan.indexPath);
    backup.status = "applied";
    atomicWrite(join(backupRoot, "manifest.json"), backup);
    return backup;
  } catch (error) {
    if (canRestore) restoreProvisionTarget(backup);
    throw error;
  } finally {
    if (lock !== undefined) {
      closeSync(lock);
      if (existsSync(lockPath)) unlinkSync(lockPath);
    }
  }
}

export function rollbackQmdGlobalProvisioning(
  manifestPath: string,
  confirmedIndex: string,
  resolveNamedIndexPath: typeof resolveNamedQmdIndexPath = resolveNamedQmdIndexPath,
  recoverIncomplete = false,
): QmdProvisionBackupManifest {
  const path = resolve(manifestPath);
  const backupRoot = dirname(path);
  const backup = JSON.parse(readFileSync(path, "utf8")) as QmdProvisionBackupManifest;
  if (backup.schema !== "engram.qmd.global-provision-backup.v1" || backup.index !== confirmedIndex) {
    throw new Error("invalid or unconfirmed provisioning backup manifest");
  }
  if (resolve(resolveNamedIndexPath(confirmedIndex)) !== resolve(backup.indexPath)) {
    throw new Error("backup target does not match the confirmed named index");
  }
  const lockPath = `${backup.indexPath}.engram-provision.lock`;
  const lock = openSync(lockPath, "wx", 0o600);
  writeFileSync(lock, `${JSON.stringify({ pid: process.pid, index: confirmedIndex, rollback: true })}\n`);
  try {
    if (!isAbsolute(backup.indexPath)) throw new Error("provisioning target path must be absolute");
    if (backup.status === "prepared") {
      if (!recoverIncomplete) throw new Error("incomplete provisioning requires explicit recovery mode");
    } else if (backup.status !== "applied" || !backup.afterSha256
      || !existsSync(backup.indexPath) || hashFile(backup.indexPath) !== backup.afterSha256) {
      throw new Error("provisioned target changed since apply");
    }
    if (backup.targetExisted) {
      const expectedSnapshot = join(backupRoot, "index.sqlite");
      if (resolve(backup.snapshot ?? "") !== expectedSnapshot || !existsSync(expectedSnapshot)
        || hashFile(expectedSnapshot) !== backup.beforeSha256) {
        throw new Error("provisioning snapshot is missing or changed");
      }
    } else if (backup.snapshot !== null || backup.beforeSha256 !== null) {
      throw new Error("new-target backup manifest is inconsistent");
    }
    restoreProvisionTarget(backup);
    return backup;
  } finally {
    closeSync(lock);
    if (existsSync(lockPath)) unlinkSync(lockPath);
  }
}
