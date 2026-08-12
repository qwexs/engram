import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import assertionSchema from "../../schemas/kg-assertion-v3-mvp.schema.json";
import { markWorkspaceQmdDirty, type WorkspaceDirtyMarkResult } from "../qmd/maintenance-integration.ts";
import {
  KG_V3_ASSERTION_SCHEMA,
  KG_V3_AUTHORITY_SCHEMA,
  KG_V3_OPERATION_SCHEMA,
  KG_V3_REGISTRY_SCHEMA,
  type KgAdmissionReason,
  type KgAssertionInput,
  type KgAssertionV3,
  type KgAuthorityMarkerV1,
  type KgCrashPoint,
  type KgProvenance,
  type KgReceipt,
  type KgRegistryV1,
  type KgRetractionRequest,
  type KgWriteRequest,
  type TrustedKgCallerContext,
} from "./types.ts";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

interface OperationRecord {
  schema: typeof KG_V3_OPERATION_SCHEMA;
  operationId: string;
  payloadDigest: `sha256:${string}`;
  workspaceId: string;
  entityId: string;
  action: "write" | "retract";
  actionProvenance: KgProvenance;
  status: "prepared" | "store_committed" | "committed" | "skipped";
  assertionId: string | null;
  assertionAfter: KgAssertionV3 | null;
  previousId: string | null;
  previousAfter: KgAssertionV3 | null;
  receipt: KgReceipt | null;
  projectionCommitted: boolean;
  qmdDirty: {
    status: "pending" | "marked" | "disabled" | "error";
    generation: number | null;
    collections: string[];
    error: string | null;
  };
}

export interface KgV3CoreOptions {
  workspace: string;
  workspaceId: string;
  registryPath?: string;
  authorityPath?: string;
  crashAt?: KgCrashPoint;
  qmdDirtyMarker?: (input: { workspace: string; reason: string; collectionRole: "knowledge-graph" }) => Promise<WorkspaceDirtyMarkResult>;
}

export class KgV3Error extends Error {
  constructor(readonly reason: KgAdmissionReason, message: string) {
    super(message);
    this.name = "KgV3Error";
  }
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value as object).sort().map((key) => (
    `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`
  )).join(",")}}`;
}

function digest(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
}

export const KG_V3_SCHEMA_DIGEST = digest(assertionSchema);

/** Stable operation identity: deliberately excludes observed/runtime time. */
export function deriveKgOperationId(input: {
  workspaceId: string;
  sessionKey: string;
  messageId: string;
  actorId: string;
  entityId: string;
  predicate?: string;
  assertionId?: string;
  action?: "write" | "retract";
}): `sha256:${string}` {
  const action = input.action || "write";
  if (action === "write" && !token(input.predicate, 128)) throw new Error("write operation identity requires predicate");
  if (action === "retract" && !uuid(input.assertionId)) throw new Error("retract operation identity requires assertionId");
  return digest({
    action,
    actorId: input.actorId,
    entityId: input.entityId,
    messageId: input.messageId,
    semanticTarget: action === "retract" ? { assertionId: input.assertionId } : { predicate: input.predicate },
    sessionKey: input.sessionKey,
    workspaceId: input.workspaceId,
  });
}

function atomicWriteJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
  let directory: number | undefined;
  try {
    directory = openSync(dirname(path), "r");
    fsyncSync(directory);
  } catch {
    // Directory fsync is not supported on every target filesystem.
  } finally {
    if (directory !== undefined) closeSync(directory);
  }
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function assertInside(root: string, path: string): void {
  const rel = relative(resolve(root), resolve(path));
  if (rel === "" || rel.startsWith("..") || rel.includes("/../")) {
    throw new Error(`KG v3 path escapes its workspace root: ${path}`);
  }
}

function token(value: unknown, max = 512): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= max;
}

function iso(value: unknown): value is string {
  return token(value) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
    && Number.isFinite(Date.parse(value));
}

function operationId(value: unknown): value is `sha256:${string}` {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}

function validProvenance(value: unknown, expectedOperationId?: string): value is KgProvenance {
  const provenance = value as KgProvenance;
  return Boolean(provenance && typeof provenance === "object"
    && ["user_message", "operator-curated"].includes(provenance.sourceKind)
    && token(provenance.sessionKey) && token(provenance.messageId) && token(provenance.actorId)
    && operationId(provenance.operationId)
    && (!expectedOperationId || provenance.operationId === expectedOperationId)
    && iso(provenance.observedAt));
}

function uuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

/** Runtime validator kept in lockstep with the normative JSON Schema. */
export function validateKgAssertion(value: unknown): string[] {
  const errors: string[] = [];
  const a = value as KgAssertionV3;
  if (!a || typeof a !== "object" || Array.isArray(a)) return ["assertion must be an object"];
  const keys = Object.keys(a).sort();
  const expected = ["createdAt", "entityId", "entityType", "id", "kind", "lifecycle", "object", "predicate", "provenance", "schema", "scope", "workspaceId"].sort();
  if (canonical(keys) !== canonical(expected)) errors.push("assertion has missing or additional properties");
  if (a.schema !== KG_V3_ASSERTION_SCHEMA) errors.push("unsupported assertion schema");
  if (!uuid(a.id)) errors.push("id must be a UUID");
  if (!token(a.workspaceId, 128)) errors.push("workspaceId is invalid");
  if (!token(a.entityId, 300) || !/^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)+$/.test(a.entityId)) errors.push("entityId is invalid");
  if (!token(a.entityType, 128)) errors.push("entityType is invalid");
  if (!["identity", "preference", "decision", "constraint"].includes(a.kind)) errors.push("kind is invalid");
  if (!token(a.predicate, 128)) errors.push("predicate is invalid");
  if (!a.object || !["string", "number", "boolean", "entity-ref"].includes(a.object.type)) errors.push("object type is invalid");
  else {
    if (canonical(Object.keys(a.object).sort()) !== canonical(["type", "value"])) errors.push("object has missing or additional properties");
    if (typeof a.object.value !== (a.object.type === "entity-ref" ? "string" : a.object.type)) errors.push("object value does not match type");
    else if (a.object.type === "string" && (!token(a.object.value, 4096))) errors.push("string object is invalid");
    else if (a.object.type === "number" && !Number.isFinite(a.object.value)) errors.push("number object is invalid");
    else if (a.object.type === "entity-ref" && (!token(a.object.value, 300) || !a.object.value.includes("/"))) errors.push("entity-ref object is invalid");
  }
  if (!Array.isArray(a.scope) || a.scope.length === 0 || new Set(a.scope).size !== a.scope.length || a.scope.some((item) => !token(item, 128))) errors.push("scope is invalid");
  if (!a.lifecycle || !["active", "superseded", "retracted"].includes(a.lifecycle.status)) errors.push("lifecycle status is invalid");
  else {
    if (canonical(Object.keys(a.lifecycle).sort()) !== canonical(["changedAt", "replacesId", "status", "supersededById"])) errors.push("lifecycle has missing or additional properties");
    if (a.lifecycle.replacesId !== null && !uuid(a.lifecycle.replacesId)) errors.push("replacesId is invalid");
    if (a.lifecycle.supersededById !== null && !uuid(a.lifecycle.supersededById)) errors.push("supersededById is invalid");
    if (!iso(a.lifecycle.changedAt)) errors.push("changedAt is invalid");
  }
  if (!a.provenance) errors.push("provenance is missing");
  else {
    if (canonical(Object.keys(a.provenance).sort()) !== canonical(["actorId", "messageId", "observedAt", "operationId", "sessionKey", "sourceKind"])) errors.push("provenance has missing or additional properties");
    if (!["user_message", "operator-curated"].includes(a.provenance.sourceKind)) errors.push("sourceKind is invalid");
    for (const key of ["sessionKey", "messageId", "actorId"] as const) if (!token(a.provenance[key])) errors.push(`${key} is invalid`);
    if (!operationId(a.provenance.operationId)) errors.push("operationId is invalid");
    if (!iso(a.provenance.observedAt)) errors.push("observedAt is invalid");
  }
  if (!iso(a.createdAt)) errors.push("createdAt is invalid");
  return errors;
}

export function validateKgRegistry(value: unknown, workspaceId: string): KgRegistryV1 {
  const registry = value as KgRegistryV1;
  if (!registry || registry.schema !== KG_V3_REGISTRY_SCHEMA || registry.workspaceId !== workspaceId) {
    throw new Error("KG v3 registry schema/workspace mismatch");
  }
  if (!Number.isInteger(registry.revision) || registry.revision < 1 || !Array.isArray(registry.entities)) {
    throw new Error("KG v3 registry revision/entities are invalid");
  }
  const ids = new Set<string>();
  for (const entity of registry.entities) {
    if (!token(entity.id, 300) || !entity.id.includes("/") || !token(entity.type, 128) || ids.has(entity.id)) throw new Error("KG v3 registry entity is invalid or duplicated");
    ids.add(entity.id);
    if (!Array.isArray(entity.scopes) || entity.scopes.length === 0 || new Set(entity.scopes).size !== entity.scopes.length || entity.scopes.some((item) => !token(item, 128))) throw new Error("KG v3 registry entity scopes are invalid");
    const predicates = new Set<string>();
    for (const predicate of entity.predicates || []) {
      if (!token(predicate.name, 128) || predicates.has(predicate.name)) throw new Error("KG v3 registry predicate is invalid or duplicated");
      predicates.add(predicate.name);
      if (!predicate.kinds?.length || !predicate.objectTypes?.length
        || predicate.kinds.some((kind) => !["identity", "preference", "decision", "constraint"].includes(kind))
        || predicate.objectTypes.some((type) => !["string", "number", "boolean", "entity-ref"].includes(type))) {
        throw new Error("KG v3 registry predicate allowlists are invalid");
      }
    }
  }
  return registry;
}

function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function withLock<T>(path: string, fn: () => T): T {
  const started = Date.now();
  mkdirSync(dirname(path), { recursive: true });
  for (;;) {
    try {
      mkdirSync(path, { mode: 0o700 });
      atomicWriteJson(join(path, "owner.json"), { pid: process.pid, acquiredAt: new Date().toISOString() });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let remove = false;
      try {
        const owner = readJson<{ pid?: number }>(join(path, "owner.json"));
        remove = !Number.isInteger(owner.pid) || !processAlive(owner.pid!);
      } catch {
        try { remove = Date.now() - statSync(path).mtimeMs > 30_000; } catch { remove = false; }
      }
      if (remove) {
        rmSync(path, { recursive: true, force: true });
        continue;
      }
      if (Date.now() - started >= 10_000) throw new Error(`KG v3 lock timeout: ${path}`);
      sleepSync(10);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
}

async function withLockAsync<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const started = Date.now();
  mkdirSync(dirname(path), { recursive: true });
  for (;;) {
    try {
      mkdirSync(path, { mode: 0o700 });
      atomicWriteJson(join(path, "owner.json"), { pid: process.pid, acquiredAt: new Date().toISOString() });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let remove = false;
      try {
        const owner = readJson<{ pid?: number }>(join(path, "owner.json"));
        remove = !Number.isInteger(owner.pid) || !processAlive(owner.pid!);
      } catch {
        try { remove = Date.now() - statSync(path).mtimeMs > 30_000; } catch { remove = false; }
      }
      if (remove) { rmSync(path, { recursive: true, force: true }); continue; }
      if (Date.now() - started >= 10_000) throw new Error(`KG v3 lock timeout: ${path}`);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    }
  }
  try { return await fn(); } finally { rmSync(path, { recursive: true, force: true }); }
}

function rejected(operation: string, payloadDigest: `sha256:${string}`, reason: KgAdmissionReason): KgReceipt {
  return { schema: "engram.kg-v3-receipt.v1", operationId: operation, status: "rejected", assertionId: null, reason, payloadDigest, committedAt: null };
}

function semanticObjectEqual(left: KgAssertionV3["object"], right: KgAssertionInput["object"]): boolean {
  return canonical(left) === canonical(right);
}

export class KgV3Core {
  readonly workspace: string;
  readonly assertionsRoot: string;
  readonly operationsRoot: string;
  readonly locksRoot: string;
  readonly projectionPath: string;
  readonly registryPath: string;
  readonly authorityPath: string;

  constructor(readonly options: KgV3CoreOptions) {
    this.workspace = resolve(options.workspace);
    this.assertionsRoot = join(this.workspace, "life", "v3", "assertions");
    this.operationsRoot = join(this.workspace, "memory-state", "kg-v3", "operations");
    this.locksRoot = join(this.workspace, "memory-state", "kg-v3", "locks");
    this.projectionPath = join(this.workspace, "life", "v3", "current-summary.md");
    this.registryPath = resolve(options.registryPath || join(this.workspace, "memory-state", "kg-v3", "registry.json"));
    this.authorityPath = resolve(options.authorityPath || join(this.workspace, "memory-state", "kg-v3", "authority.json"));
    for (const path of [this.assertionsRoot, this.operationsRoot, this.locksRoot, this.projectionPath, this.registryPath, this.authorityPath]) assertInside(this.workspace, path);
  }

  private registry(): KgRegistryV1 {
    if (!existsSync(this.registryPath)) throw new Error("KG v3 registry is unavailable");
    return validateKgRegistry(readJson(this.registryPath), this.options.workspaceId);
  }

  private authority(caller: TrustedKgCallerContext, capability: "kg:v3:write" | "kg:v3:retract" | "kg:v3:seed"): boolean {
    if (!existsSync(this.authorityPath)) return false;
    let marker: KgAuthorityMarkerV1;
    try { marker = readJson(this.authorityPath); } catch { return false; }
    if (marker.schema !== KG_V3_AUTHORITY_SCHEMA || marker.workspaceId !== this.options.workspaceId) return false;
    if (marker.schemaDigest !== KG_V3_SCHEMA_DIGEST || !operationId(marker.releaseDigest)) return false;
    if (marker.mode !== "canary" && marker.mode !== "enabled") return false;
    if (marker.currentProjectionVersion !== 1 || !token(marker.approvedBy) || !iso(marker.approvedAt) || !Array.isArray(marker.enabledSessionCapabilities)) return false;
    if (caller?.trusted !== true || caller.workspaceId !== this.options.workspaceId || !Array.isArray(caller.capabilities) || !caller.capabilities.includes(capability)) return false;
    const session = marker.enabledSessionCapabilities.find((entry) => entry && token(entry.sessionKey) && entry.sessionKey === caller.sessionKey && Array.isArray(entry.capabilities));
    return Boolean(session?.capabilities.includes(capability));
  }

  private paths(operation: string, entityId: string) {
    const operationHex = operation.slice("sha256:".length);
    const entityHex = createHash("sha256").update(`${this.options.workspaceId}\0${entityId}`).digest("hex");
    return {
      operation: join(this.operationsRoot, `${operationHex}.json`),
      commitLock: join(this.locksRoot, "workspace-commit.lock"),
      entityLock: join(this.locksRoot, `${entityHex}.lock`),
      projectionLock: join(this.locksRoot, "projection.lock"),
    };
  }

  private assertionPath(id: string): string {
    return join(this.assertionsRoot, `${id}.json`);
  }

  private nonCanonicalOperationReceipt(operation: `sha256:${string}`, entityId: string, payloadDigest: `sha256:${string}`, workspaceLockHeld = false): KgReceipt {
    const paths = this.paths(operation, entityId);
    const resolveReceipt = () => (
      existsSync(paths.operation)
        ? rejected(operation, payloadDigest, "OPERATION_CONFLICT")
        : rejected(operation, payloadDigest, "PROVENANCE_MISSING")
    );
    return workspaceLockHeld ? resolveReceipt() : withLock(paths.commitLock, resolveReceipt);
  }

  private readOperation(path: string): OperationRecord {
    const record = readJson<OperationRecord>(path);
    if (!record || record.schema !== KG_V3_OPERATION_SCHEMA || !operationId(record.operationId)
      || !operationId(record.payloadDigest) || record.workspaceId !== this.options.workspaceId
      || !token(record.entityId, 300) || !["write", "retract"].includes(record.action)
      || !validProvenance(record.actionProvenance, record.operationId)
      || !["prepared", "store_committed", "committed", "skipped"].includes(record.status)) {
      throw new Error(`invalid KG v3 operation journal: ${path}`);
    }
    if (record.assertionId !== null && !uuid(record.assertionId)) throw new Error(`invalid KG v3 operation assertion id: ${path}`);
    if (record.previousId !== null && !uuid(record.previousId)) throw new Error(`invalid KG v3 operation previous id: ${path}`);
    if (record.assertionAfter !== null) {
      const errors = validateKgAssertion(record.assertionAfter);
      if (errors.length || record.assertionAfter.id !== record.assertionId
        || record.assertionAfter.workspaceId !== record.workspaceId
        || record.assertionAfter.entityId !== record.entityId
        || record.assertionAfter.lifecycle.changedAt !== record.actionProvenance.observedAt) {
        throw new Error(`invalid KG v3 operation assertion plan: ${path}`);
      }
    }
    if (record.previousAfter !== null) {
      const errors = validateKgAssertion(record.previousAfter);
      if (errors.length || record.previousAfter.id !== record.previousId
        || record.previousAfter.workspaceId !== record.workspaceId
        || record.previousAfter.entityId !== record.entityId) {
        throw new Error(`invalid KG v3 operation previous plan: ${path}`);
      }
    }
    if (record.status === "prepared" || record.status === "store_committed" || record.status === "committed") {
      if (!record.assertionAfter || !record.assertionId) throw new Error(`incomplete KG v3 operation plan: ${path}`);
    }
    if (record.status === "committed" || record.status === "skipped") {
      if (!record.receipt || record.receipt.operationId !== record.operationId
        || record.receipt.payloadDigest !== record.payloadDigest || record.receipt.assertionId !== record.assertionId
        || record.receipt.status !== record.status) {
        throw new Error(`invalid terminal KG v3 receipt: ${path}`);
      }
    } else if (record.receipt !== null) {
      throw new Error(`non-terminal KG v3 operation has a receipt: ${path}`);
    }
    if (!record.qmdDirty || !["pending", "marked", "disabled", "error"].includes(record.qmdDirty.status)
      || !Array.isArray(record.qmdDirty.collections)) throw new Error(`invalid KG v3 QMD audit state: ${path}`);
    return record;
  }

  private readAssertions(): KgAssertionV3[] {
    if (!existsSync(this.assertionsRoot)) return [];
    return readdirSync(this.assertionsRoot).filter((name) => /^[0-9a-f-]{36}\.json$/i.test(name)).sort().map((name) => {
      const assertion = readJson<KgAssertionV3>(join(this.assertionsRoot, name));
      const errors = validateKgAssertion(assertion);
      if (errors.length) throw new Error(`invalid stored KG v3 assertion ${name}: ${errors.join("; ")}`);
      return assertion;
    });
  }

  private writeProjection(operation: string): void {
    const lock = this.paths(operation, "projection").projectionLock;
    withLock(lock, () => {
      const active = this.readAssertions().filter((assertion) => assertion.lifecycle.status === "active")
        .sort((a, b) => a.entityId.localeCompare(b.entityId) || a.predicate.localeCompare(b.predicate) || a.id.localeCompare(b.id));
      const lines = ["# Engram KG v3 current", "", "_Generated from committed active v3 assertions. Do not edit._", ""];
      for (const assertion of active) {
        lines.push(`- \`${assertion.entityId}\` · \`${assertion.predicate}\` = ${JSON.stringify(assertion.object.value)} (\`${assertion.id}\`)`);
      }
      mkdirSync(dirname(this.projectionPath), { recursive: true });
      const temporary = join(dirname(this.projectionPath), `.${randomUUID()}.tmp`);
      const fd = openSync(temporary, "wx", 0o600);
      try { writeFileSync(fd, `${lines.join("\n")}\n`, "utf8"); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temporary, this.projectionPath);
    });
  }

  private crash(point: KgCrashPoint): void {
    if (this.options.crashAt === point) throw new Error(`simulated-crash:${point}`);
  }

  private finish(recordPath: string, record: OperationRecord): KgReceipt {
    if (record.status === "skipped" || record.status === "committed") {
      if (!record.receipt) throw new Error("terminal KG v3 operation has no receipt");
      if (record.status === "committed" && !record.projectionCommitted) {
        this.writeProjection(record.operationId);
        record.projectionCommitted = true;
        atomicWriteJson(recordPath, record);
      }
      return record.receipt;
    }
    if (!record.assertionAfter || !record.assertionId) throw new Error("prepared KG v3 operation has no assertion plan");
    atomicWriteJson(this.assertionPath(record.assertionId), record.assertionAfter);
    this.crash("after-assertion-store");
    if (record.previousAfter && record.previousId) atomicWriteJson(this.assertionPath(record.previousId), record.previousAfter);
    this.crash("after-previous-store");
    record.status = "store_committed";
    atomicWriteJson(recordPath, record);
    this.crash("after-store-committed");
    record.status = "committed";
    record.receipt = {
      schema: "engram.kg-v3-receipt.v1",
      operationId: record.operationId,
      status: "committed",
      assertionId: record.assertionId,
      reason: null,
      payloadDigest: record.payloadDigest,
      committedAt: record.assertionAfter.lifecycle.changedAt,
    };
    atomicWriteJson(recordPath, record);
    this.crash("after-committed");
    this.writeProjection(record.operationId);
    record.projectionCommitted = true;
    atomicWriteJson(recordPath, record);
    return record.receipt;
  }

  private writeSync(request: KgWriteRequest, caller: TrustedKgCallerContext, workspaceLockHeld = false): KgReceipt {
    const input = request?.assertion;
    const op = input?.provenance?.operationId || "";
    const payloadDigest = digest(request);
    if (!operationId(op) || !input?.provenance || !iso(input.provenance.observedAt)
      || !token(input.provenance.sessionKey) || !token(input.provenance.messageId) || !token(input.provenance.actorId)) {
      return rejected(op, payloadDigest, "PROVENANCE_MISSING");
    }
    if (!this.authority(caller, input.provenance.sourceKind === "operator-curated" ? "kg:v3:seed" : "kg:v3:write")) return rejected(op, payloadDigest, "CALLER_NOT_AUTHORIZED");
    if (input.workspaceId !== this.options.workspaceId || caller.workspaceId !== input.workspaceId) return rejected(op, payloadDigest, "WORKSPACE_MISMATCH");
    if (input.provenance.sessionKey !== caller.sessionKey || input.provenance.actorId !== caller.actorId) return rejected(op, payloadDigest, "CALLER_NOT_AUTHORIZED");
    const expectedOperation = deriveKgOperationId({
      workspaceId: caller.workspaceId,
      sessionKey: caller.sessionKey,
      messageId: input.provenance.messageId,
      actorId: caller.actorId,
      entityId: input.entityId,
      predicate: input.predicate,
      action: "write",
    });
    if (op !== expectedOperation) return this.nonCanonicalOperationReceipt(op, input.entityId, payloadDigest, workspaceLockHeld);
    if (input.provenance.sourceKind !== "user_message" && input.provenance.sourceKind !== "operator-curated") return rejected(op, payloadDigest, "SOURCE_NOT_EXPLICIT");
    if (!request.intent?.explicit) return rejected(op, payloadDigest, "SOURCE_NOT_EXPLICIT");
    if (request.intent.compound) return rejected(op, payloadDigest, "COMPOUND_ASSERTION");
    if (request.intent.store !== "kg-current" || request.intent.statementClass !== "durable") return rejected(op, payloadDigest, "WRONG_STORE");

    let registry: KgRegistryV1;
    try { registry = this.registry(); } catch { return rejected(op, payloadDigest, "ENTITY_UNRESOLVED"); }
    const entity = registry.entities.find((item) => item.id === input.entityId);
    if (!entity || entity.type !== input.entityType) return rejected(op, payloadDigest, "ENTITY_UNRESOLVED");
    if (!Array.isArray(input.scope) || input.scope.length === 0 || input.scope.some((scope) => !entity.scopes.includes(scope))) return rejected(op, payloadDigest, "WRONG_STORE");
    const kinds = ["identity", "preference", "decision", "constraint"];
    if (!kinds.includes(input.kind)) return rejected(op, payloadDigest, "KIND_NOT_ALLOWED");
    const predicate = entity.predicates.find((item) => item.name === input.predicate);
    if (!predicate) return rejected(op, payloadDigest, "PREDICATE_NOT_ALLOWED");
    if (!predicate.kinds.includes(input.kind)) return rejected(op, payloadDigest, "KIND_NOT_ALLOWED");
    if (!predicate.objectTypes.includes(input.object?.type)) return rejected(op, payloadDigest, "OBJECT_TYPE_MISMATCH");
    if (input.object.type === "entity-ref" && !registry.entities.some((item) => item.id === input.object.value)) return rejected(op, payloadDigest, "ENTITY_UNRESOLVED");
    const valueType = input.object.type === "entity-ref" ? "string" : input.object.type;
    if (typeof input.object.value !== valueType || (valueType === "number" && !Number.isFinite(input.object.value))) return rejected(op, payloadDigest, "OBJECT_TYPE_MISMATCH");

    const paths = this.paths(op, input.entityId);
    const commit = () => {
      this.recoverUnlocked();
      return withLock(paths.entityLock, () => {
      if (existsSync(paths.operation)) {
        const prior = this.readOperation(paths.operation);
        if (prior.operationId !== op || prior.payloadDigest !== payloadDigest) return rejected(op, payloadDigest, "OPERATION_CONFLICT");
        return this.finish(paths.operation, prior);
      }
      const assertions = this.readAssertions().filter((assertion) => assertion.entityId === input.entityId && assertion.predicate === input.predicate);
      const active = assertions.filter((assertion) => assertion.lifecycle.status === "active");
      const duplicate = active.find((assertion) => assertion.kind === input.kind && semanticObjectEqual(assertion.object, input.object));
      if (duplicate) {
        const receipt: KgReceipt = { schema: "engram.kg-v3-receipt.v1", operationId: op, status: "skipped", assertionId: duplicate.id, reason: "DUPLICATE", payloadDigest, committedAt: duplicate.lifecycle.changedAt };
        const record: OperationRecord = { schema: KG_V3_OPERATION_SCHEMA, operationId: op, payloadDigest, workspaceId: input.workspaceId, entityId: input.entityId, action: "write", actionProvenance: input.provenance, status: "skipped", assertionId: duplicate.id, assertionAfter: null, previousId: null, previousAfter: null, receipt, projectionCommitted: true, qmdDirty: { status: "disabled", generation: null, collections: [], error: null } };
        atomicWriteJson(paths.operation, record);
        return receipt;
      }
      if (active.length > 1) throw new Error(`KG v3 current-key corruption: ${input.entityId}/${input.predicate}`);
      const current = active[0] || null;
      if ((current && input.replacesId !== current.id) || (!current && input.replacesId !== null)) return rejected(op, payloadDigest, "REPLACEMENT_REQUIRED");
      const id = randomUUID();
      const assertion: KgAssertionV3 = {
        schema: KG_V3_ASSERTION_SCHEMA,
        id,
        workspaceId: input.workspaceId,
        entityId: input.entityId,
        entityType: input.entityType,
        kind: input.kind,
        predicate: input.predicate,
        object: input.object,
        scope: [...input.scope],
        lifecycle: { status: "active", replacesId: input.replacesId, supersededById: null, changedAt: input.provenance.observedAt },
        provenance: input.provenance,
        createdAt: input.provenance.observedAt,
      };
      const errors = validateKgAssertion(assertion);
      if (errors.length) throw new Error(`invalid canonical KG v3 assertion: ${errors.join("; ")}`);
      const previousAfter = current ? { ...current, lifecycle: { ...current.lifecycle, status: "superseded" as const, supersededById: id, changedAt: input.provenance.observedAt } } : null;
      const record: OperationRecord = { schema: KG_V3_OPERATION_SCHEMA, operationId: op, payloadDigest, workspaceId: input.workspaceId, entityId: input.entityId, action: "write", actionProvenance: input.provenance, status: "prepared", assertionId: id, assertionAfter: assertion, previousId: current?.id || null, previousAfter, receipt: null, projectionCommitted: false, qmdDirty: { status: "pending", generation: null, collections: [], error: null } };
      atomicWriteJson(paths.operation, record);
      this.crash("after-prepared");
      return this.finish(paths.operation, record);
      });
    };
    return workspaceLockHeld ? commit() : withLock(paths.commitLock, commit);
  }

  private retractSync(request: KgRetractionRequest, caller: TrustedKgCallerContext, workspaceLockHeld = false): KgReceipt {
    const op = request?.provenance?.operationId || "";
    const payloadDigest = digest(request);
    if (!operationId(op) || !request?.provenance || !iso(request.provenance.observedAt)) return rejected(op, payloadDigest, "PROVENANCE_MISSING");
    if (!this.authority(caller, "kg:v3:retract")) return rejected(op, payloadDigest, "CALLER_NOT_AUTHORIZED");
    if (request.workspaceId !== this.options.workspaceId || caller.workspaceId !== request.workspaceId) return rejected(op, payloadDigest, "WORKSPACE_MISMATCH");
    if (request.provenance.sessionKey !== caller.sessionKey || request.provenance.actorId !== caller.actorId || request.provenance.sourceKind !== "user_message") return rejected(op, payloadDigest, "CALLER_NOT_AUTHORIZED");
    const expectedOperation = deriveKgOperationId({
      workspaceId: caller.workspaceId,
      sessionKey: caller.sessionKey,
      messageId: request.provenance.messageId,
      actorId: caller.actorId,
      entityId: request.entityId,
      assertionId: request.assertionId,
      action: "retract",
    });
    if (op !== expectedOperation) return this.nonCanonicalOperationReceipt(op, request.entityId, payloadDigest, workspaceLockHeld);
    const paths = this.paths(op, request.entityId);
    const commit = () => {
      this.recoverUnlocked();
      return withLock(paths.entityLock, () => {
      if (existsSync(paths.operation)) {
        const prior = this.readOperation(paths.operation);
        if (prior.payloadDigest !== payloadDigest) return rejected(op, payloadDigest, "OPERATION_CONFLICT");
        return this.finish(paths.operation, prior);
      }
      const targetPath = this.assertionPath(request.assertionId);
      if (!existsSync(targetPath)) return rejected(op, payloadDigest, "ENTITY_UNRESOLVED");
      const target = readJson<KgAssertionV3>(targetPath);
      if (target.entityId !== request.entityId || target.workspaceId !== request.workspaceId || target.lifecycle.status !== "active") return rejected(op, payloadDigest, "REPLACEMENT_REQUIRED");
      const after: KgAssertionV3 = { ...target, lifecycle: { ...target.lifecycle, status: "retracted", changedAt: request.provenance.observedAt } };
      const record: OperationRecord = { schema: KG_V3_OPERATION_SCHEMA, operationId: op, payloadDigest, workspaceId: request.workspaceId, entityId: request.entityId, action: "retract", actionProvenance: request.provenance, status: "prepared", assertionId: target.id, assertionAfter: after, previousId: null, previousAfter: null, receipt: null, projectionCommitted: false, qmdDirty: { status: "pending", generation: null, collections: [], error: null } };
      atomicWriteJson(paths.operation, record);
      this.crash("after-prepared");
      return this.finish(paths.operation, record);
      });
    };
    return workspaceLockHeld ? commit() : withLock(paths.commitLock, commit);
  }

  /** Recover every non-terminal WAL record before exposing current state. */
  private recoverUnlocked(): KgReceipt[] {
    if (!existsSync(this.operationsRoot)) return [];
    const receipts: KgReceipt[] = [];
    for (const name of readdirSync(this.operationsRoot).filter((item) => /^[a-f0-9]{64}\.json$/.test(item)).sort()) {
      const path = join(this.operationsRoot, name);
      const record = this.readOperation(path);
      const lock = this.paths(record.operationId, record.entityId).entityLock;
      receipts.push(withLock(lock, () => this.finish(path, this.readOperation(path))));
    }
    return receipts;
  }

  private async ensureQmdDirtyUnlocked(receipt: KgReceipt): Promise<KgReceipt> {
    if (receipt.status !== "committed") return receipt;
    const operation = receipt.operationId;
    const recordPath = this.paths(operation, "qmd").operation;
    const record = this.readOperation(recordPath);
    if (record.qmdDirty.status !== "pending" && record.qmdDirty.status !== "error") {
      return { ...record.receipt!, qmdDirty: record.qmdDirty };
    }
    const marker = this.options.qmdDirtyMarker || ((input) => markWorkspaceQmdDirty(input));
    let result: WorkspaceDirtyMarkResult;
    try {
      result = await marker({ workspace: this.workspace, collectionRole: "knowledge-graph", reason: `kg-v3:${record.operationId}` });
    } catch (error) {
      result = { schema: "engram.qmd.dirty-mark.v1", status: "error", mode: "legacy", workspace: this.workspace, error: error instanceof Error ? error.message : String(error) };
    }
    record.qmdDirty = {
      status: result.status,
      generation: result.generation ?? null,
      collections: result.collections ?? [],
      error: result.error ?? null,
    };
    atomicWriteJson(recordPath, record);
    return { ...record.receipt!, qmdDirty: record.qmdDirty };
  }

  async write(request: KgWriteRequest, caller: TrustedKgCallerContext): Promise<KgReceipt> {
    const lock = join(this.locksRoot, "workspace-commit.lock");
    return withLockAsync(lock, async () => this.ensureQmdDirtyUnlocked(this.writeSync(request, caller, true)));
  }

  async retract(request: KgRetractionRequest, caller: TrustedKgCallerContext): Promise<KgReceipt> {
    const lock = join(this.locksRoot, "workspace-commit.lock");
    return withLockAsync(lock, async () => this.ensureQmdDirtyUnlocked(this.retractSync(request, caller, true)));
  }

  async recover(): Promise<KgReceipt[]> {
    const lock = join(this.locksRoot, "workspace-commit.lock");
    return withLockAsync(lock, async () => {
      const output: KgReceipt[] = [];
      for (const receipt of this.recoverUnlocked()) output.push(await this.ensureQmdDirtyUnlocked(receipt));
      return output;
    });
  }

  async current(): Promise<KgAssertionV3[]> {
    const lock = join(this.locksRoot, "workspace-commit.lock");
    return withLockAsync(lock, async () => {
      this.recoverUnlocked();
      const operations = existsSync(this.operationsRoot)
        ? readdirSync(this.operationsRoot).filter((name) => /^[a-f0-9]{64}\.json$/.test(name)).map((name) => this.readOperation(join(this.operationsRoot, name)))
        : [];
      for (const record of operations.filter((item) => item.status === "committed")) await this.ensureQmdDirtyUnlocked(record.receipt!);
      return this.readAssertions().filter((assertion) => assertion.lifecycle.status === "active");
    });
  }
}
