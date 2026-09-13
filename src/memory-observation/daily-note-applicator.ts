import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep as pathSeparator } from "node:path";
import { withDailyNoteLock } from "../daily-note-lock.ts";
import { splitCanonicalSessionKey } from "../session-key.ts";
import {
  markWorkspaceQmdDirty,
  type MarkWorkspaceQmdDirtyInput,
  type WorkspaceDirtyMarkResult,
} from "../qmd/maintenance-integration.ts";
import {
  sha256,
  type Digest,
  type EpisodicObservationV1,
  type JsonValue,
  type ObservationScope,
  type ProducerRef,
} from "./ledger.ts";
import {
  BATCH_EVALUATOR_AUTHORITY,
  validateBatchObservation,
  type BatchObservationV1,
} from "./batch-observation.ts";
import { resolveCanaryQmdRuntimeBinding } from "./qmd-binding-preflight.ts";
import type { MemoryObservationQmdBindingV1, MemoryObservationQmdResolverV1 } from "./projection.ts";
import { resolveQmdContext } from "../qmd/context.ts";
import { readIndexHandoff, storeIndexHandoff } from "../qmd/index-provenance.ts";

import { CONTEXTUAL_BATCH_SCHEMA, CONTEXTUAL_EVALUATOR_AUTHORITY, validateReadableBatchObservation, renderContextualBatch, type ReadableBatchObservation } from "./contextual-batch-observation.ts";
type DailyNoteObservation = EpisodicObservationV1 | ReadableBatchObservation;
export type ResolvedDailyNoteQmdBinding = {
  collection: string;
  bindingDigest: Digest;
  canonicalRoot: string;
  indexName: string;
  indexKey: string;
  workspaceRegistryDigest: Digest;
};

export const SINGLE_TURN_EVALUATOR_AUTHORITY: ProducerRef = {
  id: "post-turn-observer",
  version: "v1",
  digest: "sha256:d4f0bf349ea08594fbd3a72f1e6f05ea5dda32800422c1e2cefbc434552cd406",
};

// Backward-compatible name used by recall authority contracts.
export const POST_TURN_OBSERVER = SINGLE_TURN_EVALUATOR_AUTHORITY;

export const DAILY_NOTE_APPLICATOR: ProducerRef = {
  id: "daily-note-applicator",
  version: "v1",
  digest: "sha256:f9e632bc639b5f4240c15f4ac1fffb2ffa1c0b299a380d1432216c9a2c8b7ef5",
};

export type DailyNoteCanaryPolicy = {
  workspaceId: string;
  exactScope: ObservationScope;
  applyAfter: string;
  timezone: string;
  allowedObservationClasses: ["episodic.event"] | ["episodic.event", "episodic.decision"];
  maxAppliesPerWake: 1;
  policyDigest: Digest;
  allowedBatchEvaluationPolicyDigest?: Digest;
  allowContextualObservations?: boolean;
  allowedPreviousBatchEvaluationPolicyDigests?: Digest[];
  qmdBinding?: MemoryObservationQmdBindingV1 | MemoryObservationQmdResolverV1 | ResolvedDailyNoteQmdBinding;
};

export function buildDailyNoteCanaryPolicy(input: Omit<DailyNoteCanaryPolicy, "policyDigest">): DailyNoteCanaryPolicy {
  const policyBase = {
    schema: "engram.memory-consumer-policy.v1",
    policyId: "memory-observation-daily-note-main-canary",
    policyVersion: "v1",
    consumer: "daily-note",
    workspaceId: input.workspaceId,
    mode: "canary",
    inputSchemas: ["engram.memory-observation.v1", "engram.memory-batch-observation.v1", ...(input.allowContextualObservations ? [CONTEXTUAL_BATCH_SCHEMA] : [])],
    allowedProducers: [SINGLE_TURN_EVALUATOR_AUTHORITY, BATCH_EVALUATOR_AUTHORITY, ...(input.allowContextualObservations ? [CONTEXTUAL_EVALUATOR_AUTHORITY] : [])],
    allowedObservationClasses: input.allowedObservationClasses,
    allowedCanonicalSourceSchemas: [],
    exactScopeAllowlist: [input.exactScope],
    requiredProvenanceFields: ["traceId", "sourceTurnId", "scope", "producer", "evidenceRefs", "sourceCompletedAt", "observationDigest"],
    sideEffectClass: "canonical-write",
    soleMutator: "daily-note-applicator",
    rawEvidenceAllowed: false,
    applyTimeRecheck: true,
    denyUnknownProducer: true,
    denyUnknownClass: true,
    denyUnknownScope: true,
    applyAfter: input.applyAfter,
    timezone: input.timezone,
    maxAppliesPerWake: input.maxAppliesPerWake,
    ...(input.allowedBatchEvaluationPolicyDigest
      ? { allowedBatchEvaluationPolicyDigest: input.allowedBatchEvaluationPolicyDigest }
      : {}),
    ...(input.allowContextualObservations ? { allowContextualObservations: true } : {}),
    ...(input.allowedPreviousBatchEvaluationPolicyDigests?.length ? {allowedPreviousBatchEvaluationPolicyDigests: input.allowedPreviousBatchEvaluationPolicyDigests} : {}),
    ...(input.qmdBinding ? { qmdBinding: input.qmdBinding } : {}),
  };
  return { ...input, policyDigest: sha256(policyBase as unknown as JsonValue) };
}

export type DailyNoteConsumerQueueRecordV1 = {
  schema: "engram.memory-observation-consumer-queue.v1";
  consumer: "daily-note";
  observationId: Digest;
  traceId: Digest;
  status: "queued" | "claimed" | "qmd_pending" | "terminal";
  attempt: number;
  maxAttempts: number;
  createdAt: string;
  updatedAt: string;
  claimedAt: string | null;
  claimToken: string | null;
  terminalAt: string | null;
  reasonCode: string | null;
  phase?: "apply" | "qmd";
  qmdAttempt?: number;
  nextAttemptAt?: string | null;
};

export type MemoryApplyReceiptV1 = {
  schema: "engram.memory-apply-receipt.v1";
  receiptId: Digest;
  traceId: Digest;
  sourceObservationRef: Digest;
  sourceCompletedAt: string;
  scope: ObservationScope;
  producer: ProducerRef;
  sourceProvenance: {
    sourceTurnId: string;
    producer: ProducerRef;
    observationClass: EpisodicObservationV1["observationClass"];
    evidenceRefs: EpisodicObservationV1["evidenceRefs"];
    observationDigest: Digest;
    batchSourceRefs?: BatchObservationV1["sourceRefs"];
    batchCitations?: BatchObservationV1["citations"];
    batchEvaluationPolicyDigest?: Digest;
  };
  consumer: "daily-note";
  operationId: Digest;
  destinationDate: string;
  destinationRef: string;
  destinationEntryId: Digest;
  status: "applied";
  canonicalMutation: true;
  readBackDigest: Digest;
  policyDigest: Digest;
  qmdBinding?: ResolvedDailyNoteQmdBinding;
  completedAt: string;
};

export type DailyNoteApplicatorResult =
  | { status: "idle" | "busy" | "disabled" }
  | { status: "applied" | "duplicate"; traceId: Digest; receipt: MemoryApplyReceiptV1 }
  | { status: "retry" | "terminal_failure"; traceId: Digest; reason: string }
  | { status: "qmd_pending"; traceId: Digest; reason: string; nextAttemptAt: string };

export type DailyNoteApplicatorFaultPoint =
  | "after_queue"
  | "after_claim"
  | "after_note_write"
  | "after_receipt_primary"
  | "after_receipt"
  | "after_dirty_mark"
  | "after_index_handoff"
  | "after_trace";

const ROOT_SEGMENTS = ["memory-state", "memory-observation", "v1"] as const;
const QUEUE_SCHEMA = "engram.memory-observation-consumer-queue.v1" as const;
const RECEIPT_SCHEMA = "engram.memory-apply-receipt.v1" as const;
const TRACE_SCHEMA = "engram.memory-trace-event.v1" as const;
const LOCK_STALE_MS = 30_000;
const MAX_ATTEMPTS = 3;
const QMD_RETRY_BASE_MS = 30_000;
const QMD_RETRY_MAX_MS = 30 * 60_000;

type DirtyMarker = (input: MarkWorkspaceQmdDirtyInput) => Promise<WorkspaceDirtyMarkResult>;
type QmdBindingResolver = (input: {
  workspace: string;
  runtimeSessionKey: string;
  timezone: string;
  destinationAt: string;
  resolver: MemoryObservationQmdResolverV1;
}) => ResolvedDailyNoteQmdBinding;

export class DailyNoteApplicatorError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "DailyNoteApplicatorError";
  }
}

function canonical(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const row = value as Record<string, JsonValue>;
  return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${canonical(row[key])}`).join(",")}}`;
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return canonical(left as JsonValue) === canonical(right as JsonValue);
}

function digestKey(value: Digest): string {
  if (!/^sha256:[a-f0-9]{64}$/.test(value)) throw new DailyNoteApplicatorError("INVALID_DIGEST", "digest is invalid");
  return value.slice("sha256:".length);
}

function readJson<T>(path: string): T {
  try { return JSON.parse(readFileSync(path, "utf8")) as T; }
  catch { throw new DailyNoteApplicatorError("STATE_CORRUPT", `invalid JSON state: ${path}`); }
}

function flushDirectory(path: string): void {
  if (process.platform === "win32") return;
  const descriptor = openSync(path, "r");
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function writeAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const descriptor = openSync(temp, "wx", 0o600);
  try { writeFileSync(descriptor, content, "utf8"); fsyncSync(descriptor); }
  finally { closeSync(descriptor); }
  renameSync(temp, path);
  flushDirectory(dirname(path));
}

function writeImmutable(path: string, value: unknown): boolean {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const descriptor = openSync(temp, "wx", 0o600);
  try { writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8"); fsyncSync(descriptor); }
  finally { closeSync(descriptor); }
  try {
    if (process.platform === "win32") {
      const target = openSync(path, "wx", 0o600);
      try { writeFileSync(target, readFileSync(temp)); fsyncSync(target); }
      finally { closeSync(target); }
    } else {
      linkSync(temp, path);
    }
  }
  catch (error: any) {
    unlinkSync(temp);
    if (error?.code === "EEXIST") return false;
    throw error;
  }
  unlinkSync(temp);
  flushDirectory(dirname(path));
  return true;
}

function validInstant(value: string): boolean {
  return Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function sameScope(left: ObservationScope, right: ObservationScope): boolean {
  return left.workspaceId === right.workspaceId
    && left.runtimeSessionKey === right.runtimeSessionKey
    && left.scopeClass === right.scopeClass
    && left.scopeId === right.scopeId;
}

function allowsObservationClass(policy: DailyNoteCanaryPolicy, value: DailyNoteObservation["observationClass"]): boolean {
  return policy.allowedObservationClasses.some((entry) => entry === value);
}

function allowsObservationPolicy(policy: DailyNoteCanaryPolicy, observation: DailyNoteObservation): boolean {
  if (observation.schema === "engram.memory-observation.v1") return true;
  if (observation.schema === CONTEXTUAL_BATCH_SCHEMA && !policy.allowContextualObservations) return false;
  return policy.allowedBatchEvaluationPolicyDigest === observation.evaluationPolicyDigest
    || (policy.allowedPreviousBatchEvaluationPolicyDigests ?? []).includes(observation.evaluationPolicyDigest);
}

function dateInTimezone(instant: string, timezone: string): string {
  try {
    return new Intl.DateTimeFormat("sv-SE", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(instant));
  } catch {
    throw new DailyNoteApplicatorError("INVALID_TIMEZONE", "daily-note canary timezone is invalid");
  }
}

function noteTemplate(date: string): string {
  return `# ${date}\n\n## Events\n\n## Decisions\n\n## Learnings\n\n## Active Threads\n\n## Next\n`;
}

export function renderDailyNoteEntry(observation: DailyNoteObservation, destinationEntryId: Digest): string {
  if (observation.schema === CONTEXTUAL_BATCH_SCHEMA) return `<!-- engram-entry:${destinationEntryId} -->\n${renderContextualBatch(observation)}`;
  const textLines = observation.payload.text.split(/\r?\n/);
  const bullet = [`- ${textLines[0]}`, ...textLines.slice(1).map((line) => `  ${line}`)].join("\n");
  return `<!-- engram-entry:${destinationEntryId} -->\n${bullet}`;
}

function insertEntry(content: string, section: "Events" | "Decisions", rendered: string): string {
  const lines = content.split("\n");
  const header = `## ${section}`;
  const sectionIndex = lines.findIndex((line) => line.trim() === header);
  if (sectionIndex < 0) throw new DailyNoteApplicatorError("DESTINATION_INVALID", `${header} is missing from daily note`);
  let sectionEnd = sectionIndex + 1;
  while (sectionEnd < lines.length && !/^## /.test(lines[sectionEnd]!) && !/^<!-- extracted:/.test(lines[sectionEnd]!)) sectionEnd++;
  let lastContent = sectionIndex;
  for (let index = sectionIndex + 1; index < sectionEnd; index++) {
    if (lines[index]!.trim()) lastContent = index;
  }
  lines.splice(lastContent + 1, 0, ...rendered.split("\n"));
  return lines.join("\n");
}

export function validateDailyNoteObservation(observation: DailyNoteObservation): void {
  if (observation.schema !== "engram.memory-observation.v1") {
    validateReadableBatchObservation(observation);
    return;
  }
  const { observationDigest, ...base } = observation;
  const validDestination = (observation.observationClass === "episodic.event" && observation.payload?.section === "events")
    || (observation.observationClass === "episodic.decision" && observation.payload?.section === "decisions");
  if (observation.schema !== "engram.memory-observation.v1"
    || observation.targetConsumer !== "daily-note"
    || !validDestination
    || !validInstant(observation.sourceCompletedAt)
    || !validInstant(observation.completedAt)
    || observation.producer.id !== "post-turn-observer"
    || observation.producer.version !== "v1"
    || observation.producer.digest !== "sha256:d4f0bf349ea08594fbd3a72f1e6f05ea5dda32800422c1e2cefbc434552cd406"
    || sha256(base as unknown as JsonValue) !== observationDigest) {
    throw new DailyNoteApplicatorError("OBSERVATION_DENIED", "typed observation is invalid or outside the daily-note canary contract");
  }
}

function primaryTraceId(observation: DailyNoteObservation): Digest {
  return observation.schema !== "engram.memory-observation.v1"
    ? observation.sourceRefs[0]!.traceId
    : observation.traceId;
}

function sourceTurnId(observation: DailyNoteObservation): string {
  return observation.schema !== "engram.memory-observation.v1"
    ? observation.sourceRefs[0]!.sourceTurnId
    : observation.sourceTurnId;
}

function evidenceRefs(observation: DailyNoteObservation): EpisodicObservationV1["evidenceRefs"] {
  return observation.schema !== "engram.memory-observation.v1"
    ? observation.citations.map((citation) => citation.evidenceRef).slice(0, 8)
    : observation.evidenceRefs;
}

export class DailyNoteCanaryApplicator {
  readonly workspace: string;
  readonly root: string;
  private readonly resolveActivePolicy: () => DailyNoteCanaryPolicy | null;
  private readonly fault?: (point: DailyNoteApplicatorFaultPoint) => void;
  private readonly dirtyMarker: DirtyMarker;
  private readonly qmdBindingResolver: QmdBindingResolver;

  constructor(options: {
    workspace: string;
    resolveActivePolicy: () => DailyNoteCanaryPolicy | null;
    fault?: (point: DailyNoteApplicatorFaultPoint) => void;
    dirtyMarker?: DirtyMarker;
    qmdBindingResolver?: QmdBindingResolver;
  }) {
    this.workspace = resolve(options.workspace);
    this.root = join(this.workspace, ...ROOT_SEGMENTS);
    this.resolveActivePolicy = options.resolveActivePolicy;
    this.fault = options.fault;
    this.dirtyMarker = options.dirtyMarker ?? markWorkspaceQmdDirty;
    this.qmdBindingResolver = options.qmdBindingResolver ?? ((input) => resolveCanaryQmdRuntimeBinding({
      ...input,
      context: resolveQmdContext({ value: input.workspace, source: "explicit" }),
    }));
  }

  reconcile(now = new Date()): number {
    const policy = this.resolveActivePolicy();
    if (!policy) return 0;
    let created = 0;
    for (const observation of this.listObservations()) {
      if (Date.parse(observation.completedAt) < Date.parse(policy.applyAfter)
        || !sameScope(observation.scope, policy.exactScope)
        || !allowsObservationClass(policy, observation.observationClass)
        || !allowsObservationPolicy(policy, observation)) continue;
      validateDailyNoteObservation(observation);
      const path = this.queuePath(observation.observationId);
      if (existsSync(path)) continue;
      const queue: DailyNoteConsumerQueueRecordV1 = {
        schema: QUEUE_SCHEMA,
        consumer: "daily-note",
        observationId: observation.observationId,
        traceId: primaryTraceId(observation),
        status: "queued",
        attempt: 0,
        maxAttempts: MAX_ATTEMPTS,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        claimedAt: null,
        claimToken: null,
        terminalAt: null,
        reasonCode: null,
      };
      if (writeImmutable(path, queue)) { created++; this.fault?.("after_queue"); }
    }
    return created;
  }

  async processOne(now = new Date()): Promise<DailyNoteApplicatorResult> {
    const policy = this.resolveActivePolicy();
    if (!policy) return { status: "disabled" };
    this.reconcile(now);
    const leaseToken = randomUUID();
    if (!this.acquireLease(leaseToken, now)) return { status: "busy" };
    let claimed: DailyNoteConsumerQueueRecordV1 | null = null;
    try {
      this.reconcileSuperseded(policy, now);
      claimed = this.claimNext(policy, now);
      if (!claimed) return { status: "idle" };
      this.fault?.("after_claim");
      return await this.applyClaimed(claimed, leaseToken, now);
    } catch (error) {
      if (!claimed) throw error;
      return this.failClaim(claimed, error, now);
    } finally {
      this.releaseLease(leaseToken);
    }
  }

  nextDueAt(): Date | null {
    const policy = this.resolveActivePolicy();
    if (!policy) return null;
    const queued = this.listQueue()
      .filter((record) => (record.status === "queued"
        && (this.queueMatchesPolicy(record, policy) || this.queueNeedsSupersededDisposition(record, policy)))
        || (record.status === "qmd_pending"
          && (this.queueMatchesPolicy(record, policy) || this.queueNeedsSupersededDisposition(record, policy))))
      .map((record) => ({
        record,
        dueAt: record.status === "qmd_pending" ? (record.nextAttemptAt ?? record.updatedAt) : record.updatedAt,
      }))
      .sort((left, right) => left.dueAt.localeCompare(right.dueAt)
        || left.record.createdAt.localeCompare(right.record.createdAt))[0];
    return queued ? new Date(queued.dueAt) : null;
  }

  readReceipt(observationId: Digest): MemoryApplyReceiptV1 | null {
    const destinationEntryId = this.destinationEntryId(observationId);
    const operationId = sha256(`engram.memory-apply.v1\0daily-note\0${observationId}\0${destinationEntryId}`);
    const operationPath = this.receiptByOperationPath(operationId);
    const entryPath = this.receiptByEntryPath(destinationEntryId);
    const byOperation = existsSync(operationPath) ? readJson<MemoryApplyReceiptV1>(operationPath) : null;
    const byEntry = existsSync(entryPath) ? readJson<MemoryApplyReceiptV1>(entryPath) : null;
    if (byOperation && byEntry && !jsonEqual(byOperation, byEntry)) {
      throw new DailyNoteApplicatorError("CONTENT_CONFLICT", "receipt aliases contain different content");
    }
    return byOperation ?? byEntry;
  }

  listQueue(): DailyNoteConsumerQueueRecordV1[] {
    const directory = join(this.root, "consumers", "daily-note", "queue");
    if (!existsSync(directory)) return [];
    return readdirSync(directory).filter((name) => name.endsWith(".json"))
      .map((name) => readJson<DailyNoteConsumerQueueRecordV1>(join(directory, name)));
  }

  private async applyClaimed(claimed: DailyNoteConsumerQueueRecordV1, leaseToken: string, now: Date): Promise<DailyNoteApplicatorResult> {
    const observation = this.readObservation(claimed);
    validateDailyNoteObservation(observation);
    const activePolicy = this.resolveActivePolicy();
    if (!activePolicy) return this.requeue(claimed, "kill_switch_open", now);
    if (Date.parse(observation.completedAt) < Date.parse(activePolicy.applyAfter)
      || !sameScope(observation.scope, activePolicy.exactScope)
      || !allowsObservationClass(activePolicy, observation.observationClass)
      || !allowsObservationPolicy(activePolicy, observation)) {
      throw new DailyNoteApplicatorError("POLICY_DENIED", "observation is outside the current apply-time policy");
    }
    const policy = this.resolveEffectivePolicy(activePolicy, observation);

    const split = splitCanonicalSessionKey(observation.scope.runtimeSessionKey);
    if (!split) throw new DailyNoteApplicatorError("SESSION_INVALID", "runtime session key cannot map to a daily-note partition");
    const destinationDate = dateInTimezone(observation.sourceCompletedAt, policy.timezone);
    const notePath = join(this.workspace, "memory", `agent-${split.agentId}`, split.sessionKey, `${destinationDate}.md`);
    if (policy.qmdBinding && "bindingDigest" in policy.qmdBinding
      && resolve(dirname(notePath)) !== resolve(policy.qmdBinding.canonicalRoot)) {
      throw new DailyNoteApplicatorError("QMD_BINDING_UNAVAILABLE", "canonical destination is outside the exact QMD binding root");
    }
    const destinationEntryId = this.destinationEntryId(observation.observationId);
    const operationId = sha256(`engram.memory-apply.v1\0daily-note\0${observation.observationId}\0${destinationEntryId}`);
    const existingReceipt = this.readReceipt(observation.observationId);
    if (existingReceipt) {
      this.validateReceipt(existingReceipt, observation, operationId, destinationEntryId, policy);
      this.persistReceipt(existingReceipt);
      await this.completeAfterReceipt(claimed, observation, existingReceipt, policy, now, "duplicate_receipt");
      return { status: "duplicate", traceId: primaryTraceId(observation), receipt: existingReceipt };
    }

    return withDailyNoteLock(notePath, async () => {
      this.assertLease(leaseToken, now);
      const currentActivePolicy = this.resolveActivePolicy();
      if (!currentActivePolicy) {
        return this.requeue(claimed, "kill_switch_or_policy_changed", now);
      }
      const currentPolicy = this.resolveEffectivePolicy(currentActivePolicy, observation);
      if (currentPolicy.policyDigest !== policy.policyDigest) return this.requeue(claimed, "kill_switch_or_policy_changed", now);
      const rendered = renderDailyNoteEntry(observation, destinationEntryId);
      const currentContent = existsSync(notePath) ? readFileSync(notePath, "utf8") : noteTemplate(destinationDate);
      const anchor = `<!-- engram-entry:${destinationEntryId} -->`;
      if (currentContent.includes(anchor)) {
        if (!currentContent.includes(rendered)) throw new DailyNoteApplicatorError("CONTENT_CONFLICT", "daily-note anchor has different content");
      } else {
        const destinationSection = observation.observationClass === "episodic.decision" ? "Decisions" : "Events";
        writeAtomic(notePath, insertEntry(currentContent, destinationSection, rendered));
        this.fault?.("after_note_write");
      }
      const readBack = readFileSync(notePath, "utf8");
      if (!readBack.includes(rendered) || readBack.split(anchor).length !== 2) {
        throw new DailyNoteApplicatorError("READ_BACK_FAILED", "daily-note entry read-back failed");
      }
      const readBackDigest = sha256(rendered);
      const destinationRef = `${relative(this.workspace, notePath)}#engram-entry:${destinationEntryId}`;
      const receiptBase = {
        schema: RECEIPT_SCHEMA,
        traceId: primaryTraceId(observation),
        sourceObservationRef: observation.observationId,
        sourceCompletedAt: observation.sourceCompletedAt,
        scope: observation.scope,
        producer: DAILY_NOTE_APPLICATOR,
        sourceProvenance: {
          sourceTurnId: sourceTurnId(observation),
          producer: observation.producer,
          observationClass: observation.observationClass,
          evidenceRefs: evidenceRefs(observation),
          observationDigest: observation.observationDigest,
          ...(observation.schema !== "engram.memory-observation.v1"
            ? {
                batchSourceRefs: observation.sourceRefs,
                batchCitations: observation.citations,
                batchEvaluationPolicyDigest: observation.evaluationPolicyDigest,
              }
            : {}),
        },
        consumer: "daily-note" as const,
        operationId,
        destinationDate,
        destinationRef,
        destinationEntryId,
        status: "applied" as const,
        canonicalMutation: true as const,
        readBackDigest,
        policyDigest: policy.policyDigest,
        ...(policy.qmdBinding && "bindingDigest" in policy.qmdBinding
          ? { qmdBinding: policy.qmdBinding }
          : {}),
        completedAt: now.toISOString(),
      };
      const receipt: MemoryApplyReceiptV1 = {
        ...receiptBase,
        receiptId: sha256(`engram.memory-apply-receipt.v1\0${operationId}`),
      };
      this.persistReceipt(receipt);
      this.fault?.("after_receipt");
      await this.completeAfterReceipt(claimed, observation, receipt, currentPolicy, now, "canonical_applied");
      return { status: "applied", traceId: primaryTraceId(observation), receipt };
    });
  }

  private async completeAfterReceipt(
    claimed: DailyNoteConsumerQueueRecordV1,
    observation: DailyNoteObservation,
    receipt: MemoryApplyReceiptV1,
    policy: DailyNoteCanaryPolicy,
    now: Date,
    terminalReason: "canonical_applied" | "duplicate_receipt",
  ): Promise<void> {
    const activePolicy = this.resolveActivePolicy();
    if (!activePolicy) throw new DailyNoteApplicatorError("QMD_BINDING_UNAVAILABLE", "daily-note policy became unavailable before QMD handoff");
    const verifiedPolicy = this.resolveEffectivePolicy(activePolicy, observation);
    if (verifiedPolicy.policyDigest !== policy.policyDigest) {
      throw new DailyNoteApplicatorError("QMD_BINDING_UNAVAILABLE", "exact-session QMD binding changed before handoff");
    }
    if (verifiedPolicy.qmdBinding) {
      let collection: string;
      let expectedIndexKey: string | undefined;
      if ("resolver" in verifiedPolicy.qmdBinding) throw new DailyNoteApplicatorError("QMD_BINDING_UNAVAILABLE", "QMD resolver was not normalized");
      collection = verifiedPolicy.qmdBinding.collection;
      expectedIndexKey = "indexKey" in verifiedPolicy.qmdBinding ? verifiedPolicy.qmdBinding.indexKey : undefined;
      if (!readIndexHandoff(this.workspace, receipt.receiptId)) {
        let dirty: WorkspaceDirtyMarkResult;
        try {
          dirty = await this.dirtyMarker({
            workspace: this.workspace,
            reason: `memory-observation:index-handoff:${receipt.receiptId}`,
            collections: [collection],
            bm25: true,
            vectors: true,
            ...(expectedIndexKey ? { expectedIndexKey } : {}),
          });
        } catch (error) {
          throw new DailyNoteApplicatorError(
            "QMD_DIRTY_MARK_FAILED",
            error instanceof Error ? error.message : String(error),
          );
        }
        if (dirty.status !== "marked"
          || dirty.collections?.length !== 1
          || dirty.collections[0] !== collection
          || (expectedIndexKey !== undefined && dirty.indexKey !== expectedIndexKey)) {
          throw new DailyNoteApplicatorError(
            "QMD_DIRTY_MARK_FAILED",
            dirty.error ?? `dirty marker returned ${dirty.status} for an unexpected collection`,
          );
        }
        this.fault?.("after_dirty_mark");
        try {
          storeIndexHandoff({
            workspace: this.workspace,
            applyReceipt: receipt,
            dirtyMark: dirty,
            ...(verifiedPolicy.qmdBinding && "bindingDigest" in verifiedPolicy.qmdBinding
              ? { bindingDigest: verifiedPolicy.qmdBinding.bindingDigest }
              : {}),
            recordedAt: now.toISOString(),
          });
        } catch (error) {
          throw new DailyNoteApplicatorError(
            "QMD_DIRTY_MARK_FAILED",
            error instanceof Error ? error.message : String(error),
          );
        }
        this.fault?.("after_index_handoff");
      }
    }
    this.persistCanonicalTrace(receipt, observation);
    this.fault?.("after_trace");
    this.finishQueue(claimed, terminalReason, now);
  }

  private resolveEffectivePolicy(policy: DailyNoteCanaryPolicy, observation: DailyNoteObservation): DailyNoteCanaryPolicy {
    if (!policy.qmdBinding || !("resolver" in policy.qmdBinding)) return policy;
    let resolvedBinding: ResolvedDailyNoteQmdBinding;
    try {
      resolvedBinding = this.qmdBindingResolver({
        workspace: this.workspace,
        runtimeSessionKey: observation.scope.runtimeSessionKey,
        timezone: policy.timezone,
        destinationAt: observation.sourceCompletedAt,
        resolver: policy.qmdBinding,
      });
    } catch {
      throw new DailyNoteApplicatorError("QMD_BINDING_UNAVAILABLE", "exact-session QMD binding is unavailable");
    }
    const { policyDigest: _oldDigest, ...base } = policy;
    return buildDailyNoteCanaryPolicy({
      ...base,
      qmdBinding: { ...resolvedBinding },
    });
  }

  private persistReceipt(receipt: MemoryApplyReceiptV1): void {
    const operationPath = this.receiptByOperationPath(receipt.operationId);
    const operationPublished = writeImmutable(operationPath, receipt);
    if (!operationPublished && !jsonEqual(readJson<MemoryApplyReceiptV1>(operationPath), receipt)) {
      throw new DailyNoteApplicatorError("CONTENT_CONFLICT", "apply receipt identity has different content");
    }
    if (operationPublished) this.fault?.("after_receipt_primary");
    const entryPath = this.receiptByEntryPath(receipt.destinationEntryId);
    if (!writeImmutable(entryPath, receipt) && !jsonEqual(readJson<MemoryApplyReceiptV1>(entryPath), receipt)) {
      throw new DailyNoteApplicatorError("CONTENT_CONFLICT", "apply receipt identity has different content");
    }
  }

  private persistCanonicalTrace(receipt: MemoryApplyReceiptV1, observation: DailyNoteObservation): void {
    const traceId = primaryTraceId(observation);
    const eventId = sha256(`engram.memory-trace-event.v1\0${traceId}\0canonical_applied\0${receipt.readBackDigest}`);
    const event = {
      schema: TRACE_SCHEMA,
      eventId,
      traceId,
      stage: "canonical_applied",
      scope: observation.scope,
      producer: DAILY_NOTE_APPLICATOR,
      stageRef: { kind: "canonical-record", ref: receipt.destinationEntryId, digest: receipt.readBackDigest },
      recordedAt: receipt.completedAt,
      policyDigest: receipt.policyDigest,
      reasonCode: "daily_note_canary_applied",
      verification: null,
    };
    const path = join(this.root, "traces", digestKey(traceId), `${digestKey(eventId)}.json`);
    if (!writeImmutable(path, event) && !jsonEqual(readJson(path), event)) {
      throw new DailyNoteApplicatorError("CONTENT_CONFLICT", "canonical trace identity has different content");
    }
  }

  private validateReceipt(
    receipt: MemoryApplyReceiptV1,
    observation: DailyNoteObservation,
    operationId: Digest,
    destinationEntryId: Digest,
    policy: DailyNoteCanaryPolicy,
  ): void {
    const destinationPath = resolve(this.workspace, receipt.destinationRef.split("#", 1)[0]!);
    const currentBinding = policy.qmdBinding && "bindingDigest" in policy.qmdBinding ? policy.qmdBinding : null;
    const receiptBinding = receipt.qmdBinding ?? null;
    const validReceiptBinding = Boolean(receiptBinding
      && receiptBinding.bindingDigest === sha256([
        "engram.memory-observation-qmd-binding.v1",
        receiptBinding.workspaceRegistryDigest,
        receiptBinding.indexName,
        receiptBinding.indexKey,
        receiptBinding.collection,
        receiptBinding.canonicalRoot,
        observation.scope.runtimeSessionKey,
      ].join("\0"))
      && resolve(receiptBinding.canonicalRoot) === resolve(dirname(destinationPath)));
    if ((receiptBinding && !validReceiptBinding) || (currentBinding && !receiptBinding)) {
      throw new DailyNoteApplicatorError("CONTENT_CONFLICT", "persisted apply receipt has an invalid QMD binding");
    }
    const driftRecoveryAllowed = Boolean(currentBinding
      && validReceiptBinding
      && resolve(currentBinding.canonicalRoot) === resolve(receiptBinding!.canonicalRoot));
    if (receipt.policyDigest !== policy.policyDigest && currentBinding && validReceiptBinding && !driftRecoveryAllowed) {
      throw new DailyNoteApplicatorError("QMD_BINDING_UNAVAILABLE", "persisted apply receipt belongs to a different exact QMD root");
    }
    if (receipt.schema !== RECEIPT_SCHEMA
      || receipt.traceId !== primaryTraceId(observation)
      || receipt.sourceObservationRef !== observation.observationId
      || receipt.operationId !== operationId
      || receipt.destinationEntryId !== destinationEntryId
      || (receipt.policyDigest !== policy.policyDigest && !driftRecoveryAllowed)
      || receipt.status !== "applied"
      || receipt.canonicalMutation !== true
      || receipt.readBackDigest !== sha256(renderDailyNoteEntry(observation, destinationEntryId))
      || receipt.receiptId !== sha256(`engram.memory-apply-receipt.v1\0${operationId}`)) {
      throw new DailyNoteApplicatorError("CONTENT_CONFLICT", "persisted apply receipt is invalid");
    }
    const relativeDestination = relative(this.workspace, destinationPath);
    if (relativeDestination === ".." || relativeDestination.startsWith(`..${pathSeparator}`) || isAbsolute(relativeDestination)
      || !existsSync(destinationPath)
      || !readFileSync(destinationPath, "utf8").includes(renderDailyNoteEntry(observation, destinationEntryId))) {
      throw new DailyNoteApplicatorError("READ_BACK_FAILED", "persisted receipt destination no longer reads back");
    }
  }

  private claimNext(policy: DailyNoteCanaryPolicy, now: Date): DailyNoteConsumerQueueRecordV1 | null {
    this.recoverClaims(now);
    const selected = this.listQueue().filter((record) => (record.status === "queued"
      || (record.status === "qmd_pending" && Date.parse(record.nextAttemptAt ?? record.updatedAt) <= now.getTime()))
      && this.queueMatchesPolicy(record, policy))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.observationId.localeCompare(right.observationId))[0];
    if (!selected) return null;
    const claimed: DailyNoteConsumerQueueRecordV1 = {
      ...selected,
      status: "claimed",
      attempt: selected.attempt + 1,
      updatedAt: now.toISOString(),
      claimedAt: now.toISOString(),
      claimToken: randomUUID(),
      reasonCode: null,
      phase: selected.status === "qmd_pending" ? "qmd" : (selected.phase ?? "apply"),
    };
    writeAtomic(this.queuePath(claimed.observationId), `${JSON.stringify(claimed, null, 2)}\n`);
    return claimed;
  }

  private queueMatchesPolicy(record: DailyNoteConsumerQueueRecordV1, policy: DailyNoteCanaryPolicy): boolean {
    try {
      const observation = this.readObservation(record);
      return Date.parse(observation.completedAt) >= Date.parse(policy.applyAfter)
        && sameScope(observation.scope, policy.exactScope)
        && allowsObservationClass(policy, observation.observationClass)
        && allowsObservationPolicy(policy, observation);
    } catch {
      return false;
    }
  }

  private reconcileSuperseded(policy: DailyNoteCanaryPolicy, now: Date): void {
    for (const record of this.listQueue()) {
      if (this.queueNeedsSupersededDisposition(record, policy)) {
        this.finishQueue(record, "policy_superseded_before_apply", now);
      }
    }
  }

  private queueNeedsSupersededDisposition(record: DailyNoteConsumerQueueRecordV1, policy: DailyNoteCanaryPolicy): boolean {
    if (record.status !== "queued" && record.status !== "qmd_pending") return false;
    // Binding resolution can fail before the canonical write. Such work may
    // be superseded, but a receipt-backed handoff must never be discarded.
    if (record.status === "qmd_pending" && this.readReceipt(record.observationId)) return false;
    let observation: DailyNoteObservation;
    try { observation = this.readObservation(record); }
    catch { return false; }
    // On rollback, dual readers retain v2 work; a v1-only producer must not
    // silently retire a queued v2 result as a policy skip.
    if (observation.schema === CONTEXTUAL_BATCH_SCHEMA && !policy.allowContextualObservations) return false;
    const sameRuntimePartition = observation.scope.workspaceId === policy.exactScope.workspaceId
      && observation.scope.runtimeSessionKey === policy.exactScope.runtimeSessionKey;
    const predatesPolicy = sameRuntimePartition && Date.parse(observation.completedAt) < Date.parse(policy.applyAfter);
    const scopeWasRebound = sameRuntimePartition && !sameScope(observation.scope, policy.exactScope);
    const batchPolicyWasReplaced = sameRuntimePartition
      && observation.schema !== "engram.memory-observation.v1"
      && !allowsObservationPolicy(policy, observation);
    return predatesPolicy || scopeWasRebound || batchPolicyWasReplaced;
  }

  private recoverClaims(now: Date): void {
    for (const current of this.listQueue()) {
      if (current.status !== "claimed") continue;
      const recovered: DailyNoteConsumerQueueRecordV1 = {
        ...current,
        status: current.phase === "qmd" ? "qmd_pending" : "queued",
        updatedAt: now.toISOString(),
        claimedAt: null,
        claimToken: null,
        reasonCode: "worker_claim_recovered",
      };
      writeAtomic(this.queuePath(recovered.observationId), `${JSON.stringify(recovered, null, 2)}\n`);
    }
  }

  private requeue(claimed: DailyNoteConsumerQueueRecordV1, reasonCode: string, now: Date): DailyNoteApplicatorResult {
    const queued: DailyNoteConsumerQueueRecordV1 = {
      ...claimed,
      status: "queued",
      updatedAt: now.toISOString(),
      claimedAt: null,
      claimToken: null,
      reasonCode,
      nextAttemptAt: null,
    };
    writeAtomic(this.queuePath(queued.observationId), `${JSON.stringify(queued, null, 2)}\n`);
    return { status: "disabled" };
  }

  private finishQueue(claimed: DailyNoteConsumerQueueRecordV1, reasonCode: string, now: Date): void {
    const terminal: DailyNoteConsumerQueueRecordV1 = {
      ...claimed,
      status: "terminal",
      updatedAt: now.toISOString(),
      claimedAt: null,
      claimToken: null,
      terminalAt: now.toISOString(),
      reasonCode,
      nextAttemptAt: null,
    };
    writeAtomic(this.queuePath(terminal.observationId), `${JSON.stringify(terminal, null, 2)}\n`);
  }

  private failClaim(claimed: DailyNoteConsumerQueueRecordV1, error: unknown, now: Date): DailyNoteApplicatorResult {
    const reason = error instanceof DailyNoteApplicatorError ? error.code : "APPLY_FAILED";
    if (reason === "QMD_DIRTY_MARK_FAILED" || reason === "QMD_BINDING_UNAVAILABLE") {
      const qmdAttempt = (claimed.qmdAttempt ?? 0) + 1;
      const delayMs = Math.min(QMD_RETRY_BASE_MS * (2 ** Math.min(qmdAttempt - 1, 10)), QMD_RETRY_MAX_MS);
      const nextAttemptAt = new Date(now.getTime() + delayMs).toISOString();
      const pending: DailyNoteConsumerQueueRecordV1 = {
        ...claimed,
        status: "qmd_pending",
        updatedAt: now.toISOString(),
        claimedAt: null,
        claimToken: null,
        terminalAt: null,
        reasonCode: reason === "QMD_BINDING_UNAVAILABLE" ? "qmd_binding_unavailable" : "qmd_dirty_mark_failed",
        phase: "qmd",
        qmdAttempt,
        nextAttemptAt,
      };
      writeAtomic(this.queuePath(pending.observationId), `${JSON.stringify(pending, null, 2)}\n`);
      return { status: "qmd_pending", traceId: claimed.traceId, reason, nextAttemptAt };
    }
    if (claimed.attempt >= claimed.maxAttempts) {
      this.finishQueue(claimed, `terminal_${reason.toLowerCase()}`, now);
      return { status: "terminal_failure", traceId: claimed.traceId, reason };
    }
    const queued: DailyNoteConsumerQueueRecordV1 = {
      ...claimed,
      status: "queued",
      updatedAt: now.toISOString(),
      claimedAt: null,
      claimToken: null,
      reasonCode: `retry_${reason.toLowerCase()}`,
    };
    writeAtomic(this.queuePath(queued.observationId), `${JSON.stringify(queued, null, 2)}\n`);
    return { status: "retry", traceId: claimed.traceId, reason };
  }

  private listObservations(): DailyNoteObservation[] {
    const sources: Array<{ directory: string; schema: "single" | "batch" }> = [
      { directory: join(this.root, "observations", "typed"), schema: "single" },
      { directory: join(this.root, "observations", "batch"), schema: "batch" },
    ];
    return sources.flatMap(({ directory, schema }) => existsSync(directory)
      ? readdirSync(directory).filter((name) => name.endsWith(".json")).sort()
        .map((name) => schema === "single"
          ? readJson<EpisodicObservationV1>(join(directory, name))
          : readJson<ReadableBatchObservation>(join(directory, name)))
      : []);
  }

  private readObservation(claimed: DailyNoteConsumerQueueRecordV1): DailyNoteObservation {
    const batchPath = join(this.root, "observations", "batch", `${digestKey(claimed.observationId)}.json`);
    if (existsSync(batchPath)) return readJson<ReadableBatchObservation>(batchPath);
    const path = join(this.root, "observations", "typed", `${digestKey(claimed.traceId)}.json`);
    if (!existsSync(path)) throw new DailyNoteApplicatorError("OBSERVATION_MISSING", "typed observation is unavailable");
    const observation = readJson<EpisodicObservationV1>(path);
    if (observation.observationId !== claimed.observationId) {
      throw new DailyNoteApplicatorError("OBSERVATION_MISSING", "consumer queue does not match the typed observation");
    }
    return observation;
  }

  private destinationEntryId(observationId: Digest): Digest {
    return sha256(`engram.daily-note-entry.v1\0${observationId}`);
  }

  private queuePath(observationId: Digest): string {
    return join(this.root, "consumers", "daily-note", "queue", `${digestKey(observationId)}.json`);
  }

  private receiptByOperationPath(operationId: Digest): string {
    return join(this.root, "receipts", "by-operation", `${digestKey(operationId)}.json`);
  }

  private receiptByEntryPath(destinationEntryId: Digest): string {
    return join(this.root, "receipts", "by-entry", `${digestKey(destinationEntryId)}.json`);
  }

  private acquireLease(ownerToken: string, now: Date): boolean {
    const lock = join(this.root, "locks", "daily-note-consumer.worker");
    mkdirSync(dirname(lock), { recursive: true, mode: 0o700 });
    try { mkdirSync(lock, { mode: 0o700 }); }
    catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
      const leasePath = join(lock, "lease.json");
      let stale = false;
      try { stale = Date.parse(readJson<{ expiresAt: string }>(leasePath).expiresAt) <= now.getTime(); }
      catch { stale = now.getTime() - statSync(lock).mtimeMs > LOCK_STALE_MS; }
      if (!stale) return false;
      rmSync(lock, { recursive: true, force: true });
      try { mkdirSync(lock, { mode: 0o700 }); }
      catch (retryError: any) { if (retryError?.code === "EEXIST") return false; throw retryError; }
    }
    writeAtomic(join(lock, "lease.json"), `${JSON.stringify({
      schema: "engram.memory-observation-worker-lease.v1",
      queueClass: "daily-note-consumer",
      ownerToken,
      acquiredAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + LOCK_STALE_MS).toISOString(),
    }, null, 2)}\n`);
    return true;
  }

  private releaseLease(ownerToken: string): void {
    const lock = join(this.root, "locks", "daily-note-consumer.worker");
    try {
      const lease = readJson<{ ownerToken: string }>(join(lock, "lease.json"));
      if (lease.ownerToken === ownerToken) rmSync(lock, { recursive: true, force: true });
    } catch { /* already released or fenced */ }
  }

  private assertLease(ownerToken: string, now: Date): void {
    const lease = readJson<{ ownerToken: string; expiresAt: string }>(join(this.root, "locks", "daily-note-consumer.worker", "lease.json"));
    if (lease.ownerToken !== ownerToken || Date.parse(lease.expiresAt) <= now.getTime()) {
      throw new DailyNoteApplicatorError("LEASE_LOST", "daily-note consumer lease is no longer current");
    }
  }

}
