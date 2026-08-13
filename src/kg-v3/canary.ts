import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, openSync, closeSync, fsyncSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { KG_V3_AUTHORITY_SCHEMA, type KgAuthorityMarkerV1, type KgWriteRequest, type TrustedKgCallerContext } from "./types.ts";
import { KG_V3_SCHEMA_DIGEST, KgV3Core, validateKgRegistry } from "./core.ts";
import { KgV3Reader } from "./reader.ts";
import { runKgV3Benchmark, type KgBenchmarkManifestV1, type KgBenchmarkReportV1 } from "./benchmark.ts";

export const KG_V3_CANARY_RELEASE_FILES = [
  "src/kg-v3/types.ts", "src/kg-v3/core.ts", "src/kg-v3/reader.ts", "src/kg-v3/trusted-runtime.ts",
  "src/kg-v3/benchmark.ts", "src/kg-v3/context.ts", "src/kg-v3/canary.ts", "src/kg-v3/canary-executor.ts",
  "hooks/engram-kg-context-load/handler.ts",
  "scripts/kg-v3-canary-execute.ts",
  "schemas/kg-assertion-v3-mvp.schema.json", "schemas/kg-registry-v1.schema.json",
] as const;

export class KgCanaryError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "KgCanaryError"; }
}

export interface KgCanaryManifestV1 {
  schema: "engram.kg-v3-canary.v1";
  rolloutPhase?: "main-canary" | "fleet";
  workspaceId: string;
  releaseDigest: `sha256:${string}`;
  registryDigest: `sha256:${string}`;
  seedManifestDigest: `sha256:${string}`;
  explicitRequestManifestDigest: `sha256:${string}`;
  runtimeGrantsDigest: `sha256:${string}`;
  seedRequests: KgWriteRequest[];
  explicitRequests: KgWriteRequest[];
  humanApprovedOperationIds: string[];
  benchmark: KgBenchmarkManifestV1;
  enabledSessionCapabilities: KgAuthorityMarkerV1["enabledSessionCapabilities"];
  approvedBy: string;
  approvedAt: string;
}

export interface KgCanaryReceiptLedgerV1 {
  schema: "engram.kg-v3-canary-receipts.v1";
  workspaceId: string;
  releaseDigest: `sha256:${string}`;
  explicitRequestManifestDigest: `sha256:${string}`;
  entries: Array<{ operationId: string; status: "committed" | "skipped"; assertionId: string; humanApproved: true; provenanceComplete: true }>;
}

export interface KgCanaryOptions {
  workspace: string;
  workspaceId: string;
  manifestPath: string;
  registryPath?: string;
  now?: string;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value as object).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
}

export function kgCanaryDigest(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
}

function atomicWrite(path: string, body: Buffer | string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  const fd = openSync(temporary, "wx", 0o600);
  try { writeFileSync(fd, body); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, path);
}

function atomicJson(path: string, value: unknown): void { atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`); }

function inside(workspace: string, path: string): string {
  const root = resolve(workspace);
  const target = resolve(path);
  const rel = relative(root, target);
  if (rel === "" || rel.startsWith("..")) throw new KgCanaryError("PATH_ESCAPE", `path escapes workspace: ${path}`);
  return target;
}

function readObject<T>(path: string): T {
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new KgCanaryError("INVALID_JSON", `${path} must contain an object`);
  return value as T;
}

function inventory(workspace: string) {
  const root = join(workspace, "life");
  const entries: Array<{ path: string; size: number; digest: string }> = [];
  const walk = (directory: string) => {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) { if (path !== join(root, "v3")) walk(path); }
      else if (entry.name === "items.json") entries.push({ path: relative(workspace, path), size: statSync(path).size, digest: kgCanaryDigest(readFileSync(path).toString("base64")) });
    }
  };
  walk(root);
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return { entries, digest: kgCanaryDigest(entries), bytes: entries.reduce((sum, entry) => sum + entry.size, 0) };
}

function paths(workspace: string, releaseDigest: string) {
  const id = releaseDigest.slice(7);
  const state = join(workspace, "memory-state", "kg-v3");
  const root = join(state, "canary", id);
  return {
    stateRoot: state,
    root,
    authority: join(state, "authority.json"),
    registry: join(state, "registry.json"),
    context: join(state, "default-context.json"),
    backup: join(root, "backup.json"),
    report: join(root, "read-back-report.json"),
    ledger: join(root, "explicit-receipts.json"),
    canaryState: join(root, "state.json"),
  };
}

function validate(options: KgCanaryOptions) {
  const workspace = resolve(options.workspace);
  const manifestPath = inside(workspace, options.manifestPath);
  const manifest = readObject<KgCanaryManifestV1>(manifestPath);
  if (manifest.schema !== "engram.kg-v3-canary.v1" || manifest.workspaceId !== options.workspaceId || !/^sha256:[a-f0-9]{64}$/.test(manifest.releaseDigest) || !/^sha256:[a-f0-9]{64}$/.test(manifest.runtimeGrantsDigest)) throw new KgCanaryError("MANIFEST_INVALID", "canary manifest identity is invalid");
  const rolloutPhase = manifest.rolloutPhase || "main-canary";
  if (!Array.isArray(manifest.seedRequests) || manifest.seedRequests.length === 0 || !Array.isArray(manifest.explicitRequests)) throw new KgCanaryError("MANIFEST_INVALID", "seed and explicit request manifests are required");
  if (rolloutPhase === "main-canary" && (manifest.explicitRequests.length < 20 || manifest.explicitRequests.length > 30)) throw new KgCanaryError("MANIFEST_INVALID", "main canary explicit request manifest must contain exactly 20-30 requests");
  if (rolloutPhase === "fleet" && manifest.explicitRequests.length !== 0) throw new KgCanaryError("MANIFEST_INVALID", "fleet rollout must use curated seed only; live user assertions are admitted only from their own source turns");
  if (kgCanaryDigest(manifest.seedRequests) !== manifest.seedManifestDigest || kgCanaryDigest(manifest.explicitRequests) !== manifest.explicitRequestManifestDigest) throw new KgCanaryError("MANIFEST_DIGEST_MISMATCH", "seed or explicit request manifest digest mismatch");
  const canaryPaths = paths(workspace, manifest.releaseDigest);
  const registryPath = inside(workspace, options.registryPath || canaryPaths.registry);
  const registryRaw = readFileSync(registryPath);
  if (kgCanaryDigest(JSON.parse(registryRaw.toString("utf8"))) !== manifest.registryDigest) throw new KgCanaryError("REGISTRY_DIGEST_MISMATCH", "registry digest mismatch");
  validateKgRegistry(JSON.parse(registryRaw.toString("utf8")), options.workspaceId);
  if (manifest.benchmark.workspaceId !== options.workspaceId) throw new KgCanaryError("WORKSPACE_MISMATCH", "benchmark workspace mismatch");
  const releaseDigest = computeKgCanaryReleaseDigest(resolve(import.meta.dir, "..", ".."));
  if (releaseDigest !== manifest.releaseDigest) throw new KgCanaryError("RELEASE_DIGEST_MISMATCH", "manifest release digest does not match loaded KG v3 bundle");
  return { workspace, manifestPath, manifest, rolloutPhase, registryPath, registryRaw, canaryPaths };
}

export function currentKgCanaryReleaseDigest(): `sha256:${string}` {
  return computeKgCanaryReleaseDigest(resolve(import.meta.dir, "..", ".."));
}

export function computeKgCanaryReleaseDigest(repository: string): `sha256:${string}` {
  return kgCanaryDigest(KG_V3_CANARY_RELEASE_FILES.map((path) => ({ path, digest: kgCanaryDigest(readFileSync(join(repository, path)).toString("base64")) })));
}

export function recordCanaryExplicitReceipt(options: KgCanaryOptions & { operationId: `sha256:${string}` }) {
  const value = validate(options);
  const state = readObject<any>(value.canaryPaths.canaryState);
  const marker = readObject<KgAuthorityMarkerV1>(value.canaryPaths.authority);
  if (state.status !== "collecting" || state.releaseDigest !== value.manifest.releaseDigest || state.manifestDigest !== kgCanaryDigest(value.manifest) || marker.mode !== "canary" || marker.releaseDigest !== value.manifest.releaseDigest || marker.schemaDigest !== KG_V3_SCHEMA_DIGEST) throw new KgCanaryError("CANARY_STATE_MISMATCH", "explicit receipt can only be recorded in the attested collecting canary");
  const request = value.manifest.explicitRequests.find((item) => item.assertion.provenance.operationId === options.operationId);
  if (!request || !value.manifest.humanApprovedOperationIds.includes(options.operationId)) throw new KgCanaryError("RECEIPT_NOT_DECLARED", "receipt operation is outside approved explicit request manifest");
  const operationPath = join(value.workspace, "memory-state", "kg-v3", "operations", `${options.operationId.slice(7)}.json`);
  const operation = readObject<any>(operationPath);
  if (operation.status !== "committed" || operation.operationId !== options.operationId || operation.workspaceId !== options.workspaceId || operation.action !== "write" || operation.assertionId !== operation.assertionAfter?.id || operation.assertionAfter?.provenance?.operationId !== options.operationId || operation.assertionAfter?.provenance?.sourceKind !== "user_message" || !operation.receipt || operation.receipt.status !== "committed" || operation.receipt.assertionId !== operation.assertionId || operation.payloadDigest !== operation.receipt.payloadDigest) throw new KgCanaryError("RECEIPT_INVALID", "operation journal is not a valid terminal explicit write");
  const requestDigest = kgCanaryDigest(request);
  if (operation.payloadDigest !== requestDigest) throw new KgCanaryError("RECEIPT_INVALID", "operation payload does not match approved request manifest");
  const assertionPath = join(value.workspace, "life", "v3", "assertions", `${operation.assertionId}.json`);
  const assertion = readObject<any>(assertionPath);
  const exactStoreMatch = kgCanaryDigest(assertion) === kgCanaryDigest(operation.assertionAfter);
  const { lifecycle: storedLifecycle, ...storedImmutable } = assertion;
  const { lifecycle: journalLifecycle, ...journalImmutable } = operation.assertionAfter;
  let validSupersession = false;
  if (!exactStoreMatch && storedLifecycle?.status === "superseded" && typeof storedLifecycle.supersededById === "string") {
    const successorPath = join(value.workspace, "life", "v3", "assertions", `${storedLifecycle.supersededById}.json`);
    if (existsSync(successorPath)) {
      const successor = readObject<any>(successorPath);
      validSupersession = kgCanaryDigest(storedImmutable) === kgCanaryDigest(journalImmutable)
        && storedLifecycle.replacesId === journalLifecycle.replacesId
        && successor.lifecycle?.replacesId === assertion.id
        && successor.workspaceId === assertion.workspaceId
        && successor.entityId === assertion.entityId
        && successor.predicate === assertion.predicate;
    }
  }
  if (!exactStoreMatch && !validSupersession) throw new KgCanaryError("RECEIPT_INVALID", "assertion store does not match journal or a valid supersession chain");
  const existing: KgCanaryReceiptLedgerV1 = existsSync(value.canaryPaths.ledger) ? readObject(value.canaryPaths.ledger) : { schema: "engram.kg-v3-canary-receipts.v1", workspaceId: options.workspaceId, releaseDigest: value.manifest.releaseDigest, explicitRequestManifestDigest: value.manifest.explicitRequestManifestDigest, entries: [] };
  if (existing.workspaceId !== options.workspaceId || existing.releaseDigest !== value.manifest.releaseDigest || existing.explicitRequestManifestDigest !== value.manifest.explicitRequestManifestDigest) throw new KgCanaryError("LEDGER_MISMATCH", "explicit receipt ledger identity mismatch");
  const prior = existing.entries.find((entry) => entry.operationId === options.operationId);
  const entry = { operationId: options.operationId, assertionId: operation.assertionId, status: "committed" as const, humanApproved: true as const, provenanceComplete: true as const };
  if (prior && canonical(prior) !== canonical(entry)) throw new KgCanaryError("RECEIPT_CONFLICT", "explicit receipt replay changed terminal result");
  if (!prior) existing.entries.push(entry);
  existing.entries.sort((a, b) => a.operationId.localeCompare(b.operationId));
  atomicJson(value.canaryPaths.ledger, existing);
  return existing;
}

export function planKgCanary(options: KgCanaryOptions) {
  const value = validate(options);
  return {
    schema: "engram.kg-v3-canary-plan.v1",
    rolloutPhase: value.rolloutPhase,
    workspaceId: options.workspaceId,
    releaseDigest: value.manifest.releaseDigest,
    schemaDigest: KG_V3_SCHEMA_DIGEST,
    seedCount: value.manifest.seedRequests.length,
    explicitRequestCount: value.manifest.explicitRequests.length,
    actions: value.rolloutPhase === "main-canary"
      ? ["begin:backup-v2-and-projection", "begin:write-canary-marker", "begin:apply-curated-seed", "collect:20-30-trusted-explicit-receipts", "finalize:run-essential-benchmark", "finalize:switch-default-context", "read-back", "rollback-drill"]
      : ["begin:backup-v2-and-projection", "begin:write-enabled-marker", "begin:apply-curated-seed", "finalize:run-essential-benchmark", "finalize:switch-default-context", "read-back", "rollback-drill"],
    markerPath: value.canaryPaths.authority,
    contextPath: value.canaryPaths.context,
    reportPath: value.canaryPaths.report,
    mutatesWorkspace: false,
  } as const;
}

function backupFile(path: string) {
  return existsSync(path) ? { existed: true, digest: kgCanaryDigest(readFileSync(path).toString("base64")), contentBase64: readFileSync(path).toString("base64") } : { existed: false, digest: null, contentBase64: null };
}

export async function beginKgCanary(options: KgCanaryOptions & { acknowledge?: boolean }) {
  if (options.acknowledge !== true) throw new KgCanaryError("ACK_REQUIRED", "begin requires explicit acknowledgement");
  const value = validate(options);
  const plan = planKgCanary(options);
  const { manifest, canaryPaths } = value;
  if (existsSync(canaryPaths.authority)) {
    const current = readObject<KgAuthorityMarkerV1>(canaryPaths.authority);
    const legacyContained = current.mode === "legacy-contained" && current.releaseDigest === manifest.releaseDigest;
    const mainReleaseTransition = value.rolloutPhase === "main-canary" && current.mode === "canary";
    const fleetReleaseTransition = value.rolloutPhase === "fleet" && current.mode === "enabled";
    if (current.schema !== KG_V3_AUTHORITY_SCHEMA || current.workspaceId !== options.workspaceId || current.schemaDigest !== KG_V3_SCHEMA_DIGEST || !/^sha256:[a-f0-9]{64}$/.test(current.releaseDigest) || (!legacyContained && !mainReleaseTransition && !fleetReleaseTransition)) throw new KgCanaryError("MARKER_DRIFT", "existing authority marker does not match safe pre-rollout state");
  }
  const backup = { schema: "engram.kg-v3-canary-backup.v1", workspaceId: options.workspaceId, releaseDigest: manifest.releaseDigest, inventory: inventory(value.workspace), authority: backupFile(canaryPaths.authority), context: backupFile(canaryPaths.context), createdAt: options.now || new Date().toISOString() };
  let persistedBackup = backup;
  if (existsSync(canaryPaths.backup)) {
    const prior = readObject<any>(canaryPaths.backup);
    if (prior.workspaceId !== backup.workspaceId || prior.releaseDigest !== backup.releaseDigest || prior.inventory.digest !== backup.inventory.digest || prior.authority.digest !== backup.authority.digest || prior.context.digest !== backup.context.digest) throw new KgCanaryError("BACKUP_DRIFT", "existing backup does not match current pre-activation state");
    persistedBackup = prior;
  } else atomicJson(canaryPaths.backup, backup);
  const marker: KgAuthorityMarkerV1 = { schema: KG_V3_AUTHORITY_SCHEMA, workspaceId: options.workspaceId, releaseDigest: manifest.releaseDigest, schemaDigest: KG_V3_SCHEMA_DIGEST, mode: value.rolloutPhase === "fleet" ? "enabled" : "canary", enabledSessionCapabilities: manifest.enabledSessionCapabilities, currentProjectionVersion: 1, approvedBy: manifest.approvedBy, approvedAt: manifest.approvedAt };
  if (!marker.enabledSessionCapabilities.some((entry) => entry.capabilities.includes("kg:v3:seed"))) throw new KgCanaryError("SEED_CAPABILITY_MISSING", "canary marker must explicitly enable seed capability");
  atomicJson(canaryPaths.authority, marker);
  const core = new KgV3Core({ workspace: value.workspace, workspaceId: options.workspaceId, registryPath: value.registryPath, authorityPath: canaryPaths.authority });
  const receipts = [];
  try {
   for (const request of manifest.seedRequests) {
    if (request.assertion.provenance.sourceKind !== "operator-curated") throw new KgCanaryError("SEED_NOT_CURATED", "seed request must use operator-curated provenance");
    const caller: TrustedKgCallerContext = { trusted: true, workspaceId: options.workspaceId, sessionKey: request.assertion.provenance.sessionKey, actorId: request.assertion.provenance.actorId, capabilities: ["kg:v3:seed"] };
    const receipt = await core.write(request, caller);
    if (receipt.status !== "committed" && receipt.status !== "skipped") throw new KgCanaryError("SEED_REJECTED", `seed rejected: ${receipt.reason}`);
    receipts.push(receipt);
   }
  } catch (error) {
    restoreControlPlane(canaryPaths, persistedBackup);
    throw error;
  }
  const state = { schema: "engram.kg-v3-canary-state.v1", workspaceId: options.workspaceId, releaseDigest: manifest.releaseDigest, status: "collecting", manifestDigest: kgCanaryDigest(manifest), backupDigest: kgCanaryDigest(persistedBackup), seedReceipts: receipts, startedAt: options.now || new Date().toISOString() };
  atomicJson(canaryPaths.canaryState, state);
  return state;
}

export async function finalizeKgCanary(options: KgCanaryOptions & { acknowledge?: boolean }) {
  if (options.acknowledge !== true) throw new KgCanaryError("ACK_REQUIRED", "finalize requires explicit acknowledgement");
  const value = validate(options);
  const plan = planKgCanary(options);
  const { manifest, canaryPaths } = value;
  const state = readObject<any>(canaryPaths.canaryState);
  if (state.schema !== "engram.kg-v3-canary-state.v1" || state.workspaceId !== options.workspaceId || state.releaseDigest !== manifest.releaseDigest || state.manifestDigest !== kgCanaryDigest(manifest) || state.status !== "collecting") throw new KgCanaryError("CANARY_STATE_MISMATCH", "rollout is not collecting the exact approved manifest");
  const marker = readObject<KgAuthorityMarkerV1>(canaryPaths.authority);
  const expectedMode = value.rolloutPhase === "fleet" ? "enabled" : "canary";
  if (marker.mode !== expectedMode || marker.workspaceId !== options.workspaceId || marker.releaseDigest !== manifest.releaseDigest || marker.schemaDigest !== KG_V3_SCHEMA_DIGEST) throw new KgCanaryError("MARKER_DRIFT", "rollout authority read-back mismatch");
  const backup = readObject<any>(canaryPaths.backup);
  if (state.backupDigest !== kgCanaryDigest(backup)) throw new KgCanaryError("BACKUP_MISMATCH", "canary backup digest does not match collecting state");
  const ledger = existsSync(canaryPaths.ledger) ? readObject<KgCanaryReceiptLedgerV1>(canaryPaths.ledger) : null;
  const declared = new Set<string>(manifest.explicitRequests.map((request) => request.assertion.provenance.operationId));
  if (value.rolloutPhase === "main-canary" && (!ledger || ledger.releaseDigest !== manifest.releaseDigest || ledger.entries.length < 20 || ledger.entries.length > 30 || ledger.entries.length !== declared.size || ledger.entries.some((entry) => !declared.has(entry.operationId) || entry.humanApproved !== true || entry.provenanceComplete !== true))) {
    restoreControlPlane(canaryPaths, backup);
    throw new KgCanaryError("EXPLICIT_LEDGER_INCOMPLETE", "20-30 trusted explicit terminal receipts are required before benchmark");
  }
  const reader = new KgV3Reader({ workspace: value.workspace, workspaceId: options.workspaceId, registryPath: value.registryPath, authorityPath: canaryPaths.authority });
  let benchmark: KgBenchmarkReportV1;
  try { benchmark = await runKgV3Benchmark({ workspace: value.workspace, workspaceId: options.workspaceId, reader, manifest: manifest.benchmark }); }
  catch (error) { restoreControlPlane(canaryPaths, backup); throw error; }
  if (!benchmark.gates.passed) {
    atomicJson(canaryPaths.report, { schema: "engram.kg-v3-canary-readback.v1", status: "stopped", plan, benchmark, projectionSwitched: false });
    restoreControlPlane(canaryPaths, backup);
    throw new KgCanaryError("BENCHMARK_FAILED", "seed benchmark did not pass; default projection remains unchanged");
  }
  const context = {
    schema: "engram.kg-v3-default-context.v1",
    workspaceId: options.workspaceId,
    releaseDigest: manifest.releaseDigest,
    mode: "v3-current",
    sources: [...manifest.benchmark.proposedDefaultContext.sources],
    archiveIncludedInDefault: manifest.benchmark.proposedDefaultContext.archiveIncludedInDefault,
    switchedAt: options.now || new Date().toISOString(),
  };
  if (value.rolloutPhase === "fleet") {
    atomicJson(canaryPaths.authority, {
      ...marker,
      enabledSessionCapabilities: marker.enabledSessionCapabilities
        .map((entry) => ({ ...entry, capabilities: entry.capabilities.filter((capability) => capability !== "kg:v3:seed") }))
        .filter((entry) => entry.capabilities.length > 0),
    });
  }
  atomicJson(canaryPaths.context, context);
  const markerReadback = readObject<KgAuthorityMarkerV1>(canaryPaths.authority);
  const contextReadback = readObject<typeof context>(canaryPaths.context);
  if (markerReadback.releaseDigest !== manifest.releaseDigest || markerReadback.schemaDigest !== KG_V3_SCHEMA_DIGEST || contextReadback.archiveIncludedInDefault !== false || contextReadback.sources.some((source) => source.includes("items.json"))) {
    restoreControlPlane(canaryPaths, backup);
    throw new KgCanaryError("READBACK_FAILED", "canary read-back failed closed");
  }
  const report = { schema: "engram.kg-v3-canary-readback.v1", status: "passed", rolloutPhase: value.rolloutPhase, workspaceId: options.workspaceId, releaseDigest: manifest.releaseDigest, markerDigest: kgCanaryDigest(markerReadback), contextDigest: kgCanaryDigest(contextReadback), seedReceipts: state.seedReceipts, explicitReceipts: ledger?.entries || [], benchmark, projectionSwitched: true, archiveLeakage: benchmark.archiveLeakage };
  atomicJson(canaryPaths.report, report);
  atomicJson(canaryPaths.canaryState, { ...state, status: "finalized", finalizedAt: options.now || new Date().toISOString(), reportDigest: kgCanaryDigest(report) });
  return report;
}

function restoreControlPlane(canaryPaths: ReturnType<typeof paths>, backup: any): void {
  for (const [path, item] of [[canaryPaths.authority, backup.authority], [canaryPaths.context, backup.context]] as const) {
    if (item.existed) atomicWrite(path, Buffer.from(item.contentBase64, "base64"));
    else rmSync(path, { force: true });
  }
}

export function rollbackKgCanary(options: KgCanaryOptions & { acknowledge?: boolean }) {
  if (options.acknowledge !== true) throw new KgCanaryError("ACK_REQUIRED", "rollback requires explicit acknowledgement");
  const value = validate(options);
  const backup = readObject<any>(value.canaryPaths.backup);
  if (backup.schema !== "engram.kg-v3-canary-backup.v1" || backup.workspaceId !== options.workspaceId || backup.releaseDigest !== value.manifest.releaseDigest) throw new KgCanaryError("BACKUP_MISMATCH", "canary backup identity mismatch");
  if (existsSync(value.canaryPaths.canaryState)) {
    const state = readObject<any>(value.canaryPaths.canaryState);
    if (state.backupDigest !== kgCanaryDigest(backup)) throw new KgCanaryError("BACKUP_MISMATCH", "canary backup digest mismatch");
  }
  restoreControlPlane(value.canaryPaths, backup);
  const authority = backup.authority.existed ? kgCanaryDigest(readFileSync(value.canaryPaths.authority).toString("base64")) : null;
  const context = backup.context.existed ? kgCanaryDigest(readFileSync(value.canaryPaths.context).toString("base64")) : null;
  if (authority !== backup.authority.digest || context !== backup.context.digest) throw new KgCanaryError("ROLLBACK_READBACK_FAILED", "rollback byte read-back mismatch");
  const report = { schema: "engram.kg-v3-canary-rollback.v1", status: "rolled_back", workspaceId: options.workspaceId, releaseDigest: value.manifest.releaseDigest, authorityDigest: authority, contextDigest: context, assertionsPreserved: existsSync(join(value.workspace, "life", "v3", "assertions")), operationsPreserved: existsSync(join(value.workspace, "memory-state", "kg-v3", "operations")), readBack: true };
  atomicJson(join(value.canaryPaths.root, "rollback-report.json"), report);
  return report;
}
