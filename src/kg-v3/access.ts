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
import { KG_V3_ASSERTION_SCHEMA, type KgAssertionV3 } from "./types.ts";

export const KG_V3_ACCESS_EVENT_SCHEMA = "engram.kg-v3-access-event.v1" as const;
export const KG_V3_ACCESS_STATE_SCHEMA = "engram.kg-v3-access-state.v1" as const;

export interface KgV3AccessEvent {
  schema: typeof KG_V3_ACCESS_EVENT_SCHEMA;
  eventId: `sha256:${string}`;
  workspaceId: string;
  sessionKey: string;
  messageId: string;
  assertionIds: string[];
  observedAt: string;
}

export interface KgV3AssertionAccessState {
  lastAccessed: string;
  accessCount: number;
}

export interface KgV3AccessState {
  schema: typeof KG_V3_ACCESS_STATE_SCHEMA;
  workspaceId: string;
  revision: number;
  appliedEventIds: string[];
  assertions: Record<string, KgV3AssertionAccessState>;
  updatedAt: string | null;
}

export interface KgV3AccessReconcileResult {
  schema: "engram.kg-v3-access-reconcile.v1";
  workspace: string;
  workspaceId: string;
  mode: "dry-run" | "write";
  read: number;
  applied: number;
  alreadyApplied: number;
  invalid: number;
  assertionTouches: number;
  state: KgV3AccessState;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value as object).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
}

function digest(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
}

function token(value: unknown, max = 512): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= max;
}

function uuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function iso(value: unknown): value is string {
  return token(value) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
    && Number.isFinite(Date.parse(value));
}

function assertInside(root: string, path: string): void {
  const rel = relative(resolve(root), resolve(path));
  if (rel === "" || rel.startsWith("..") || rel.includes("/../")) throw new Error(`KG v3 access path escapes workspace: ${path}`);
}

function atomicJson(path: string, value: unknown): void {
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

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function withLock<T>(path: string, fn: () => T): T {
  const started = Date.now();
  mkdirSync(dirname(path), { recursive: true });
  for (;;) {
    try {
      mkdirSync(path, { mode: 0o700 });
      atomicJson(join(path, "owner.json"), { pid: process.pid, acquiredAt: new Date().toISOString() });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let stale = false;
      try {
        const owner = readJson<{ pid?: number }>(join(path, "owner.json"));
        stale = !Number.isInteger(owner.pid) || !processAlive(owner.pid!);
      } catch {
        try { stale = Date.now() - statSync(path).mtimeMs > 30_000; } catch { stale = false; }
      }
      if (stale) {
        rmSync(path, { recursive: true, force: true });
        continue;
      }
      if (Date.now() - started >= 10_000) throw new Error(`KG v3 access lock timeout: ${path}`);
      sleepSync(10);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
}

function emptyState(workspaceId: string): KgV3AccessState {
  return {
    schema: KG_V3_ACCESS_STATE_SCHEMA,
    workspaceId,
    revision: 0,
    appliedEventIds: [],
    assertions: {},
    updatedAt: null,
  };
}

export function readKgV3AccessState(workspace: string, workspaceId: string): KgV3AccessState {
  const root = resolve(workspace);
  const path = join(root, "memory-state", "kg-v3", "access", "state.json");
  assertInside(root, path);
  if (!existsSync(path)) return emptyState(workspaceId);
  const state = readJson<KgV3AccessState>(path);
  if (state.schema !== KG_V3_ACCESS_STATE_SCHEMA || state.workspaceId !== workspaceId
    || !Number.isInteger(state.revision) || state.revision < 0
    || !Array.isArray(state.appliedEventIds) || new Set(state.appliedEventIds).size !== state.appliedEventIds.length
    || state.appliedEventIds.some((id) => !/^sha256:[a-f0-9]{64}$/.test(id))
    || !state.assertions || typeof state.assertions !== "object") {
    throw new Error("invalid KG v3 access state");
  }
  for (const [id, value] of Object.entries(state.assertions)) {
    if (!uuid(id) || !value || !iso(value.lastAccessed) || !Number.isInteger(value.accessCount) || value.accessCount < 1) {
      throw new Error("invalid KG v3 assertion access state");
    }
  }
  return state;
}

function validateEvent(value: unknown, workspaceId: string): value is KgV3AccessEvent {
  const event = value as KgV3AccessEvent;
  if (!event || event.schema !== KG_V3_ACCESS_EVENT_SCHEMA || event.workspaceId !== workspaceId
    || !/^sha256:[a-f0-9]{64}$/.test(event.eventId || "")
    || !token(event.sessionKey) || !token(event.messageId) || !iso(event.observedAt)
    || !Array.isArray(event.assertionIds) || event.assertionIds.length < 1 || event.assertionIds.length > 64
    || event.assertionIds.some((id) => !uuid(id)) || new Set(event.assertionIds).size !== event.assertionIds.length) return false;
  return event.eventId === deriveKgV3AccessEventId(event);
}

export function deriveKgV3AccessEventId(input: Pick<KgV3AccessEvent, "workspaceId" | "sessionKey" | "messageId" | "assertionIds">): `sha256:${string}` {
  return digest({
    assertionIds: [...new Set(input.assertionIds)].sort(),
    messageId: input.messageId,
    sessionKey: input.sessionKey,
    workspaceId: input.workspaceId,
  });
}

export function recordKgV3AccessEvent(options: {
  workspace: string;
  workspaceId: string;
  sessionKey: string;
  messageId: string;
  assertionIds: string[];
  observedAt?: string;
}): { status: "recorded" | "duplicate"; event: KgV3AccessEvent } {
  const workspace = resolve(options.workspace);
  const assertionIds = [...new Set(options.assertionIds)].sort();
  const observedAt = options.observedAt || new Date().toISOString();
  if (!token(options.workspaceId, 128) || !token(options.sessionKey) || !token(options.messageId) || !iso(observedAt)
    || assertionIds.length < 1 || assertionIds.length > 64 || assertionIds.some((id) => !uuid(id))) {
    throw new Error("invalid KG v3 access event input");
  }
  for (const id of assertionIds) {
    const assertionPath = join(workspace, "life", "v3", "assertions", `${id}.json`);
    assertInside(workspace, assertionPath);
    if (!existsSync(assertionPath)) throw new Error(`unknown KG v3 assertion: ${id}`);
    const assertion = readJson<KgAssertionV3>(assertionPath);
    if (assertion.schema !== KG_V3_ASSERTION_SCHEMA || assertion.id !== id || assertion.workspaceId !== options.workspaceId
      || assertion.lifecycle?.status !== "active") throw new Error(`KG v3 assertion is not active: ${id}`);
  }
  const eventId = deriveKgV3AccessEventId({ workspaceId: options.workspaceId, sessionKey: options.sessionKey, messageId: options.messageId, assertionIds });
  const event: KgV3AccessEvent = { schema: KG_V3_ACCESS_EVENT_SCHEMA, eventId, workspaceId: options.workspaceId, sessionKey: options.sessionKey, messageId: options.messageId, assertionIds, observedAt };
  const path = join(workspace, "memory-state", "kg-v3", "access", "events", `${eventId.slice(7)}.json`);
  assertInside(workspace, path);
  if (existsSync(path)) {
    const prior = readJson<KgV3AccessEvent>(path);
    if (!validateEvent(prior, options.workspaceId) || canonical(prior) !== canonical(event)) throw new Error("KG v3 access event conflict");
    return { status: "duplicate", event: prior };
  }
  atomicJson(path, event);
  return { status: "recorded", event };
}

export function reconcileKgV3Access(options: { workspace: string; workspaceId: string; dryRun?: boolean }): KgV3AccessReconcileResult {
  const workspace = resolve(options.workspace);
  const root = join(workspace, "memory-state", "kg-v3", "access");
  const eventsRoot = join(root, "events");
  const statePath = join(root, "state.json");
  const lockPath = join(workspace, "memory-state", "kg-v3", "locks", "access-reconcile.lock");
  for (const path of [root, eventsRoot, statePath, lockPath]) assertInside(workspace, path);
  return withLock(lockPath, () => {
    const current = readKgV3AccessState(workspace, options.workspaceId);
    const state: KgV3AccessState = JSON.parse(JSON.stringify(current)) as KgV3AccessState;
    const applied = new Set(state.appliedEventIds);
    const report: KgV3AccessReconcileResult = {
      schema: "engram.kg-v3-access-reconcile.v1",
      workspace,
      workspaceId: options.workspaceId,
      mode: options.dryRun ? "dry-run" : "write",
      read: 0,
      applied: 0,
      alreadyApplied: 0,
      invalid: 0,
      assertionTouches: 0,
      state,
    };
    const names = existsSync(eventsRoot) ? readdirSync(eventsRoot).filter((name) => /^[a-f0-9]{64}\.json$/.test(name)).sort() : [];
    for (const name of names) {
      report.read++;
      let event: KgV3AccessEvent;
      try {
        event = readJson<KgV3AccessEvent>(join(eventsRoot, name));
        if (!validateEvent(event, options.workspaceId) || `${event.eventId.slice(7)}.json` !== name) throw new Error("invalid event");
        for (const id of event.assertionIds) {
          const assertion = readJson<KgAssertionV3>(join(workspace, "life", "v3", "assertions", `${id}.json`));
          if (assertion.schema !== KG_V3_ASSERTION_SCHEMA || assertion.id !== id || assertion.workspaceId !== options.workspaceId) {
            throw new Error("invalid assertion target");
          }
        }
      } catch {
        report.invalid++;
        continue;
      }
      if (applied.has(event.eventId)) {
        report.alreadyApplied++;
        continue;
      }
      for (const id of event.assertionIds) {
        const prior = state.assertions[id];
        state.assertions[id] = {
          lastAccessed: prior && Date.parse(prior.lastAccessed) > Date.parse(event.observedAt) ? prior.lastAccessed : event.observedAt,
          accessCount: (prior?.accessCount || 0) + 1,
        };
        report.assertionTouches++;
      }
      applied.add(event.eventId);
      state.appliedEventIds.push(event.eventId);
      state.revision++;
      state.updatedAt = state.updatedAt && Date.parse(state.updatedAt) > Date.parse(event.observedAt) ? state.updatedAt : event.observedAt;
      report.applied++;
    }
    if (!options.dryRun && report.applied > 0) atomicJson(statePath, state);
    return report;
  });
}
