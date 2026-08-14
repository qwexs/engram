import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

export const LEGACY_MIGRATION_ID = "legacy-heartbeat-v1" as const;
export const LEGACY_OLL_PHASES = Object.freeze([
  "hb-rethink",
  "hb-rethink2",
  "hb-autoresearch",
]);

export const DEPRECATED_HEARTBEAT_KEYS = Object.freeze([
  "lastHeartbeat",
  "schedule",
  "enabled",
  "cronJobId",
  "model",
  "notes",
  "lastWeeklySynthesis",
  "lastRethink",
  "lastRethinkScore",
  "rethinkCount",
  "rethinkInProgress",
  "rethinkStartedAt",
  "pendingRethink2",
  "rethink2InProgress",
  "rethink2StartedAt",
  "autoresearchInProgress",
  "autoresearchStartedAt",
  "currentExperiment",
  "lastAutoresearch",
  "lastAutoSeedAt",
]);

export const LEGACY_SOURCE_DISPOSITIONS = Object.freeze([
  { source: "heartbeat.lastWeeklySynthesis", target: "state.memoryReconciliation.weeklyWindowStart", disposition: "migrate" },
  { source: "memory/weekly-synthesis-tracker.json", target: "legacy-quarantine", disposition: "retire" },
  { source: "heartbeat.lastRethink", target: "state.evaluation.lastCompletedAt", disposition: "migrate" },
  { source: "heartbeat.lastRethinkScore", target: "state.evaluation.lastScore", disposition: "migrate" },
  { source: "heartbeat.rethinkCount", target: "state.evaluation.completedCount", disposition: "migrate" },
  { source: "heartbeat OLL in-progress flags", target: "legacy-quarantine/manifest", disposition: "quarantine" },
  { source: "heartbeat.subagentRuns legacy phases", target: "legacy-quarantine/manifest", disposition: "quarantine" },
  { source: "legacy queued/spawned/handoff records", target: "legacy-quarantine/files", disposition: "quarantine" },
  { source: "legacy terminal records", target: "original done directory", disposition: "retain_terminal" },
  { source: "pending experiment specs", target: "legacy-quarantine/manifest", disposition: "quarantine_reference" },
]);

type JsonObject = Record<string, any>;

export interface LegacyArtifact {
  relativePath: string;
  kind: "spawn" | "handoff" | "experiment" | "weekly_tracker";
  phase: string | null;
  status: string | null;
  digest: `sha256:${string}`;
  disposition: "quarantine" | "retain_terminal" | "quarantine_reference";
}

export interface WorkspaceMigrationPlan {
  schema: "oll.legacy-migration-plan.v1";
  migrationId: typeof LEGACY_MIGRATION_ID;
  workspace: string;
  workspaceId: string;
  createdAt: string;
  sourceDigest: `sha256:${string}`;
  sourceToTarget: readonly JsonObject[];
  artifacts: LegacyArtifact[];
  sourceFiles: Array<{ relativePath: string; digest: `sha256:${string}` }>;
  targetConfig: JsonObject;
  targetHeartbeatState: JsonObject;
  targetNightlyState: JsonObject;
}

function sha256(value: string | Buffer): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function jsonDigest(value: unknown): `sha256:${string}` {
  return sha256(JSON.stringify(value));
}

function readJson(path: string): JsonObject {
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must contain a JSON object`);
  }
  return value;
}

function fsyncDirectory(path: string): void {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    fsyncSync(fd);
  } catch {
    // Some platforms do not support fsync on directories.
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

export function atomicWriteJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(value, null, 2) + "\n", "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
  fsyncDirectory(dirname(path));
}

function durableCopy(source: string, destination: string): void {
  if (existsSync(destination)) return;
  mkdirSync(dirname(destination), { recursive: true });
  const temporary = join(dirname(destination), `.${randomUUID()}.tmp`);
  copyFileSync(source, temporary);
  const fd = openSync(temporary, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, destination);
  fsyncDirectory(dirname(destination));
}

function durableMove(source: string, destination: string): void {
  if (!existsSync(source)) return;
  if (existsSync(destination)) return;
  mkdirSync(dirname(destination), { recursive: true });
  renameSync(source, destination);
  fsyncDirectory(dirname(source));
  fsyncDirectory(dirname(destination));
}

function walkFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const result: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) result.push(...walkFiles(path));
    else if (entry.isFile()) result.push(path);
  }
  return result.sort();
}

function legacyPhase(value: unknown): string | null {
  const phase = String(value || "");
  return LEGACY_OLL_PHASES.includes(phase) ? phase : null;
}

function handoffPhase(text: string): string | null {
  if (/=== HB-RETHINK2 HANDOFF ===/.test(text)) return "hb-rethink2";
  if (/=== HB-AUTORESEARCH HANDOFF ===/.test(text)) return "hb-autoresearch";
  if (/=== HB-RETHINK HANDOFF ===/.test(text)) return "hb-rethink";
  return null;
}

function isTerminal(status: string | null): boolean {
  return ["done", "ok", "failed", "cancelled", "stale", "quarantined"].includes(String(status));
}

function relativeSafe(workspace: string, path: string): string {
  const rel = relative(workspace, path).replace(/\\/g, "/");
  if (!rel || rel === ".." || rel.startsWith("../")) throw new Error(`path escapes workspace: ${path}`);
  return rel;
}

function artifactFor(workspace: string, path: string): LegacyArtifact | null {
  const relativePath = relativeSafe(workspace, path);
  const bytes = readFileSync(path);
  if (path.endsWith(".json")) {
    let value: JsonObject;
    try { value = JSON.parse(bytes.toString("utf8")); } catch { return null; }
    const phase = legacyPhase(value?.phase);
    if (!phase) return null;
    const status = value?.status == null ? null : String(value.status);
    const inDone = relativePath.includes("/heartbeat-spawns/done/");
    return {
      relativePath,
      kind: "spawn",
      phase,
      status,
      digest: sha256(bytes),
      disposition: inDone && isTerminal(status) ? "retain_terminal" : "quarantine",
    };
  }
  if (path.endsWith(".md")) {
    const phase = handoffPhase(bytes.toString("utf8"));
    if (!phase) return null;
    const inDone = relativePath.includes("/heartbeat-spawns/done/");
    return {
      relativePath,
      kind: "handoff",
      phase,
      status: inDone ? "done" : "pending",
      digest: sha256(bytes),
      disposition: inDone ? "retain_terminal" : "quarantine",
    };
  }
  return null;
}

function inspectArtifacts(workspace: string): LegacyArtifact[] {
  const spawnsRoot = join(workspace, "workspace", "ops", "heartbeat-spawns");
  const artifacts = walkFiles(spawnsRoot)
    .map((path) => artifactFor(workspace, path))
    .filter((value): value is LegacyArtifact => Boolean(value));

  const experimentsPath = join(workspace, "workspace", "research", "experiments.json");
  if (existsSync(experimentsPath)) {
    let registry: JsonObject | null = null;
    try { registry = readJson(experimentsPath); } catch { registry = null; }
    for (const id of Array.isArray(registry?.experiments) ? registry.experiments : []) {
      const spec = join(workspace, "workspace", "research", String(id), "spec.yaml");
      if (!existsSync(spec)) continue;
      const text = readFileSync(spec, "utf8");
      if (!/^status:\s*(pending|running)\s*$/m.test(text)) continue;
      artifacts.push({
        relativePath: relativeSafe(workspace, spec),
        kind: "experiment",
        phase: "hb-autoresearch",
        status: text.match(/^status:\s*(pending|running)\s*$/m)?.[1] || "pending",
        digest: sha256(text),
        disposition: "quarantine_reference",
      });
    }
  }

  const weeklyTracker = join(workspace, "memory", "weekly-synthesis-tracker.json");
  if (existsSync(weeklyTracker)) {
    artifacts.push({
      relativePath: relativeSafe(workspace, weeklyTracker),
      kind: "weekly_tracker",
      phase: null,
      status: "retired",
      digest: sha256(readFileSync(weeklyTracker)),
      disposition: "quarantine",
    });
  }
  return artifacts.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

function workspaceIdFromConfig(config: JsonObject, requestedId?: string): string {
  const id = String(requestedId || config?.workspace?.id || String(config?.agent || "").replace(/^agent-/, "")).trim();
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(id)) throw new Error(`invalid workspace id ${JSON.stringify(id)}`);
  if (config?.workspace?.id && config.workspace.id !== id) {
    throw new Error(`workspace.id mismatch: ${config.workspace.id} != ${id}`);
  }
  return id;
}

function targetConfig(config: JsonObject, workspaceId: string): JsonObject {
  const existingOll = config.oll && typeof config.oll === "object" && !Array.isArray(config.oll) ? config.oll : {};
  return {
    ...config,
    schemaVersion: 1,
    workspace: { ...(config.workspace || {}), id: workspaceId },
    oll: {
      ...existingOll,
      enabled: existingOll.enabled !== false,
      scheduleOwner: "nightly",
      nightly: {
        timezone: "UTC",
        weekStart: "monday",
        coordinatorStateRoot: "${ENGRAM_STATE_ROOT}/oll-nightly",
        workspaceStateDir: "memory-state/oll",
        leaseTtlSeconds: 600,
        leaseRenewSeconds: 60,
        handoffTimeoutSeconds: 300,
        batchTimeoutSeconds: 21600,
        maxSpawnAttempts: 2,
        retryBackoffSeconds: [30, 60],
        ...(existingOll.nightly || {}),
        enabled: false,
      },
      weeklyMode: { enabled: true, day: "monday", ...(existingOll.weeklyMode || {}) },
      candidateCompiler: existingOll.candidateCompiler
        ? structuredClone(existingOll.candidateCompiler)
        : {
            schema: "oll.memory-candidate-policy.v1",
            mode: "disabled",
            forwardOnlySince: "1970-01-01T00:00:00.000Z",
            maxCandidatesPerRun: 50,
            maxContextBytes: 65536,
            dailySessions: [],
            domainSources: false,
            kgSources: false,
            sourceQuotas: {
              "daily-decision": 12,
              "daily-learning": 12,
              "retrieval-card": 12,
              "domain-decision": 12,
              "domain-proposal": 8,
              "kg-assertion": 16,
            },
          },
      adaptation: {
        enabled: true,
        autoApplyMaxRisk: "low",
        actorRegistry: "${ENGRAM_STATE_ROOT}/oll/actors.v1.json",
        companyRuleStore: "${ENGRAM_STATE_ROOT}/oll/company-rules",
        maxHandoffBytes: 262144,
        maxActionsPerHandoff: 50,
        maxInjectedRuleBytes: 8192,
        ...(existingOll.adaptation || {}),
        mode: "observe-only",
      },
    },
  };
}

function targetHeartbeatState(state: JsonObject): JsonObject {
  const target = structuredClone(state);
  for (const key of DEPRECATED_HEARTBEAT_KEYS) delete target[key];
  if (target.subagentRuns && typeof target.subagentRuns === "object") {
    for (const phase of LEGACY_OLL_PHASES) delete target.subagentRuns[phase];
  }
  return target;
}

function dateOrNull(value: unknown): string | null {
  const text = String(value || "");
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function isoOrNull(value: unknown): string | null {
  const text = String(value || "");
  return Number.isFinite(Date.parse(text)) ? new Date(text).toISOString() : null;
}

export function buildWorkspaceMigrationPlan(options: {
  workspace: string;
  workspaceId?: string;
  now?: string;
}): WorkspaceMigrationPlan {
  const workspace = resolve(options.workspace);
  const configPath = join(workspace, "engram.json");
  const heartbeatPath = join(workspace, "memory", "heartbeat-state.json");
  if (!existsSync(configPath)) throw new Error(`engram.json is missing: ${configPath}`);
  if (!existsSync(heartbeatPath)) throw new Error(`heartbeat state is missing: ${heartbeatPath}`);
  const config = readJson(configPath);
  const heartbeat = readJson(heartbeatPath);
  const workspaceId = workspaceIdFromConfig(config, options.workspaceId);
  const now = options.now || new Date().toISOString();
  if (!Number.isFinite(Date.parse(now))) throw new Error(`invalid migration timestamp ${JSON.stringify(now)}`);
  const artifacts = inspectArtifacts(workspace);
  const sourceFiles = [configPath, heartbeatPath, ...artifacts.map((artifact) => join(workspace, artifact.relativePath))]
    .filter((path, index, all) => existsSync(path) && all.indexOf(path) === index)
    .map((path) => ({ relativePath: relativeSafe(workspace, path), digest: sha256(readFileSync(path)) }))
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  const sourceDigest = jsonDigest(sourceFiles);
  const backupManifest = `memory-state/oll/migrations/${LEGACY_MIGRATION_ID}/backup-manifest.json`;
  const quarantineManifest = `memory-state/oll/migrations/${LEGACY_MIGRATION_ID}/quarantine-manifest.json`;
  const trackerPath = join(workspace, "memory", "weekly-synthesis-tracker.json");
  let tracker: JsonObject = {};
  if (existsSync(trackerPath)) {
    try { tracker = readJson(trackerPath); } catch { tracker = {}; }
  }
  const targetNightlyState = {
    schema: "oll-nightly-state.v1",
    schemaVersion: 1,
    workspaceId,
    scheduleOwner: "nightly",
    nightlyEnabled: false,
    legacyHeartbeat: { admission: "disabled", application: "disabled", disabledAt: now },
    memoryReconciliation: {
      weeklyWindowStart: dateOrNull(heartbeat.lastWeeklySynthesis) || dateOrNull(tracker.lastRun),
      lastCompletedAt: isoOrNull(tracker.executedAt),
    },
    capture: {
      lastObservedAt: null,
    },
    evaluation: {
      lastCompletedAt: isoOrNull(heartbeat.lastRethink),
      lastSnapshotAt: isoOrNull(heartbeat.lastRethink),
      signalRevisions: {},
      lastScore: typeof heartbeat.lastRethinkScore === "number" ? heartbeat.lastRethinkScore : null,
      completedCount: Number.isInteger(heartbeat.rethinkCount) && heartbeat.rethinkCount >= 0 ? heartbeat.rethinkCount : 0,
    },
    migration: {
      id: LEGACY_MIGRATION_ID,
      sourceDigest,
      mappingVersion: 1,
      backupManifest,
      quarantineManifest,
      completedAt: now,
    },
  };
  return {
    schema: "oll.legacy-migration-plan.v1",
    migrationId: LEGACY_MIGRATION_ID,
    workspace,
    workspaceId,
    createdAt: now,
    sourceDigest,
    sourceToTarget: LEGACY_SOURCE_DISPOSITIONS,
    artifacts,
    sourceFiles,
    targetConfig: targetConfig(config, workspaceId),
    targetHeartbeatState: targetHeartbeatState(heartbeat),
    targetNightlyState,
  };
}

function migrationPaths(workspace: string) {
  const ollRoot = join(workspace, "memory-state", "oll");
  const migrationRoot = join(ollRoot, "migrations", LEGACY_MIGRATION_ID);
  return {
    ollRoot,
    migrationRoot,
    marker: join(ollRoot, "legacy-admission-disabled.json"),
    state: join(ollRoot, "state.json"),
    schemaVersion: join(ollRoot, "schema-version.json"),
    plan: join(migrationRoot, "plan.json"),
    journal: join(migrationRoot, "journal.json"),
    backupManifest: join(migrationRoot, "backup-manifest.json"),
    quarantineManifest: join(migrationRoot, "quarantine-manifest.json"),
    backupRoot: join(migrationRoot, "backups"),
    quarantineRoot: join(ollRoot, "legacy-quarantine", LEGACY_MIGRATION_ID),
  };
}

function ensureAdaptationLayout(workspace: string): void {
  const root = join(workspace, "memory-state", "oll");
  for (const directory of [
    "signals", "rules", "reviews", "operations", "audit",
    "handoffs/incoming", "handoffs/applied", "handoffs/rejected", "apply-journal",
  ]) {
    mkdirSync(join(root, directory), { recursive: true });
  }
}

function migrationComplete(workspace: string): boolean {
  const paths = migrationPaths(workspace);
  if (!existsSync(paths.marker) || !existsSync(paths.state) || !existsSync(paths.journal)) return false;
  try {
    const config = readJson(join(workspace, "engram.json"));
    const state = readJson(paths.state);
    const heartbeat = readJson(join(workspace, "memory", "heartbeat-state.json"));
    const journal = readJson(paths.journal);
    return config?.oll?.scheduleOwner === "nightly"
      && state.schema === "oll-nightly-state.v1"
      && state.scheduleOwner === "nightly"
      && typeof state.nightlyEnabled === "boolean"
      && state.nightlyEnabled === Boolean(config?.oll?.nightly?.enabled)
      && state.legacyHeartbeat?.admission === "disabled"
      && state.legacyHeartbeat?.application === "disabled"
      && journal.status === "completed"
      && DEPRECATED_HEARTBEAT_KEYS.every((key) => !(key in heartbeat))
      && LEGACY_OLL_PHASES.every((phase) => !(phase in (heartbeat.subagentRuns || {})))
      && inspectArtifacts(workspace).every((artifact) => artifact.disposition !== "quarantine");
  } catch {
    return false;
  }
}

export function migrateWorkspaceLegacyOll(options: {
  workspace: string;
  workspaceId?: string;
  now?: string;
  apply?: boolean;
}): JsonObject {
  const workspace = resolve(options.workspace);
  const paths = migrationPaths(workspace);
  if (migrationComplete(workspace)) {
    if (options.apply) ensureAdaptationLayout(workspace);
    const state = readJson(paths.state);
    return {
      schema: "oll.legacy-workspace-migration-result.v1",
      workspace,
      workspaceId: state.workspaceId,
      status: "unchanged",
      changed: false,
      nightlyEnabled: state.nightlyEnabled,
      sourceDigest: state.migration.sourceDigest,
      proof: { legacyAdmission: "disabled", legacyApplication: "disabled", activeLegacyArtifacts: 0 },
    };
  }

  const existingPlan = existsSync(paths.plan) ? readJson(paths.plan) as WorkspaceMigrationPlan : null;
  const plan = existingPlan || buildWorkspaceMigrationPlan(options);
  if (!options.apply) {
    return {
      schema: "oll.legacy-workspace-migration-result.v1",
      workspace,
      workspaceId: plan.workspaceId,
      status: "planned",
      changed: true,
      nightlyEnabled: false,
      sourceDigest: plan.sourceDigest,
      artifacts: plan.artifacts,
    };
  }

  mkdirSync(paths.migrationRoot, { recursive: true });
  ensureAdaptationLayout(workspace);
  if (!existsSync(paths.marker)) {
    atomicWriteJson(paths.marker, {
      schema: "oll.legacy-admission-disabled.v1",
      workspaceId: plan.workspaceId,
      migrationId: LEGACY_MIGRATION_ID,
      disabledAt: plan.createdAt,
      reason: "nightly OLL cutover barrier",
    });
  }
  if (!existsSync(paths.plan)) atomicWriteJson(paths.plan, plan);
  atomicWriteJson(paths.journal, {
    schema: "oll.legacy-workspace-migration-journal.v1",
    migrationId: LEGACY_MIGRATION_ID,
    workspaceId: plan.workspaceId,
    status: "applying",
    sourceDigest: plan.sourceDigest,
    updatedAt: plan.createdAt,
  });

  const backups: JsonObject[] = [];
  for (const source of plan.sourceFiles) {
    const sourcePath = join(workspace, source.relativePath);
    const destination = join(paths.backupRoot, source.relativePath);
    if (existsSync(sourcePath)) durableCopy(sourcePath, destination);
    if (existsSync(destination)) {
      const actualDigest = sha256(readFileSync(destination));
      if (actualDigest !== source.digest) throw new Error(`backup digest mismatch for ${source.relativePath}`);
      backups.push({ ...source, backupPath: relativeSafe(workspace, destination) });
    }
  }
  atomicWriteJson(paths.backupManifest, {
    schema: "oll.legacy-backup-manifest.v1",
    migrationId: LEGACY_MIGRATION_ID,
    workspaceId: plan.workspaceId,
    sourceDigest: plan.sourceDigest,
    createdAt: plan.createdAt,
    files: backups,
    rollback: {
      mode: "operator-reviewed",
      warning: "Restoration must preserve newer audit events and must not re-enable legacy admission implicitly.",
    },
  });

  const quarantine: JsonObject[] = [];
  for (const artifact of plan.artifacts) {
    if (artifact.disposition === "quarantine") {
      const source = join(workspace, artifact.relativePath);
      const destination = join(paths.quarantineRoot, artifact.relativePath);
      durableMove(source, destination);
      quarantine.push({ ...artifact, quarantinePath: relativeSafe(workspace, destination) });
    } else {
      quarantine.push(artifact);
    }
  }
  atomicWriteJson(paths.quarantineManifest, {
    schema: "oll.legacy-quarantine-manifest.v1",
    migrationId: LEGACY_MIGRATION_ID,
    workspaceId: plan.workspaceId,
    createdAt: plan.createdAt,
    artifacts: quarantine,
  });

  atomicWriteJson(join(workspace, "engram.json"), plan.targetConfig);
  atomicWriteJson(join(workspace, "memory", "heartbeat-state.json"), plan.targetHeartbeatState);
  atomicWriteJson(paths.schemaVersion, { schema: "oll.workspace-state-version.v1", version: 1 });
  atomicWriteJson(paths.state, plan.targetNightlyState);
  const auditPath = join(paths.ollRoot, "audit", `000001-${LEGACY_MIGRATION_ID}.json`);
  if (!existsSync(auditPath)) {
    atomicWriteJson(auditPath, {
      schema: "oll.audit-event.v1",
      eventId: randomUUID(),
      sequence: 1,
      type: "legacy_cutover_completed",
      workspaceId: plan.workspaceId,
      sourceDigest: plan.sourceDigest,
      sourceToTarget: plan.sourceToTarget,
      createdAt: plan.createdAt,
    });
  }

  const remaining = inspectArtifacts(workspace).filter((artifact) => artifact.disposition === "quarantine");
  if (remaining.length > 0) {
    throw new Error(`legacy OLL artifacts remain active: ${remaining.map((item) => item.relativePath).join(", ")}`);
  }
  atomicWriteJson(paths.journal, {
    schema: "oll.legacy-workspace-migration-journal.v1",
    migrationId: LEGACY_MIGRATION_ID,
    workspaceId: plan.workspaceId,
    status: "completed",
    sourceDigest: plan.sourceDigest,
    completedAt: plan.createdAt,
    backupManifest: relativeSafe(workspace, paths.backupManifest),
    quarantineManifest: relativeSafe(workspace, paths.quarantineManifest),
  });

  return {
    schema: "oll.legacy-workspace-migration-result.v1",
    workspace,
    workspaceId: plan.workspaceId,
    status: "migrated",
    changed: true,
    nightlyEnabled: false,
    sourceDigest: plan.sourceDigest,
    backupManifest: paths.backupManifest,
    quarantineManifest: paths.quarantineManifest,
    proof: { legacyAdmission: "disabled", legacyApplication: "disabled", activeLegacyArtifacts: 0 },
  };
}

export function migrateFleetLegacyOll(options: {
  registrySnapshotPath: string;
  stateRoot: string;
  now?: string;
  apply?: boolean;
}): JsonObject {
  const snapshotPath = resolve(options.registrySnapshotPath);
  const snapshot = readJson(snapshotPath);
  if (snapshot.schema !== "oll.workspace-registry-snapshot.v1" || !Array.isArray(snapshot.entries)) {
    throw new Error("registry snapshot must use oll.workspace-registry-snapshot.v1");
  }
  const entries = [...snapshot.entries].sort((a, b) => String(a.workspaceId).localeCompare(String(b.workspaceId)));
  const ids = new Set<string>();
  for (const entry of entries) {
    if (ids.has(entry.workspaceId)) throw new Error(`duplicate workspace id ${entry.workspaceId}`);
    ids.add(entry.workspaceId);
  }
  const now = options.now || new Date().toISOString();
  const fleetRoot = join(resolve(options.stateRoot), "oll-nightly", "migrations", LEGACY_MIGRATION_ID);
  const journalPath = join(fleetRoot, "fleet-journal.json");
  const registryDigest = sha256(readFileSync(snapshotPath));
  let journal: JsonObject = existsSync(journalPath)
    ? readJson(journalPath)
    : {
      schema: "oll.legacy-fleet-migration-journal.v1",
      migrationId: LEGACY_MIGRATION_ID,
      status: "pending",
      registryDigest,
      createdAt: now,
      workspaces: Object.fromEntries(entries.map((entry) => [entry.workspaceId, { status: "pending" }])),
    };
  if (journal.registryDigest !== registryDigest) throw new Error("registry snapshot changed during resumable migration");
  const results: JsonObject[] = [];
  if (options.apply) {
    mkdirSync(fleetRoot, { recursive: true });
    journal.status = "running";
    atomicWriteJson(journalPath, journal);
  }
  for (const entry of entries) {
    if (options.apply && journal.workspaces?.[entry.workspaceId]?.status === "completed") {
      results.push({ workspaceId: entry.workspaceId, status: "unchanged", resumed: true });
      continue;
    }
    try {
      const result = migrateWorkspaceLegacyOll({
        workspace: entry.workspacePath,
        workspaceId: entry.workspaceId,
        now,
        apply: options.apply,
      });
      results.push(result);
      if (options.apply) {
        journal.workspaces[entry.workspaceId] = { status: "completed", sourceDigest: result.sourceDigest };
        atomicWriteJson(journalPath, journal);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({ workspaceId: entry.workspaceId, status: "error", error: message });
      if (options.apply) {
        journal.workspaces[entry.workspaceId] = { status: "failed", error: message };
        atomicWriteJson(journalPath, journal);
      }
    }
  }
  const failed = results.filter((result) => result.status === "error").length;
  if (options.apply) {
    journal.status = failed ? "partial" : "completed";
    journal.completedAt = failed ? null : now;
    atomicWriteJson(journalPath, journal);
  }
  return {
    schema: "oll.legacy-fleet-migration-result.v1",
    mode: options.apply ? "apply" : "dry-run",
    registryDigest,
    status: failed ? "partial" : options.apply ? "completed" : "planned",
    nightlyEnabled: false,
    workspaces: results,
    summary: { total: entries.length, failed, completed: entries.length - failed },
    ...(options.apply ? { journalPath } : {}),
  };
}
