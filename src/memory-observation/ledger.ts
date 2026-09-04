import { createHash, randomUUID } from "node:crypto";
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
import { dirname, join, resolve } from "node:path";

export type Digest = `sha256:${string}`;
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type ObservationScope = {
  workspaceId: string;
  runtimeSessionKey: string;
  scopeClass: "self" | "managers" | "company" | "project";
  scopeId: string;
};

export type ProducerRef = { id: string; version: string; digest: Digest };
export type EvidenceRef = { kind: "source-turn" | "message" | "approved-tool-outcome"; ref: string; digest: Digest };

export type TrustedCompletedTurn = {
  sourceTurnId: string;
  scope: ObservationScope;
  sourceCompletedAt: string;
  authority: ProducerRef;
  evidenceRefs: EvidenceRef[];
  redactedEvidence: JsonValue;
  trustedInputs: string[];
};

export type ObservationJobV1 = {
  schema: "engram.memory-observation-job.v1";
  traceId: Digest;
  sourceTurnId: string;
  scope: ObservationScope;
  sourceCompletedAt: string;
  sourceDigest: Digest;
  evidenceDigest: Digest;
  policyVersion: string;
  policyDigest: Digest;
  evidenceRefs: EvidenceRef[];
  authority: ProducerRef;
  admittedAt: string;
};

export type LedgerQueueRecordV1 = {
  schema: "engram.memory-observation-ledger-queue.v1";
  traceId: Digest;
  queueClass: "evaluator";
  status: "queued" | "claimed" | "terminal";
  attempt: number;
  maxAttempts: number;
  nextAttemptAt: string;
  createdAt: string;
  updatedAt: string;
  claimedAt: string | null;
  claimToken: string | null;
  terminalAt: string | null;
  reasonCode: string | null;
};

export type TraceEventV1 = {
  schema: "engram.memory-trace-event.v1";
  eventId: Digest;
  traceId: Digest;
  stage: "source_completed" | "observation_admitted" | "observation_skipped" | "batch_evaluation_terminal";
  scope: ObservationScope;
  producer: ProducerRef;
  stageRef: { kind: "source-turn" | "observation" | "batch-result"; ref: string; digest: Digest };
  recordedAt: string;
  policyDigest: Digest;
  reasonCode: string;
  verification: null;
};

export type EpisodicSection = "events" | "decisions";
export type EpisodicActorRef = "user" | "assistant" | "system";
export type EpisodicOutcomeStatus = "completed" | "in-progress" | "decided" | "corrected" | "failed" | "unknown";
export type EpisodicSkipReason = "noise" | "incomplete" | "already_captured" | "not_authoritative" | "insufficient_evidence";

export type EpisodicEvaluationDecision =
  | {
      decision: "write";
      section: EpisodicSection;
      text: string;
      actorRef: EpisodicActorRef;
      outcomeStatus: EpisodicOutcomeStatus;
      confidence: number;
      reasonCodes: string[];
      evidenceRefs: EvidenceRef[];
    }
  | { decision: "skip"; reason: EpisodicSkipReason };

export type EpisodicEvaluationCompletion = {
  traceId: Digest;
  decision: EpisodicEvaluationDecision;
  observation: EpisodicObservationV1 | null;
};

export type EpisodicObservationV1 = {
  schema: "engram.memory-observation.v1";
  observationId: Digest;
  traceId: Digest;
  sourceTurnId: string;
  scope: ObservationScope;
  producer: ProducerRef;
  observationClass: "episodic.event" | "episodic.decision";
  targetConsumer: "daily-note";
  payload: {
    section: EpisodicSection;
    text: string;
    actorRef: EpisodicActorRef;
    outcomeStatus: EpisodicOutcomeStatus;
  };
  evidenceRefs: EvidenceRef[];
  sourceCompletedAt: string;
  confidence: number;
  reasonCodes: string[];
  observationDigest: Digest;
  completedAt: string;
};

export type EvaluationEvidenceV1 = {
  envelope: ObservationJobV1;
  evidence: {
    schema: "engram.memory-evidence-envelope.v1";
    traceId: Digest;
    scope: ObservationScope;
    payload: JsonValue;
    createdAt: string;
    expiresAt: string;
  };
};

export type BatchEvaluationDispositionV1 = {
  traceId: Digest;
  decision: "write" | "skip" | "defer";
  reasonCode: string;
  observationRefs: Digest[];
};

type ProducerRegistry = {
  schema: string;
  producers: Array<ProducerRef & { authorityClass: string; artifactSchemas: string[]; observationClasses?: string[] }>;
};

type AuthorityPolicy = {
  schema: string;
  policyVersion: string;
  rules: Array<{
    artifactSchema: string;
    stage: string;
    allowedAuthorityClasses: string[];
    allowedProducerIds: string[];
    requiredTrustedInputs: string[];
  }>;
  defaultDecision: string;
};

export type LedgerLimits = {
  evidenceTtlMs: number;
  maxJobs: number;
  maxBytes: number;
  maxQueueAgeMs: number;
  maxAttempts: number;
  claimTtlMs: number;
  maxInferenceCalls: 0 | 1;
};

export type LedgerFaultPoint =
  | "after_evidence"
  | "after_envelope"
  | "after_queue"
  | "after_source_trace"
  | "after_typed_observation"
  | "after_evaluation_trace";

export class ObservationLedgerError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ObservationLedgerError";
  }
}

const ROOT_SEGMENTS = ["memory-state", "memory-observation", "v1"] as const;
const MAX_EVIDENCE_TTL_MS = 72 * 60 * 60 * 1_000;
const OBSERVATION_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const TRACE_RECEIPT_RETENTION_MS = 180 * 24 * 60 * 60 * 1_000;
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 5_000;
const SOURCE_SCHEMA = "engram.memory-observation-job.v1";
const AUTHORITY_SCHEMA = "engram.memory-authority-policy.v1";
const AUTHORITY_VERSION = "memory-observation-authority-v1";
const OBSERVATION_SCHEMA = "engram.memory-observation.v1";
const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,299}$/;
const SKIP_REASONS = new Set<EpisodicSkipReason>(["noise", "incomplete", "already_captured", "not_authoritative", "insufficient_evidence"]);
const OUTCOME_STATUSES = new Set<EpisodicOutcomeStatus>(["completed", "in-progress", "decided", "corrected", "failed", "unknown"]);
const ACTOR_REFS = new Set<EpisodicActorRef>(["user", "assistant", "system"]);
const BLOCKED_EVIDENCE_KEYS = new Set(["attachment", "attachments", "media", "rawtooloutcome", "rawtooloutcomes", "tooloutcome", "tooloutcomes"]);
const SENSITIVE_EVIDENCE_KEY = /(?:password|secret|credential|authorization|api[_-]?key|access[_-]?token|refresh[_-]?token)/i;

function redactSensitiveString(value: string): string {
  return value
    .replace(/-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)* PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\bBasic\s+[A-Za-z0-9+/=]{12,}/gi, "Basic [REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[REDACTED JWT]")
    .replace(/\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/g, "[REDACTED TELEGRAM TOKEN]")
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "[REDACTED GITHUB TOKEN]")
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "[REDACTED AWS ACCESS KEY]")
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, "[REDACTED SLACK TOKEN]")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED]")
    .replace(/\b(password|passwd|pwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token)\s*([:=])\s*([^\s,;]+)/gi, "$1$2[REDACTED]")
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)([^\s/@]+)(@)/gi, "$1[REDACTED]$3");
}

function canonical(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const row = value as Record<string, JsonValue>;
  return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${canonical(row[key])}`).join(",")}}`;
}

export function sanitizeEvidence(value: JsonValue, key = "root"): JsonValue {
  if (BLOCKED_EVIDENCE_KEYS.has(key.toLowerCase())) {
    throw new ObservationLedgerError("RAW_EVIDENCE_DENIED", `raw evidence field is denied: ${key}`);
  }
  if (SENSITIVE_EVIDENCE_KEY.test(key)) return "[REDACTED]";
  if (typeof value === "string") {
    return redactSensitiveString(value);
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ObservationLedgerError("INVALID_EVIDENCE", "evidence contains a non-finite number");
    return value;
  }
  if (Array.isArray(value)) return value.map((entry) => sanitizeEvidence(entry));
  const sanitized: Record<string, JsonValue> = {};
  for (const [childKey, childValue] of Object.entries(value)) sanitized[childKey] = sanitizeEvidence(childValue, childKey);
  return sanitized;
}

export function sha256(value: string | JsonValue): Digest {
  const input = typeof value === "string" ? value : canonical(value);
  return `sha256:${createHash("sha256").update(input).digest("hex")}`;
}

export function deriveTraceId(workspaceId: string, runtimeSessionKey: string, sourceTurnId: string): Digest {
  return sha256(`engram.memory-trace.v1\0${workspaceId}\0${runtimeSessionKey}\0${sourceTurnId}`);
}

export function deriveSourceDigest(sourceTurnId: string, scope: ObservationScope, sourceCompletedAt: string): Digest {
  return sha256({ sourceTurnId, scope, sourceCompletedAt } as unknown as JsonValue);
}

export function deriveTraceEventId(traceId: Digest, stage: string, stageRefDigest: Digest): Digest {
  return sha256(`engram.memory-trace-event.v1\0${traceId}\0${stage}\0${stageRefDigest}`);
}

export function deriveObservationId(traceId: Digest, producerId: string, observationClass: string): Digest {
  return sha256(`engram.memory-observation.v1\0${traceId}\0${producerId}\0${observationClass}`);
}

function digestKey(value: Digest): string {
  if (!/^sha256:[a-f0-9]{64}$/.test(value)) throw new ObservationLedgerError("INVALID_DIGEST", "digest is invalid");
  return value.slice("sha256:".length);
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readJson<T>(path: string): T {
  try { return JSON.parse(readFileSync(path, "utf8")) as T; }
  catch { throw new ObservationLedgerError("STATE_CORRUPT", `invalid JSON state: ${path}`); }
}

function flushDirectory(path: string): void {
  if (process.platform === "win32") return;
  const descriptor = openSync(path, "r");
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function writeAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const descriptor = openSync(temp, "wx", 0o600);
  try {
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fsyncSync(descriptor);
  } finally { closeSync(descriptor); }
  renameSync(temp, path);
  flushDirectory(dirname(path));
}

function writeImmutable(path: string, value: unknown): boolean {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const descriptor = openSync(temp, "wx", 0o600);
  try {
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fsyncSync(descriptor);
  } finally { closeSync(descriptor); }
  try { linkSync(temp, path); }
  catch (error: any) {
    unlinkSync(temp);
    if (error?.code === "EEXIST") return false;
    throw error;
  }
  unlinkSync(temp);
  flushDirectory(dirname(path));
  return true;
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return canonical(left as JsonValue) === canonical(right as JsonValue);
}

function validInstant(value: string): boolean {
  return Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function directoryBytes(path: string): number {
  if (!existsSync(path)) return 0;
  let total = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    total += entry.isDirectory() ? directoryBytes(child) : statSync(child).size;
  }
  return total;
}

export type MemoryObservationPurgeResult = {
  evidence: number;
  transportLinks: number;
  envelopes: number;
  observations: number;
  evaluatorQueue: number;
  consumerQueue: number;
  traces: number;
  receipts: number;
};

function lifecycleJson(path: string): Record<string, any> | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch { return null; }
}

function isExpired(value: unknown, cutoff: number): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && Date.parse(value) <= cutoff;
}

function withLifecycleLock<T>(root: string, operation: () => T): T {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const lock = join(root, "locks", "workspace-state");
  mkdirSync(dirname(lock), { recursive: true, mode: 0o700 });
  const started = Date.now();
  while (true) {
    try { mkdirSync(lock, { mode: 0o700 }); break; }
    catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
      let stale = false;
      try { stale = Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS; } catch { stale = false; }
      if (stale) { rmSync(lock, { recursive: true, force: true }); continue; }
      if (Date.now() - started >= LOCK_WAIT_MS) throw new ObservationLedgerError("LOCK_TIMEOUT", "workspace lifecycle lock timed out");
      sleepSync(20);
    }
  }
  try { return operation(); }
  finally { rmSync(lock, { recursive: true, force: true }); }
}

/** Purges only bounded v1 sidecars; corrupt records and canonical memory/KG are retained. */
export function purgeMemoryObservationLifecycle(workspace: string, now = new Date()): MemoryObservationPurgeResult {
  const root = join(resolve(workspace), ...ROOT_SEGMENTS);
  const result: MemoryObservationPurgeResult = { evidence: 0, transportLinks: 0, envelopes: 0, observations: 0, evaluatorQueue: 0, consumerQueue: 0, traces: 0, receipts: 0 };
  if (!existsSync(root)) return result;
  return withLifecycleLock(root, () => {
    const cutoff30 = now.getTime() - OBSERVATION_RETENTION_MS;
    const cutoff180 = now.getTime() - TRACE_RECEIPT_RETENTION_MS;
    const queueDir = join(root, "queues", "evaluator");
    const queues = new Map<string, Record<string, any>>();
    if (existsSync(queueDir)) for (const name of readdirSync(queueDir).filter((value) => value.endsWith(".json"))) {
      const record = lifecycleJson(join(queueDir, name));
      if (record?.schema === "engram.memory-observation-ledger-queue.v1") queues.set(name.slice(0, -5), record);
    }
    const consumerDir = join(root, "consumers", "daily-note", "queue");
    const consumers = new Map<string, Record<string, any>>();
    if (existsSync(consumerDir)) for (const name of readdirSync(consumerDir).filter((value) => value.endsWith(".json"))) {
      const record = lifecycleJson(join(consumerDir, name));
      if (record?.schema === "engram.memory-observation-consumer-queue.v1" && typeof record.observationId === "string") consumers.set(record.observationId.slice(7), record);
    }
    const oldTerminal = (record: Record<string, any> | undefined) => record?.status === "terminal" && isExpired(record.terminalAt, cutoff30);
    const purgeExpiresAt = (directory: string, counter: "evidence" | "transportLinks") => {
      if (!existsSync(directory)) return;
      let changed = false;
      for (const name of readdirSync(directory).filter((value) => value.endsWith(".json"))) {
        const path = join(directory, name);
        const record = lifecycleJson(path);
        if (!record || typeof record.expiresAt !== "string") continue;
        const expires = Date.parse(record.expiresAt);
        const created = Date.parse(record.createdAt);
        const deadline = Number.isFinite(created) ? Math.min(expires, created + MAX_EVIDENCE_TTL_MS) : expires;
        if (Number.isFinite(deadline) && deadline <= now.getTime()) { unlinkSync(path); result[counter]++; changed = true; }
      }
      if (changed) flushDirectory(directory);
    };
    purgeExpiresAt(join(root, "evidence"), "evidence");
    purgeExpiresAt(join(root, "transport-links"), "transportLinks");
    const envelopeDir = join(root, "envelopes");
    let envelopesChanged = false;
    if (existsSync(envelopeDir)) for (const name of readdirSync(envelopeDir).filter((value) => value.endsWith(".json"))) {
      if (oldTerminal(queues.get(name.slice(0, -5)))) { unlinkSync(join(envelopeDir, name)); result.envelopes++; envelopesChanged = true; }
    }
    if (envelopesChanged) flushDirectory(envelopeDir);
    const purgeObservations = (directory: string, batch: boolean) => {
      if (!existsSync(directory)) return;
      let changed = false;
      for (const name of readdirSync(directory).filter((value) => value.endsWith(".json"))) {
        const path = join(directory, name);
        const record = lifecycleJson(path);
        if (!record || typeof record.observationId !== "string") continue;
        const consumer = consumers.get(record.observationId.slice(7));
        const terminal = batch
          ? Array.isArray(record.sourceRefs) && record.sourceRefs.length > 0 && record.sourceRefs.every((source: any) => typeof source?.traceId === "string" && oldTerminal(queues.get(source.traceId.slice(7))))
          : oldTerminal(queues.get(name.slice(0, -5)));
        if (terminal && (!consumer || oldTerminal(consumer))) { unlinkSync(path); result.observations++; changed = true; }
      }
      if (changed) flushDirectory(directory);
    };
    purgeObservations(join(root, "observations", "typed"), false);
    purgeObservations(join(root, "observations", "batch"), true);
    let evaluatorChanged = false;
    for (const [key, record] of queues) if (oldTerminal(record)) { unlinkSync(join(queueDir, `${key}.json`)); result.evaluatorQueue++; evaluatorChanged = true; }
    if (evaluatorChanged) flushDirectory(queueDir);
    let consumerChanged = false;
    for (const [key, record] of consumers) if (oldTerminal(record)) { unlinkSync(join(consumerDir, `${key}.json`)); result.consumerQueue++; consumerChanged = true; }
    if (consumerChanged) flushDirectory(consumerDir);
    const tracesDir = join(root, "traces");
    if (existsSync(tracesDir)) for (const traceName of readdirSync(tracesDir)) {
      const directory = join(tracesDir, traceName);
      try {
        let changed = false;
        for (const name of readdirSync(directory).filter((value) => value.endsWith(".json"))) {
          const path = join(directory, name);
          const record = lifecycleJson(path);
          if (record && isExpired(record.recordedAt, cutoff180)) { unlinkSync(path); result.traces++; changed = true; }
        }
        if (changed) flushDirectory(directory);
        if (readdirSync(directory).length === 0) { rmSync(directory, { recursive: false, force: true }); flushDirectory(tracesDir); }
      } catch { /* retain unexpected entries */ }
    }
    for (const kind of ["by-operation", "by-entry"] as const) {
      const directory = join(root, "receipts", kind);
      if (!existsSync(directory)) continue;
      let changed = false;
      for (const name of readdirSync(directory).filter((value) => value.endsWith(".json"))) {
        const path = join(directory, name);
        const record = lifecycleJson(path);
        if (record && isExpired(record.completedAt, cutoff180)) { unlinkSync(path); result.receipts++; changed = true; }
      }
      if (changed) flushDirectory(directory);
    }
    return result;
  });
}

export class MemoryObservationLedger {
  readonly workspace: string;
  readonly workspaceId: string;
  readonly root: string;
  readonly limits: LedgerLimits;
  readonly evaluatorEnabled: boolean;
  private readonly exactSessionKeys: Set<string>;
  private readonly registry: ProducerRegistry;
  private readonly policy: AuthorityPolicy;
  private readonly policyDigest: Digest;
  private readonly evaluationStartedAt: number | null;
  private readonly fault?: (point: LedgerFaultPoint) => void;

  constructor(options: {
    workspace: string;
    workspaceId: string;
    exactSessionKeys: string[];
    producerRegistry: ProducerRegistry;
    authorityPolicy: AuthorityPolicy;
    limits: LedgerLimits;
    evaluatorEnabled?: boolean;
    evaluationStartedAt?: string;
    fault?: (point: LedgerFaultPoint) => void;
  }) {
    this.workspace = resolve(options.workspace);
    this.workspaceId = options.workspaceId;
    this.root = join(this.workspace, ...ROOT_SEGMENTS);
    this.exactSessionKeys = new Set(options.exactSessionKeys);
    this.registry = options.producerRegistry;
    this.policy = options.authorityPolicy;
    this.policyDigest = sha256(options.authorityPolicy as unknown as JsonValue);
    this.limits = options.limits;
    this.evaluatorEnabled = options.evaluatorEnabled ?? false;
    this.evaluationStartedAt = options.evaluationStartedAt ? Date.parse(options.evaluationStartedAt) : null;
    this.fault = options.fault;
    this.validateConfiguration();
  }

  admit(source: TrustedCompletedTurn, now = new Date()): { status: "admitted" | "duplicate"; envelope: ObservationJobV1 } {
    return this.withStateLock(() => {
      this.validateSource(source);
      const traceId = deriveTraceId(this.workspaceId, source.scope.runtimeSessionKey, source.sourceTurnId);
      const sanitizedEvidence = sanitizeEvidence(source.redactedEvidence);
      const evidencePath = this.evidencePath(traceId);
      const evidenceIdentity = {
        schema: "engram.memory-evidence-envelope.v1",
        traceId,
        scope: source.scope,
        payload: sanitizedEvidence,
      } as const;
      const evidenceDigest = sha256(evidenceIdentity as unknown as JsonValue);
      let evidenceRecord = {
        ...evidenceIdentity,
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + this.limits.evidenceTtlMs).toISOString(),
      };
      if (existsSync(evidencePath)) {
        const current = readJson<typeof evidenceRecord>(evidencePath);
        const currentIdentity = { schema: current.schema, traceId: current.traceId, scope: current.scope, payload: current.payload };
        if (sha256(currentIdentity as unknown as JsonValue) !== evidenceDigest) {
          throw new ObservationLedgerError("CONTENT_CONFLICT", "evidence identity has different content");
        }
        evidenceRecord = current;
      }
      const admittedAt = evidenceRecord.createdAt;
      const envelope: ObservationJobV1 = {
        schema: SOURCE_SCHEMA,
        traceId,
        sourceTurnId: source.sourceTurnId,
        scope: source.scope,
        sourceCompletedAt: source.sourceCompletedAt,
        sourceDigest: deriveSourceDigest(source.sourceTurnId, source.scope, source.sourceCompletedAt),
        evidenceDigest,
        policyVersion: this.policy.policyVersion,
        policyDigest: this.policyDigest,
        evidenceRefs: source.evidenceRefs,
        authority: source.authority,
        admittedAt,
      };
      const envelopePath = this.envelopePath(traceId);
      if (existsSync(envelopePath)) {
        const current = readJson<ObservationJobV1>(envelopePath);
        this.assertSameAdmission(current, envelope);
        this.repairAdmission(current, evidenceRecord);
        return { status: "duplicate", envelope: current };
      }
      this.assertCapacity(JSON.stringify(envelope).length + JSON.stringify(evidenceRecord).length, now);
      if (!writeImmutable(evidencePath, evidenceRecord)) {
        const current = readJson<typeof evidenceRecord>(evidencePath);
        if (!jsonEqual(current, evidenceRecord)) throw new ObservationLedgerError("CONTENT_CONFLICT", "evidence identity has different content");
      }
      this.fault?.("after_evidence");
      if (!writeImmutable(envelopePath, envelope)) {
        const current = readJson<ObservationJobV1>(envelopePath);
        this.assertSameAdmission(current, envelope);
      }
      this.fault?.("after_envelope");
      this.ensureQueue(envelope);
      this.fault?.("after_queue");
      this.ensureTrace(envelope, "source_completed");
      this.fault?.("after_source_trace");
      return { status: "admitted", envelope };
    });
  }

  reconcile(trustedCompletedTurns: TrustedCompletedTurn[], now = new Date()): { admitted: number; duplicate: number } {
    let admitted = 0;
    let duplicate = 0;
    for (const source of trustedCompletedTurns) {
      const result = this.admit(source, now);
      if (result.status === "admitted") admitted++; else duplicate++;
    }
    return { admitted, duplicate };
  }

  acquireWorkerLease(queueClass: "evaluator", ownerToken: string, ttlMs: number, now = new Date()): boolean {
    if (queueClass !== "evaluator" || !ownerToken || ttlMs < 1) throw new ObservationLedgerError("INVALID_LEASE", "worker lease is invalid");
    const lock = this.workerLockPath(queueClass);
    this.ensureRoot();
    try { mkdirSync(lock, { mode: 0o700 }); }
    catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
      const leasePath = join(lock, "lease.json");
      let expired = false;
      try { expired = Date.parse(readJson<{ expiresAt: string }>(leasePath).expiresAt) <= now.getTime(); }
      catch { expired = now.getTime() - statSync(lock).mtimeMs > ttlMs; }
      if (!expired) return false;
      rmSync(lock, { recursive: true, force: true });
      try { mkdirSync(lock, { mode: 0o700 }); }
      catch (retryError: any) { if (retryError?.code === "EEXIST") return false; throw retryError; }
    }
    writeAtomic(join(lock, "lease.json"), {
      schema: "engram.memory-observation-worker-lease.v1",
      queueClass,
      ownerToken,
      acquiredAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
    });
    return true;
  }

  releaseWorkerLease(queueClass: "evaluator", ownerToken: string): void {
    const lock = this.workerLockPath(queueClass);
    try {
      const current = readJson<{ ownerToken: string }>(join(lock, "lease.json"));
      if (current.ownerToken === ownerToken) rmSync(lock, { recursive: true, force: true });
    } catch { /* already released or fenced */ }
  }

  claimNextDue(ownerToken: string, now = new Date()): LedgerQueueRecordV1 | null {
    if (!this.evaluatorEnabled) return null;
    return this.withStateLock(() => {
      this.assertWorkerLease("evaluator", ownerToken, now);
      this.recoverStaleClaims(now);
      this.disposePreActivationQueue(now);
      const selected = this.listQueue().filter((record) => record.status === "queued" && Date.parse(record.nextAttemptAt) <= now.getTime())
        .sort((left, right) => left.nextAttemptAt.localeCompare(right.nextAttemptAt) || left.createdAt.localeCompare(right.createdAt) || left.traceId.localeCompare(right.traceId))[0];
      if (!selected) return null;
      const claimed: LedgerQueueRecordV1 = {
        ...selected,
        status: "claimed",
        attempt: selected.attempt + 1,
        updatedAt: now.toISOString(),
        claimedAt: now.toISOString(),
        claimToken: randomUUID(),
        reasonCode: null,
      };
      writeAtomic(this.queuePath(claimed.traceId), claimed);
      return claimed;
    });
  }

  peekDueEvaluationEvidence(now = new Date()): EvaluationEvidenceV1[] {
    if (!this.evaluatorEnabled) return [];
    return this.listQueue()
      .filter((record) => record.status === "queued"
        && Date.parse(record.nextAttemptAt) <= now.getTime()
        && (this.evaluationStartedAt === null || Date.parse(record.createdAt) >= this.evaluationStartedAt))
      .sort((left, right) => left.nextAttemptAt.localeCompare(right.nextAttemptAt)
        || left.createdAt.localeCompare(right.createdAt)
        || left.traceId.localeCompare(right.traceId))
      .map((record) => this.readEvaluationEvidence(record.traceId, now));
  }

  claimBatchExact(
    ownerToken: string,
    traceIds: Digest[],
    now = new Date(),
    acceptedReasonByTrace: ReadonlyMap<Digest, string> = new Map(),
  ): LedgerQueueRecordV1[] {
    if (!this.evaluatorEnabled || traceIds.length < 1 || new Set(traceIds).size !== traceIds.length) {
      throw new ObservationLedgerError("INVALID_BATCH_CLAIM", "batch claim is disabled, empty, or duplicated");
    }
    return this.withStateLock(() => {
      this.assertWorkerLease("evaluator", ownerToken, now);
      this.recoverStaleClaims(now);
      const records = traceIds.map((traceId) => this.readQueue(traceId));
      if (records.some((record) => {
        const accepted = acceptedReasonByTrace.get(record.traceId);
        if (accepted && record.reasonCode === accepted && record.status === "terminal") return false;
        if (record.status === "claimed") return false;
        return record.status !== "queued" || Date.parse(record.nextAttemptAt) > now.getTime();
      })) {
        throw new ObservationLedgerError("BATCH_CLAIM_CONFLICT", "one or more batch sources are not due and queued");
      }
      return records.map((record) => {
        const accepted = acceptedReasonByTrace.get(record.traceId);
        if (accepted && record.reasonCode === accepted && record.status === "terminal") return record;
        const claimed: LedgerQueueRecordV1 = {
          ...record,
          status: "claimed",
          attempt: record.status === "claimed" ? record.attempt : record.attempt + 1,
          updatedAt: now.toISOString(),
          claimedAt: now.toISOString(),
          claimToken: randomUUID(),
          reasonCode: null,
        };
        writeAtomic(this.queuePath(claimed.traceId), claimed);
        return claimed;
      });
    });
  }

  completeBatchClaim(
    ownerToken: string,
    claimed: LedgerQueueRecordV1,
    producer: ProducerRef,
    batchResultRef: { ref: string; digest: Digest },
    disposition: BatchEvaluationDispositionV1,
    now = new Date(),
  ): LedgerQueueRecordV1 {
    if (claimed.traceId !== disposition.traceId || !TOKEN_RE.test(disposition.reasonCode)
      || disposition.observationRefs.some((value) => !/^sha256:[a-f0-9]{64}$/.test(value))
      || new Set(disposition.observationRefs).size !== disposition.observationRefs.length
      || (disposition.decision === "write" && disposition.observationRefs.length < 1)
      || (disposition.decision !== "write" && disposition.observationRefs.length !== 0)) {
      throw new ObservationLedgerError("INVALID_BATCH_DISPOSITION", "batch disposition is invalid");
    }
    return this.withStateLock(() => {
      this.assertWorkerLease("evaluator", ownerToken, now);
      const envelope = this.requireEnvelope(claimed.traceId);
      const current = this.assertClaim(claimed);
      const eventBase = {
        schema: "engram.memory-trace-event.v1" as const,
        traceId: envelope.traceId,
        stage: "batch_evaluation_terminal" as const,
        scope: envelope.scope,
        producer,
        stageRef: { kind: "batch-result" as const, ref: batchResultRef.ref, digest: batchResultRef.digest },
        recordedAt: now.toISOString(),
        policyDigest: this.policyDigest,
        reasonCode: disposition.reasonCode,
        verification: null,
      };
      const event: TraceEventV1 = {
        ...eventBase,
        eventId: sha256({ ...eventBase, observationRefs: disposition.observationRefs } as unknown as JsonValue),
      };
      const tracePath = join(this.root, "traces", digestKey(envelope.traceId), `${digestKey(event.eventId)}.json`);
      if (!writeImmutable(tracePath, event) && !jsonEqual(readJson<TraceEventV1>(tracePath), event)) {
        throw new ObservationLedgerError("CONTENT_CONFLICT", "batch terminal trace identity has different content");
      }
      const terminal: LedgerQueueRecordV1 = {
        ...current,
        status: "terminal",
        updatedAt: now.toISOString(),
        claimedAt: null,
        claimToken: null,
        terminalAt: now.toISOString(),
        reasonCode: disposition.reasonCode,
      };
      writeAtomic(this.queuePath(terminal.traceId), terminal);
      return terminal;
    });
  }

  deferBatchClaim(
    ownerToken: string,
    claimed: LedgerQueueRecordV1,
    delayMs: number,
    reasonCode: string,
    now = new Date(),
  ): LedgerQueueRecordV1 {
    if (!Number.isSafeInteger(delayMs) || delayMs < 1 || !TOKEN_RE.test(reasonCode)) {
      throw new ObservationLedgerError("INVALID_BATCH_DEFER", "batch defer parameters are invalid");
    }
    return this.withStateLock(() => {
      this.assertWorkerLease("evaluator", ownerToken, now);
      const current = this.assertClaim(claimed);
      const queued: LedgerQueueRecordV1 = {
        ...current,
        status: "queued",
        attempt: Math.max(0, current.attempt - 1),
        nextAttemptAt: new Date(now.getTime() + delayMs).toISOString(),
        updatedAt: now.toISOString(),
        claimedAt: null,
        claimToken: null,
        terminalAt: null,
        reasonCode,
      };
      writeAtomic(this.queuePath(queued.traceId), queued);
      return queued;
    });
  }

  nextEvaluationAt(): Date | null {
    if (!this.evaluatorEnabled) return null;
    const selected = this.listQueue()
      .filter((record) => record.status === "queued"
        && (this.evaluationStartedAt === null || Date.parse(record.createdAt) >= this.evaluationStartedAt))
      .sort((left, right) => left.nextAttemptAt.localeCompare(right.nextAttemptAt) || left.traceId.localeCompare(right.traceId))[0];
    return selected ? new Date(selected.nextAttemptAt) : null;
  }

  retry(claimed: LedgerQueueRecordV1, delayMs: number, reasonCode: string, now = new Date()): LedgerQueueRecordV1 {
    if (!Number.isFinite(delayMs) || delayMs < 1 || !reasonCode) throw new ObservationLedgerError("INVALID_RETRY", "retry parameters are invalid");
    return this.withStateLock(() => {
      const current = this.readQueue(claimed.traceId);
      if (current.status !== "claimed" || !claimed.claimToken || current.claimToken !== claimed.claimToken) {
        throw new ObservationLedgerError("CLAIM_LOST", "queue claim is no longer owned");
      }
      const persistedCompletion = current.attempt >= current.maxAttempts && this.hasPersistedEvaluation(current.traceId);
      const terminal = current.attempt >= current.maxAttempts && !persistedCompletion;
      const next: LedgerQueueRecordV1 = {
        ...current,
        status: terminal ? "terminal" : "queued",
        nextAttemptAt: terminal ? current.nextAttemptAt : new Date(now.getTime() + delayMs).toISOString(),
        updatedAt: now.toISOString(),
        claimedAt: null,
        claimToken: null,
        terminalAt: terminal ? now.toISOString() : null,
        reasonCode: persistedCompletion ? "persisted_completion_pending_resume" : reasonCode,
      };
      writeAtomic(this.queuePath(next.traceId), next);
      return next;
    });
  }

  readEvaluationEvidence(traceId: Digest, now = new Date()): EvaluationEvidenceV1 {
    const envelope = this.readEnvelope(traceId);
    if (!envelope) throw new ObservationLedgerError("SOURCE_MISSING", "observation envelope is unavailable");
    const path = this.evidencePath(traceId);
    if (!existsSync(path)) throw new ObservationLedgerError("EVIDENCE_MISSING", "observation evidence is unavailable");
    const evidence = readJson<EvaluationEvidenceV1["evidence"]>(path);
    if (evidence.schema !== "engram.memory-evidence-envelope.v1"
      || evidence.traceId !== traceId
      || !jsonEqual(evidence.scope, envelope.scope)
      || !validInstant(evidence.createdAt)
      || !validInstant(evidence.expiresAt)) {
      throw new ObservationLedgerError("STATE_CORRUPT", "observation evidence record is invalid");
    }
    const identity = { schema: evidence.schema, traceId: evidence.traceId, scope: evidence.scope, payload: evidence.payload };
    if (sha256(identity as unknown as JsonValue) !== envelope.evidenceDigest) {
      throw new ObservationLedgerError("CONTENT_CONFLICT", "observation evidence does not match the admitted envelope");
    }
    if (Date.parse(evidence.expiresAt) <= now.getTime()) {
      throw new ObservationLedgerError("EVIDENCE_EXPIRED", "observation evidence has expired");
    }
    return { envelope, evidence };
  }

  readObservation(traceId: Digest): EpisodicObservationV1 | null {
    const path = this.observationPath(traceId);
    return existsSync(path) ? readJson<EpisodicObservationV1>(path) : null;
  }

  readEvaluationResult(traceId: Digest): EpisodicEvaluationCompletion | null {
    const observation = this.readObservation(traceId);
    if (observation) {
      this.validatePersistedObservation(observation, this.requireEnvelope(traceId));
      return { traceId, decision: this.decisionFromObservation(observation), observation };
    }
    const skip = this.readSkipCompletion(traceId);
    return skip ? { traceId, decision: skip.decision, observation: null } : null;
  }

  resumePersistedEvaluation(claimed: LedgerQueueRecordV1, now = new Date()): EpisodicEvaluationCompletion | null {
    return this.withStateLock(() => {
      this.assertClaim(claimed);
      const envelope = this.requireEnvelope(claimed.traceId);
      const observation = this.readObservation(claimed.traceId);
      if (observation) {
        this.validatePersistedObservation(observation, envelope);
        const decision = this.decisionFromObservation(observation);
        this.finishEvaluation(claimed, envelope, observation.producer, decision, observation, observation.completedAt, now);
        return { traceId: envelope.traceId, decision, observation };
      }
      const skip = this.readSkipCompletion(claimed.traceId);
      if (!skip) return null;
      this.finishEvaluation(claimed, envelope, skip.event.producer, skip.decision, null, skip.event.recordedAt, now);
      return { traceId: envelope.traceId, decision: skip.decision, observation: null };
    });
  }

  completeEvaluation(
    claimed: LedgerQueueRecordV1,
    producer: ProducerRef,
    decision: EpisodicEvaluationDecision,
    trustedInputs: string[],
    now = new Date(),
  ): EpisodicEvaluationCompletion {
    return this.withStateLock(() => {
      this.assertClaim(claimed);
      const envelope = this.requireEnvelope(claimed.traceId);
      this.readEvaluationEvidence(envelope.traceId, now);
      this.authorizeEvaluator(producer, trustedInputs);
      this.validateEvaluationDecision(decision, envelope);
      let observation: EpisodicObservationV1 | null = null;
      if (decision.decision === "write") observation = this.writeObservation(envelope, producer, decision, now);
      this.finishEvaluation(claimed, envelope, producer, decision, observation, now.toISOString(), now);
      return { traceId: envelope.traceId, decision, observation };
    });
  }

  purgeExpiredEvidence(now = new Date()): number {
    return this.withStateLock(() => {
      const directory = join(this.root, "evidence");
      if (!existsSync(directory)) return 0;
      let removed = 0;
      for (const name of readdirSync(directory).filter((entry) => entry.endsWith(".json"))) {
        const path = join(directory, name);
        const record = readJson<{ expiresAt: string }>(path);
        if (Date.parse(record.expiresAt) <= now.getTime()) {
          unlinkSync(path);
          removed++;
        }
      }
      return removed;
    });
  }

  listQueue(): LedgerQueueRecordV1[] {
    const directory = join(this.root, "queues", "evaluator");
    if (!existsSync(directory)) return [];
    return readdirSync(directory).filter((name) => name.endsWith(".json"))
      .map((name) => this.readQueue(`sha256:${name.slice(0, -5)}` as Digest));
  }

  readEnvelope(traceId: Digest): ObservationJobV1 | null {
    const path = this.envelopePath(traceId);
    return existsSync(path) ? readJson<ObservationJobV1>(path) : null;
  }

  readTrace(traceId: Digest): TraceEventV1[] {
    const directory = join(this.root, "traces", digestKey(traceId));
    if (!existsSync(directory)) return [];
    return readdirSync(directory).filter((name) => name.endsWith(".json")).sort()
      .map((name) => readJson<TraceEventV1>(join(directory, name)))
      .sort((left, right) => left.recordedAt.localeCompare(right.recordedAt) || left.stage.localeCompare(right.stage));
  }

  private validateConfiguration(): void {
    if (!this.workspaceId || this.exactSessionKeys.size === 0) throw new ObservationLedgerError("INVALID_CONFIG", "workspace and exact sessions are required");
    if (this.policy.schema !== AUTHORITY_SCHEMA || this.policy.policyVersion !== AUTHORITY_VERSION || this.policy.defaultDecision !== "deny") {
      throw new ObservationLedgerError("UNKNOWN_AUTHORITY_POLICY", "authority policy is not supported");
    }
    const limits = this.limits;
    if (!Number.isInteger(limits.maxJobs) || limits.maxJobs < 1
      || !Number.isInteger(limits.maxBytes) || limits.maxBytes < 1
      || !Number.isInteger(limits.maxAttempts) || limits.maxAttempts < 1
      || !Number.isInteger(limits.claimTtlMs) || limits.claimTtlMs < 1
      || limits.maxQueueAgeMs < 1
      || limits.evidenceTtlMs < 1 || limits.evidenceTtlMs > MAX_EVIDENCE_TTL_MS
      || ![0, 1].includes(limits.maxInferenceCalls)
      || this.evaluatorEnabled !== (limits.maxInferenceCalls === 1)
      || (this.evaluatorEnabled && this.evaluationStartedAt === null)) {
      throw new ObservationLedgerError("INVALID_LIMITS", "ledger limits or evaluator inference gate are invalid");
    }
  }

  private validateSource(source: TrustedCompletedTurn): void {
    if (source.scope.workspaceId !== this.workspaceId || !this.exactSessionKeys.has(source.scope.runtimeSessionKey)) {
      throw new ObservationLedgerError("WRONG_SCOPE", "source is outside the exact workspace/session partition");
    }
    if (!/^channel-user:v1:[a-f0-9]{64}$/.test(source.sourceTurnId) || !validInstant(source.sourceCompletedAt)) {
      throw new ObservationLedgerError("INVALID_SOURCE", "source identity or completion time is invalid");
    }
    if (source.evidenceRefs.length < 1 || source.evidenceRefs.length > 8
      || source.evidenceRefs.some((ref) => !["source-turn", "message", "approved-tool-outcome"].includes(ref.kind)
        || !ref.ref || !/^sha256:[a-f0-9]{64}$/.test(ref.digest))) {
      throw new ObservationLedgerError("INVALID_EVIDENCE", "evidence refs are invalid or unbounded");
    }
    const producer = this.registry.producers.find((entry) => entry.id === source.authority.id
      && entry.version === source.authority.version && entry.digest === source.authority.digest);
    const rule = this.policy.rules.find((entry) => entry.artifactSchema === SOURCE_SCHEMA && entry.stage === "source-admission");
    if (!producer || !rule || !producer.artifactSchemas.includes(SOURCE_SCHEMA)
      || !rule.allowedProducerIds.includes(producer.id) || !rule.allowedAuthorityClasses.includes(producer.authorityClass)) {
      throw new ObservationLedgerError("AUTHORITY_DENIED", "source producer is not authorized");
    }
    if (rule.requiredTrustedInputs.some((input) => !source.trustedInputs.includes(input))) {
      throw new ObservationLedgerError("TRUSTED_INPUT_MISSING", "source admission lacks a required trusted input");
    }
  }

  private assertCapacity(incomingBytes: number, now: Date): void {
    const queue = this.listQueue();
    if (queue.length >= this.limits.maxJobs) throw new ObservationLedgerError("CAPACITY_JOBS", "job high-water limit reached");
    if (directoryBytes(this.root) + incomingBytes > this.limits.maxBytes) throw new ObservationLedgerError("CAPACITY_BYTES", "byte high-water limit reached");
    const oldest = queue.filter((record) => record.status !== "terminal").sort((left, right) => left.createdAt.localeCompare(right.createdAt))[0];
    if (oldest && now.getTime() - Date.parse(oldest.createdAt) > this.limits.maxQueueAgeMs) {
      throw new ObservationLedgerError("CAPACITY_AGE", "queue age high-water limit reached");
    }
  }

  private recoverStaleClaims(now: Date): void {
    for (const current of this.listQueue()) {
      if (current.status !== "claimed" || !current.claimedAt
        || Date.parse(current.claimedAt) + this.limits.claimTtlMs > now.getTime()) continue;
      const persistedCompletion = current.attempt >= current.maxAttempts && this.hasPersistedEvaluation(current.traceId);
      const terminal = current.attempt >= current.maxAttempts && !persistedCompletion;
      const recovered: LedgerQueueRecordV1 = {
        ...current,
        status: terminal ? "terminal" : "queued",
        nextAttemptAt: terminal ? current.nextAttemptAt : now.toISOString(),
        updatedAt: now.toISOString(),
        claimedAt: null,
        claimToken: null,
        terminalAt: terminal ? now.toISOString() : null,
        reasonCode: persistedCompletion
          ? "persisted_completion_pending_resume"
          : terminal ? "stale_claim_exhausted" : "stale_claim_recovered",
      };
      writeAtomic(this.queuePath(recovered.traceId), recovered);
    }
  }

  private disposePreActivationQueue(now: Date): void {
    if (this.evaluationStartedAt === null) return;
    for (const current of this.listQueue()) {
      if (current.status !== "queued" || Date.parse(current.createdAt) >= this.evaluationStartedAt) continue;
      writeAtomic(this.queuePath(current.traceId), {
        ...current,
        status: "terminal",
        updatedAt: now.toISOString(),
        claimedAt: null,
        claimToken: null,
        terminalAt: now.toISOString(),
        reasonCode: "pre_activation_not_evaluated",
      });
    }
  }

  private hasPersistedEvaluation(traceId: Digest): boolean {
    try { return this.readEvaluationResult(traceId) !== null; }
    catch { return false; }
  }

  private repairAdmission(envelope: ObservationJobV1, evidenceRecord: unknown): void {
    const evidencePath = this.evidencePath(envelope.traceId);
    if (!existsSync(evidencePath)) writeImmutable(evidencePath, evidenceRecord);
    else {
      const current = readJson<any>(evidencePath);
      const identity = { schema: current.schema, traceId: current.traceId, scope: current.scope, payload: current.payload };
      if (sha256(identity as JsonValue) !== envelope.evidenceDigest) {
        throw new ObservationLedgerError("CONTENT_CONFLICT", "stored evidence does not match envelope");
      }
    }
    this.ensureQueue(envelope);
    this.ensureTrace(envelope, "source_completed");
  }

  private assertClaim(claimed: LedgerQueueRecordV1): LedgerQueueRecordV1 {
    const current = this.readQueue(claimed.traceId);
    if (current.status !== "claimed" || !claimed.claimToken || current.claimToken !== claimed.claimToken) {
      throw new ObservationLedgerError("CLAIM_LOST", "queue claim is no longer owned");
    }
    return current;
  }

  private requireEnvelope(traceId: Digest): ObservationJobV1 {
    const envelope = this.readEnvelope(traceId);
    if (!envelope) throw new ObservationLedgerError("SOURCE_MISSING", "observation envelope is unavailable");
    return envelope;
  }

  private authorizeEvaluator(producer: ProducerRef, trustedInputs: string[]): void {
    const registered = this.registry.producers.find((entry) => entry.id === producer.id
      && entry.version === producer.version && entry.digest === producer.digest);
    const rule = this.policy.rules.find((entry) => entry.artifactSchema === OBSERVATION_SCHEMA && entry.stage === "advisory-evaluation");
    if (!registered || !rule || !registered.artifactSchemas.includes(OBSERVATION_SCHEMA)
      || !registered.observationClasses?.includes("episodic.event")
      || !registered.observationClasses.includes("episodic.decision")
      || !rule.allowedProducerIds.includes(registered.id) || !rule.allowedAuthorityClasses.includes(registered.authorityClass)) {
      throw new ObservationLedgerError("AUTHORITY_DENIED", "evaluator producer is not authorized");
    }
    if (rule.requiredTrustedInputs.some((input) => !trustedInputs.includes(input))) {
      throw new ObservationLedgerError("TRUSTED_INPUT_MISSING", "evaluation lacks a required trusted input");
    }
  }

  private validateEvaluationDecision(decision: EpisodicEvaluationDecision, envelope: ObservationJobV1): void {
    if (decision.decision === "skip") {
      if (!SKIP_REASONS.has(decision.reason)) throw new ObservationLedgerError("INVALID_EVALUATION", "skip reason is invalid");
      return;
    }
    if (!(["events", "decisions"] as string[]).includes(decision.section)
      || typeof decision.text !== "string" || decision.text.trim() !== decision.text
      || decision.text.length < 1 || decision.text.length > 1_000
      || decision.text.split(/\r?\n/).length > 2
      || !ACTOR_REFS.has(decision.actorRef)
      || !OUTCOME_STATUSES.has(decision.outcomeStatus)
      || !Number.isFinite(decision.confidence) || decision.confidence < 0 || decision.confidence > 1
      || !Array.isArray(decision.reasonCodes) || decision.reasonCodes.length < 1 || decision.reasonCodes.length > 8
      || new Set(decision.reasonCodes).size !== decision.reasonCodes.length
      || decision.reasonCodes.some((reason) => !TOKEN_RE.test(reason))
      || !Array.isArray(decision.evidenceRefs) || decision.evidenceRefs.length < 1 || decision.evidenceRefs.length > 8) {
      throw new ObservationLedgerError("INVALID_EVALUATION", "write decision is invalid or unbounded");
    }
    const admittedRefs = new Set(envelope.evidenceRefs.map((ref) => canonical(ref as unknown as JsonValue)));
    const selectedRefs = decision.evidenceRefs.map((ref) => canonical(ref as unknown as JsonValue));
    if (new Set(selectedRefs).size !== selectedRefs.length || selectedRefs.some((ref) => !admittedRefs.has(ref))) {
      throw new ObservationLedgerError("INVALID_EVALUATION", "write decision cites evidence outside the admitted bundle");
    }
  }

  private finishEvaluation(
    claimed: LedgerQueueRecordV1,
    envelope: ObservationJobV1,
    producer: ProducerRef,
    decision: EpisodicEvaluationDecision,
    observation: EpisodicObservationV1 | null,
    completedAt: string,
    now: Date,
  ): void {
    this.validateEvaluationDecision(decision, envelope);
    if (decision.decision === "write" && !observation) {
      throw new ObservationLedgerError("STATE_CORRUPT", "write decision has no typed observation");
    }
    if (observation) this.validatePersistedObservation(observation, envelope);
    this.authorizeEvaluator(producer, ["observation-job", "ttl-evidence-store", "producer-registry"]);
    this.ensureEvaluationTrace(envelope, producer, decision, observation, completedAt);
    this.fault?.("after_evaluation_trace");
    const current = this.assertClaim(claimed);
    const terminal: LedgerQueueRecordV1 = {
      ...current,
      status: "terminal",
      updatedAt: now.toISOString(),
      claimedAt: null,
      claimToken: null,
      terminalAt: now.toISOString(),
      reasonCode: decision.decision === "write" ? "semantic_write" : `semantic_skip_${decision.reason}`,
    };
    writeAtomic(this.queuePath(terminal.traceId), terminal);
  }

  private writeObservation(
    envelope: ObservationJobV1,
    producer: ProducerRef,
    decision: Extract<EpisodicEvaluationDecision, { decision: "write" }>,
    now: Date,
  ): EpisodicObservationV1 {
    const observationClass: EpisodicObservationV1["observationClass"] = decision.section === "events"
      ? "episodic.event"
      : "episodic.decision";
    const base = {
      schema: OBSERVATION_SCHEMA as "engram.memory-observation.v1",
      observationId: deriveObservationId(envelope.traceId, producer.id, observationClass),
      traceId: envelope.traceId,
      sourceTurnId: envelope.sourceTurnId,
      scope: envelope.scope,
      producer,
      observationClass,
      targetConsumer: "daily-note" as const,
      payload: {
        section: decision.section,
        text: decision.text,
        actorRef: decision.actorRef,
        outcomeStatus: decision.outcomeStatus,
      },
      evidenceRefs: decision.evidenceRefs,
      sourceCompletedAt: envelope.sourceCompletedAt,
      confidence: decision.confidence,
      reasonCodes: decision.reasonCodes,
      completedAt: now.toISOString(),
    };
    const observation: EpisodicObservationV1 = { ...base, observationDigest: sha256(base as unknown as JsonValue) };
    const path = this.observationPath(envelope.traceId);
    if (!writeImmutable(path, observation) && !jsonEqual(readJson<EpisodicObservationV1>(path), observation)) {
      throw new ObservationLedgerError("CONTENT_CONFLICT", "typed observation identity has different content");
    }
    this.fault?.("after_typed_observation");
    return observation;
  }

  private validatePersistedObservation(observation: EpisodicObservationV1, envelope: ObservationJobV1): void {
    const expectedClass = observation.payload?.section === "events" ? "episodic.event" : "episodic.decision";
    if (observation.schema !== OBSERVATION_SCHEMA
      || observation.traceId !== envelope.traceId
      || observation.sourceTurnId !== envelope.sourceTurnId
      || !jsonEqual(observation.scope, envelope.scope)
      || observation.observationClass !== expectedClass
      || observation.targetConsumer !== "daily-note"
      || observation.sourceCompletedAt !== envelope.sourceCompletedAt
      || observation.observationId !== deriveObservationId(envelope.traceId, observation.producer.id, observation.observationClass)
      || !validInstant(observation.completedAt)) {
      throw new ObservationLedgerError("STATE_CORRUPT", "persisted typed observation is invalid");
    }
    this.authorizeEvaluator(observation.producer, ["observation-job", "ttl-evidence-store", "producer-registry"]);
    const decision = this.decisionFromObservation(observation);
    this.validateEvaluationDecision(decision, envelope);
    const { observationDigest, ...base } = observation;
    if (sha256(base as unknown as JsonValue) !== observationDigest) {
      throw new ObservationLedgerError("CONTENT_CONFLICT", "persisted typed observation digest is invalid");
    }
  }

  private decisionFromObservation(observation: EpisodicObservationV1): Extract<EpisodicEvaluationDecision, { decision: "write" }> {
    return {
      decision: "write",
      section: observation.payload.section,
      text: observation.payload.text,
      actorRef: observation.payload.actorRef,
      outcomeStatus: observation.payload.outcomeStatus,
      confidence: observation.confidence,
      reasonCodes: observation.reasonCodes,
      evidenceRefs: observation.evidenceRefs,
    };
  }

  private readSkipCompletion(traceId: Digest): { decision: Extract<EpisodicEvaluationDecision, { decision: "skip" }>; event: TraceEventV1 } | null {
    const event = this.readTrace(traceId).find((entry) => entry.stage === "observation_skipped");
    if (!event) return null;
    const envelope = this.requireEnvelope(traceId);
    const match = event.reasonCode.match(/^episodic_skip_(noise|incomplete|already_captured|not_authoritative|insufficient_evidence)$/);
    if (!match || event.stageRef.kind !== "observation" || event.stageRef.ref !== traceId
      || !jsonEqual(event.scope, envelope.scope)
      || event.policyDigest !== this.policyDigest || !validInstant(event.recordedAt)) {
      throw new ObservationLedgerError("STATE_CORRUPT", "persisted semantic skip trace is invalid");
    }
    this.authorizeEvaluator(event.producer, ["observation-job", "ttl-evidence-store", "producer-registry"]);
    const decision = { decision: "skip" as const, reason: match[1] as EpisodicSkipReason };
    const expectedDigest = sha256({ traceId, decision } as unknown as JsonValue);
    if (event.stageRef.digest !== expectedDigest) {
      throw new ObservationLedgerError("CONTENT_CONFLICT", "persisted semantic skip digest is invalid");
    }
    return { decision, event };
  }

  private ensureQueue(envelope: ObservationJobV1): void {
    const path = this.queuePath(envelope.traceId);
    if (existsSync(path)) {
      const current = this.readQueue(envelope.traceId);
      if (current.traceId !== envelope.traceId) throw new ObservationLedgerError("CONTENT_CONFLICT", "queue identity conflict");
      return;
    }
    const queue: LedgerQueueRecordV1 = {
      schema: "engram.memory-observation-ledger-queue.v1",
      traceId: envelope.traceId,
      queueClass: "evaluator",
      status: "queued",
      attempt: 0,
      maxAttempts: this.limits.maxAttempts,
      nextAttemptAt: envelope.admittedAt,
      createdAt: envelope.admittedAt,
      updatedAt: envelope.admittedAt,
      claimedAt: null,
      claimToken: null,
      terminalAt: null,
      reasonCode: null,
    };
    writeImmutable(path, queue);
  }

  private ensureTrace(envelope: ObservationJobV1, stage: "source_completed"): void {
    const stageRef = { kind: "source-turn" as const, ref: envelope.sourceTurnId, digest: envelope.sourceDigest };
    const event: TraceEventV1 = {
      schema: "engram.memory-trace-event.v1",
      eventId: deriveTraceEventId(envelope.traceId, stage, stageRef.digest),
      traceId: envelope.traceId,
      stage,
      scope: envelope.scope,
      producer: envelope.authority,
      stageRef,
      recordedAt: envelope.admittedAt,
      policyDigest: envelope.policyDigest,
      reasonCode: "trusted_source_completed",
      verification: null,
    };
    const path = join(this.root, "traces", digestKey(envelope.traceId), `${digestKey(event.eventId)}.json`);
    if (!writeImmutable(path, event) && !jsonEqual(readJson<TraceEventV1>(path), event)) {
      throw new ObservationLedgerError("CONTENT_CONFLICT", "trace event identity has different content");
    }
  }

  private ensureEvaluationTrace(
    envelope: ObservationJobV1,
    producer: ProducerRef,
    decision: EpisodicEvaluationDecision,
    observation: EpisodicObservationV1 | null,
    completedAt: string,
  ): void {
    const stage = observation ? "observation_admitted" : "observation_skipped";
    const stageRef = observation
      ? { kind: "observation" as const, ref: observation.observationId, digest: observation.observationDigest }
      : { kind: "observation" as const, ref: envelope.traceId, digest: sha256({ traceId: envelope.traceId, decision } as unknown as JsonValue) };
    const event: TraceEventV1 = {
      schema: "engram.memory-trace-event.v1",
      eventId: deriveTraceEventId(envelope.traceId, stage, stageRef.digest),
      traceId: envelope.traceId,
      stage,
      scope: envelope.scope,
      producer,
      stageRef,
      recordedAt: completedAt,
      policyDigest: this.policyDigest,
      reasonCode: decision.decision === "write"
        ? "episodic_candidate_admitted"
        : `episodic_skip_${decision.reason}`,
      verification: null,
    };
    const path = join(this.root, "traces", digestKey(envelope.traceId), `${digestKey(event.eventId)}.json`);
    if (!writeImmutable(path, event) && !jsonEqual(readJson<TraceEventV1>(path), event)) {
      throw new ObservationLedgerError("CONTENT_CONFLICT", "evaluation trace event identity has different content");
    }
  }

  private assertSameAdmission(current: ObservationJobV1, expected: ObservationJobV1): void {
    const stableCurrent = { ...current, admittedAt: expected.admittedAt };
    if (!jsonEqual(stableCurrent, expected)) throw new ObservationLedgerError("CONTENT_CONFLICT", "source identity has different content");
  }

  private readQueue(traceId: Digest): LedgerQueueRecordV1 {
    const record = readJson<LedgerQueueRecordV1>(this.queuePath(traceId));
    if (record.schema !== "engram.memory-observation-ledger-queue.v1" || record.traceId !== traceId || record.queueClass !== "evaluator") {
      throw new ObservationLedgerError("STATE_CORRUPT", "queue record is invalid");
    }
    return record;
  }

  private assertWorkerLease(queueClass: "evaluator", ownerToken: string, now: Date): void {
    const lease = readJson<{ ownerToken: string; expiresAt: string }>(join(this.workerLockPath(queueClass), "lease.json"));
    if (lease.ownerToken !== ownerToken || Date.parse(lease.expiresAt) <= now.getTime()) {
      throw new ObservationLedgerError("LEASE_LOST", "worker lease is not current");
    }
  }

  private envelopePath(traceId: Digest): string { return join(this.root, "envelopes", `${digestKey(traceId)}.json`); }
  private evidencePath(traceId: Digest): string { return join(this.root, "evidence", `${digestKey(traceId)}.json`); }
  private observationPath(traceId: Digest): string { return join(this.root, "observations", "typed", `${digestKey(traceId)}.json`); }
  private queuePath(traceId: Digest): string { return join(this.root, "queues", "evaluator", `${digestKey(traceId)}.json`); }
  private workerLockPath(queueClass: "evaluator"): string { return join(this.root, "locks", `${queueClass}.worker`); }

  private ensureRoot(): void {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
  }

  private withStateLock<T>(fn: () => T): T {
    this.ensureRoot();
    const lock = join(this.root, "locks", "workspace-state");
    mkdirSync(dirname(lock), { recursive: true, mode: 0o700 });
    const started = Date.now();
    while (true) {
      try { mkdirSync(lock, { mode: 0o700 }); break; }
      catch (error: any) {
        if (error?.code !== "EEXIST") throw error;
        let stale = false;
        try { stale = Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS; } catch { stale = false; }
        if (stale) { rmSync(lock, { recursive: true, force: true }); continue; }
        if (Date.now() - started >= LOCK_WAIT_MS) throw new ObservationLedgerError("LOCK_TIMEOUT", "workspace ledger lock timed out");
        sleepSync(20);
      }
    }
    try { return fn(); }
    finally { rmSync(lock, { recursive: true, force: true }); }
  }
}
