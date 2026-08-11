import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { RegistryWorkspaceEntryV1, WorkspaceRegistryAdapter } from "./contracts";
import { canonicalizeJcs, Digest, sha256Digest } from "./handoff-v2";

export interface DiscoveredWorkspaceV1 extends RegistryWorkspaceEntryV1 {
  workspacePath: string;
  timezone: string;
  config: Record<string, any>;
}

export interface QuarantinedRegistryEntryV1 {
  workspaceId: string;
  workspacePath: string;
  reason: string;
}

export interface FrozenRegistrySnapshotV1 {
  schema: "oll.workspace-registry-snapshot.v1";
  capturedAt: string;
  registryDigest: Digest;
  configDigest: Digest;
  entries: readonly DiscoveredWorkspaceV1[];
  disabled: readonly string[];
  quarantined: readonly QuarantinedRegistryEntryV1[];
  snapshotDigest: Digest;
}

const WORKSPACE_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

function inside(root: string, target: string): boolean {
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return target === root || target.startsWith(prefix);
}

function validateNightlyConfig(config: Record<string, any>, workspaceId: string): string | null {
  if (config.schemaVersion !== 1) return "unsupported engram schemaVersion";
  if (config?.workspace?.id !== workspaceId) return "registry ID does not match engram workspace.id";
  if (config?.oll?.scheduleOwner !== "nightly") return "OLL schedule owner is not nightly";
  if (typeof config?.oll?.nightly?.enabled !== "boolean") return "oll.nightly.enabled is missing";
  if (typeof config?.oll?.nightly?.timezone !== "string" || !config.oll.nightly.timezone) return "nightly timezone is invalid";
  try { new Intl.DateTimeFormat("en-US", { timeZone: config.oll.nightly.timezone }).format(new Date()); }
  catch { return "nightly timezone is unavailable"; }
  if (config?.oll?.nightly?.weekStart !== "monday") return "nightly weekStart is invalid";
  const ttl = config?.oll?.nightly?.leaseTtlSeconds;
  const renewal = config?.oll?.nightly?.leaseRenewSeconds;
  const handoffTimeout = config?.oll?.nightly?.handoffTimeoutSeconds;
  const batchTimeout = config?.oll?.nightly?.batchTimeoutSeconds;
  if (!Number.isInteger(ttl) || ttl < 60) return "nightly lease TTL is invalid";
  if (!Number.isInteger(renewal) || renewal < 1 || renewal >= ttl) return "nightly lease renewal is invalid";
  if (!Number.isInteger(handoffTimeout) || handoffTimeout < 1) return "nightly handoff timeout is invalid";
  if (!Number.isInteger(batchTimeout) || batchTimeout < 1 || handoffTimeout >= batchTimeout) return "nightly batch timeout is invalid";
  if (!Number.isInteger(config?.oll?.nightly?.maxSpawnAttempts) || config.oll.nightly.maxSpawnAttempts < 1) return "nightly retry policy is invalid";
  if (!Array.isArray(config?.oll?.nightly?.retryBackoffSeconds)) return "nightly retry backoff is invalid";
  if (!config?.models?.heartbeat?.subagents?.["hb-rethink"]) return "hb-rethink model mapping is missing";
  return null;
}

function validateActivationProjection(workspacePath: string, config: Record<string, any>, workspaceId: string): string | null {
  if (config?.oll?.nightly?.enabled !== true) return null;
  const statePath = join(workspacePath, "memory-state", "oll", "state.json");
  const rolloutPath = join(workspacePath, "memory-state", "oll", "rollout.json");
  if (!existsSync(statePath) || !existsSync(rolloutPath)) return "nightly activation projection is missing";
  try {
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    const rollout = JSON.parse(readFileSync(rolloutPath, "utf8"));
    const expectedStatus = config?.oll?.adaptation?.mode === "active" ? "active" : "observe_only_canary";
    if (
      state?.schema !== "oll-nightly-state.v1"
      || state?.workspaceId !== workspaceId
      || state?.scheduleOwner !== "nightly"
      || state?.nightlyEnabled !== true
      || state?.legacyHeartbeat?.admission !== "disabled"
      || state?.legacyHeartbeat?.application !== "disabled"
      || rollout?.schema !== "oll.workspace-rollout-state.v1"
      || rollout?.workspaceId !== workspaceId
      || rollout?.targetMode !== config?.oll?.adaptation?.mode
      || rollout?.status !== expectedStatus
    ) return "nightly activation projection is inconsistent";
  } catch {
    return "nightly activation projection is malformed";
  }
  return null;
}

function freezeDeep<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const entry of Object.values(value as Record<string, unknown>)) freezeDeep(entry);
  }
  return value;
}

export async function discoverNightlyWorkspaces(options: {
  adapter: WorkspaceRegistryAdapter;
  allowedRoots: readonly string[];
  capturedAt?: string;
}): Promise<FrozenRegistrySnapshotV1> {
  if (!options.allowedRoots.length) throw new Error("at least one workspace allowlist root is required");
  const roots = options.allowedRoots.map((root) => {
    const absolute = resolve(root);
    return existsSync(absolute) ? realpathSync(absolute) : absolute;
  });
  const source = await options.adapter.snapshot();
  if (source.schema !== "oll.workspace-registry-snapshot.v1" || !Array.isArray(source.entries)) throw new Error("registry adapter returned an invalid snapshot");
  const capturedAt = options.capturedAt || source.capturedAt;
  if (!Number.isFinite(Date.parse(capturedAt))) throw new Error("registry capturedAt is invalid");
  const quarantined: QuarantinedRegistryEntryV1[] = [];
  const disabled: string[] = [];
  const candidates: Array<DiscoveredWorkspaceV1 & { sourceIndex: number }> = [];

  for (const [sourceIndex, entry] of source.entries.entries()) {
    const workspaceId = String(entry?.workspaceId || "");
    const originalPath = String(entry?.workspacePath || "");
    const reject = (reason: string) => quarantined.push({ workspaceId: workspaceId || "invalid", workspacePath: originalPath, reason });
    if (!WORKSPACE_RE.test(workspaceId)) { reject("invalid registry workspace ID"); continue; }
    if (!DIGEST_RE.test(String(entry.registryDigest || ""))) { reject("invalid registry digest"); continue; }
    const requested = resolve(originalPath);
    if (!existsSync(requested)) { reject("workspace path does not exist"); continue; }
    let workspacePath: string;
    try { workspacePath = realpathSync(requested); }
    catch { reject("workspace path cannot be canonicalized"); continue; }
    if (!roots.some((root) => inside(root, workspacePath))) { reject("workspace path escapes the deployment allowlist"); continue; }
    if (!statSync(workspacePath).isDirectory()) { reject("workspace path is not a directory"); continue; }
    const configPath = resolve(workspacePath, "engram.json");
    if (!existsSync(configPath)) { reject("engram.json is missing"); continue; }
    let config: Record<string, any>;
    let raw: string;
    try {
      raw = readFileSync(configPath, "utf8");
      config = JSON.parse(raw);
    } catch { reject("engram.json is malformed"); continue; }
    const configError = validateNightlyConfig(config, workspaceId);
    if (configError) { reject(configError); continue; }
    if (config.oll.nightly.enabled !== true) { disabled.push(workspaceId); continue; }
    const activationError = validateActivationProjection(workspacePath, config, workspaceId);
    if (activationError) { reject(activationError); continue; }
    candidates.push({
      workspaceId,
      workspacePath,
      registryRevision: entry.registryRevision,
      registryDigest: entry.registryDigest,
      configDigest: sha256Digest(raw),
      timezone: config.oll.nightly.timezone,
      config,
      sourceIndex,
    });
  }

  const duplicateIds = new Set(candidates.filter((entry, index, all) => all.some((other, otherIndex) => otherIndex !== index && other.workspaceId === entry.workspaceId)).map((entry) => entry.workspaceId));
  const duplicatePaths = new Set(candidates.filter((entry, index, all) => all.some((other, otherIndex) => otherIndex !== index && other.workspacePath === entry.workspacePath)).map((entry) => entry.workspacePath));
  const entries: DiscoveredWorkspaceV1[] = [];
  for (const candidate of candidates) {
    if (duplicateIds.has(candidate.workspaceId)) {
      quarantined.push({ workspaceId: candidate.workspaceId, workspacePath: candidate.workspacePath, reason: "duplicate canonical workspace ID" });
      continue;
    }
    if (duplicatePaths.has(candidate.workspacePath)) {
      quarantined.push({ workspaceId: candidate.workspaceId, workspacePath: candidate.workspacePath, reason: "duplicate canonical workspace path" });
      continue;
    }
    const { sourceIndex: _sourceIndex, ...entry } = candidate;
    entries.push(entry);
  }
  entries.sort((a, b) => a.workspaceId.localeCompare(b.workspaceId));
  quarantined.sort((a, b) => `${a.workspaceId}\0${a.workspacePath}\0${a.reason}`.localeCompare(`${b.workspaceId}\0${b.workspacePath}\0${b.reason}`));
  disabled.sort();
  const registryDigest = sha256Digest(canonicalizeJcs(source.entries));
  const configDigest = sha256Digest(canonicalizeJcs(entries.map((entry) => ({ workspaceId: entry.workspaceId, configDigest: entry.configDigest }))));
  const base = { schema: "oll.workspace-registry-snapshot.v1" as const, capturedAt, registryDigest, configDigest, entries, disabled, quarantined };
  return freezeDeep({ ...base, snapshotDigest: sha256Digest(canonicalizeJcs(base)) });
}
