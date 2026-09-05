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
import { dirname, join, resolve } from "node:path";
import {
  ObservationLedgerError,
  sha256,
  type Digest,
  type JsonValue,
  type ObservationScope,
  type ProducerRef,
} from "./ledger.ts";

export const ADMISSION_CHECKPOINT_SCHEMA = "engram.memory-admission-checkpoint.v1" as const;
export const ADMISSION_GAP_RECEIPT_SCHEMA = "engram.memory-admission-gap-receipt.v1" as const;

export const ADMISSION_CHECKPOINT_STAGES = [
  "received",
  "persisted",
  "run_attached",
  "completion_observed",
  "ledger_admitted",
  "terminal_gap",
] as const;

export const ADMISSION_GAP_REASON_CODES = [
  "restart_before_completion",
  "expired_before_completion",
  "identity_ambiguous",
  "identity_conflict",
  "scope_revoked",
  "run_failed",
  "delivery_failed",
  "evidence_missing",
  "evidence_invalid",
] as const;

export type AdmissionCheckpointStage = typeof ADMISSION_CHECKPOINT_STAGES[number];
export type AdmissionFailureStage = Exclude<AdmissionCheckpointStage, "ledger_admitted" | "terminal_gap">;
export type AdmissionGapReasonCode = typeof ADMISSION_GAP_REASON_CODES[number];

export type AdmissionCandidateIdentity = {
  workspaceId: string;
  runtimeSessionKey: string;
  channel: "telegram" | "openclaw";
  inboundMessageId: string;
};

export type AdmissionCheckpointV1 = {
  schema: typeof ADMISSION_CHECKPOINT_SCHEMA;
  candidateId: Digest;
  scope: ObservationScope;
  bindingFingerprint: Digest;
  channel: "telegram" | "openclaw";
  inboundMessageId: string;
  actorId: string;
  replyToId: string | null;
  sourceTurnId: string | null;
  runId: string | null;
  sessionId: string | null;
  sourceText: string | null;
  stage: AdmissionCheckpointStage;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  checkpointDigest: Digest;
};

export type AdmissionGapReceiptV1 = {
  schema: typeof ADMISSION_GAP_RECEIPT_SCHEMA;
  receiptId: Digest;
  candidateId: Digest;
  sourceTurnId: string | null;
  scope: ObservationScope;
  failureStage: AdmissionFailureStage;
  reasonCode: AdmissionGapReasonCode;
  producer: ProducerRef;
  bindingFingerprint: Digest;
  checkpointDigest: Digest;
  discoveredAt: string;
  terminalAt: string;
  receiptDigest: Digest;
};

export type AdmissionGapReceiptInput = {
  checkpoint: AdmissionCheckpointV1;
  failureStage: AdmissionFailureStage;
  reasonCode: AdmissionGapReasonCode;
  terminalAt: Date;
};

export type AdmissionStoreScan<T> = {
  records: T[];
  corrupt: { path: string; error: string }[];
};

const CHECKPOINT_RETENTION_MS = 72 * 60 * 60 * 1_000;
const LOCK_WAIT_MS = 5_000;
const LOCK_STALE_MS = 60_000;

function canonical(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const row = value as Record<string, JsonValue>;
  return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${canonical(row[key])}`).join(",")}}`;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
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

function digestBody<T extends Record<string, unknown>>(value: T, field: keyof T): Digest {
  const body: Record<string, unknown> = { ...value };
  delete body[String(field)];
  return sha256(body as unknown as JsonValue);
}

function checkpointContent(value: Partial<AdmissionCheckpointV1>): JsonValue {
  const {
    schema: _schema,
    candidateId: _candidateId,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    expiresAt: _expiresAt,
    checkpointDigest: _checkpointDigest,
    ...content
  } = value;
  return content as unknown as JsonValue;
}

function validInstant(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function validDigest(value: unknown): value is Digest {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}

function validSourceTurnId(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && /^channel-user:v1:[a-f0-9]{64}$/.test(value));
}

function validToken(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 2_048;
}

function validOptionalToken(value: unknown): value is string | null {
  return value === null || validToken(value);
}

function validScope(value: unknown): value is ObservationScope {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const scope = value as Partial<ObservationScope>;
  return validToken(scope.workspaceId)
    && validToken(scope.runtimeSessionKey)
    && ["self", "managers", "company", "project"].includes(String(scope.scopeClass))
    && validToken(scope.scopeId);
}

function validProducer(value: unknown): value is ProducerRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const producer = value as Partial<ProducerRef>;
  return validToken(producer.id) && validToken(producer.version) && validDigest(producer.digest);
}

function checkpointStageRank(stage: AdmissionCheckpointStage): number {
  return ADMISSION_CHECKPOINT_STAGES.indexOf(stage);
}

export function deriveAdmissionCandidateId(identity: AdmissionCandidateIdentity): Digest {
  return sha256(`engram.memory-admission-candidate.v1\0${identity.workspaceId}\0${identity.runtimeSessionKey}\0${identity.channel}\0${identity.inboundMessageId}`);
}

export function deriveAdmissionGapReceiptId(candidateId: Digest): Digest {
  return sha256(`engram.memory-admission-gap-receipt.v1\0${candidateId}`);
}

export class AdmissionStore {
  readonly root: string;
  private readonly checkpointRoot: string;
  private readonly gapReceiptRoot: string;
  private readonly heldDispositions = new Set<Digest>();

  constructor(
    workspace: string,
    private readonly producer: ProducerRef,
    private readonly fault?: (point: "after_gap_receipt") => void,
  ) {
    this.root = join(resolve(workspace), "memory-state", "memory-observation", "v1");
    this.checkpointRoot = join(this.root, "pre-admission", "checkpoints");
    this.gapReceiptRoot = join(this.root, "receipts", "admission-gap");
  }

  recordCheckpoint(input: Omit<AdmissionCheckpointV1, "schema" | "candidateId" | "createdAt" | "updatedAt" | "expiresAt" | "checkpointDigest"> & {
    now: Date;
  }): { status: "written" | "duplicate"; checkpoint: AdmissionCheckpointV1 } {
    const { now, ...payload } = input;
    const candidateId = deriveAdmissionCandidateId({
      workspaceId: payload.scope.workspaceId,
      runtimeSessionKey: payload.scope.runtimeSessionKey,
      channel: payload.channel,
      inboundMessageId: payload.inboundMessageId,
    });
    return this.withLock(() => {
      const path = this.checkpointPath(candidateId);
      if (existsSync(this.gapReceiptPath(deriveAdmissionGapReceiptId(candidateId)))) {
        throw new ObservationLedgerError("TERMINAL_DISPOSITION", "admission candidate already has a terminal gap receipt");
      }
      const current = existsSync(path) ? this.readCheckpointPath(path) : null;
      if (current) {
        this.assertStableIdentity(current, { ...payload, candidateId });
        if (checkpointStageRank(payload.stage) < checkpointStageRank(current.stage)) {
          if (this.isHistoricalReplay(payload)) return { status: "duplicate", checkpoint: current };
          throw new ObservationLedgerError("CONTENT_CONFLICT", "admission checkpoint stage regressed");
        }
        if (checkpointStageRank(payload.stage) > checkpointStageRank(current.stage) + 1) {
          throw new ObservationLedgerError("INVALID_TRANSITION", "admission checkpoint skipped a required stage");
        }
        const currentContent = checkpointContent(current);
        if (canonical(currentContent) === canonical(checkpointContent(payload))) {
          return { status: "duplicate", checkpoint: current };
        }
        const updated = this.buildCheckpoint({
          ...current,
          ...payload,
          candidateId,
          createdAt: current.createdAt,
          updatedAt: now.toISOString(),
          expiresAt: current.expiresAt,
        });
        writeAtomic(path, updated);
        return { status: "written", checkpoint: updated };
      }
      if (payload.stage !== "received") {
        throw new ObservationLedgerError("STATE_MISSING", "admission checkpoint must begin at received");
      }
      const checkpoint = this.buildCheckpoint({
        ...payload,
        candidateId,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + CHECKPOINT_RETENTION_MS).toISOString(),
      });
      writeAtomic(path, checkpoint);
      return { status: "written", checkpoint };
    });
  }

  readCheckpoint(candidateId: Digest): AdmissionCheckpointV1 | null {
    const path = this.checkpointPath(candidateId);
    return existsSync(path) ? this.readCheckpointPath(path) : null;
  }

  scanCheckpoints(): AdmissionStoreScan<AdmissionCheckpointV1> {
    return this.scan(this.checkpointRoot, (path) => this.readCheckpointPath(path));
  }

  publishGapReceipt(input: AdmissionGapReceiptInput): { status: "written" | "duplicate"; receipt: AdmissionGapReceiptV1; checkpoint: AdmissionCheckpointV1 } {
    return this.withCandidateDisposition(input.checkpoint.candidateId, () => this.publishGapReceiptUnderDisposition(input));
  }

  private publishGapReceiptUnderDisposition(input: AdmissionGapReceiptInput): { status: "written" | "duplicate"; receipt: AdmissionGapReceiptV1; checkpoint: AdmissionCheckpointV1 } {
    if (!ADMISSION_GAP_REASON_CODES.includes(input.reasonCode)) {
      throw new ObservationLedgerError("INVALID_GAP_REASON", "admission gap reason is not registered");
    }
    return this.withLock(() => {
      const current = this.readCheckpoint(input.checkpoint.candidateId);
      const receiptId = deriveAdmissionGapReceiptId(input.checkpoint.candidateId);
      const path = this.gapReceiptPath(receiptId);
      if (existsSync(path)) {
        const existing = this.readGapReceiptPath(path);
        if (existing.candidateId !== input.checkpoint.candidateId) {
          throw new ObservationLedgerError("CONTENT_CONFLICT", "admission gap receipt identity has different candidate");
        }
        if (!current) throw new ObservationLedgerError("STATE_MISSING", "terminal admission checkpoint is missing");
        if (current.stage === "terminal_gap") {
          return { status: "duplicate", receipt: existing, checkpoint: current };
        }
        if (current.checkpointDigest !== existing.checkpointDigest) {
          throw new ObservationLedgerError("CONTENT_CONFLICT", "admission checkpoint changed after terminal receipt publication");
        }
        const terminal = this.buildCheckpoint({
          ...current,
          sourceText: null,
          stage: "terminal_gap",
          updatedAt: input.terminalAt.toISOString(),
        });
        writeAtomic(this.checkpointPath(current.candidateId), terminal);
        return { status: "duplicate", receipt: existing, checkpoint: terminal };
      }
      if (!current || current.checkpointDigest !== input.checkpoint.checkpointDigest) {
        throw new ObservationLedgerError("CONTENT_CONFLICT", "admission checkpoint changed before gap publication");
      }
      const partial = {
        schema: ADMISSION_GAP_RECEIPT_SCHEMA,
        receiptId,
        candidateId: current.candidateId,
        sourceTurnId: current.sourceTurnId,
        scope: current.scope,
        failureStage: input.failureStage,
        reasonCode: input.reasonCode,
        producer: this.producer,
        bindingFingerprint: current.bindingFingerprint,
        checkpointDigest: current.checkpointDigest,
        discoveredAt: current.createdAt,
        terminalAt: input.terminalAt.toISOString(),
      } as const;
      const receipt: AdmissionGapReceiptV1 = {
        ...partial,
        receiptDigest: sha256(partial as unknown as JsonValue),
      };
      const written = writeImmutable(path, receipt);
      if (!written) {
        const existing = this.readGapReceiptPath(path);
        if (canonical(existing as unknown as JsonValue) !== canonical(receipt as unknown as JsonValue)) {
          throw new ObservationLedgerError("CONTENT_CONFLICT", "admission gap receipt identity has different content");
        }
      }
      this.fault?.("after_gap_receipt");
      const terminal = this.buildCheckpoint({
        ...current,
        sourceText: null,
        stage: "terminal_gap",
        updatedAt: input.terminalAt.toISOString(),
      });
      writeAtomic(this.checkpointPath(current.candidateId), terminal);
      return { status: written ? "written" : "duplicate", receipt, checkpoint: terminal };
    });
  }

  scanGapReceipts(): AdmissionStoreScan<AdmissionGapReceiptV1> {
    return this.scan(this.gapReceiptRoot, (path) => this.readGapReceiptPath(path));
  }

  readGapReceiptForCandidate(candidateId: Digest): AdmissionGapReceiptV1 | null {
    const path = this.gapReceiptPath(deriveAdmissionGapReceiptId(candidateId));
    return existsSync(path) ? this.readGapReceiptPath(path) : null;
  }

  withCandidateDisposition<T>(candidateId: Digest, operation: () => T): T {
    if (!validDigest(candidateId)) throw new ObservationLedgerError("INVALID_DIGEST", "candidate digest is invalid");
    if (this.heldDispositions.has(candidateId)) return operation();
    return this.withPathLock(join(this.root, "locks", "admission-disposition", candidateId.slice(7)), () => {
      this.heldDispositions.add(candidateId);
      try { return operation(); }
      finally { this.heldDispositions.delete(candidateId); }
    });
  }

  findOpenBySession(runtimeSessionKey: string, stages: AdmissionCheckpointStage[]): AdmissionCheckpointV1[] {
    return this.scanCheckpoints().records
      .filter((record) => record.scope.runtimeSessionKey === runtimeSessionKey && stages.includes(record.stage))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.candidateId.localeCompare(right.candidateId));
  }

  findOpenByRun(runId: string, stages: AdmissionCheckpointStage[]): AdmissionCheckpointV1[] {
    return this.scanCheckpoints().records
      .filter((record) => record.runId === runId && stages.includes(record.stage))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.candidateId.localeCompare(right.candidateId));
  }

  private buildCheckpoint(input: Omit<AdmissionCheckpointV1, "schema" | "checkpointDigest">): AdmissionCheckpointV1 {
    const partial = {
      schema: ADMISSION_CHECKPOINT_SCHEMA,
      candidateId: input.candidateId,
      scope: input.scope,
      bindingFingerprint: input.bindingFingerprint,
      channel: input.channel,
      inboundMessageId: input.inboundMessageId,
      actorId: input.actorId,
      replyToId: input.replyToId,
      sourceTurnId: input.sourceTurnId,
      runId: input.runId,
      sessionId: input.sessionId,
      sourceText: input.sourceText,
      stage: input.stage,
      createdAt: input.createdAt,
      updatedAt: input.updatedAt,
      expiresAt: input.expiresAt,
    } as const;
    return { ...partial, checkpointDigest: sha256(partial as unknown as JsonValue) };
  }

  private assertStableIdentity(current: AdmissionCheckpointV1, next: Omit<AdmissionCheckpointV1, "schema" | "createdAt" | "updatedAt" | "expiresAt" | "checkpointDigest">): void {
    const currentRank = checkpointStageRank(current.stage);
    const nextRank = checkpointStageRank(next.stage);
    if (current.candidateId !== next.candidateId
      || current.scope.workspaceId !== next.scope.workspaceId
      || current.scope.runtimeSessionKey !== next.scope.runtimeSessionKey
      || current.scope.scopeClass !== next.scope.scopeClass
      || current.scope.scopeId !== next.scope.scopeId
      || current.bindingFingerprint !== next.bindingFingerprint
      || current.channel !== next.channel
      || current.inboundMessageId !== next.inboundMessageId
      || current.actorId !== next.actorId) {
      throw new ObservationLedgerError("CONTENT_CONFLICT", "admission candidate identity changed");
    }
    if ((current.replyToId !== null && next.replyToId !== null && current.replyToId !== next.replyToId)
      || (currentRank === nextRank && current.replyToId !== next.replyToId)
      || (nextRank > currentRank && current.replyToId !== null && next.replyToId === null)) {
      throw new ObservationLedgerError("CONTENT_CONFLICT", "admission reply identity changed");
    }
    if ((current.sourceText !== null && next.sourceText !== null && current.sourceText !== next.sourceText)
      || (currentRank === nextRank && current.sourceText !== next.sourceText)
      || (nextRank > currentRank && current.sourceText !== null && next.sourceText === null && next.stage !== "ledger_admitted")) {
      throw new ObservationLedgerError("CONTENT_CONFLICT", "admission source evidence changed");
    }
    for (const [label, oldValue, newValue] of [
      ["source turn", current.sourceTurnId, next.sourceTurnId],
      ["run", current.runId, next.runId],
      ["runtime session", current.sessionId, next.sessionId],
    ] as const) {
      if (oldValue !== null && newValue !== null && oldValue !== newValue) {
        throw new ObservationLedgerError("CONTENT_CONFLICT", `admission ${label} identity changed`);
      }
    }
  }

  private isHistoricalReplay(value: Omit<AdmissionCheckpointV1, "schema" | "candidateId" | "createdAt" | "updatedAt" | "expiresAt" | "checkpointDigest">): boolean {
    if (value.stage === "received") {
      return value.sourceTurnId === null && value.runId === null && value.sessionId === null && value.sourceText === null;
    }
    if (value.stage === "persisted") return value.runId === null && value.sessionId === null;
    return value.stage === "run_attached" || value.stage === "completion_observed";
  }

  private readCheckpointPath(path: string): AdmissionCheckpointV1 {
    const record = this.readJson<AdmissionCheckpointV1>(path);
    if (record.schema !== ADMISSION_CHECKPOINT_SCHEMA
      || !validDigest(record.candidateId)
      || !validScope(record.scope)
      || !validDigest(record.bindingFingerprint)
      || !validDigest(record.checkpointDigest)
      || !ADMISSION_CHECKPOINT_STAGES.includes(record.stage)
      || (record.channel !== "telegram" && record.channel !== "openclaw")
      || !validToken(record.inboundMessageId)
      || !validToken(record.actorId)
      || !validOptionalToken(record.replyToId)
      || !validSourceTurnId(record.sourceTurnId)
      || !validOptionalToken(record.runId)
      || !validOptionalToken(record.sessionId)
      || !(record.sourceText === null || (typeof record.sourceText === "string" && record.sourceText.length <= 50_000))
      || !validInstant(record.createdAt)
      || !validInstant(record.updatedAt)
      || !validInstant(record.expiresAt)
      || deriveAdmissionCandidateId({
        workspaceId: record.scope?.workspaceId,
        runtimeSessionKey: record.scope?.runtimeSessionKey,
        channel: record.channel,
        inboundMessageId: record.inboundMessageId,
      }) !== record.candidateId
      || digestBody(record as unknown as Record<string, unknown>, "checkpointDigest") !== record.checkpointDigest) {
      throw new ObservationLedgerError("STATE_CORRUPT", "admission checkpoint failed validation");
    }
    return record;
  }

  private readGapReceiptPath(path: string): AdmissionGapReceiptV1 {
    const record = this.readJson<AdmissionGapReceiptV1>(path);
    if (record.schema !== ADMISSION_GAP_RECEIPT_SCHEMA
      || !validDigest(record.receiptId)
      || !validDigest(record.candidateId)
      || !validScope(record.scope)
      || !validDigest(record.bindingFingerprint)
      || !validDigest(record.checkpointDigest)
      || !validDigest(record.receiptDigest)
      || !validSourceTurnId(record.sourceTurnId)
      || !ADMISSION_CHECKPOINT_STAGES.slice(0, 4).includes(record.failureStage)
      || !ADMISSION_GAP_REASON_CODES.includes(record.reasonCode)
      || !validProducer(record.producer)
      || !validInstant(record.discoveredAt)
      || !validInstant(record.terminalAt)
      || Date.parse(record.terminalAt) < Date.parse(record.discoveredAt)
      || deriveAdmissionGapReceiptId(record.candidateId) !== record.receiptId
      || digestBody(record as unknown as Record<string, unknown>, "receiptDigest") !== record.receiptDigest) {
      throw new ObservationLedgerError("STATE_CORRUPT", "admission gap receipt failed validation");
    }
    return record;
  }

  private readJson<T>(path: string): T {
    try { return JSON.parse(readFileSync(path, "utf8")) as T; }
    catch { throw new ObservationLedgerError("STATE_CORRUPT", `invalid JSON state: ${path}`); }
  }

  private scan<T>(directory: string, read: (path: string) => T): AdmissionStoreScan<T> {
    const result: AdmissionStoreScan<T> = { records: [], corrupt: [] };
    if (!existsSync(directory)) return result;
    for (const name of readdirSync(directory).filter((entry) => /^[a-f0-9]{64}\.json$/.test(entry)).sort()) {
      const path = join(directory, name);
      try { result.records.push(read(path)); }
      catch (error) { result.corrupt.push({ path, error: error instanceof Error ? error.message : "state read failed" }); }
    }
    return result;
  }

  private checkpointPath(candidateId: Digest): string {
    if (!validDigest(candidateId)) throw new ObservationLedgerError("INVALID_DIGEST", "candidate digest is invalid");
    return join(this.checkpointRoot, `${candidateId.slice(7)}.json`);
  }

  private gapReceiptPath(receiptId: Digest): string {
    if (!validDigest(receiptId)) throw new ObservationLedgerError("INVALID_DIGEST", "receipt digest is invalid");
    return join(this.gapReceiptRoot, `${receiptId.slice(7)}.json`);
  }

  private withLock<T>(operation: () => T): T {
    return this.withPathLock(join(this.root, "locks", "admission-store"), operation);
  }

  private withPathLock<T>(lock: string, operation: () => T): T {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    mkdirSync(dirname(lock), { recursive: true, mode: 0o700 });
    const started = Date.now();
    while (true) {
      try { mkdirSync(lock, { mode: 0o700 }); break; }
      catch (error: any) {
        if (error?.code !== "EEXIST") throw error;
        let stale = false;
        try { stale = Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS; } catch { stale = false; }
        if (stale) { rmSync(lock, { recursive: true, force: true }); continue; }
        if (Date.now() - started >= LOCK_WAIT_MS) throw new ObservationLedgerError("LOCK_TIMEOUT", "admission store lock timed out");
        sleepSync(20);
      }
    }
    try { return operation(); }
    finally { rmSync(lock, { recursive: true, force: true }); }
  }
}
