import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { canonicalizeJcs, sha256Digest, type Digest } from "./handoff-v2";
import {
  CANDIDATE_SUPPORTED_VERSIONS_V1,
  MEMORY_CANDIDATE_ASSESSMENT_V1_SCHEMA,
  MEMORY_CANDIDATE_OPERATION_V2_SCHEMA,
  MEMORY_CANDIDATE_PROJECTION_V1_SCHEMA,
  MEMORY_CANDIDATE_RESERVATION_V1_SCHEMA,
  candidateOperationId,
  candidateOperationIntentDigest,
  candidatePolicyDigestV2,
  candidateProjectionDigest,
  candidateReservationId,
  evidenceSetDigestV1,
  scopeContains,
  selectionAssessmentId,
  validateCandidateClusterV1,
  validateCandidateOperationV2,
  validateCandidateProjectionV1,
  validateCandidateReportV2,
  validateCandidateReservationV1,
  validateCandidateScopeRegistryV1,
  validateCandidateSelectionAssessmentV1,
  validateLifecycleTransition,
  type CandidateClusterV1,
  type CandidateContractVersionRegistryV1,
  type CandidateOperationV2,
  type CandidateProjectionV1,
  type CandidateReasonCode,
  type CandidateReportV2,
  type CandidateReservationV1,
  type CandidateScopeRegistryV1,
  type CandidateSelectionAssessmentV1,
  type CandidateSourcePolicyV2,
  type EvidenceOccurrenceV1,
} from "./memory-candidate-contracts-v2";

const STORE_ROOT_VERSION = "oll-memory-candidates-v1" as const;
const JOURNAL_EVENT_SCHEMA = "oll.memory-candidate-journal-event.v1" as const;
const PENDING_EVIDENCE_SCHEMA = "oll.memory-candidate-pending-evidence.v1" as const;
const QUARANTINE_SCHEMA = "oll.memory-candidate-quarantine.v1" as const;
const REVISION_NAME = /^([0-9]{20})\.json$/;

type JournalEventKind = "materialized" | "evidence_merged" | "lifecycle_transition" | "reservation_acquired" | "reservation_released" | "review_pending" | "review_outcome" | "optimistic_applied";

interface CandidateJournalEventV1 {
  schema: typeof JOURNAL_EVENT_SCHEMA;
  workspaceId: string;
  candidateId: Digest;
  revision: number;
  kind: JournalEventKind;
  correlationId: Digest;
  previousEventDigest: Digest | null;
  cluster: CandidateClusterV1;
  reservation: CandidateReservationV1 | null;
  eventDigest: Digest;
}

interface PendingEvidenceV1 {
  schema: typeof PENDING_EVIDENCE_SCHEMA;
  workspaceId: string;
  candidateId: Digest;
  reportDigest: Digest;
  occurrence: EvidenceOccurrenceV1;
  receivedAt: string;
  recordDigest: Digest;
}

interface CandidateQuarantineV1 {
  schema: typeof QUARANTINE_SCHEMA;
  workspaceId: string;
  correlationDigest: Digest;
  reasonCode: "report_digest_mismatch" | "payload_conflict" | "operator_quarantine";
  artifactClass: "report" | "operation" | "journal" | "assessment" | "reservation";
  observedAt: string;
  recordDigest: Digest;
}

export interface MaterializeCandidateReportV2Options {
  workspace: string;
  workspaceId: string;
  report: CandidateReportV2;
  policy: CandidateSourcePolicyV2;
  scopeRegistry: CandidateScopeRegistryV1;
  versions?: CandidateContractVersionRegistryV1;
  faultInjector?: (point: MaterializationFaultPoint, candidateId?: Digest) => void;
}

export type MaterializationFaultPoint =
  | "after_report_publication"
  | "after_operation_intent"
  | "after_occurrence_publication"
  | "after_journal_publication"
  | "after_projection_rebuild"
  | "after_operation_commit";

export interface MaterializationCandidateResultV1 {
  candidateId: Digest;
  operationId: Digest;
  status: "committed" | "replay_verified" | "inboxed";
  revision: number;
  inboxedOccurrences: number;
}

export interface MaterializationResultV1 {
  schema: "oll.memory-candidate-materialization-result.v1";
  workspaceId: string;
  reportDigest: Digest;
  candidates: MaterializationCandidateResultV1[];
}

export interface AssessCandidateSelectionV1Options {
  workspace: string;
  workspaceId: string;
  candidateId: Digest;
  expectedCandidateRevision: number;
  frozenReport: CandidateReportV2;
  frozenPolicy: CandidateSourcePolicyV2;
  frozenScopeRegistry: CandidateScopeRegistryV1;
  currentReport: CandidateReportV2;
  currentPolicy: CandidateSourcePolicyV2;
  currentScopeRegistry: CandidateScopeRegistryV1;
  versions?: CandidateContractVersionRegistryV1;
  faultInjector?: (point: "after_assessment_publication") => void;
}

export interface ReserveCandidateV1Options {
  workspace: string;
  workspaceId: string;
  planId: Digest;
  candidateId: Digest;
  expectedRevision: number;
  evidenceSetDigest: Digest;
  now: string;
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function digestPath(id: Digest): string {
  invariant(/^sha256:[0-9a-f]{64}$/.test(id), "invalid digest path");
  return id.slice("sha256:".length);
}

function jsonBytes(value: unknown): Buffer {
  return Buffer.from(`${canonicalizeJcs(value)}\n`, "utf8");
}

function inside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep) && !rel.split(sep).includes(".."));
}

function fsyncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function ensureDirectory(path: string): void {
  const absolute = resolve(path);
  const parts = absolute.split(sep).filter(Boolean);
  let current: string = sep;
  for (const part of parts) {
    current = join(current, part);
    if (!existsSync(current)) mkdirSync(current, { mode: 0o700 });
    const stat = lstatSync(current);
    invariant(stat.isDirectory() && !stat.isSymbolicLink(), `store path is not a plain directory: ${current}`);
  }
}

export function memoryCandidateStoreRootV1(workspace: string): string {
  const canonicalWorkspace = realpathSync(resolve(workspace));
  const root = join(canonicalWorkspace, "memory-state", "oll", STORE_ROOT_VERSION);
  invariant(inside(canonicalWorkspace, root), "candidate store root escapes workspace");
  return root;
}

function ensureStoreRoot(workspace: string): string {
  const root = memoryCandidateStoreRootV1(workspace);
  ensureDirectory(root);
  for (const child of ["reports", "occurrences", "operations", "journal", "projections", "assessments", "pending-evidence", "quarantine"]) {
    ensureDirectory(join(root, child));
  }
  return root;
}

function readJson<T>(path: string): T {
  const stat = lstatSync(path);
  invariant(stat.isFile() && !stat.isSymbolicLink(), `store artifact is not a plain file: ${path}`);
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function writeNoReplace(path: string, value: unknown): "published" | "replay" {
  ensureDirectory(dirname(path));
  const body = jsonBytes(value);
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    writeFileSync(fd, body);
    fsyncSync(fd);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  try {
    linkSync(temporary, path);
    fsyncDirectory(dirname(path));
    return "published";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      const stat = lstatSync(path);
      invariant(stat.isFile() && !stat.isSymbolicLink(), `immutable artifact is not a plain file: ${path}`);
      invariant(readFileSync(path).equals(body), `immutable payload conflict: ${path}`);
      return "replay";
    }
    throw new Error(`atomic no-replace publication failed closed (${code || "unknown"})`);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
    fsyncDirectory(dirname(path));
  }
}

function writeReplaceableCache(path: string, value: unknown): void {
  ensureDirectory(dirname(path));
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    writeFileSync(fd, jsonBytes(value));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
  fsyncDirectory(dirname(path));
}

function eventDigest(event: Omit<CandidateJournalEventV1, "eventDigest"> | CandidateJournalEventV1): Digest {
  const { eventDigest: _ignored, ...base } = event as CandidateJournalEventV1;
  return sha256Digest(canonicalizeJcs(base));
}

function pendingEvidenceDigest(record: Omit<PendingEvidenceV1, "recordDigest"> | PendingEvidenceV1): Digest {
  const { recordDigest: _ignored, ...base } = record as PendingEvidenceV1;
  return sha256Digest(canonicalizeJcs(base));
}

function quarantineDigest(record: Omit<CandidateQuarantineV1, "recordDigest"> | CandidateQuarantineV1): Digest {
  const { recordDigest: _ignored, ...base } = record as CandidateQuarantineV1;
  return sha256Digest(canonicalizeJcs(base));
}

function candidateCoreDigest(cluster: CandidateClusterV1): Digest {
  return sha256Digest(canonicalizeJcs({
    schema: cluster.schema,
    workspaceId: cluster.workspaceId,
    normalizerVersion: cluster.normalizerVersion,
    semanticKey: cluster.semanticKey,
    effectiveScope: cluster.effectiveScope,
    candidateId: cluster.candidateId,
  }));
}

function candidatePayloadDigest(cluster: CandidateClusterV1): Digest {
  return sha256Digest(canonicalizeJcs(cluster));
}

function journalDirectory(root: string, candidateId: Digest): string {
  return join(root, "journal", digestPath(candidateId));
}

function revisionPath(root: string, candidateId: Digest, revision: number): string {
  return join(journalDirectory(root, candidateId), `${String(revision).padStart(20, "0")}.json`);
}

function validateJournalEvent(value: CandidateJournalEventV1, previous: CandidateJournalEventV1 | null): CandidateJournalEventV1 {
  invariant(value.schema === JOURNAL_EVENT_SCHEMA, "journal event schema mismatch");
  invariant(value.revision >= 1 && Number.isInteger(value.revision), "journal revision is invalid");
  invariant(["materialized", "evidence_merged", "lifecycle_transition", "reservation_acquired", "reservation_released", "review_pending", "review_outcome", "optimistic_applied"].includes(value.kind), "journal event kind is invalid");
  invariant(value.cluster.candidateId === value.candidateId && value.cluster.workspaceId === value.workspaceId, "journal event correlation mismatch");
  invariant(value.cluster.lifecycle.revision === value.revision, "journal cluster revision mismatch");
  validateCandidateClusterV1(value.cluster);
  if (value.reservation) validateCandidateReservationV1(value.reservation);
  invariant(value.previousEventDigest === (previous?.eventDigest || null), "journal hash chain mismatch");
  invariant(value.eventDigest === eventDigest(value), "journal event digest mismatch");
  return value;
}

function readJournal(root: string, workspaceId: string, candidateId: Digest): CandidateJournalEventV1[] {
  const directory = journalDirectory(root, candidateId);
  if (!existsSync(directory)) return [];
  const names = readdirSync(directory).filter((name) => REVISION_NAME.test(name)).sort();
  const events: CandidateJournalEventV1[] = [];
  let previous: CandidateJournalEventV1 | null = null;
  for (const [index, name] of names.entries()) {
    const revision = Number(REVISION_NAME.exec(name)![1]);
    invariant(revision === index + 1, "candidate journal contains a revision gap");
    const event = validateJournalEvent(readJson<CandidateJournalEventV1>(join(directory, name)), previous);
    invariant(event.workspaceId === workspaceId && event.candidateId === candidateId, "journal path correlation mismatch");
    events.push(event);
    previous = event;
  }
  return events;
}

function projectionFromEvents(workspaceId: string, candidateId: Digest, events: CandidateJournalEventV1[]): CandidateProjectionV1 {
  invariant(events.length > 0, "candidate journal is empty");
  const latest = events.at(-1)!;
  const base: Omit<CandidateProjectionV1, "projectionDigest"> = {
    schema: MEMORY_CANDIDATE_PROJECTION_V1_SCHEMA,
    workspaceId,
    candidateId,
    highestContiguousRevision: latest.revision,
    journalDigest: sha256Digest(canonicalizeJcs(events.map((event) => event.eventDigest))),
    cluster: latest.cluster,
    reservation: latest.reservation,
    rebuiltAt: latest.cluster.lifecycle.updatedAt,
  };
  const projection = { ...base, projectionDigest: candidateProjectionDigest(base as CandidateProjectionV1) };
  return validateCandidateProjectionV1(projection);
}

export function readCandidateProjectionV1(options: { workspace: string; workspaceId: string; candidateId: Digest }): CandidateProjectionV1 | null {
  const root = ensureStoreRoot(options.workspace);
  const events = readJournal(root, options.workspaceId, options.candidateId);
  if (!events.length) return null;
  const expected = projectionFromEvents(options.workspaceId, options.candidateId, events);
  const path = join(root, "projections", `${digestPath(options.candidateId)}.json`);
  if (existsSync(path)) {
    try {
      const cached = validateCandidateProjectionV1(readJson<CandidateProjectionV1>(path));
      if (cached.highestContiguousRevision === expected.highestContiguousRevision
        && cached.journalDigest === expected.journalDigest
        && cached.projectionDigest === expected.projectionDigest) return cached;
    } catch {
      // The projection is a cache. Invalid or stale bytes are rebuilt below.
    }
  }
  writeReplaceableCache(path, expected);
  return expected;
}

function appendEvent(root: string, eventBase: Omit<CandidateJournalEventV1, "eventDigest">): CandidateProjectionV1 {
  const existing = readJournal(root, eventBase.workspaceId, eventBase.candidateId);
  const previous = existing.at(-1) || null;
  invariant(eventBase.revision === (previous?.revision || 0) + 1, "candidate revision CAS conflict");
  invariant(eventBase.previousEventDigest === (previous?.eventDigest || null), "candidate previous digest CAS conflict");
  const event = { ...eventBase, eventDigest: eventDigest(eventBase) };
  validateJournalEvent(event, previous);
  writeNoReplace(revisionPath(root, event.candidateId, event.revision), event);
  const events = readJournal(root, event.workspaceId, event.candidateId);
  const projection = projectionFromEvents(event.workspaceId, event.candidateId, events);
  writeReplaceableCache(join(root, "projections", `${digestPath(event.candidateId)}.json`), projection);
  return projection;
}

function quarantine(root: string, input: Omit<CandidateQuarantineV1, "schema" | "recordDigest">): CandidateQuarantineV1 {
  const base: Omit<CandidateQuarantineV1, "recordDigest"> = { schema: QUARANTINE_SCHEMA, ...input };
  const record = { ...base, recordDigest: quarantineDigest(base) };
  writeNoReplace(join(root, "quarantine", `${digestPath(record.recordDigest)}.json`), record);
  return record;
}

function operationIntent(report: CandidateReportV2, cluster: CandidateClusterV1): CandidateOperationV2 {
  const operationId = candidateOperationId({
    reportDigest: report.reportDigest,
    candidateId: cluster.candidateId,
    evidenceSetDigest: cluster.evidenceSetDigest,
    workspaceId: report.workspaceId,
  });
  const intent: CandidateOperationV2["intent"] = {
    occurrenceIds: [...cluster.occurrenceIds].sort(),
    candidateCoreDigest: candidateCoreDigest(cluster),
    candidatePayloadDigest: candidatePayloadDigest(cluster),
    targetRootVersion: STORE_ROOT_VERSION,
  };
  return validateCandidateOperationV2({
    schema: MEMORY_CANDIDATE_OPERATION_V2_SCHEMA,
    operationId,
    reportDigest: report.reportDigest,
    workspaceId: report.workspaceId,
    candidateId: cluster.candidateId,
    evidenceSetDigest: cluster.evidenceSetDigest,
    intent,
    immutableIntentDigest: candidateOperationIntentDigest(intent),
    status: "intent_recorded",
    reasonCode: "admitted",
    createdAt: report.snapshotAt,
    updatedAt: report.snapshotAt,
  });
}

function committedOperation(intent: CandidateOperationV2, replay: boolean): CandidateOperationV2 {
  return validateCandidateOperationV2({
    ...intent,
    status: "committed",
    reasonCode: replay ? "replay_verified" : "report_verified",
  });
}

function publishOperation(root: string, operation: CandidateOperationV2, stage: "intent" | "terminal"): "published" | "replay" {
  const directory = join(root, "operations", digestPath(operation.operationId));
  return writeNoReplace(join(directory, `${stage}.json`), operation);
}

function publishOccurrence(root: string, occurrence: EvidenceOccurrenceV1): "published" | "replay" {
  return writeNoReplace(join(root, "occurrences", `${digestPath(occurrence.occurrenceId)}.json`), occurrence);
}

function publishPendingEvidence(root: string, report: CandidateReportV2, candidateId: Digest, occurrence: EvidenceOccurrenceV1): "published" | "replay" {
  const base: Omit<PendingEvidenceV1, "recordDigest"> = {
    schema: PENDING_EVIDENCE_SCHEMA,
    workspaceId: report.workspaceId,
    candidateId,
    reportDigest: report.reportDigest,
    occurrence,
    receivedAt: report.snapshotAt,
  };
  const record = { ...base, recordDigest: pendingEvidenceDigest(base) };
  const path = join(root, "pending-evidence", digestPath(candidateId), `${digestPath(occurrence.occurrenceId)}.json`);
  if (existsSync(path)) {
    const existing = readJson<PendingEvidenceV1>(path);
    invariant(existing.schema === PENDING_EVIDENCE_SCHEMA
      && existing.workspaceId === report.workspaceId
      && existing.candidateId === candidateId
      && existing.recordDigest === pendingEvidenceDigest(existing)
      && canonicalizeJcs(existing.occurrence) === canonicalizeJcs(occurrence), "pending evidence payload conflict");
    return "replay";
  }
  return writeNoReplace(path, record);
}

class MaterializationPreflightConflict extends Error {
  constructor(readonly correlationDigest: Digest, message: string) {
    super(message);
  }
}

function preflightMaterialization(root: string, report: CandidateReportV2): void {
  const occurrences = new Map(report.occurrences.map((occurrence) => [occurrence.occurrenceId, occurrence]));
  for (const cluster of report.candidates) {
    const operation = operationIntent(report, cluster);
    const operationDirectory = join(root, "operations", digestPath(operation.operationId));
    const intentPath = join(operationDirectory, "intent.json");
    if (existsSync(intentPath)) {
      const existing = validateCandidateOperationV2(readJson<CandidateOperationV2>(intentPath));
      if (canonicalizeJcs(existing) !== canonicalizeJcs(operation)) {
        throw new MaterializationPreflightConflict(operation.operationId, "existing operation intent payload conflict");
      }
    }
    const terminalPath = join(operationDirectory, "terminal.json");
    if (existsSync(terminalPath)) {
      const existing = validateCandidateOperationV2(readJson<CandidateOperationV2>(terminalPath));
      const committed = committedOperation(operation, false);
      const replayed = committedOperation(operation, true);
      if (canonicalizeJcs(existing) !== canonicalizeJcs(committed) && canonicalizeJcs(existing) !== canonicalizeJcs(replayed)) {
        throw new MaterializationPreflightConflict(operation.operationId, "existing operation terminal payload conflict");
      }
    }
    for (const occurrenceId of cluster.occurrenceIds) {
      const occurrence = occurrences.get(occurrenceId)!;
      const occurrencePath = join(root, "occurrences", `${digestPath(occurrenceId)}.json`);
      if (existsSync(occurrencePath) && canonicalizeJcs(readJson<EvidenceOccurrenceV1>(occurrencePath)) !== canonicalizeJcs(occurrence)) {
        throw new MaterializationPreflightConflict(operation.operationId, "existing occurrence payload conflict");
      }
    }
    const events = readJournal(root, report.workspaceId, cluster.candidateId);
    if (events.length && candidateCoreDigest(events.at(-1)!.cluster) !== operation.intent.candidateCoreDigest) {
      throw new MaterializationPreflightConflict(operation.operationId, "existing candidate immutable core conflict");
    }
  }
}

function materializeOne(workspace: string, root: string, report: CandidateReportV2, cluster: CandidateClusterV1, occurrences: Map<Digest, EvidenceOccurrenceV1>, fault?: MaterializeCandidateReportV2Options["faultInjector"]): MaterializationCandidateResultV1 {
  const operation = operationIntent(report, cluster);
  const operationDirectory = join(root, "operations", digestPath(operation.operationId));
  const intentPath = join(operationDirectory, "intent.json");
  if (existsSync(intentPath)) {
    const existing = validateCandidateOperationV2(readJson<CandidateOperationV2>(intentPath));
    invariant(canonicalizeJcs(existing) === canonicalizeJcs(operation), "existing operation intent payload conflict");
  }
  const intentPublication = publishOperation(root, operation, "intent");
  fault?.("after_operation_intent", cluster.candidateId);

  for (const occurrenceId of cluster.occurrenceIds) {
    const occurrence = occurrences.get(occurrenceId);
    invariant(occurrence, "materialization candidate cites missing occurrence");
    publishOccurrence(root, occurrence);
    fault?.("after_occurrence_publication", cluster.candidateId);
  }

  const current = readCandidateProjectionV1({ workspace, workspaceId: report.workspaceId, candidateId: cluster.candidateId });
  let projection: CandidateProjectionV1;
  let inboxed = 0;
  if (!current) {
    projection = appendEvent(root, {
      schema: JOURNAL_EVENT_SCHEMA,
      workspaceId: report.workspaceId,
      candidateId: cluster.candidateId,
      revision: 1,
      kind: "materialized",
      correlationId: operation.operationId,
      previousEventDigest: null,
      cluster,
      reservation: null,
    });
  } else {
    invariant(candidateCoreDigest(current.cluster) === operation.intent.candidateCoreDigest, "existing candidate immutable core conflict");
    const oldIds = new Set(current.cluster.occurrenceIds);
    const newIds = cluster.occurrenceIds.filter((id) => !oldIds.has(id));
    if (!newIds.length) {
      projection = current;
    } else if (["pending", "deferred"].includes(current.cluster.lifecycle.status) && current.reservation === null) {
      const nextRevision = current.highestContiguousRevision + 1;
      const allIds = [...new Set([...current.cluster.occurrenceIds, ...newIds])].sort((left, right) => {
        const leftOccurrence = occurrences.get(left) || readJson<EvidenceOccurrenceV1>(join(root, "occurrences", `${digestPath(left)}.json`));
        const rightOccurrence = occurrences.get(right) || readJson<EvidenceOccurrenceV1>(join(root, "occurrences", `${digestPath(right)}.json`));
        return leftOccurrence.observedAt.localeCompare(rightOccurrence.observedAt) || left.localeCompare(right);
      });
      const merged: CandidateClusterV1 = {
        ...current.cluster,
        occurrenceIds: allIds,
        distinctProvenanceRootIds: [...new Set([...current.cluster.distinctProvenanceRootIds, ...cluster.distinctProvenanceRootIds])].sort(),
        evidenceSetDigest: evidenceSetDigestV1(allIds),
        lifecycle: {
          ...current.cluster.lifecycle,
          revision: nextRevision,
          correlationId: operation.operationId,
          updatedAt: report.snapshotAt,
        },
      };
      validateCandidateClusterV1(merged);
      const events = readJournal(root, report.workspaceId, cluster.candidateId);
      projection = appendEvent(root, {
        schema: JOURNAL_EVENT_SCHEMA,
        workspaceId: report.workspaceId,
        candidateId: cluster.candidateId,
        revision: nextRevision,
        kind: "evidence_merged",
        correlationId: operation.operationId,
        previousEventDigest: events.at(-1)!.eventDigest,
        cluster: merged,
        reservation: null,
      });
    } else {
      for (const occurrenceId of newIds) {
        publishPendingEvidence(root, report, cluster.candidateId, occurrences.get(occurrenceId)!);
        inboxed += 1;
      }
      projection = current;
    }
  }
  fault?.("after_journal_publication", cluster.candidateId);
  fault?.("after_projection_rebuild", cluster.candidateId);
  const terminalPath = join(operationDirectory, "terminal.json");
  let terminalPublication: "published" | "replay";
  if (existsSync(terminalPath)) {
    const existingTerminal = validateCandidateOperationV2(readJson<CandidateOperationV2>(terminalPath));
    const expectedTerminal = committedOperation(operation, false);
    const expectedReplayTerminal = committedOperation(operation, true);
    invariant(canonicalizeJcs(existingTerminal) === canonicalizeJcs(expectedTerminal)
      || canonicalizeJcs(existingTerminal) === canonicalizeJcs(expectedReplayTerminal), "existing operation terminal payload conflict");
    terminalPublication = "replay";
  } else {
    terminalPublication = publishOperation(root, committedOperation(operation, intentPublication === "replay"), "terminal");
  }
  fault?.("after_operation_commit", cluster.candidateId);
  return {
    candidateId: cluster.candidateId,
    operationId: operation.operationId,
    status: inboxed ? "inboxed" : terminalPublication === "replay" ? "replay_verified" : "committed",
    revision: projection.highestContiguousRevision,
    inboxedOccurrences: inboxed,
  };
}

function verifiedMaterializationInputs(options: MaterializeCandidateReportV2Options): CandidateReportV2 {
  invariant(options.workspaceId === options.report.workspaceId, "materialization workspace mismatch");
  invariant(options.policy.mode === "materialize", "materialization requires materialize policy");
  const report = validateCandidateReportV2(options.report, {
    policy: options.policy,
    scopeRegistry: options.scopeRegistry,
    versions: options.versions || CANDIDATE_SUPPORTED_VERSIONS_V1,
  });
  invariant(report.executionMode === "materialize", "materialization requires materialize report");
  return report;
}

export function materializeCandidateReportV2(options: MaterializeCandidateReportV2Options): MaterializationResultV1 {
  const root = ensureStoreRoot(options.workspace);
  let report: CandidateReportV2;
  try {
    report = verifiedMaterializationInputs(options);
  } catch (error) {
    quarantine(root, {
      workspaceId: options.workspaceId,
      correlationDigest: /^sha256:[0-9a-f]{64}$/.test(String(options.report?.reportDigest)) ? options.report.reportDigest : sha256Digest("invalid-report-digest"),
      reasonCode: "report_digest_mismatch",
      artifactClass: "report",
      observedAt: /^\d{4}-\d{2}-\d{2}T/.test(String(options.report?.snapshotAt)) ? options.report.snapshotAt : new Date(0).toISOString(),
    });
    throw error;
  }
  try {
    writeNoReplace(join(root, "reports", `${digestPath(report.compilationAttemptId)}.json`), report);
  } catch (error) {
    quarantine(root, {
      workspaceId: report.workspaceId,
      correlationDigest: report.compilationAttemptId,
      reasonCode: "payload_conflict",
      artifactClass: "report",
      observedAt: report.snapshotAt,
    });
    throw error;
  }
  try {
    preflightMaterialization(root, report);
  } catch (error) {
    quarantine(root, {
      workspaceId: report.workspaceId,
      correlationDigest: error instanceof MaterializationPreflightConflict ? error.correlationDigest : report.reportDigest,
      reasonCode: "payload_conflict",
      artifactClass: "operation",
      observedAt: report.snapshotAt,
    });
    throw error;
  }
  options.faultInjector?.("after_report_publication");
  const occurrenceMap = new Map(report.occurrences.map((occurrence) => [occurrence.occurrenceId, occurrence]));
  const results: MaterializationCandidateResultV1[] = [];
  for (const cluster of report.candidates) {
    try {
      results.push(materializeOne(options.workspace, root, report, cluster, occurrenceMap, options.faultInjector));
    } catch (error) {
      const operationId = candidateOperationId({ reportDigest: report.reportDigest, candidateId: cluster.candidateId, evidenceSetDigest: cluster.evidenceSetDigest, workspaceId: report.workspaceId });
      quarantine(root, {
        workspaceId: report.workspaceId,
        correlationDigest: operationId,
        reasonCode: "payload_conflict",
        artifactClass: "operation",
        observedAt: report.snapshotAt,
      });
      throw error;
    }
  }
  return { schema: "oll.memory-candidate-materialization-result.v1", workspaceId: report.workspaceId, reportDigest: report.reportDigest, candidates: results };
}

export function recoverCandidateMaterializationV2(options: Omit<MaterializeCandidateReportV2Options, "report"> & { compilationAttemptId: Digest }): MaterializationResultV1 {
  const root = ensureStoreRoot(options.workspace);
  const path = join(root, "reports", `${digestPath(options.compilationAttemptId)}.json`);
  invariant(existsSync(path), "verified candidate report is not persisted");
  const report = readJson<CandidateReportV2>(path);
  return materializeCandidateReportV2({ ...options, report });
}

function liveOccurrenceMatch(frozen: EvidenceOccurrenceV1, current: CandidateReportV2): EvidenceOccurrenceV1 | null {
  return current.occurrences.find((entry) => entry.sourceClass === frozen.sourceClass
    && entry.sourceRef === frozen.sourceRef
    && entry.contentDigest === frozen.contentDigest
    && entry.canonicalStatement === frozen.canonicalStatement) || null;
}

function assessmentLifecycleInputsDigest(report: CandidateReportV2, cluster: CandidateClusterV1): Digest {
  return sha256Digest(canonicalizeJcs({
    reportDigest: report.reportDigest,
    evidenceSetDigest: cluster.evidenceSetDigest,
    policyDigest: report.policyDigest,
    scopeRegistryRevision: report.scopeRegistryRevision,
    scopeRegistryDigest: report.scopeRegistryDigest,
    kgAssertionRevision: report.kgAssertionRevision,
    kgAssertionDigest: report.kgAssertionDigest,
  }));
}

export function assessCandidateSelectionV1(options: AssessCandidateSelectionV1Options): CandidateSelectionAssessmentV1 {
  const versions = options.versions || CANDIDATE_SUPPORTED_VERSIONS_V1;
  const frozen = validateCandidateReportV2(options.frozenReport, { policy: options.frozenPolicy, scopeRegistry: options.frozenScopeRegistry, versions });
  const current = validateCandidateReportV2(options.currentReport, { policy: options.currentPolicy, scopeRegistry: options.currentScopeRegistry, versions });
  invariant(frozen.workspaceId === options.workspaceId && current.workspaceId === options.workspaceId, "assessment workspace mismatch");
  invariant(Date.parse(current.snapshotAt) >= Date.parse(frozen.snapshotAt), "live revalidation snapshot predates frozen report");
  const frozenCluster = frozen.candidates.find((candidate) => candidate.candidateId === options.candidateId);
  invariant(frozenCluster, "candidate is not in frozen report");

  let outcome: CandidateSelectionAssessmentV1["outcome"] = "selected";
  let reasonCode: CandidateReasonCode = "selected";
  for (const occurrenceId of frozenCluster.occurrenceIds) {
    const occurrence = frozen.occurrences.find((entry) => entry.occurrenceId === occurrenceId)!;
    const live = liveOccurrenceMatch(occurrence, current);
    if (!live) {
      outcome = "invalidated";
      reasonCode = occurrence.sourceClass === "kg-assertion" ? "source_retracted" : "source_revoked";
      break;
    }
    if (canonicalizeJcs(live.effectiveScope) !== canonicalizeJcs(occurrence.effectiveScope)) {
      invariant(scopeContains(options.currentScopeRegistry, occurrence.effectiveScope, live.effectiveScope), "live revalidation attempted to broaden or make scope incomparable");
      outcome = "invalidated";
      reasonCode = "scope_revoked";
      break;
    }
  }

  const base: Omit<CandidateSelectionAssessmentV1, "schema" | "assessmentId" | "outcome" | "reasonCode" | "assessedAt"> = {
    batchId: frozen.batchId,
    candidateId: options.candidateId,
    expectedCandidateRevision: options.expectedCandidateRevision,
    lifecycleInputsDigest: assessmentLifecycleInputsDigest(frozen, frozenCluster),
    accessStateRevision: frozen.accessStateRevision,
    decayPolicyDigest: sha256Digest(canonicalizeJcs(options.frozenPolicy.decayPolicy)),
  };
  const assessment: CandidateSelectionAssessmentV1 = validateCandidateSelectionAssessmentV1({
    schema: MEMORY_CANDIDATE_ASSESSMENT_V1_SCHEMA,
    assessmentId: selectionAssessmentId(base),
    ...base,
    outcome,
    reasonCode,
    assessedAt: current.snapshotAt,
  });
  const root = ensureStoreRoot(options.workspace);
  const assessmentPath = join(root, "assessments", `${digestPath(assessment.assessmentId)}.json`);
  const assessmentExists = existsSync(assessmentPath);
  if (assessmentExists) {
    const existing = validateCandidateSelectionAssessmentV1(readJson<CandidateSelectionAssessmentV1>(assessmentPath));
    invariant(canonicalizeJcs(existing) === canonicalizeJcs(assessment), "existing assessment payload conflict");
  }
  const projection = readCandidateProjectionV1({ workspace: options.workspace, workspaceId: options.workspaceId, candidateId: options.candidateId });
  if (assessmentExists && projection) {
    const lifecycle = projection.cluster.lifecycle;
    if (assessment.outcome === "invalidated"
      && lifecycle.status === "invalidated"
      && lifecycle.correlationId === assessment.assessmentId) return assessment;
    if (assessment.outcome === "selected" && lifecycle.status === "pending"
      && (projection.highestContiguousRevision === options.expectedCandidateRevision
        || lifecycle.correlationId === assessment.assessmentId)) return assessment;
  }
  invariant(projection && projection.highestContiguousRevision === options.expectedCandidateRevision, "assessment candidate revision CAS conflict");
  invariant(projection.cluster.lifecycle.status === "pending" || projection.cluster.lifecycle.status === "deferred", "candidate is not selectable");
  if (!assessmentExists) {
    writeNoReplace(assessmentPath, assessment);
    options.faultInjector?.("after_assessment_publication");
  }

  if (outcome === "invalidated") {
    validateLifecycleTransition(projection.cluster.lifecycle.status, "invalidated", reasonCode);
    const events = readJournal(root, options.workspaceId, options.candidateId);
    appendEvent(root, {
      schema: JOURNAL_EVENT_SCHEMA,
      workspaceId: options.workspaceId,
      candidateId: options.candidateId,
      revision: projection.highestContiguousRevision + 1,
      kind: "lifecycle_transition",
      correlationId: assessment.assessmentId,
      previousEventDigest: events.at(-1)!.eventDigest,
      cluster: {
        ...projection.cluster,
        lifecycle: {
          status: "invalidated",
          revision: projection.highestContiguousRevision + 1,
          evaluationEpoch: projection.cluster.evaluationEpoch,
          reasonCode,
          reservationOwner: null,
          correlationId: assessment.assessmentId,
          updatedAt: current.snapshotAt,
        },
      },
      reservation: null,
    });
  } else if (projection.cluster.lifecycle.status === "deferred") {
    validateLifecycleTransition("deferred", "pending", "selected");
    const events = readJournal(root, options.workspaceId, options.candidateId);
    appendEvent(root, {
      schema: JOURNAL_EVENT_SCHEMA,
      workspaceId: options.workspaceId,
      candidateId: options.candidateId,
      revision: projection.highestContiguousRevision + 1,
      kind: "lifecycle_transition",
      correlationId: assessment.assessmentId,
      previousEventDigest: events.at(-1)!.eventDigest,
      cluster: {
        ...projection.cluster,
        lifecycle: {
          status: "pending",
          revision: projection.highestContiguousRevision + 1,
          evaluationEpoch: projection.cluster.evaluationEpoch,
          reasonCode: "selected",
          reservationOwner: null,
          correlationId: assessment.assessmentId,
          updatedAt: current.snapshotAt,
        },
      },
      reservation: null,
    });
  }
  return assessment;
}

export function reserveCandidateV1(options: ReserveCandidateV1Options): CandidateReservationV1 {
  const projection = readCandidateProjectionV1(options);
  if (projection?.reservation?.planId === options.planId
    && projection.reservation.expectedRevision === options.expectedRevision
    && projection.reservation.evidenceSetDigest === options.evidenceSetDigest
    && projection.reservation.status === "held") return projection.reservation;
  invariant(projection && projection.highestContiguousRevision === options.expectedRevision, "reservation candidate revision CAS conflict");
  invariant(projection.cluster.lifecycle.status === "pending" && projection.reservation === null, "candidate is not reservable");
  invariant(projection.cluster.evidenceSetDigest === options.evidenceSetDigest, "reservation evidence digest mismatch");
  validateLifecycleTransition("pending", "reserved", "reservation_acquired");
  const reservationBase: Omit<CandidateReservationV1, "schema" | "reservationId"> = {
    planId: options.planId,
    candidateId: options.candidateId,
    expectedRevision: options.expectedRevision,
    evidenceSetDigest: options.evidenceSetDigest,
    status: "held",
    reasonCode: "reservation_acquired",
    createdAt: options.now,
    updatedAt: options.now,
  };
  const reservation = validateCandidateReservationV1({
    schema: MEMORY_CANDIDATE_RESERVATION_V1_SCHEMA,
    reservationId: candidateReservationId(reservationBase as CandidateReservationV1),
    ...reservationBase,
  });
  const root = ensureStoreRoot(options.workspace);
  const events = readJournal(root, options.workspaceId, options.candidateId);
  appendEvent(root, {
    schema: JOURNAL_EVENT_SCHEMA,
    workspaceId: options.workspaceId,
    candidateId: options.candidateId,
    revision: options.expectedRevision + 1,
    kind: "reservation_acquired",
    correlationId: options.planId,
    previousEventDigest: events.at(-1)!.eventDigest,
    cluster: {
      ...projection.cluster,
      lifecycle: {
        status: "reserved",
        revision: options.expectedRevision + 1,
        evaluationEpoch: projection.cluster.evaluationEpoch,
        reasonCode: "reservation_acquired",
        reservationOwner: options.planId,
        correlationId: options.planId,
        updatedAt: options.now,
      },
    },
    reservation,
  });
  return reservation;
}

export function markCandidateReviewPendingV1(options: {
  workspace: string;
  workspaceId: string;
  planId: Digest;
  candidateId: Digest;
  expectedRevision: number;
  reviewId: Digest;
  now: string;
}): CandidateProjectionV1 {
  const projection = readCandidateProjectionV1(options);
  if (projection?.cluster.lifecycle.status === "review_pending"
    && projection.cluster.lifecycle.reservationOwner === options.planId
    && projection.cluster.lifecycle.correlationId === options.reviewId) return projection;
  invariant(projection && projection.highestContiguousRevision === options.expectedRevision, "review-pending candidate revision CAS conflict");
  invariant(projection.cluster.lifecycle.status === "reserved"
    && projection.cluster.lifecycle.reservationOwner === options.planId
    && projection.reservation?.planId === options.planId
    && projection.reservation.status === "held", "candidate reservation owner mismatch");
  validateLifecycleTransition("reserved", "review_pending", "review_created");
  const reservation = validateCandidateReservationV1({
    ...projection.reservation,
    status: "review_pending",
    reasonCode: "review_created",
    updatedAt: options.now,
  });
  const root = ensureStoreRoot(options.workspace);
  const events = readJournal(root, options.workspaceId, options.candidateId);
  return appendEvent(root, {
    schema: JOURNAL_EVENT_SCHEMA,
    workspaceId: options.workspaceId,
    candidateId: options.candidateId,
    revision: options.expectedRevision + 1,
    kind: "review_pending",
    correlationId: options.reviewId,
    previousEventDigest: events.at(-1)!.eventDigest,
    cluster: {
      ...projection.cluster,
      lifecycle: {
        status: "review_pending",
        revision: options.expectedRevision + 1,
        evaluationEpoch: projection.cluster.evaluationEpoch,
        reasonCode: "review_created",
        reservationOwner: options.planId,
        correlationId: options.reviewId,
        updatedAt: options.now,
      },
    },
    reservation,
  });
}

export function releaseCandidateReservationV1(options: {
  workspace: string;
  workspaceId: string;
  planId: Digest;
  candidateId: Digest;
  expectedRevision: number;
  to: "pending" | "deferred" | "dismissed";
  reasonCode: "plan_cancelled_before_effect" | "review_policy_rejected_retryable" | "review_policy_rejected_terminal";
  now: string;
}): CandidateProjectionV1 {
  const projection = readCandidateProjectionV1(options);
  if (projection && projection.highestContiguousRevision > options.expectedRevision
    && projection.cluster.lifecycle.status === options.to
    && projection.cluster.lifecycle.correlationId === options.planId) return projection;
  invariant(projection && projection.highestContiguousRevision === options.expectedRevision, "reservation release revision CAS conflict");
  invariant(projection.cluster.lifecycle.status === "reserved"
    && projection.cluster.lifecycle.reservationOwner === options.planId
    && projection.reservation?.planId === options.planId, "candidate reservation owner mismatch");
  validateLifecycleTransition("reserved", options.to, options.reasonCode);
  const root = ensureStoreRoot(options.workspace);
  const events = readJournal(root, options.workspaceId, options.candidateId);
  return appendEvent(root, {
    schema: JOURNAL_EVENT_SCHEMA,
    workspaceId: options.workspaceId,
    candidateId: options.candidateId,
    revision: options.expectedRevision + 1,
    kind: "reservation_released",
    correlationId: options.planId,
    previousEventDigest: events.at(-1)!.eventDigest,
    cluster: {
      ...projection.cluster,
      lifecycle: {
        status: options.to,
        revision: options.expectedRevision + 1,
        evaluationEpoch: projection.cluster.evaluationEpoch,
        reasonCode: options.reasonCode,
        reservationOwner: null,
        correlationId: options.planId,
        updatedAt: options.now,
      },
    },
    reservation: null,
  });
}

export function markCandidateOptimisticAppliedV1(options: {
  workspace: string;
  workspaceId: string;
  planId: Digest;
  candidateId: Digest;
  expectedRevision: number;
  operationId: Digest;
  now: string;
}): CandidateProjectionV1 {
  const projection = readCandidateProjectionV1(options);
  if (projection && projection.highestContiguousRevision > options.expectedRevision
    && projection.cluster.lifecycle.status === "evaluated"
    && projection.cluster.lifecycle.reasonCode === "optimistic_apply"
    && projection.cluster.lifecycle.correlationId === options.operationId) return projection;
  invariant(projection && projection.highestContiguousRevision === options.expectedRevision, "optimistic apply revision CAS conflict");
  invariant(projection.cluster.lifecycle.status === "reserved"
    && projection.cluster.lifecycle.reservationOwner === options.planId
    && projection.reservation?.planId === options.planId
    && projection.reservation.status === "held", "optimistic apply reservation owner mismatch");
  validateLifecycleTransition("reserved", "evaluated", "optimistic_apply");
  const root = ensureStoreRoot(options.workspace);
  const events = readJournal(root, options.workspaceId, options.candidateId);
  return appendEvent(root, {
    schema: JOURNAL_EVENT_SCHEMA,
    workspaceId: options.workspaceId,
    candidateId: options.candidateId,
    revision: options.expectedRevision + 1,
    kind: "optimistic_applied",
    correlationId: options.operationId,
    previousEventDigest: events.at(-1)!.eventDigest,
    cluster: {
      ...projection.cluster,
      lifecycle: {
        status: "evaluated",
        revision: options.expectedRevision + 1,
        evaluationEpoch: projection.cluster.evaluationEpoch,
        reasonCode: "optimistic_apply",
        reservationOwner: null,
        correlationId: options.operationId,
        updatedAt: options.now,
      },
    },
    reservation: null,
  });
}

export function dispositionCandidateV1(options: {
  workspace: string;
  workspaceId: string;
  candidateId: Digest;
  expectedRevision: number;
  disposition: "ignored" | "deferred";
  correlationId: Digest;
  now: string;
}): CandidateProjectionV1 {
  const projection = readCandidateProjectionV1(options);
  const target = options.disposition === "ignored" ? "dismissed" : "deferred";
  const reasonCode = options.disposition === "ignored" ? "explicit_ignore" : "not_selected";
  if (projection && projection.highestContiguousRevision > options.expectedRevision
    && projection.cluster.lifecycle.status === target
    && projection.cluster.lifecycle.correlationId === options.correlationId) return projection;
  invariant(projection && projection.highestContiguousRevision === options.expectedRevision, "candidate disposition revision CAS conflict");
  invariant(projection.cluster.lifecycle.status === "pending" && projection.reservation === null, "candidate is not dispositionable");
  validateLifecycleTransition("pending", target, reasonCode);
  const root = ensureStoreRoot(options.workspace);
  const events = readJournal(root, options.workspaceId, options.candidateId);
  return appendEvent(root, {
    schema: JOURNAL_EVENT_SCHEMA,
    workspaceId: options.workspaceId,
    candidateId: options.candidateId,
    revision: options.expectedRevision + 1,
    kind: "lifecycle_transition",
    correlationId: options.correlationId,
    previousEventDigest: events.at(-1)!.eventDigest,
    cluster: {
      ...projection.cluster,
      lifecycle: {
        status: target,
        revision: options.expectedRevision + 1,
        evaluationEpoch: projection.cluster.evaluationEpoch,
        reasonCode,
        reservationOwner: null,
        correlationId: options.correlationId,
        updatedAt: options.now,
      },
    },
    reservation: null,
  });
}

export function applyCandidateReviewOutcomeV1(options: {
  workspace: string;
  workspaceId: string;
  planId: Digest;
  candidateId: Digest;
  expectedRevision: number;
  outcomeId: Digest;
  to: "evaluated" | "deferred" | "dismissed";
  reasonCode: "review_approved" | "review_rejected_retryable" | "review_rejected_terminal" | "review_expired_retryable" | "review_expired_terminal";
  now: string;
}): CandidateProjectionV1 {
  const projection = readCandidateProjectionV1(options);
  if (projection && projection.highestContiguousRevision > options.expectedRevision
    && projection.cluster.lifecycle.status === options.to
    && projection.cluster.lifecycle.correlationId === options.outcomeId) return projection;
  invariant(projection && projection.highestContiguousRevision === options.expectedRevision, "review outcome candidate revision CAS conflict");
  invariant(projection.cluster.lifecycle.status === "review_pending"
    && projection.cluster.lifecycle.reservationOwner === options.planId
    && projection.reservation?.planId === options.planId, "review outcome reservation owner mismatch");
  validateLifecycleTransition("review_pending", options.to, options.reasonCode);
  const root = ensureStoreRoot(options.workspace);
  const events = readJournal(root, options.workspaceId, options.candidateId);
  return appendEvent(root, {
    schema: JOURNAL_EVENT_SCHEMA,
    workspaceId: options.workspaceId,
    candidateId: options.candidateId,
    revision: options.expectedRevision + 1,
    kind: "review_outcome",
    correlationId: options.outcomeId,
    previousEventDigest: events.at(-1)!.eventDigest,
    cluster: {
      ...projection.cluster,
      lifecycle: {
        status: options.to,
        revision: options.expectedRevision + 1,
        evaluationEpoch: projection.cluster.evaluationEpoch,
        reasonCode: options.reasonCode,
        reservationOwner: null,
        correlationId: options.outcomeId,
        updatedAt: options.now,
      },
    },
    reservation: null,
  });
}

export function listPendingEvidenceV1(options: { workspace: string; candidateId: Digest }): EvidenceOccurrenceV1[] {
  const root = ensureStoreRoot(options.workspace);
  const directory = join(root, "pending-evidence", digestPath(options.candidateId));
  if (!existsSync(directory)) return [];
  return readdirSync(directory).filter((name) => name.endsWith(".json")).sort().map((name) => {
    const record = readJson<PendingEvidenceV1>(join(directory, name));
    invariant(record.schema === PENDING_EVIDENCE_SCHEMA && record.candidateId === options.candidateId, "pending evidence correlation mismatch");
    invariant(record.recordDigest === pendingEvidenceDigest(record), "pending evidence digest mismatch");
    return record.occurrence;
  });
}
