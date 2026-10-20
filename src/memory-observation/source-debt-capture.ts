/** Protected administrative accounting. No transcript/model text is copied here.
 * The operational queue is NOT the source of truth for completeness. */
import { closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { isAdmissionGapRecovered } from "./admission-gap-recovery.ts";
import { acquireProcessLease } from "./process-lease.ts";
import { sha256, deriveTraceId, type Digest, type ObservationScope } from "./ledger.ts";

export const SOURCE_DEBT_SCHEMA = "engram.memory-source-debt.v1" as const;
export const SOURCE_DEBT_LIMITS = { maxRecords: 10_000, maxBytes: 64 * 1024 * 1024 } as const;
const HASH = /^sha256:[a-f0-9]{64}$/;
const SOURCE = /^channel-user:v1:[a-f0-9]{64}$/;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,299}$/;
const evaluationOk = new Set(["semantic_contextual_asserted", "semantic_contextual_supports", "semantic_contextual_duplicate", "semantic_contextual_skip", "semantic_batch_write", "semantic_batch_skip", "semantic_batch_grouped_no_assertion", "semantic_write", "semantic_skip", "semantic_skip_noise", "semantic_skip_already_captured", "semantic_skip_incomplete", "pre_activation_not_evaluated"]);
const dailyOk = new Set(["canonical_applied", "duplicate_receipt", "policy_superseded_before_apply"]);
type Row = Record<string, any>;
export type SourceDebtRecord = {
  schema: typeof SOURCE_DEBT_SCHEMA; debtId: Digest; recordId: Digest; scope: ObservationScope;
  identity: { kind: "source" | "candidate" | "trace"; id: string };
  classification: "confirmed_completed_source" | "completion_unverified_gap" | "failed_run" | "identity_unverified";
  traceId: Digest | null; candidateId: Digest | null; sourceTurnId: string | null;
  stage: "evaluation" | "daily" | "admission" | "evidence_expired";
  reasonCode: string; failedAt: string; proofDigest: Digest;
  sourceProof: null | { envelopeDigest: Digest; sourceDigest: Digest; evidenceDigest: Digest; policyDigest: Digest };
  batchParents: Array<{ jobId: Digest; jobDigest: Digest; bundleId: Digest; failureDigest: Digest | null }>;
};
type SourceDebtLink = { schema: "engram.memory-source-debt-link.v1"; linkId: Digest; debtId: Digest; candidateId: Digest;
  scope: ObservationScope; traceId: Digest; sourceTurnId: string; envelopeDigest: Digest; checkpointDigest: Digest;
  gapReceiptDigest: Digest; authorizationDigest: Digest; completionDigest: Digest };
export type SourceDebtSnapshot = {
  schema: "engram.memory-source-debt-snapshot.v1"; workspaceId: string | null;
  observed: boolean; debtIds: Digest[]; openIds: Digest[]; closedIds: Digest[]; verifiedAt: string;
  corrupt: boolean; errors: string[]; snapshotDigest: Digest;
};
export class SourceDebtError extends Error { constructor(readonly code: string) { super(code); } }
function root(workspace: string) { return join(workspace, "memory-state/memory-observation/source-debt/v1"); }
function scopeValid(s: any): s is ObservationScope {
  return !!s && TOKEN.test(s.workspaceId) && typeof s.runtimeSessionKey === "string" && /^agent:[^\s]{1,2042}$/.test(s.runtimeSessionKey)
    && ["self", "managers", "company", "project"].includes(s.scopeClass) && TOKEN.test(s.scopeId)
    && Object.keys(s).sort().join() === "runtimeSessionKey,scopeClass,scopeId,workspaceId";
}
function instant(value: any) { return typeof value === "string" && Number.isFinite(Date.parse(value)); }
function json(file: string): Row { const value = JSON.parse(readFileSync(file, "utf8")); if (!value || typeof value !== "object" || Array.isArray(value)) throw new SourceDebtError("DEBT_INVALID_JSON"); return value; }
function rows(directory: string): { file: string; value: Row }[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory).sort().filter(n => n.endsWith(".json")).map(n => ({ file: join(directory, n), value: json(join(directory, n)) }));
}
function fsyncDirectory(path: string) { const fd = openSync(path, "r"); try { fsyncSync(fd); } finally { closeSync(fd); } }
function durableDirectory(path: string) {
  if (existsSync(path)) { if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory()) throw new SourceDebtError("DEBT_UNSAFE_DIRECTORY"); return; }
  durableDirectory(dirname(path)); mkdirSync(path, { mode: 0o700 }); fsyncDirectory(path); fsyncDirectory(dirname(path));
}
function immutable(file: string, value: Row) {
  const bytes = JSON.stringify(value) + "\n";
  if (existsSync(file)) { if (sha256(json(file)) !== sha256(value)) throw new SourceDebtError("DEBT_CONTENT_CONFLICT"); return; }
  durableDirectory(dirname(file));
  const temp = file + ".tmp-" + randomUUID();
  const fd = openSync(temp, "wx", 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  try { linkSync(temp, file); fsyncDirectory(dirname(file)); }
  finally { rmSync(temp, { force: true }); }
}
function workspaceId(workspace: string, explicitOwner?: string): string {
  const config = join(workspace, "engram.json");
  // Only the already-authorized ledger constructor may supply an explicit
  // owner for a legacy scope without config. Never infer it from queue data.
  const id = existsSync(config) ? json(config).workspace?.id : explicitOwner;
  if (!TOKEN.test(id ?? "") || (explicitOwner !== undefined && id !== explicitOwner)) throw new SourceDebtError("DEBT_WORKSPACE_ID_INVALID"); return id;
}
export function sourceDebtId(scope: ObservationScope, identity: SourceDebtRecord["identity"]): Digest {
  return sha256({ schema: SOURCE_DEBT_SCHEMA, workspaceId: scope.workspaceId, exactSessionKey: scope.runtimeSessionKey, identity });
}
function validateRecord(r: Row, owner: string) {
  const { recordId, ...base } = r;
  if (r.schema !== SOURCE_DEBT_SCHEMA || !scopeValid(r.scope) || r.scope.workspaceId !== owner
    || !["source", "candidate", "trace"].includes(r.identity?.kind) || Object.keys(r.identity).sort().join() !== "id,kind"
    || !(r.identity.kind === "source" ? SOURCE : HASH).test(r.identity.id ?? "")
    || r.debtId !== sourceDebtId(r.scope, r.identity) || recordId !== sha256(base)
    || !["confirmed_completed_source", "completion_unverified_gap", "failed_run", "identity_unverified"].includes(r.classification)
    || !["evaluation", "daily", "admission", "evidence_expired"].includes(r.stage)
    || !TOKEN.test(r.reasonCode) || !instant(r.failedAt) || !HASH.test(r.proofDigest)) throw new SourceDebtError("DEBT_RECORD_INVALID");
  // Reject arbitrary additional fields, including any accidentally supplied text.
  const keys = ["schema", "debtId", "recordId", "scope", "identity", "classification", "traceId", "candidateId", "sourceTurnId", "stage", "reasonCode", "failedAt", "proofDigest", "sourceProof", "batchParents"];
  const actual = Object.keys(r).sort().join();
  // The initial in-turn v1 writer emitted exactly these same fourteen fields
  // before batchParents was added. Its original hash remains authoritative;
  // never normalize or rewrite an immutable legacy record in place.
  const legacyWithoutParents = !Object.hasOwn(r, "batchParents") && actual === keys.filter(k => k !== "batchParents").sort().join();
  if (!legacyWithoutParents && actual !== keys.sort().join()) throw new SourceDebtError("DEBT_FIELDS_INVALID");
  if (r.traceId !== null && !HASH.test(r.traceId) || r.candidateId !== null && !HASH.test(r.candidateId)
    || r.sourceTurnId !== null && !SOURCE.test(r.sourceTurnId)) throw new SourceDebtError("DEBT_IDENTITY_INVALID");
  if (!legacyWithoutParents && (!Array.isArray(r.batchParents) || r.batchParents.some((p: Row) => Object.keys(p).sort().join() !== "bundleId,failureDigest,jobDigest,jobId"
    || ![p.jobId, p.jobDigest, p.bundleId].every(v => HASH.test(v)) || p.failureDigest !== null && !HASH.test(p.failureDigest)))) throw new SourceDebtError("DEBT_PARENT_INVALID");
  if (r.sourceProof !== null && (Object.keys(r.sourceProof).sort().join() !== "envelopeDigest,evidenceDigest,policyDigest,sourceDigest"
    || Object.values(r.sourceProof).some(v => !HASH.test(String(v))))) throw new SourceDebtError("DEBT_PROOF_INVALID");
}
function inventory(workspace: string, owner: string, limits: { maxRecords: number; maxBytes: number }) {
  const directory = root(workspace), records: SourceDebtRecord[] = [], links: SourceDebtLink[] = []; let count = 0, bytes = 0;
  if (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory()) throw new SourceDebtError("DEBT_UNSAFE_DIRECTORY");
  for (const kind of ["failures", "closures", "links"]) {
    const dir = join(directory, kind); if (!existsSync(dir)) continue;
    if (lstatSync(dir).isSymbolicLink() || !lstatSync(dir).isDirectory()) throw new SourceDebtError("DEBT_UNSAFE_DIRECTORY");
    for (const name of readdirSync(dir).sort()) {
    const file = join(dir, name), info = lstatSync(file);
    if (!/^[a-f0-9]{64}\.json$/.test(name) || !info.isFile() || info.isSymbolicLink()) throw new SourceDebtError("DEBT_UNEXPECTED_METADATA");
    count++; bytes += info.size;
    if (count > limits.maxRecords || bytes > limits.maxBytes) throw new SourceDebtError("DEBT_CAPACITY_EXCEEDED");
    const row = { file, value: json(file) };
    if (kind === "failures") { validateRecord(row.value, owner); if (row.file !== join(directory, kind, row.value.recordId.slice(7) + ".json")) throw new SourceDebtError("DEBT_FILENAME_INVALID"); records.push(row.value as SourceDebtRecord); }
    else if (kind === "links") {
      const { linkId, ...base } = row.value;
      if (row.value.schema !== "engram.memory-source-debt-link.v1" || linkId !== sha256(base) || !scopeValid(row.value.scope)
        || row.value.scope.workspaceId !== owner || !HASH.test(row.value.candidateId) || !SOURCE.test(row.value.sourceTurnId)
        || row.value.traceId !== deriveTraceId(owner, row.value.scope.runtimeSessionKey, row.value.sourceTurnId)
        || row.value.debtId !== sourceDebtId(row.value.scope, { kind: "candidate", id: row.value.candidateId })
        || ![row.value.envelopeDigest, row.value.checkpointDigest, row.value.gapReceiptDigest, row.value.authorizationDigest, row.value.completionDigest].every(v => HASH.test(v))
        || row.file !== join(directory, kind, row.value.debtId.slice(7) + ".json")) throw new SourceDebtError("DEBT_LINK_INVALID");
      links.push(row.value as SourceDebtLink);
    } else {
      const { certificateId, ...base } = row.value;
      if (row.value.schema !== "engram.memory-source-debt-closure.v1" || certificateId !== sha256(base)
        || row.file !== join(directory, kind, row.value.debtId?.slice(7) + ".json")) throw new SourceDebtError("DEBT_CLOSURE_INVALID");
    }
  }
  }
  return { records, links, count, bytes };
}
function makeRecord(options: { scope: ObservationScope; envelope?: Row; candidateId?: Digest; traceId?: Digest; stage: SourceDebtRecord["stage"]; reason: string; failedAt: string; proof: Row; classification?: SourceDebtRecord["classification"]; batchParents?: SourceDebtRecord["batchParents"] }): SourceDebtRecord {
  const e = options.envelope;
  const confirmed = e?.schema === "engram.memory-observation-job.v1" && SOURCE.test(e.sourceTurnId) && e.traceId === deriveTraceId(e.scope.workspaceId, e.scope.runtimeSessionKey, e.sourceTurnId)
    && sha256(e.scope) === sha256(options.scope) && [e.sourceDigest, e.evidenceDigest, e.policyDigest].every(v => HASH.test(v));
  if (e && !confirmed) throw new SourceDebtError("DEBT_ENVELOPE_INVALID");
  const traceId = e?.traceId ?? options.traceId ?? null, candidateId = options.candidateId ?? null;
  const identity: SourceDebtRecord["identity"] = candidateId ? { kind: "candidate", id: candidateId }
    : confirmed ? { kind: "source", id: e!.sourceTurnId } : { kind: "trace", id: traceId! };
  const base = { schema: SOURCE_DEBT_SCHEMA, debtId: sourceDebtId(options.scope, identity), scope: options.scope, identity,
    classification: options.classification ?? (confirmed ? "confirmed_completed_source" : "identity_unverified"), traceId, candidateId,
    sourceTurnId: confirmed ? e!.sourceTurnId : null, stage: options.stage, reasonCode: options.reason, failedAt: options.failedAt,
    batchParents: options.batchParents ?? [], proofDigest: sha256(options.proof), sourceProof: confirmed ? { envelopeDigest: sha256(e!), sourceDigest: e!.sourceDigest, evidenceDigest: e!.evidenceDigest, policyDigest: e!.policyDigest } : null };
  return { ...base, recordId: sha256(base) };
}
/** A compact verified certificate retains authenticated exact identities after
 * the corresponding operational/effect proof reaches its own retention limit. */
function validCertificate(c: Row, records: SourceDebtRecord[], links: SourceDebtLink[]) {
  const { certificateId, ...base } = c;
  const failures = records.filter(r => r.debtId === c.debtId), proof = c.proof;
  if (c.schema !== "engram.memory-source-debt-closure.v1" || certificateId !== sha256(base) || !instant(c.verifiedAt)
    || !failures.length || sha256(c.recordIds) !== sha256(failures.map(r => r.recordId).sort())
    || !["evaluated_skip", "materialized_verified"].includes(c.disposition) || proof?.disposition !== c.disposition
    || proof?.schema !== "engram.source-effect-proof.v1" || proof.verifiedAt !== c.verifiedAt || !scopeValid(proof.scope)
    || ![proof.traceId, proof.envelopeDigest, proof.terminalId, proof.terminalDigest, proof.jobId, proof.jobDigest].every(v => HASH.test(v))
    || !SOURCE.test(proof.sourceTurnId) || !Array.isArray(proof.observationIds) || proof.observationIds.some((id: string) => !HASH.test(id))
    || !Array.isArray(proof.applicableEffects) || !failures.every(r => sha256(r.scope) === sha256(proof.scope))) return false;
  if (c.disposition === "evaluated_skip" && (proof.observationIds.length || proof.applicableEffects.length || failures.some(r => r.stage === "daily"))) return false;
  if (c.disposition === "materialized_verified" && (!proof.observationIds.length || !proof.applicableEffects.length)) return false;
  if (failures.every(r => r.identity.kind === "source" && r.traceId === proof.traceId && r.sourceTurnId === proof.sourceTurnId
    && r.sourceProof?.envelopeDigest === proof.envelopeDigest)) return c.linkId === null;
  const link = links.find(l => l.linkId === c.linkId && l.debtId === c.debtId);
  return !!link && failures.every(r => r.identity.kind === "candidate" && r.candidateId === link.candidateId && r.classification !== "failed_run")
    && link.traceId === proof.traceId && link.sourceTurnId === proof.sourceTurnId && link.envelopeDigest === proof.envelopeDigest;
}
/** Single synchronous writer, bounded and fail-closed. It never requeues or writes
 * memory. Call before any lifecycle deletion and again after Worker effects. */
export type SourceDebtCaptureOptions = { maxRecords?: number; maxBytes?: number; workspaceId?: string;
  verifyClosure?: (workspace: string, identity: { traceId: Digest; sourceTurnId: string; scope: ObservationScope }, now: Date) => { closed: boolean; proof?: Row };
};
export function captureSourceDebt(workspace: string, now = new Date(), options: SourceDebtCaptureOptions = {}) {
  const owner = workspaceId(workspace, options.workspaceId), directory = root(workspace), limits = {
    maxRecords: Math.min(SOURCE_DEBT_LIMITS.maxRecords, options.maxRecords ?? SOURCE_DEBT_LIMITS.maxRecords),
    maxBytes: Math.min(SOURCE_DEBT_LIMITS.maxBytes, options.maxBytes ?? SOURCE_DEBT_LIMITS.maxBytes) };
  if (!Number.isSafeInteger(limits.maxRecords) || !Number.isSafeInteger(limits.maxBytes) || limits.maxRecords < 0 || limits.maxBytes < 0) throw new SourceDebtError("DEBT_LIMIT_INVALID");
  durableDirectory(directory);
  const release = acquireProcessLease(join(directory, "writer.lock"));
  if (!release) throw new SourceDebtError("DEBT_WRITER_BUSY");
  try {
    const state = inventory(workspace, owner, limits), op = join(workspace, "memory-state/memory-observation/v1");
    const append = (record: SourceDebtRecord) => {
      validateRecord(record, owner);
      if (state.records.some(r => r.debtId === record.debtId && (sha256(r.scope) !== sha256(record.scope) || sha256(r.sourceProof) !== sha256(record.sourceProof)))) throw new SourceDebtError("DEBT_SOURCE_CONFLICT");
      if (state.records.some(r => r.recordId === record.recordId || (r.debtId === record.debtId && r.stage === record.stage && r.reasonCode === record.reasonCode))) return;
      const bytes = Buffer.byteLength(JSON.stringify(record) + "\n");
      if (state.count + 1 > limits.maxRecords || state.bytes + bytes > limits.maxBytes) throw new SourceDebtError("DEBT_CAPACITY_EXCEEDED");
      immutable(join(directory, "failures", record.recordId.slice(7) + ".json"), record);
      state.records.push(record); state.count++; state.bytes += bytes;
    };
    const envelopes = rows(join(op, "envelopes"));
    const batch = join(op, "../batch-live-store/memory-batch-live/v1");
    const jobs = rows(join(batch, "jobs"));
    const parents = (e: Row): SourceDebtRecord["batchParents"] => jobs.filter(({ value: job }) => job.bundle?.sourceRefs?.some((s: Row) => s.traceId === e.traceId)).map(({ value: job }) => {
      const failureFile = HASH.test(job.jobId ?? "") ? join(batch, "failures", job.jobId.slice(7) + ".json") : "";
      return { jobId: job.jobId, jobDigest: sha256(job), bundleId: job.bundle?.bundleId, failureDigest: failureFile && existsSync(failureFile) ? sha256(json(failureFile)) : null };
    });
    const envelope = (traceId: string) => envelopes.find(r => r.value.traceId === traceId)?.value;
    // Recovery is NOT closure. The original immutable authorization snapshots
    // remain failure origins even after live queues were legitimately requeued.
    const recoveries = join(batch, "recoveries");
    if (existsSync(recoveries)) for (const jobKey of readdirSync(recoveries).sort().filter(n => /^[a-f0-9]{64}$/.test(n))) {
      const jobRoot = join(recoveries, jobKey);
      for (const recoveryKey of readdirSync(jobRoot).sort().filter(n => /^[a-f0-9]{64}$/.test(n))) {
        const archive = join(jobRoot, recoveryKey), authFile = join(archive, "authorization.json");
        if (!existsSync(authFile)) continue;
        const auth = json(authFile);
        if (auth.schema !== "engram.memory-batch-terminal-recovery-authorization.v1") continue;
        const expectedId = sha256({ schema: "engram.memory-batch-terminal-recovery.v1", jobId: auth.jobId,
          authorizedBy: auth.authorizedBy, authorizedAt: auth.authorizedAt, reason: auth.reason });
        const job = jobs.find(({ value }) => value.jobId === auth.jobId)?.value;
        const failureFile = existsSync(join(archive, "failure.json")) ? join(archive, "failure.json") : join(batch, "failures", jobKey + ".json");
        const doneFile = existsSync(join(archive, "done.json")) ? join(archive, "done.json") : join(batch, "done", jobKey + ".json");
        if (auth.recoveryId !== expectedId || recoveryKey !== expectedId.slice(7) || jobKey !== auth.jobId?.slice(7) || !job
          || auth.bundleId !== job.bundle?.bundleId || !Array.isArray(auth.queues) || !auth.queues.length
          || !existsSync(failureFile) || !existsSync(doneFile)) throw new SourceDebtError("DEBT_RECOVERY_ARCHIVE_INVALID");
        const failure = json(failureFile), done = json(doneFile), { failureId, ...failureBody } = failure;
        if (failure.schema !== "engram.memory-batch-live-failure.v1" || failureId !== sha256(failureBody)
          || sha256(failure) !== auth.failureDigest || sha256(done) !== auth.doneDigest || sha256(done) !== sha256(failure)
          || failure.jobId !== auth.jobId || failure.bundleId !== auth.bundleId || failure.errorCode !== auth.failureCode
          || sha256(auth.traceIds) !== sha256(job.bundle.sourceRefs.map((s: Row) => s.traceId))
          || sha256(auth.queues.map((q: Row) => q.traceId)) !== sha256(auth.traceIds)) throw new SourceDebtError("DEBT_RECOVERY_ARCHIVE_INVALID");
        for (const q of auth.queues) {
          if (q.originalDigest !== sha256(q.original) || q.requeuedDigest !== sha256(q.requeued)
            || q.original.traceId !== q.traceId || q.original.status !== "terminal" || q.original.reasonCode !== auth.failureCode
            || q.requeued.traceId !== q.traceId || q.requeued.status !== "queued") throw new SourceDebtError("DEBT_RECOVERY_QUEUE_INVALID");
          const e = envelope(q.traceId);
          if (!e) {
            // The protected origin is sufficient after the operational envelope
            // has deliberately aged out; do not reopen closed historical proof.
            if (state.records.some(r => r.traceId === q.traceId && r.stage === "evaluation" && r.reasonCode === q.original.reasonCode
              && r.proofDigest === q.originalDigest && (r.batchParents ?? []).some(p => p.jobId === job.jobId && p.jobDigest === sha256(job) && (p.failureDigest === null || p.failureDigest === sha256(failure))))) continue;
            throw new SourceDebtError("DEBT_SOURCE_IDENTITY_UNAVAILABLE");
          }
          append(makeRecord({ scope: e.scope, envelope: e, batchParents: [{ jobId: job.jobId, jobDigest: sha256(job), bundleId: auth.bundleId, failureDigest: sha256(failure) }],
            stage: "evaluation", reason: q.original.reasonCode, failedAt: q.original.terminalAt, proof: q.original }));
        }
      }
    }
    const evidenceRows = rows(join(op, "evidence"));
    const expiredEvidence = new Map(evidenceRows.filter(({value:e}) => {
      if (!HASH.test(e.traceId) || !instant(e.expiresAt)) throw new SourceDebtError("DEBT_EVIDENCE_METADATA_INVALID");
      return Date.parse(e.expiresAt) <= now.getTime();
    }).map(({value:e}) => [e.traceId, e]));
    const evaluatorRows = rows(join(op, "queues/evaluator"));
    for (const { value: q } of evaluatorRows) {
      if (q.schema !== "engram.memory-observation-ledger-queue.v1" || !HASH.test(q.traceId) || !["queued", "claimed", "terminal"].includes(q.status)) throw new SourceDebtError("DEBT_EVALUATOR_QUEUE_INVALID");
      if (q.status === "terminal" && evaluationOk.has(q.reasonCode)) continue;
      if (q.status !== "terminal" && !expiredEvidence.has(q.traceId) && !(instant(q.createdAt) && Date.parse(q.createdAt) + 72 * 3600_000 <= now.getTime())) continue;
      const e = envelope(q.traceId);
      if (!e) {
        if (state.records.some(r => r.traceId === q.traceId && r.proofDigest === sha256(q))) continue;
        throw new SourceDebtError("DEBT_SOURCE_IDENTITY_UNAVAILABLE");
      }
      append(makeRecord({ scope: e.scope, envelope: e, batchParents: parents(e), stage: q.status === "terminal" ? "evaluation" : "evidence_expired",
        reason: q.status === "terminal" ? q.reasonCode : "source_evidence_expired", failedAt: q.terminalAt ?? q.updatedAt, proof: q }));
    }
    // Partial admission cannot make an expiring source disappear without an
    // evaluator row. Preserve exact metadata or block deletion if identity is lost.
    for (const [traceId, evidence] of expiredEvidence) {
      if (evaluatorRows.some(({value:q}) => q.traceId === traceId)) continue;
      const e = envelope(traceId);
      if (!e) {
        if (state.records.some(r => r.traceId === traceId)) continue;
        throw new SourceDebtError("DEBT_SOURCE_IDENTITY_UNAVAILABLE");
      }
      append(makeRecord({scope:e.scope,envelope:e,batchParents:parents(e),stage:"evidence_expired",
        reason:"source_evidence_expired",failedAt:evidence.expiresAt,proof:{traceId,expiresAt:evidence.expiresAt,evidenceDigest:sha256(evidence)}}));
    }
    for (const { value: q } of rows(join(op, "consumers/daily-note/queue"))) {
      if (q.schema !== "engram.memory-observation-consumer-queue.v1" || !["queued", "claimed", "qmd_pending", "terminal"].includes(q.status)) throw new SourceDebtError("DEBT_CONSUMER_QUEUE_INVALID");
      if (q.status === "terminal" && dailyOk.has(q.reasonCode)) continue;
      // Fresh pending effects remain ordinary queues; retain unfinished failures
      // before their operational/source proofs can age out.
      if (q.status !== "terminal" && !(instant(q.createdAt) && Date.parse(q.createdAt) + 72 * 3600_000 <= now.getTime())) continue;
      let obs: Row | undefined;
      for (const kind of ["batch", "typed"]) {
        if (!HASH.test(q.observationId ?? "")) continue;
        const file = join(op, "observations", kind, q.observationId.slice(7) + ".json");
        if (existsSync(file)) { obs = json(file); break; }
      }
      const traces = obs?.sourceRefs?.map((s: Row) => s.traceId) ?? [obs?.traceId ?? q.traceId];
      if (!traces.length) throw new SourceDebtError("DEBT_CONSUMER_SOURCE_UNAVAILABLE");
      for (const trace of traces) {
        const e = envelope(trace); if (!e) throw new SourceDebtError("DEBT_SOURCE_IDENTITY_UNAVAILABLE");
        append(makeRecord({ scope: e.scope, envelope: e, batchParents: parents(e), stage: "daily", reason: q.status === "terminal" ? q.reasonCode : "consumer_effects_pending", failedAt: q.terminalAt ?? q.createdAt, proof: q }));
      }
    }
    const gaps = rows(join(op, "receipts/admission-gap"));
    for (const { value: gap } of gaps) {
      const { receiptDigest, ...base } = gap;
      if (gap.schema !== "engram.memory-admission-gap-receipt.v1" || receiptDigest !== sha256(base) || !HASH.test(gap.candidateId)) throw new SourceDebtError("DEBT_GAP_INVALID");
      if (/^agent:[^:]+:telegram:slash:[^:]+$/.test(gap.scope?.runtimeSessionKey ?? "")) continue;
      append(makeRecord({ scope: gap.scope, candidateId: gap.candidateId, stage: "admission", reason: gap.reasonCode,
        failedAt: gap.terminalAt, proof: gap, classification: gap.reasonCode === "run_failed" ? "failed_run" : "completion_unverified_gap" }));
    }
    for (const { value: checkpoint } of rows(join(op, "pre-admission/checkpoints"))) {
      if (checkpoint.stage === "ledger_admitted" || /^agent:[^:]+:telegram:slash:[^:]+$/.test(checkpoint.scope?.runtimeSessionKey ?? "")) continue;
      if (checkpoint.stage === "terminal_gap" && gaps.some(({ value: gap }) => gap.candidateId === checkpoint.candidateId)) continue;
      if (checkpoint.stage !== "terminal_gap" && (!instant(checkpoint.expiresAt) || Date.parse(checkpoint.expiresAt) > now.getTime())) continue;
      const { checkpointDigest, ...body } = checkpoint;
      if (checkpoint.schema !== "engram.memory-admission-checkpoint.v1" || checkpointDigest !== sha256(body) || !HASH.test(checkpoint.candidateId))
        throw new SourceDebtError("DEBT_CHECKPOINT_INVALID");
      append(makeRecord({ scope: checkpoint.scope, candidateId: checkpoint.candidateId, stage: "admission", reason: checkpoint.stage === "terminal_gap" ? "admission_gap_receipt_unavailable" : "durable_checkpoint_expired",
        failedAt: checkpoint.stage === "terminal_gap" ? checkpoint.updatedAt : checkpoint.expiresAt, proof: checkpoint, classification: "completion_unverified_gap" }));
    }
    if (options.verifyClosure) for (const debtId of [...new Set(state.records.map(r => r.debtId))]) {
      const records = state.records.filter(r => r.debtId === debtId), file = join(directory, "closures", debtId.slice(7) + ".json");
      if (existsSync(file)) { if (!validCertificate(json(file), records, state.links)) throw new SourceDebtError("DEBT_CLOSURE_INVALID"); continue; }
      let link = state.links.find(l => l.debtId === debtId);
      const first = records[0]!;
      if (!link && first.identity.kind === "candidate" && first.candidateId && records.every(r => r.classification !== "failed_run")) {
        const cpFile = join(op, "pre-admission/checkpoints", first.candidateId.slice(7) + ".json");
        const recoveryRoot = join(op, "receipts/admission-recovery", first.candidateId.slice(7));
        if (existsSync(cpFile)) {
          const checkpoint = json(cpFile);
          if (isAdmissionGapRecovered(workspace, checkpoint as any)) {
            const authorization = json(join(recoveryRoot, "authorization.json")), completion = json(join(recoveryRoot, "completed.json"));
            const e = envelope(completion.result.traceId);
            if (!e || sha256(e.scope) !== sha256(first.scope)) throw new SourceDebtError("DEBT_RECOVERY_LINK_INVALID");
            const linkBase = { schema: "engram.memory-source-debt-link.v1" as const, debtId, candidateId: first.candidateId,
              scope: first.scope, traceId: e.traceId, sourceTurnId: e.sourceTurnId, envelopeDigest: sha256(e), checkpointDigest: checkpoint.checkpointDigest,
              gapReceiptDigest: authorization.gapReceiptDigest, authorizationDigest: sha256(authorization), completionDigest: sha256(completion) };
            link = { ...linkBase, linkId: sha256(linkBase) };
            const bytes = Buffer.byteLength(JSON.stringify(link) + "\n");
            if (state.count + 1 > limits.maxRecords || state.bytes + bytes > limits.maxBytes) throw new SourceDebtError("DEBT_CAPACITY_EXCEEDED");
            immutable(join(directory, "links", debtId.slice(7) + ".json"), link); state.links.push(link); state.count++; state.bytes += bytes;
          }
        }
      }
      const traceId = link?.traceId ?? first.traceId, sourceTurnId = link?.sourceTurnId ?? first.sourceTurnId;
      if (!traceId || !sourceTurnId || (first.identity.kind !== "source" && !link)) continue;
      const e = envelope(traceId), expectedEnvelope = link?.envelopeDigest ?? first.sourceProof?.envelopeDigest;
      if (!e || sha256(e) !== expectedEnvelope) continue;
      const verified = options.verifyClosure!(workspace, { traceId, sourceTurnId, scope: first.scope }, now);
      if (!verified.closed || !verified.proof || verified.proof.envelopeDigest !== expectedEnvelope) continue;
      const proof = verified.proof;
      if (proof.disposition === "evaluated_skip" && records.some(r => r.stage === "daily")) continue;
      const base = { schema: "engram.memory-source-debt-closure.v1", debtId, recordIds: records.map(r => r.recordId).sort(), linkId: link?.linkId ?? null,
        disposition: proof.disposition, verifiedAt: now.toISOString(), proof };
      const certificate = { ...base, certificateId: sha256(base) }, bytes = Buffer.byteLength(JSON.stringify(certificate) + "\n");
      if (state.count + 1 > limits.maxRecords || state.bytes + bytes > limits.maxBytes) throw new SourceDebtError("DEBT_CAPACITY_EXCEEDED");
      if (!validCertificate(certificate, records, state.links)) throw new SourceDebtError("DEBT_VERIFIED_CERTIFICATE_INVALID");
      immutable(file, certificate); state.count++; state.bytes += bytes;
    }
    return sourceDebtSnapshot(workspace, now, { workspaceId: owner });
  } finally { release(); }
}
/** Read-only completeness surface; absence is explicit, never a claim that all
 * historical sources have been inventoried. Closed certificates survive proof TTL. */
export function sourceDebtSnapshot(workspace: string, now = new Date(), options: { workspaceId?: string } = {}): SourceDebtSnapshot {
  let owner: string | null = null; const errors: string[] = [], debtIds: Digest[] = [], closedIds: Digest[] = [];
  const observed = existsSync(root(workspace));
  try {
    if (observed) {
      owner = workspaceId(workspace, options.workspaceId); const state = inventory(workspace, owner, SOURCE_DEBT_LIMITS);
      debtIds.push(...new Set(state.records.map(r => r.debtId)));
      for (const { value: c } of rows(join(root(workspace), "closures"))) {
        if (!validCertificate(c, state.records, state.links)) throw new SourceDebtError("DEBT_CLOSURE_INVALID"); closedIds.push(c.debtId);
      }
    }
  } catch (e) { errors.push(e instanceof SourceDebtError ? e.code : "DEBT_STATE_UNREADABLE"); }
  debtIds.sort(); closedIds.sort();
  const base = { schema: "engram.memory-source-debt-snapshot.v1" as const, workspaceId: owner, observed, debtIds,
    openIds: debtIds.filter(id => !closedIds.includes(id)), closedIds, verifiedAt: now.toISOString(), corrupt: errors.length > 0, errors };
  return { ...base, snapshotDigest: sha256(base) };
}
/** Lifecycle guard is staged separately because importing this module in ledger
 * changes the shared plugin bundle. Metadata may be retained, raw text may not. */
export function assertSourceDebtPurgeSafe(workspace: string, now = new Date(), options: { workspaceId?: string } = {}) {
  const snapshot = captureSourceDebt(workspace, now, options);
  if (snapshot.corrupt) throw new SourceDebtError("DEBT_PURGE_BLOCKED");
  return snapshot;
}

/** Worker/operator-only upgrade. Retain authenticated legacy TRACE debt before
 * the unchanged host lifecycle guard. Never manufacture an expired envelope. */
export function captureLegacyRecoveryOrigins(workspace: string) {
  const owner=workspaceId(workspace),directory=root(workspace),op=join(workspace,"memory-state/memory-observation/v1"),batch=join(op,"../batch-live-store/memory-batch-live/v1"),recoveries=join(batch,"recoveries");
  if(!existsSync(recoveries))return 0;
  durableDirectory(directory);const release=acquireProcessLease(join(directory,"writer.lock"));if(!release)throw new SourceDebtError("DEBT_WRITER_BUSY");
  let added=0;
  try {
    const state=inventory(workspace,owner,SOURCE_DEBT_LIMITS);
    for(const jobKey of readdirSync(recoveries).filter(n=>/^[a-f0-9]{64}$/.test(n)).sort())for(const recoveryKey of readdirSync(join(recoveries,jobKey)).filter(n=>/^[a-f0-9]{64}$/.test(n)).sort()){
      const archive=join(recoveries,jobKey,recoveryKey),authFile=join(archive,"authorization.json");if(!existsSync(authFile))continue;
      const auth=json(authFile);if(auth.schema!=="engram.memory-batch-terminal-recovery-authorization.v1")continue;
      const jobFile=join(batch,"jobs",jobKey+".json"),failureFile=existsSync(join(archive,"failure.json"))?join(archive,"failure.json"):join(batch,"failures",jobKey+".json"),doneFile=existsSync(join(archive,"done.json"))?join(archive,"done.json"):join(batch,"done",jobKey+".json");
      if(!existsSync(jobFile)||!existsSync(failureFile)||!existsSync(doneFile))throw new SourceDebtError("DEBT_RECOVERY_ARCHIVE_INVALID");
      const job=json(jobFile),failure=json(failureFile),done=json(doneFile),{failureId,...fb}=failure,p=job.partition,b=job.bundle;
      const scope={workspaceId:p?.workspaceId,runtimeSessionKey:p?.runtimeSessionKey,scopeClass:p?.scopeClass,scopeId:p?.scopeId};
      const expectedId=sha256({schema:"engram.memory-batch-terminal-recovery.v1",jobId:auth.jobId,authorizedBy:auth.authorizedBy,authorizedAt:auth.authorizedAt,reason:auth.reason});
      if(auth.recoveryId!==expectedId||recoveryKey!==expectedId.slice(7)||jobKey!==auth.jobId?.slice(7)||job.jobId!==auth.jobId
        ||!scopeValid(scope)||scope.workspaceId!==owner||job.schema!=="engram.memory-batch-live-job.v1"||b?.schema!=="engram.memory-batch-bundle.v1"
        ||sha256(b.partition)!==sha256(p)||b.policyDigest!==p.policyDigest
        ||b.bundleId!==sha256({schema:b.schema,partition:p,policyDigest:b.policyDigest,sourceRefs:b.sourceRefs})
        ||job.jobId!==sha256({schema:job.schema,partition:p,evaluationPolicyDigest:job.evaluationPolicyDigest,bundleId:b.bundleId})
        ||auth.bundleId!==b.bundleId||!Array.isArray(auth.queues)||!auth.queues.length
        ||failure.schema!=="engram.memory-batch-live-failure.v1"||failureId!==sha256(fb)||sha256(failure)!==auth.failureDigest
        ||sha256(done)!==auth.doneDigest||sha256(done)!==sha256(failure)||failure.jobId!==job.jobId||failure.bundleId!==b.bundleId||failure.errorCode!==auth.failureCode
        ||sha256(auth.traceIds)!==sha256(b.sourceRefs.map((s:Row)=>s.traceId))||sha256(auth.queues.map((q:Row)=>q.traceId))!==sha256(auth.traceIds))throw new SourceDebtError("DEBT_RECOVERY_ARCHIVE_INVALID");
      for(const q of auth.queues){
        if(!HASH.test(q.traceId))throw new SourceDebtError("DEBT_RECOVERY_QUEUE_INVALID");
        if(existsSync(join(op,"envelopes",q.traceId.slice(7)+".json")))continue;
        if(q.originalDigest!==sha256(q.original)||q.requeuedDigest!==sha256(q.requeued)||q.original.traceId!==q.traceId||q.original.status!=="terminal"
          ||q.original.reasonCode!==auth.failureCode||q.requeued.traceId!==q.traceId||q.requeued.status!=="queued")throw new SourceDebtError("DEBT_RECOVERY_QUEUE_INVALID");
        const refs=b.sourceRefs.filter((s:Row)=>s.traceId===q.traceId),ref=refs.length===1?refs[0]:null;
        if(!ref||!SOURCE.test(ref.sourceTurnId)||ref.traceId!==deriveTraceId(owner,scope.runtimeSessionKey,ref.sourceTurnId)
          ||!instant(ref.sourceCompletedAt)||ref.sourceDigest!==sha256({sourceTurnId:ref.sourceTurnId,scope,sourceCompletedAt:ref.sourceCompletedAt})||!HASH.test(ref.evidenceDigest))throw new SourceDebtError("DEBT_SOURCE_IDENTITY_UNAVAILABLE");
        const record=makeRecord({scope,traceId:q.traceId,stage:"evaluation",reason:q.original.reasonCode,failedAt:q.original.terminalAt,proof:q.original,
          classification:"identity_unverified",batchParents:[{jobId:job.jobId,jobDigest:sha256(job),bundleId:b.bundleId,failureDigest:sha256(failure)}]});
        validateRecord(record,owner);
        if(state.records.some(r=>r.traceId===q.traceId&&r.stage==="evaluation"&&r.reasonCode===q.original.reasonCode&&r.proofDigest===q.originalDigest&&(r.batchParents??[]).some(p=>p.jobId===job.jobId&&p.jobDigest===sha256(job))))continue;
        if(state.records.some(r=>r.debtId===record.debtId&&(sha256(r.scope)!==sha256(record.scope)||sha256(r.sourceProof)!==sha256(record.sourceProof))))throw new SourceDebtError("DEBT_SOURCE_CONFLICT");
        const bytes=Buffer.byteLength(JSON.stringify(record)+"\n");if(state.count+1>SOURCE_DEBT_LIMITS.maxRecords||state.bytes+bytes>SOURCE_DEBT_LIMITS.maxBytes)throw new SourceDebtError("DEBT_CAPACITY_EXCEEDED");
        immutable(join(directory,"failures",record.recordId.slice(7)+".json"),record);state.records.push(record);state.count++;state.bytes+=bytes;added++;
      }
    }
    return added;
  }finally{release();}
}

/** Preserve an expired orphan's authenticated trace identity; this is NOT
 * successful processing, an envelope reconstruction, or permission to replay. */
export function captureExpiredOrphanJob(workspace:string,jobId:Digest,now=new Date()) {
  const owner=workspaceId(workspace),directory=root(workspace),op=join(workspace,"memory-state/memory-observation/v1");
  if(!HASH.test(jobId))throw new SourceDebtError("DEBT_SOURCE_IDENTITY_UNAVAILABLE");
  const job=json(join(op,"../batch-live-store/memory-batch-live/v1/jobs",jobId.slice(7)+".json")),p=job.partition,b=job.bundle;
  const scope={workspaceId:p?.workspaceId,runtimeSessionKey:p?.runtimeSessionKey,scopeClass:p?.scopeClass,scopeId:p?.scopeId};
  if(!scopeValid(scope)||owner!==scope.workspaceId||job.schema!=="engram.memory-batch-live-job.v1"||job.jobId!==jobId
    ||b?.schema!=="engram.memory-batch-bundle.v1"||sha256(b.partition)!==sha256(p)||b.policyDigest!==p.policyDigest
    ||!Array.isArray(b.sourceRefs)||!b.sourceRefs.length||!Array.isArray(b.inputs)||b.inputs.length!==b.sourceRefs.length
    ||b.bundleId!==sha256({schema:b.schema,partition:p,policyDigest:b.policyDigest,sourceRefs:b.sourceRefs})
    ||jobId!==sha256({schema:job.schema,partition:p,evaluationPolicyDigest:job.evaluationPolicyDigest,bundleId:b.bundleId}))throw new SourceDebtError("DEBT_SOURCE_IDENTITY_UNAVAILABLE");
  for(const ref of b.sourceRefs){
    const inputs=b.inputs.filter((i:Row)=>i.traceId===ref.traceId);
    if(!SOURCE.test(ref.sourceTurnId)||ref.traceId!==deriveTraceId(owner,scope.runtimeSessionKey,ref.sourceTurnId)
      ||!instant(ref.sourceCompletedAt)||ref.sourceDigest!==sha256({sourceTurnId:ref.sourceTurnId,scope,sourceCompletedAt:ref.sourceCompletedAt})
      ||!HASH.test(ref.evidenceDigest)||inputs.length!==1||!instant(inputs[0].expiresAt)||Date.parse(inputs[0].expiresAt)>now.getTime()
      ||["envelopes","evidence","queues/evaluator"].some(d=>existsSync(join(op,d,ref.traceId.slice(7)+".json"))))throw new SourceDebtError("DEBT_ORPHAN_NOT_EXPIRED");
  }
  durableDirectory(directory);const release=acquireProcessLease(join(directory,"writer.lock"));if(!release)throw new SourceDebtError("DEBT_WRITER_BUSY");
  try{
    const state=inventory(workspace,owner,SOURCE_DEBT_LIMITS),records:SourceDebtRecord[]=[];
    for(const ref of b.sourceRefs){
      const record=makeRecord({scope,traceId:ref.traceId,stage:"evidence_expired",reason:"expired_orphan_batch_source",failedAt:b.inputs.find((i:Row)=>i.traceId===ref.traceId).expiresAt,
        proof:{jobId,jobDigest:sha256(job),traceId:ref.traceId},classification:"identity_unverified",batchParents:[{jobId,jobDigest:sha256(job),bundleId:b.bundleId,failureDigest:null}]});
      validateRecord(record,owner);
      if(!state.records.some(r=>r.recordId===record.recordId)){
        if(state.records.some(r=>r.debtId===record.debtId&&(sha256(r.scope)!==sha256(record.scope)||sha256(r.sourceProof)!==sha256(record.sourceProof))))throw new SourceDebtError("DEBT_SOURCE_CONFLICT");
        const bytes=Buffer.byteLength(JSON.stringify(record)+"\n");if(state.count+1>SOURCE_DEBT_LIMITS.maxRecords||state.bytes+bytes>SOURCE_DEBT_LIMITS.maxBytes)throw new SourceDebtError("DEBT_CAPACITY_EXCEEDED");
        immutable(join(directory,"failures",record.recordId.slice(7)+".json"),record);state.records.push(record);state.count++;state.bytes+=bytes;
      }
      records.push(record);
    }
    return records;
  }finally{release();}
}
