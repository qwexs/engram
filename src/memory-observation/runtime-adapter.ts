import type { TopicDomainBinding } from "./topic-bindings.ts";
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
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  AdmissionStore,
  deriveAdmissionCandidateId,
  type AdmissionCheckpointV1,
  type AdmissionFailureStage,
  type AdmissionGapReasonCode,
} from "./admission-store.ts";
import type { Digest, JsonValue, ProducerRef, TrustedCompletedTurn } from "./ledger.ts";
import { inspectMemoryObservationAdmission, ObservationLedgerError, sanitizeEvidence, sha256 } from "./ledger.ts";
import { MAX_REPLY_CONTEXT_PAIRS, type ReplyContextResult } from "./reply-context.ts";

type Row = Record<string, unknown>;

export type RuntimeObservationBinding = {
  workspaceId: string;
  scopeClass: "self" | "managers" | "company" | "project";
  scopeId: string;
  requireOwner: boolean;
  topicDomain?: TopicDomainBinding;
  allowedChannels: readonly ("telegram" | "openclaw")[];
  admit: (
    source: TrustedCompletedTurn,
    completedAt: Date,
    transport: {
      channel: "telegram" | "openclaw";
      inboundMessageId: string;
      parentMessageId?: string;
      deliveryMessageId?: string;
    },
  ) => unknown;
  resolveReplyContext?: (params: {
    scope: TrustedCompletedTurn["scope"];
    channel: "telegram" | "openclaw";
    replyToId?: string;
    maxPairs: number;
    now: Date;
  }) => ReplyContextResult;
  recordTransportLink?: (params: {
    scope: TrustedCompletedTurn["scope"];
    channel: "telegram" | "openclaw";
    messageId: string;
    messageRole: "user" | "assistant";
    sourceTurnId: string;
    parentMessageId?: string;
  }) => unknown;
};

export type RuntimeAdapterResult =
  | { status: "ignored"; reason: string }
  | { status: "captured" | "adopted" | "attached" | "duplicate"; sourceTurnId?: string }
  | { status: "admitted"; sourceTurnId: string; result: unknown };

export const RUNTIME_ADMISSION_SPOOL_SCHEMA = "engram.memory-runtime-admission-spool.v2" as const;
const LEGACY_RUNTIME_ADMISSION_SPOOL_SCHEMA = "engram.memory-runtime-admission-spool.v1" as const;

export type RuntimeAdmissionSpoolRecordV1 = {
  schema: typeof RUNTIME_ADMISSION_SPOOL_SCHEMA;
  candidateId: Digest;
  sourceTurnId: string;
  runtimeSessionKey: string;
  bindingFingerprint: Digest;
  source: TrustedCompletedTurn | null;
  transport: {
    channel: "telegram" | "openclaw";
    inboundMessageId: string;
    parentMessageId?: string;
    deliveryMessageId?: string;
  };
  payloadDigest: Digest;
  sealedPayloadDigest: Digest;
  status: "completed" | "admitted" | "terminal";
  createdAt: string;
  updatedAt: string;
  admittedAt: string | null;
  terminalAt: string | null;
  reasonCode: string | null;
};

type LegacyRuntimeAdmissionSpoolRecordV1 = Omit<RuntimeAdmissionSpoolRecordV1, "schema" | "candidateId" | "sealedPayloadDigest" | "source"> & {
  schema: typeof LEGACY_RUNTIME_ADMISSION_SPOOL_SCHEMA;
  source: TrustedCompletedTurn;
};

export type RuntimeAdapterFaultPoint = "after_completed_spool" | "after_admission";

type PendingTurn = {
  candidateId: Digest;
  runtimeSessionKey: string;
  messageId: string;
  actorId: string;
  channel: "telegram" | "openclaw";
  replyToId?: string;
  observedAt: number;
  bindingFingerprint: Digest;
};

type AdoptedTurn = PendingTurn & {
  sourceTurnId: string;
  userText: string;
  senderIsOwner: boolean;
  bindingFingerprint: string;
};

type BoundRun = AdoptedTurn & {
  runId: string;
  sessionId?: string;
  attachedAt: number;
};

type CompletedRun = {
  runtimeSessionKey: string;
  sourceTurnId: string;
  channel: "telegram" | "openclaw";
  replyToId?: string;
  bindingFingerprint: string;
  completedAt: number;
};

export class RuntimeAdapterError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "RuntimeAdapterError";
  }
}

function row(value: unknown): Row | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : null;
}

function token(label: string, value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 2_048) {
    throw new RuntimeAdapterError("INVALID_TURN", `${label} is missing or invalid`);
  }
  return value;
}

function sharedToken(label: string, left: unknown, right: unknown): string {
  const leftValue = left === undefined ? null : token(label, left);
  const rightValue = right === undefined ? null : token(label, right);
  if (leftValue && rightValue && leftValue !== rightValue) {
    throw new RuntimeAdapterError("IDENTITY_CONFLICT", `${label} differs across runtime surfaces`);
  }
  if (!leftValue && !rightValue) throw new RuntimeAdapterError("INVALID_TURN", `${label} is missing`);
  return leftValue ?? rightValue!;
}

function optionalToken(label: string, value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  return token(label, value);
}

function sharedOptionalToken(label: string, left: unknown, right: unknown): string | undefined {
  const leftValue = optionalToken(label, left);
  const rightValue = optionalToken(label, right);
  if (leftValue && rightValue && leftValue !== rightValue) {
    throw new RuntimeAdapterError("IDENTITY_CONFLICT", `${label} differs across runtime surfaces`);
  }
  return leftValue ?? rightValue;
}

function channel(value: unknown): "telegram" | "openclaw" {
  if (value !== "telegram" && value !== "openclaw") {
    throw new RuntimeAdapterError("UNSUPPORTED_TRANSPORT", "runtime transport is unsupported");
  }
  return value;
}

function messageText(value: unknown, depth = 0): string[] {
  if (depth > 5 || value === null || value === undefined) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => messageText(item, depth + 1));
  const object = row(value);
  if (!object) return [];
  const type = typeof object.type === "string" ? object.type : "";
  if (["image", "image_url", "audio", "video", "file", "tool", "tool_result"].includes(type)) return [];
  const fragments: unknown[] = [];
  if (typeof object.text === "string") fragments.push(object.text);
  if (typeof object.output_text === "string") fragments.push(object.output_text);
  if (typeof object.content === "string" || Array.isArray(object.content)) fragments.push(object.content);
  return fragments.flatMap((item) => messageText(item, depth + 1));
}

function extractText(message: Row, maxChars: number): string {
  return messageText(message.content ?? message.text)
    .map((fragment) => fragment.trim())
    .filter(Boolean)
    .join("\n")
    .slice(0, maxChars)
    .trim();
}

function timestamp(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return value < 10_000_000_000 ? value * 1_000 : value;
}

function flushDirectory(path: string): void {
  if (process.platform === "win32") return;
  const descriptor = openSync(path, "r");
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

export class OpenClawObservationRuntimeAdapter {
  private readonly pending = new Map<string, PendingTurn>();
  private readonly adopted = new Map<string, AdoptedTurn>();
  private readonly runs = new Map<string, BoundRun>();
  private readonly completed = new Map<string, CompletedRun>();
  private readonly spoolRoot: string | null;
  private readonly admissionStore: AdmissionStore | null;

  constructor(private readonly options: {
    authority: ProducerRef;
    resolveBinding: (runtimeSessionKey: string) => RuntimeObservationBinding | null;
    classifyMissingBinding?: (runtimeSessionKey: string) => "revoked" | "unavailable";
    now?: () => Date;
    stateTtlMs?: number;
    spoolRoot?: string;
    workspace?: string;
    fault?: (point: RuntimeAdapterFaultPoint) => void;
  }) {
    if (options.stateTtlMs !== undefined && (!Number.isInteger(options.stateTtlMs) || options.stateTtlMs < 1)) {
      throw new RuntimeAdapterError("INVALID_CONFIG", "runtime adapter state TTL is invalid");
    }
    this.spoolRoot = options.spoolRoot ? resolve(options.spoolRoot) : null;
    this.admissionStore = options.workspace ? new AdmissionStore(options.workspace, options.authority) : null;
  }

  captureMessageReceived(eventValue: unknown, contextValue: unknown): RuntimeAdapterResult {
    const now = this.now();
    this.sweep(now.getTime());
    const event = row(eventValue) ?? {};
    const context = row(contextValue) ?? {};
    const runtimeSessionKey = sharedToken("sessionKey", event.sessionKey, context.sessionKey);
    const binding = this.options.resolveBinding(runtimeSessionKey);
    if (!binding) return { status: "ignored", reason: "scope_disabled" };
    const runtimeChannel = channel(context.channelId ?? event.channel);
    if (!binding.allowedChannels.includes(runtimeChannel)) return { status: "ignored", reason: "transport_disabled" };
    const replyToId = sharedOptionalToken("replyToIdFull", event.replyToIdFull, context.replyToIdFull)
      ?? sharedOptionalToken("replyToId", event.replyToId, context.replyToId);
    const messageId = sharedToken("messageId", event.messageId, context.messageId);
    const actorId = sharedToken("senderId", event.senderId, context.senderId);
    const bindingFingerprint = this.bindingFingerprint(binding);
    const scope: TrustedCompletedTurn["scope"] = {
      workspaceId: binding.workspaceId,
      runtimeSessionKey,
      scopeClass: binding.scopeClass,
      scopeId: binding.scopeId,
    };
    const candidateId = deriveAdmissionCandidateId({
      workspaceId: binding.workspaceId,
      runtimeSessionKey,
      channel: runtimeChannel,
      inboundMessageId: messageId,
    });
    let checkpoint: AdmissionCheckpointV1 | undefined;
    let checkpointStatus: "written" | "duplicate" | undefined;
    try {
      const recorded = this.admissionStore?.recordCheckpoint({
        scope,
        bindingFingerprint,
        channel: runtimeChannel,
        inboundMessageId: messageId,
        actorId,
        replyToId: replyToId ?? null,
        sourceTurnId: null,
        runId: null,
        sessionId: null,
        sourceText: null,
        stage: "received",
        now,
      });
      checkpoint = recorded?.checkpoint;
      checkpointStatus = recorded?.status;
    } catch (error) {
      if (error instanceof ObservationLedgerError && error.code === "TERMINAL_DISPOSITION") {
        return { status: "duplicate" };
      }
      if (error instanceof ObservationLedgerError && error.code === "CONTENT_CONFLICT") {
        const current = this.admissionStore?.readCheckpoint(candidateId);
        if (current) {
          this.publishGap(current, this.failureStage(current), "identity_conflict", now);
          this.pending.delete(runtimeSessionKey);
          this.adopted.delete(runtimeSessionKey);
          for (const [runId, run] of this.runs) if (run.candidateId === candidateId) this.runs.delete(runId);
        }
      }
      throw error;
    }
    if (checkpointStatus === "duplicate" && checkpoint?.stage !== "received") {
      return { status: "duplicate", ...(checkpoint?.sourceTurnId ? { sourceTurnId: checkpoint.sourceTurnId } : {}) };
    }
    const candidate: PendingTurn = {
      candidateId,
      runtimeSessionKey,
      messageId,
      actorId,
      channel: runtimeChannel,
      ...(replyToId ? { replyToId } : {}),
      observedAt: timestamp(event.timestamp, now.getTime()),
      bindingFingerprint,
    };
    const current = this.pending.get(runtimeSessionKey);
    if (current) {
      if (this.samePending(current, candidate)) return { status: "duplicate" };
      if (checkpoint) this.publishGap(checkpoint, "received", "identity_ambiguous", now);
      throw new RuntimeAdapterError("AMBIGUOUS_TURN", "multiple inbound turns compete for one runtime session");
    }
    if (this.adopted.has(runtimeSessionKey)) {
      if (checkpoint) this.publishGap(checkpoint, "received", "identity_ambiguous", now);
      throw new RuntimeAdapterError("AMBIGUOUS_TURN", "an adopted turn is already waiting for a run");
    }
    this.pending.set(runtimeSessionKey, candidate);
    return { status: "captured" };
  }

  adoptPersistedUser(eventValue: unknown, contextValue: unknown): RuntimeAdapterResult {
    const now = this.now();
    this.sweep(now.getTime());
    const event = row(eventValue) ?? {};
    const context = row(contextValue) ?? {};
    const message = row(event.message);
    if (!message || message.role !== "user") throw new RuntimeAdapterError("INVALID_TURN", "persisted message is not a user turn");
    const metadata = row(message.__openclaw);
    const transport = row(metadata?.transport);
    const runtimeSessionKey = sharedToken("sessionKey", event.sessionKey, context.sessionKey);
    const binding = this.options.resolveBinding(runtimeSessionKey);
    if (!binding) return { status: "ignored", reason: "scope_disabled" };
    const transportChannel = channel(transport?.channel);
    const messageId = token("transport.messageId", transport?.messageId);
    const transportReplyToId = optionalToken("transport.replyToId", transport?.replyToId);
    const senderIsOwner = metadata?.senderIsOwner;
    if (typeof senderIsOwner !== "boolean") throw new RuntimeAdapterError("INVALID_TURN", "persisted sender ownership is missing");
    if (binding.requireOwner && !senderIsOwner) throw new RuntimeAdapterError("OWNER_REQUIRED", "runtime scope requires an owner turn");
    const sourceTurnId = token("sourceTurnId", message.idempotencyKey);
    if (!/^channel-user:v1:[a-f0-9]{64}$/.test(sourceTurnId)) {
      throw new RuntimeAdapterError("INVALID_TURN", "persisted source identity is invalid");
    }
    const userText = extractText(message, 50_000);
    if (!userText) throw new RuntimeAdapterError("INVALID_TURN", "persisted user turn has no text evidence");
    const sanitizedUserText = String(sanitizeEvidence(userText as unknown as JsonValue));
    const durableProgressed = this.admissionStore?.findOpenBySession(runtimeSessionKey, [
      "persisted",
      "run_attached",
      "completion_observed",
      "ledger_admitted",
      "terminal_gap",
    ]).filter((entry) => entry.channel === transportChannel && entry.inboundMessageId === messageId) ?? [];
    if (durableProgressed.length > 1) {
      for (const entry of durableProgressed) this.publishGap(entry, this.failureStage(entry), "identity_ambiguous", now);
      throw new RuntimeAdapterError("AMBIGUOUS_TURN", "multiple durable candidates match one persisted turn");
    }
    if (durableProgressed[0]) {
      if (durableProgressed[0].stage === "terminal_gap") return { status: "duplicate" };
      if (durableProgressed[0].stage === "ledger_admitted"
        && durableProgressed[0].sourceTurnId === sourceTurnId
        && durableProgressed[0].replyToId === (transportReplyToId ?? null)) {
        return { status: "duplicate", sourceTurnId };
      }
      if (durableProgressed[0].sourceTurnId === sourceTurnId
        && durableProgressed[0].sourceText === sanitizedUserText
        && durableProgressed[0].replyToId === (transportReplyToId ?? null)) {
        return { status: "duplicate", ...(durableProgressed[0].sourceTurnId ? { sourceTurnId: durableProgressed[0].sourceTurnId } : {}) };
      }
      this.publishGap(durableProgressed[0], this.failureStage(durableProgressed[0]), "identity_conflict", now);
      throw new RuntimeAdapterError("IDENTITY_CONFLICT", "persisted source identity changed after durable progress");
    }
    const current = this.adopted.get(runtimeSessionKey);
    if (current) {
      if (current.sourceTurnId === sourceTurnId
        && current.messageId === messageId
        && current.channel === transportChannel
        && current.userText === sanitizedUserText
        && current.replyToId === transportReplyToId) {
        return { status: "duplicate", sourceTurnId };
      }
      this.publishBoundGap(current, "persisted", "identity_conflict", now);
      throw new RuntimeAdapterError("AMBIGUOUS_TURN", "multiple persisted turns compete for one runtime session");
    }
    const durablePending = this.admissionStore?.findOpenBySession(runtimeSessionKey, ["received"])
      .filter((entry) => entry.channel === transportChannel && entry.inboundMessageId === messageId) ?? [];
    if (!this.pending.has(runtimeSessionKey) && durablePending.length > 1) {
      for (const entry of durablePending) this.publishGap(entry, "received", "identity_ambiguous", now);
      throw new RuntimeAdapterError("AMBIGUOUS_TURN", "multiple durable inbound turns match one persisted turn");
    }
    const pending = this.pending.get(runtimeSessionKey) ?? (durablePending[0] ? this.pendingFromCheckpoint(durablePending[0]) : null);
    if (!pending) throw new RuntimeAdapterError("TURN_NOT_FOUND", "persisted user turn has no trusted inbound capture");
    if (pending.channel !== transportChannel || pending.messageId !== messageId) {
      this.publishBoundGap(pending, "received", "identity_conflict", now);
      throw new RuntimeAdapterError("IDENTITY_CONFLICT", "persisted turn does not match trusted inbound identity");
    }
    if (pending.replyToId && transportReplyToId && pending.replyToId !== transportReplyToId) {
      this.publishBoundGap(pending, "received", "identity_conflict", now);
      throw new RuntimeAdapterError("IDENTITY_CONFLICT", "persisted reply target does not match trusted inbound identity");
    }
    const adopted: AdoptedTurn = {
      ...pending,
      ...(transportReplyToId ? { replyToId: transportReplyToId } : {}),
      sourceTurnId,
      userText: sanitizedUserText,
      senderIsOwner,
      bindingFingerprint: pending.bindingFingerprint,
    };
    this.recordCheckpoint(adopted, "persisted", now);
    this.pending.delete(runtimeSessionKey);
    this.adopted.set(runtimeSessionKey, adopted);
    return { status: "adopted", sourceTurnId };
  }

  attachRun(_eventValue: unknown, contextValue: unknown): RuntimeAdapterResult {
    const now = this.now();
    this.sweep(now.getTime());
    const context = row(contextValue) ?? {};
    if (context.trigger !== "user") return { status: "ignored", reason: "non_user_trigger" };
    const runId = token("runId", context.runId);
    const runtimeSessionKey = token("sessionKey", context.sessionKey);
    const current = this.runs.get(runId);
    if (current) {
      if (current.runtimeSessionKey === runtimeSessionKey) return { status: "duplicate", sourceTurnId: current.sourceTurnId };
      throw new RuntimeAdapterError("IDENTITY_CONFLICT", "run identity crossed runtime sessions");
    }
    const progressedRuns = this.admissionStore?.findOpenByRun(runId, ["run_attached", "completion_observed", "ledger_admitted", "terminal_gap"])
      .filter((entry) => entry.scope.runtimeSessionKey === runtimeSessionKey) ?? [];
    if (progressedRuns.length > 1) {
      for (const entry of progressedRuns) this.publishGap(entry, this.failureStage(entry), "identity_ambiguous", now);
      throw new RuntimeAdapterError("AMBIGUOUS_TURN", "multiple durable candidates share one run identity");
    }
    if (progressedRuns[0]) {
      return { status: "duplicate", ...(progressedRuns[0].sourceTurnId ? { sourceTurnId: progressedRuns[0].sourceTurnId } : {}) };
    }
    const durableAdopted = this.admissionStore?.findOpenBySession(runtimeSessionKey, ["persisted"]) ?? [];
    if (!this.adopted.has(runtimeSessionKey) && durableAdopted.length > 1) {
      for (const entry of durableAdopted) this.publishGap(entry, "persisted", "identity_ambiguous", now);
      throw new RuntimeAdapterError("AMBIGUOUS_TURN", "multiple durable persisted turns compete for one run");
    }
    const adopted = this.adopted.get(runtimeSessionKey) ?? (durableAdopted[0] ? this.adoptedFromCheckpoint(durableAdopted[0]) : null);
    if (!adopted) throw new RuntimeAdapterError("TURN_NOT_FOUND", "run has no adopted trusted user turn");
    this.adopted.delete(runtimeSessionKey);
    const bound = {
      ...adopted,
      runId,
      ...(typeof context.sessionId === "string" && context.sessionId ? { sessionId: context.sessionId } : {}),
      attachedAt: now.getTime(),
    };
    this.recordCheckpoint(bound, "run_attached", now);
    this.runs.set(runId, bound);
    return { status: "attached", sourceTurnId: adopted.sourceTurnId };
  }

  completeAgentEnd(eventValue: unknown, contextValue: unknown): RuntimeAdapterResult {
    const now = this.now();
    this.sweep(now.getTime());
    const event = row(eventValue) ?? {};
    const context = row(contextValue) ?? {};
    const runId = sharedToken("runId", event.runId, context.runId);
    const runtimeSessionKey = token("sessionKey", context.sessionKey);
    const bound = this.runs.get(runId) ?? this.boundFromDurableRun(runId, runtimeSessionKey);
    if (!bound) return { status: "ignored", reason: "unbound_run" };
    try {
      if (context.trigger !== "user" || event.success !== true || bound.runtimeSessionKey !== runtimeSessionKey) {
        this.publishBoundGap(bound, "run_attached", event.success === true ? "identity_conflict" : "run_failed", now);
        return { status: "ignored", reason: event.success === true ? "runtime_identity_mismatch" : "run_failed" };
      }
      const binding = this.options.resolveBinding(runtimeSessionKey);
      if (!binding || this.bindingFingerprint(binding) !== bound.bindingFingerprint) {
        if (!binding && this.missingBindingState(runtimeSessionKey) === "unavailable") {
          throw new RuntimeAdapterError("BINDING_UNAVAILABLE", "runtime observation binding is temporarily unavailable");
        }
        this.publishBoundGap(bound, "run_attached", "scope_revoked", now);
        throw new RuntimeAdapterError("SCOPE_REVOKED", "runtime observation scope changed before admission");
      }
      const messages = Array.isArray(event.messages) ? event.messages : [];
      const sourceIndexes = messages.map((message, index) => ({ message: row(message), index }))
        .filter((entry) => entry.message?.role === "user" && entry.message.idempotencyKey === bound.sourceTurnId);
      if (sourceIndexes.length !== 1) {
        this.publishBoundGap(bound, "run_attached", "evidence_missing", now);
        throw new RuntimeAdapterError("TURN_NOT_FOUND", "terminal transcript does not contain exactly one bound source turn");
      }
      const terminalUserText = extractText(sourceIndexes[0]!.message!, 50_000);
      if (!terminalUserText || String(sanitizeEvidence(terminalUserText as unknown as JsonValue)) !== bound.userText) {
        this.publishBoundGap(bound, "run_attached", "identity_conflict", now);
        throw new RuntimeAdapterError("IDENTITY_CONFLICT", "terminal transcript source content changed after durable persistence");
      }
      let assistantText = "";
      for (const value of messages.slice(sourceIndexes[0]!.index + 1)) {
        const message = row(value);
        if (message?.role !== "assistant") continue;
        const text = extractText(message, 50_000);
        if (text) assistantText = text;
      }
      if (!assistantText) {
        this.publishBoundGap(bound, "run_attached", "evidence_missing", now);
        throw new RuntimeAdapterError("INVALID_TURN", "successful run has no terminal assistant text");
      }
      const completionCheckpoint = this.recordCheckpoint(bound, "completion_observed", now);
      const completionAt = completionCheckpoint ? new Date(completionCheckpoint.updatedAt) : now;
      const result = this.admitCompletedTurn({ bound, binding, runtimeSessionKey, assistantText, now: completionAt });
      this.completed.set(runId, {
        runtimeSessionKey,
        sourceTurnId: bound.sourceTurnId,
        channel: bound.channel,
        ...(bound.replyToId ? { replyToId: bound.replyToId } : {}),
        bindingFingerprint: bound.bindingFingerprint,
        completedAt: completionAt.getTime(),
      });
      return result;
    } finally {
      this.runs.delete(runId);
    }
  }

  completeMessageSent(eventValue: unknown, contextValue: unknown): RuntimeAdapterResult {
    const now = this.now();
    this.sweep(now.getTime());
    const event = row(eventValue) ?? {};
    const context = row(contextValue) ?? {};
    const sourceReply = row(event.sourceReply);
    if (!sourceReply) return { status: "ignored", reason: "not_source_reply" };
    if (sourceReply.final !== true) return { status: "ignored", reason: "non_terminal_source_reply" };
    const runId = sharedToken("runId", event.runId, context.runId);
    const runtimeSessionKey = sharedToken("sessionKey", event.sessionKey, context.sessionKey);
    const bound = this.runs.get(runId) ?? this.boundFromDurableRun(runId, runtimeSessionKey);
    if (!bound) return { status: "ignored", reason: "unbound_run" };
    try {
      if (event.success !== true) {
        this.publishBoundGap(bound, "run_attached", "delivery_failed", now);
        return { status: "ignored", reason: "delivery_failed" };
      }
      const sourceTurnId = token("sourceTurnId", sourceReply.sourceTurnId);
      token("toolCallId", sourceReply.toolCallId);
      if (
        bound.runtimeSessionKey !== runtimeSessionKey ||
        bound.sourceTurnId !== sourceTurnId
      ) {
        this.publishBoundGap(bound, "run_attached", "identity_conflict", now);
        throw new RuntimeAdapterError(
          "IDENTITY_CONFLICT",
          "delivered source reply does not match the bound run",
        );
      }
      const binding = this.options.resolveBinding(runtimeSessionKey);
      if (!binding || this.bindingFingerprint(binding) !== bound.bindingFingerprint) {
        if (!binding && this.missingBindingState(runtimeSessionKey) === "unavailable") {
          throw new RuntimeAdapterError("BINDING_UNAVAILABLE", "runtime observation binding is temporarily unavailable");
        }
        this.publishBoundGap(bound, "run_attached", "scope_revoked", now);
        throw new RuntimeAdapterError(
          "SCOPE_REVOKED",
          "runtime observation scope changed before admission",
        );
      }
      const assistantText = typeof event.content === "string"
        ? event.content.slice(0, 50_000).trim()
        : "";
      if (!assistantText) {
        this.publishBoundGap(bound, "run_attached", "evidence_missing", now);
        throw new RuntimeAdapterError(
          "INVALID_TURN",
          "delivered source reply has no assistant text",
        );
      }
      const deliveryMessageId = optionalToken("messageId", event.messageId);
      const completionCheckpoint = this.recordCheckpoint(bound, "completion_observed", now);
      const completionAt = completionCheckpoint ? new Date(completionCheckpoint.updatedAt) : now;
      return this.admitCompletedTurn({
        bound,
        binding,
        runtimeSessionKey,
        assistantText,
        now: completionAt,
        ...(deliveryMessageId ? { deliveryMessageId } : {}),
      });
    } finally {
      this.runs.delete(runId);
    }
  }

  recordMessageSent(eventValue: unknown, contextValue: unknown): RuntimeAdapterResult {
    const now = this.now();
    this.sweep(now.getTime());
    const event = row(eventValue) ?? {};
    const context = row(contextValue) ?? {};
    if (event.success !== true) return { status: "ignored", reason: "delivery_failed" };
    const runId = sharedToken("runId", event.runId, context.runId);
    const runtimeSessionKey = sharedToken("sessionKey", event.sessionKey, context.sessionKey);
    const messageId = optionalToken("messageId", event.messageId);
    if (!messageId) return { status: "ignored", reason: "delivery_message_id_missing" };
    const completed = this.completed.get(runId);
    if (!completed) return { status: "ignored", reason: "unbound_completed_run" };
    if (completed.runtimeSessionKey !== runtimeSessionKey) {
      throw new RuntimeAdapterError("IDENTITY_CONFLICT", "delivered message crossed runtime sessions");
    }
    const binding = this.options.resolveBinding(runtimeSessionKey);
    if (!binding || this.bindingFingerprint(binding) !== completed.bindingFingerprint) {
      throw new RuntimeAdapterError("SCOPE_REVOKED", "runtime observation scope changed before delivery link");
    }
    if (!binding.recordTransportLink) return { status: "ignored", reason: "transport_link_disabled" };
    binding.recordTransportLink({
      scope: {
        workspaceId: binding.workspaceId,
        runtimeSessionKey,
        scopeClass: binding.scopeClass,
        scopeId: binding.scopeId,
      },
      channel: completed.channel,
      messageId,
      messageRole: "assistant",
      sourceTurnId: completed.sourceTurnId,
      ...(completed.replyToId ? { parentMessageId: completed.replyToId } : {}),
    });
    return { status: "attached", sourceTurnId: completed.sourceTurnId };
  }

  dropRun(runId: string | undefined): void {
    if (runId) this.runs.delete(runId);
  }

  stateCounts(): { pending: number; adopted: number; runs: number } {
    return { pending: this.pending.size, adopted: this.adopted.size, runs: this.runs.size };
  }

  reconcileCompleted(now = this.now()): { admitted: number; retained: number; terminal: number } {
    const result = { admitted: 0, retained: 0, terminal: 0 };
    for (const record of this.scanSpool().records.filter((entry) => entry.status === "completed")) {
      try {
        const outcome = this.admissionStore
          ? this.admissionStore.withCandidateDisposition(record.candidateId, () => this.reconcileCompletedRecord(record, now))
          : this.reconcileCompletedRecord(record, now);
        result[outcome]++;
      } catch {
        result.retained++;
      }
    }
    return result;
  }

  private reconcileCompletedRecord(record: RuntimeAdmissionSpoolRecordV1, now: Date): "admitted" | "retained" | "terminal" {
    const terminalGap = this.admissionStore?.readGapReceiptForCandidate(record.candidateId);
    if (terminalGap) {
      this.finishSpool(record, "terminal", now, `admission_gap_${terminalGap.reasonCode}`);
      return "terminal";
    }
    if (!record.source) return "retained";
    const checkpoint = this.admissionStore?.readCheckpoint(record.candidateId) ?? null;
    const binding = this.options.resolveBinding(record.runtimeSessionKey);
    const durableAdmission = this.durableAdmissionState(record.source);
    if (durableAdmission === "admitted") {
      this.finishSpool(record, "admitted", now, "ledger_admission_confirmed_after_recovery");
      this.markCheckpointAdmitted(record.candidateId, now);
      return "admitted";
    }
    if (durableAdmission === "partial") {
      if (!binding || this.bindingFingerprint(binding) !== record.bindingFingerprint) return "retained";
    } else if (durableAdmission === "unavailable") {
      return "retained";
    } else if (durableAdmission === "conflict") {
      if (!checkpoint) return "retained";
      this.publishCheckpointGapLocked(record.candidateId, "completion_observed", "identity_conflict", now);
      this.finishSpool(record, "terminal", now, "durable_admission_identity_conflict");
      return "terminal";
    }
    if (!binding) {
      if (this.missingBindingState(record.runtimeSessionKey) === "unavailable") return "retained";
      if (!checkpoint) return "retained";
      this.publishCheckpointGapLocked(record.candidateId, "completion_observed", "scope_revoked", now);
      this.finishSpool(record, "terminal", now, "scope_revoked_before_admission");
      return "terminal";
    }
    if (this.bindingFingerprint(binding) !== record.bindingFingerprint) {
      if (!checkpoint) return "retained";
      this.publishCheckpointGapLocked(record.candidateId, "completion_observed", "scope_revoked", now);
      this.finishSpool(record, "terminal", now, "scope_revoked_before_admission");
      return "terminal";
    }
    try {
      binding.admit(record.source, new Date(record.source.sourceCompletedAt), record.transport);
      this.finishSpool(record, "admitted", now, "ledger_admitted_after_recovery");
      this.markCheckpointAdmitted(record.candidateId, now);
      return "admitted";
    } catch {
      const afterFailure = this.durableAdmissionState(record.source);
      if (afterFailure === "admitted") {
        this.finishSpool(record, "admitted", now, "ledger_admission_confirmed_after_recovery");
        this.markCheckpointAdmitted(record.candidateId, now);
        return "admitted";
      }
      if (afterFailure === "partial" || afterFailure === "unavailable") return "retained";
      if (!checkpoint || Date.parse(checkpoint.expiresAt) > now.getTime()) return "retained";
      this.publishGapLocked(checkpoint, "completion_observed", afterFailure === "conflict" ? "identity_conflict" : "evidence_invalid", now);
      this.finishSpool(record, "terminal", now, afterFailure === "conflict" ? "durable_admission_identity_conflict" : "admission_retry_expired");
      return "terminal";
    }
  }

  listSpool(): RuntimeAdmissionSpoolRecordV1[] {
    return this.scanSpool().records;
  }

  scanSpool(): { records: RuntimeAdmissionSpoolRecordV1[]; corrupt: string[] } {
    if (!this.spoolRoot || !existsSync(this.spoolRoot)) return { records: [], corrupt: [] };
    const records: RuntimeAdmissionSpoolRecordV1[] = [];
    const corrupt: string[] = [];
    for (const name of readdirSync(this.spoolRoot).filter((entry) => /^[a-f0-9]{64}\.json$/.test(entry)).sort()) {
      try { records.push(this.readSpool(join(this.spoolRoot, name))); }
      catch { corrupt.push(join(this.spoolRoot, name)); }
    }
    return { records, corrupt };
  }

  reconcileOrphanedCheckpoints(
    now = this.now(),
    mode: "startup" | "periodic" = "startup",
  ): { admitted: number; gaps: number; retained: number; corrupt: number; errors: number } {
    const result = { admitted: 0, gaps: 0, retained: 0, corrupt: 0, errors: 0 };
    if (!this.admissionStore) return result;
    const scan = this.admissionStore.scanCheckpoints();
    result.corrupt = scan.corrupt.length;
    const spools = new Map(this.listSpool().map((record) => [record.candidateId, record]));
    for (const checkpoint of scan.records) {
      try {
        if (checkpoint.stage === "ledger_admitted" || checkpoint.stage === "terminal_gap") continue;
        const spool = spools.get(checkpoint.candidateId);
        if (spool?.status === "admitted") {
          this.markCheckpointAdmitted(checkpoint.candidateId, now);
          result.admitted++;
          continue;
        }
        if (spool?.status === "completed") { result.retained++; continue; }
        if (mode === "periodic" && checkpoint.stage !== "completion_observed" && Date.parse(checkpoint.expiresAt) > now.getTime()) {
          result.retained++;
          continue;
        }
        const failureStage = checkpoint.stage === "completion_observed" ? "completion_observed" : checkpoint.stage;
        const reason = checkpoint.stage === "completion_observed"
          ? "evidence_missing"
          : mode === "startup" ? "restart_before_completion" : "expired_before_completion";
        this.publishGap(checkpoint, failureStage, reason, now);
        result.gaps++;
      } catch {
        result.errors++;
      }
    }
    return result;
  }

  private now(): Date { return this.options.now?.() ?? new Date(); }
  private stateTtlMs(): number { return this.options.stateTtlMs ?? 30 * 60 * 1_000; }

  private missingBindingState(runtimeSessionKey: string): "revoked" | "unavailable" {
    return this.options.classifyMissingBinding?.(runtimeSessionKey) ?? "revoked";
  }

  private durableAdmissionState(source: TrustedCompletedTurn): "absent" | "partial" | "admitted" | "conflict" | "unavailable" {
    if (!this.options.workspace) return "absent";
    try { return inspectMemoryObservationAdmission(this.options.workspace, source); }
    catch (error) {
      return error instanceof ObservationLedgerError && error.code === "CONTENT_CONFLICT"
        ? "conflict"
        : "unavailable";
    }
  }

  private sweep(nowMs: number): void {
    const cutoff = nowMs - this.stateTtlMs();
    const now = new Date(nowMs);
    for (const [key, value] of this.pending) if (value.observedAt < cutoff) {
      this.publishBoundGap(value, "received", "expired_before_completion", now);
      this.pending.delete(key);
    }
    for (const [key, value] of this.adopted) if (value.observedAt < cutoff) {
      this.publishBoundGap(value, "persisted", "expired_before_completion", now);
      this.adopted.delete(key);
    }
    for (const [key, value] of this.runs) if (value.attachedAt < cutoff) {
      this.publishBoundGap(value, "run_attached", "expired_before_completion", now);
      this.runs.delete(key);
    }
    for (const [key, value] of this.completed) if (value.completedAt < cutoff) this.completed.delete(key);
  }

  private pendingFromCheckpoint(checkpoint: AdmissionCheckpointV1): PendingTurn {
    return {
      candidateId: checkpoint.candidateId,
      runtimeSessionKey: checkpoint.scope.runtimeSessionKey,
      messageId: checkpoint.inboundMessageId,
      actorId: checkpoint.actorId,
      channel: checkpoint.channel,
      ...(checkpoint.replyToId ? { replyToId: checkpoint.replyToId } : {}),
      observedAt: Date.parse(checkpoint.createdAt),
      bindingFingerprint: checkpoint.bindingFingerprint,
    };
  }

  private adoptedFromCheckpoint(checkpoint: AdmissionCheckpointV1): AdoptedTurn {
    if (!checkpoint.sourceTurnId || !checkpoint.sourceText) {
      throw new RuntimeAdapterError("STATE_CORRUPT", "persisted admission checkpoint lacks source evidence");
    }
    return {
      ...this.pendingFromCheckpoint(checkpoint),
      sourceTurnId: checkpoint.sourceTurnId,
      userText: checkpoint.sourceText,
      senderIsOwner: true,
    };
  }

  private boundFromDurableRun(runId: string, runtimeSessionKey: string): BoundRun | null {
    if (!this.admissionStore) return null;
    const matches = this.admissionStore.findOpenByRun(runId, ["run_attached", "completion_observed"])
      .filter((entry) => entry.scope.runtimeSessionKey === runtimeSessionKey);
    if (matches.length > 1) {
      const now = this.now();
      for (const checkpoint of matches) {
        const failureStage: AdmissionFailureStage = checkpoint.stage === "completion_observed" ? "completion_observed" : "run_attached";
        this.publishGap(checkpoint, failureStage, "identity_ambiguous", now);
      }
      throw new RuntimeAdapterError("AMBIGUOUS_TURN", "multiple durable turns share one run identity");
    }
    if (!matches[0]) return null;
    const adopted = this.adoptedFromCheckpoint(matches[0]);
    return {
      ...adopted,
      runId,
      ...(matches[0].sessionId ? { sessionId: matches[0].sessionId } : {}),
      attachedAt: Date.parse(matches[0].updatedAt),
    };
  }

  private recordCheckpoint(
    turn: PendingTurn & Partial<Pick<AdoptedTurn, "sourceTurnId" | "userText">> & Partial<Pick<BoundRun, "runId" | "sessionId">>,
    stage: AdmissionCheckpointV1["stage"],
    now: Date,
    stripSource = false,
  ): AdmissionCheckpointV1 | null {
    if (!this.admissionStore) return null;
    const current = this.admissionStore.readCheckpoint(turn.candidateId);
    if (!current) throw new RuntimeAdapterError("STATE_CORRUPT", "durable admission checkpoint is missing");
    return this.admissionStore.recordCheckpoint({
      scope: current.scope,
      bindingFingerprint: turn.bindingFingerprint,
      channel: turn.channel,
      inboundMessageId: turn.messageId,
      actorId: turn.actorId,
      replyToId: turn.replyToId ?? null,
      sourceTurnId: turn.sourceTurnId ?? current.sourceTurnId,
      runId: turn.runId ?? current.runId,
      sessionId: turn.sessionId ?? current.sessionId,
      sourceText: stripSource ? null : turn.userText ?? current.sourceText,
      stage,
      now,
    }).checkpoint;
  }

  private markCheckpointAdmitted(candidateId: Digest, now: Date): void {
    if (!this.admissionStore) return;
    const current = this.admissionStore.readCheckpoint(candidateId);
    if (!current || current.stage === "ledger_admitted") return;
    this.recordCheckpoint(this.turnFromCheckpoint(current), "ledger_admitted", now, true);
  }

  private publishCheckpointGap(candidateId: Digest, failureStage: AdmissionFailureStage, reasonCode: AdmissionGapReasonCode, now: Date): void {
    const checkpoint = this.admissionStore?.readCheckpoint(candidateId);
    if (checkpoint) this.publishGap(checkpoint, failureStage, reasonCode, now);
  }

  private publishCheckpointGapLocked(candidateId: Digest, failureStage: AdmissionFailureStage, reasonCode: AdmissionGapReasonCode, now: Date): void {
    const checkpoint = this.admissionStore?.readCheckpoint(candidateId);
    if (checkpoint) this.publishGapLocked(checkpoint, failureStage, reasonCode, now);
  }

  private publishBoundGap(
    turn: PendingTurn & Partial<Pick<AdoptedTurn, "sourceTurnId" | "userText">> & Partial<Pick<BoundRun, "runId" | "sessionId">>,
    failureStage: AdmissionFailureStage,
    reasonCode: AdmissionGapReasonCode,
    now: Date,
  ): void {
    this.publishCheckpointGap(turn.candidateId, failureStage, reasonCode, now);
  }

  private publishGap(checkpoint: AdmissionCheckpointV1, failureStage: AdmissionFailureStage, reasonCode: AdmissionGapReasonCode, now: Date): void {
    if (!this.admissionStore || checkpoint.stage === "ledger_admitted" || checkpoint.stage === "terminal_gap") return;
    this.admissionStore.withCandidateDisposition(checkpoint.candidateId, () => {
      this.publishGapLocked(checkpoint, failureStage, reasonCode, now);
    });
  }

  private publishGapLocked(checkpoint: AdmissionCheckpointV1, failureStage: AdmissionFailureStage, reasonCode: AdmissionGapReasonCode, now: Date): void {
    if (!this.admissionStore) return;
    const current = this.admissionStore.readCheckpoint(checkpoint.candidateId);
    if (!current || current.stage === "ledger_admitted" || current.stage === "terminal_gap") return;
    const spool = this.scanSpool().records.find((record) => record.candidateId === checkpoint.candidateId && record.status === "completed");
    if (spool?.source) {
      const admission = this.durableAdmissionState(spool.source);
      if (admission === "admitted") {
        this.finishSpool(spool, "admitted", now, "ledger_admission_confirmed_before_gap");
        this.markCheckpointAdmitted(checkpoint.candidateId, now);
        return;
      }
      if (admission === "partial" || admission === "unavailable") return;
    }
    this.admissionStore.publishGapReceipt({
      checkpoint: current,
      failureStage: current.checkpointDigest === checkpoint.checkpointDigest ? failureStage : this.failureStage(current),
      reasonCode,
      terminalAt: now,
    });
  }

  private failureStage(checkpoint: AdmissionCheckpointV1): AdmissionFailureStage {
    return checkpoint.stage === "persisted" || checkpoint.stage === "run_attached" || checkpoint.stage === "completion_observed"
      ? checkpoint.stage
      : "received";
  }

  private turnFromCheckpoint(checkpoint: AdmissionCheckpointV1): PendingTurn & Partial<Pick<AdoptedTurn, "sourceTurnId" | "userText">> & Partial<Pick<BoundRun, "runId" | "sessionId">> {
    return {
      ...this.pendingFromCheckpoint(checkpoint),
      ...(checkpoint.sourceTurnId ? { sourceTurnId: checkpoint.sourceTurnId } : {}),
      ...(checkpoint.sourceText ? { userText: checkpoint.sourceText } : {}),
      ...(checkpoint.runId ? { runId: checkpoint.runId } : {}),
      ...(checkpoint.sessionId ? { sessionId: checkpoint.sessionId } : {}),
    };
  }

  private samePending(left: PendingTurn, right: PendingTurn): boolean {
    return left.runtimeSessionKey === right.runtimeSessionKey
      && left.messageId === right.messageId
      && left.actorId === right.actorId
      && left.channel === right.channel
      && left.replyToId === right.replyToId;
  }

  private admitCompletedTurn(params: {
    bound: BoundRun;
    binding: RuntimeObservationBinding;
    runtimeSessionKey: string;
    assistantText: string;
    now: Date;
    deliveryMessageId?: string;
  }): RuntimeAdapterResult {
    const scope: TrustedCompletedTurn["scope"] = {
      workspaceId: params.binding.workspaceId,
      runtimeSessionKey: params.runtimeSessionKey,
      scopeClass: params.binding.scopeClass,
      scopeId: params.binding.scopeId,
    };
    const replyContext = params.bound.replyToId
      ? params.binding.resolveReplyContext?.({
        scope,
        channel: params.bound.channel,
        replyToId: params.bound.replyToId,
        maxPairs: MAX_REPLY_CONTEXT_PAIRS,
        now: params.now,
      }) ?? {
        status: "partial" as const,
        requestedReplyToId: params.bound.replyToId,
        maxPairs: MAX_REPLY_CONTEXT_PAIRS,
        pairs: [],
        reasonCode: "reply_resolver_unavailable",
      }
      : null;
    const evidenceDigest = sha256({
      sourceTurnId: params.bound.sourceTurnId,
      userText: params.bound.userText,
      assistantText: params.assistantText,
      ...(replyContext ? { replyContext } : {}),
    });
    const source: TrustedCompletedTurn = {
      sourceTurnId: params.bound.sourceTurnId,
      scope,
      sourceCompletedAt: params.now.toISOString(),
      authority: this.options.authority,
      evidenceRefs: [
        { kind: "source-turn", ref: params.bound.sourceTurnId, digest: evidenceDigest },
        ...(replyContext?.pairs.map((pair) => ({
          kind: "message" as const,
          ref: `${params.runtimeSessionKey}#${pair.transportMessageId}`,
          digest: pair.evidenceDigest,
        })) ?? []),
      ],
      redactedEvidence: sanitizeEvidence({
        source: { role: "user", text: params.bound.userText,
          ...(params.binding.topicDomain ? { actorId: params.bound.actorId, attribution: "speaker-only" } : {}) },
        outcome: { role: "assistant", text: params.assistantText },
        ...(replyContext ? { replyContext } : {}),
      } as unknown as JsonValue),
      trustedInputs: [
        "completed-source-turn",
        "runtime-session-key",
        "workspace-binding",
        "source-completion-time",
      ],
    };
    const transport = {
      channel: params.bound.channel,
      inboundMessageId: params.bound.messageId,
      ...(params.bound.replyToId ? { parentMessageId: params.bound.replyToId } : {}),
      ...(params.deliveryMessageId ? { deliveryMessageId: params.deliveryMessageId } : {}),
    };
    const admit = (): RuntimeAdapterResult => {
      if (this.admissionStore?.readGapReceiptForCandidate(params.bound.candidateId)) {
        throw new RuntimeAdapterError("TERMINAL_DISPOSITION", "runtime candidate already has a terminal gap disposition");
      }
      const spool = this.persistCompletedSpool(source, params.bound.candidateId, params.bound.bindingFingerprint, transport, params.now);
      this.options.fault?.("after_completed_spool");
      const result = params.binding.admit(source, params.now, transport);
      this.options.fault?.("after_admission");
      if (spool) this.finishSpool(spool, "admitted", params.now, "ledger_admitted");
      this.recordCheckpoint(params.bound, "ledger_admitted", params.now, true);
      return {
        status: "admitted",
        sourceTurnId: params.bound.sourceTurnId,
        result,
      };
    };
    return this.admissionStore
      ? this.admissionStore.withCandidateDisposition(params.bound.candidateId, admit)
      : admit();
  }

  private persistCompletedSpool(
    source: TrustedCompletedTurn,
    candidateId: Digest,
    bindingFingerprint: Digest,
    transport: RuntimeAdmissionSpoolRecordV1["transport"],
    now: Date,
  ): RuntimeAdmissionSpoolRecordV1 | null {
    if (!this.spoolRoot) return null;
    const sealedPayloadDigest = sha256({ source, transport, bindingFingerprint } as unknown as JsonValue);
    const path = this.spoolPath(source.sourceTurnId);
    if (existsSync(path)) {
      const current = this.readSpool(path);
      if (current.sourceTurnId !== source.sourceTurnId || current.candidateId !== candidateId
        || current.sealedPayloadDigest !== sealedPayloadDigest) {
        throw new RuntimeAdapterError("IDENTITY_CONFLICT", "completed source identity has different durable admission content");
      }
      if (current.status === "terminal") {
        throw new RuntimeAdapterError("SCOPE_REVOKED", "durable completed source already has a terminal disposition");
      }
      return current;
    }
    const record: RuntimeAdmissionSpoolRecordV1 = {
      schema: RUNTIME_ADMISSION_SPOOL_SCHEMA,
      candidateId,
      sourceTurnId: source.sourceTurnId,
      runtimeSessionKey: source.scope.runtimeSessionKey,
      bindingFingerprint,
      source,
      transport,
      payloadDigest: sealedPayloadDigest,
      sealedPayloadDigest,
      status: "completed",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      admittedAt: null,
      terminalAt: null,
      reasonCode: null,
    };
    if (this.writeInitialSpool(path, record)) return record;
    const current = this.readSpool(path);
    if (current.sourceTurnId !== source.sourceTurnId || current.candidateId !== candidateId
      || current.sealedPayloadDigest !== sealedPayloadDigest) {
      throw new RuntimeAdapterError("IDENTITY_CONFLICT", "completed source identity has different durable admission content");
    }
    return current;
  }

  private finishSpool(
    record: RuntimeAdmissionSpoolRecordV1,
    status: "admitted" | "terminal",
    now: Date,
    reasonCode: string,
  ): void {
    if (!this.spoolRoot) return;
    const next: RuntimeAdmissionSpoolRecordV1 = {
      ...record,
      source: null,
      status,
      updatedAt: now.toISOString(),
      admittedAt: status === "admitted" ? now.toISOString() : null,
      terminalAt: status === "terminal" ? now.toISOString() : null,
      reasonCode,
    };
    next.payloadDigest = sha256({
      source: next.source,
      transport: next.transport,
      bindingFingerprint: next.bindingFingerprint,
    } as unknown as JsonValue);
    this.writeSpool(this.spoolPath(record.sourceTurnId), next);
  }

  private spoolPath(sourceTurnId: string): string {
    if (!this.spoolRoot || !/^channel-user:v1:[a-f0-9]{64}$/.test(sourceTurnId)) {
      throw new RuntimeAdapterError("INVALID_TURN", "durable source identity is invalid");
    }
    return join(this.spoolRoot, `${sourceTurnId.slice(-64)}.json`);
  }

  private readSpool(path: string): RuntimeAdmissionSpoolRecordV1 {
    let value: RuntimeAdmissionSpoolRecordV1 | LegacyRuntimeAdmissionSpoolRecordV1;
    try { value = JSON.parse(readFileSync(path, "utf8")) as RuntimeAdmissionSpoolRecordV1 | LegacyRuntimeAdmissionSpoolRecordV1; }
    catch { throw new RuntimeAdapterError("STATE_CORRUPT", "durable admission spool is unreadable"); }
    const record = value.schema === LEGACY_RUNTIME_ADMISSION_SPOOL_SCHEMA
      ? this.migrateLegacySpool(path, value)
      : value;
    if (record.schema !== RUNTIME_ADMISSION_SPOOL_SCHEMA
      || !/^sha256:[a-f0-9]{64}$/.test(record.candidateId)
      || !/^channel-user:v1:[a-f0-9]{64}$/.test(record.sourceTurnId)
      || (record.source !== null && record.runtimeSessionKey !== record.source.scope?.runtimeSessionKey)
      || (record.status === "completed" && record.source === null)
      || !/^sha256:[a-f0-9]{64}$/.test(record.sealedPayloadDigest)
      || record.payloadDigest !== sha256({
        source: record.source,
        transport: record.transport,
        bindingFingerprint: record.bindingFingerprint,
      } as unknown as JsonValue)) {
      throw new RuntimeAdapterError("STATE_CORRUPT", "durable admission spool failed validation");
    }
    return record;
  }

  private migrateLegacySpool(path: string, legacy: LegacyRuntimeAdmissionSpoolRecordV1): RuntimeAdmissionSpoolRecordV1 {
    const legacyDigest = sha256({
      source: legacy.source,
      transport: legacy.transport,
      bindingFingerprint: legacy.bindingFingerprint,
    } as unknown as JsonValue);
    if (legacy.payloadDigest !== legacyDigest
      || legacy.runtimeSessionKey !== legacy.source?.scope?.runtimeSessionKey
      || !/^channel-user:v1:[a-f0-9]{64}$/.test(legacy.sourceTurnId)
      || legacy.sourceTurnId !== legacy.source?.sourceTurnId
      || !/^sha256:[a-f0-9]{64}$/.test(legacy.bindingFingerprint)) {
      throw new RuntimeAdapterError("STATE_CORRUPT", "legacy durable admission spool failed validation");
    }
    const sanitizedSource: TrustedCompletedTurn = {
      ...legacy.source,
      redactedEvidence: sanitizeEvidence(legacy.source.redactedEvidence),
    };
    const candidateId = deriveAdmissionCandidateId({
      workspaceId: sanitizedSource.scope.workspaceId,
      runtimeSessionKey: legacy.runtimeSessionKey,
      channel: legacy.transport.channel,
      inboundMessageId: legacy.transport.inboundMessageId,
    });
    const sealedPayloadDigest = sha256({
      source: sanitizedSource,
      transport: legacy.transport,
      bindingFingerprint: legacy.bindingFingerprint,
    } as unknown as JsonValue);
    const migrated: RuntimeAdmissionSpoolRecordV1 = {
      ...legacy,
      schema: RUNTIME_ADMISSION_SPOOL_SCHEMA,
      candidateId,
      source: legacy.status === "completed" ? sanitizedSource : null,
      sealedPayloadDigest,
      payloadDigest: sha256({
        source: legacy.status === "completed" ? sanitizedSource : null,
        transport: legacy.transport,
        bindingFingerprint: legacy.bindingFingerprint,
      } as unknown as JsonValue),
    };
    this.writeSpool(path, migrated);
    return migrated;
  }

  private writeSpool(path: string, record: RuntimeAdmissionSpoolRecordV1): void {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temp = `${path}.tmp-${process.pid}-${randomUUID()}`;
    const descriptor = openSync(temp, "wx", 0o600);
    try { writeFileSync(descriptor, `${JSON.stringify(record, null, 2)}\n`, "utf8"); fsyncSync(descriptor); }
    finally { closeSync(descriptor); }
    renameSync(temp, path);
    flushDirectory(dirname(path));
  }

  private writeInitialSpool(path: string, record: RuntimeAdmissionSpoolRecordV1): boolean {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temp = `${path}.tmp-${process.pid}-${randomUUID()}`;
    const descriptor = openSync(temp, "wx", 0o600);
    try { writeFileSync(descriptor, `${JSON.stringify(record, null, 2)}\n`, "utf8"); fsyncSync(descriptor); }
    finally { closeSync(descriptor); }
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

  private bindingFingerprint(binding: RuntimeObservationBinding): Digest {
    return sha256({
      workspaceId: binding.workspaceId,
      scopeClass: binding.scopeClass,
      scopeId: binding.scopeId,
      requireOwner: binding.requireOwner,
      ...(binding.topicDomain ? { topicDomain: binding.topicDomain } : {}),
      allowedChannels: [...binding.allowedChannels].sort(),
    });
  }
}

export function observationRuntimeAdapterError(error: unknown): { code: string; message: string } {
  if (error instanceof RuntimeAdapterError || error instanceof ObservationLedgerError) {
    return { code: error.code, message: error.message.replace(/[\r\n]+/g, " ").slice(0, 500) };
  }
  return { code: "RUNTIME_ADAPTER_FAILED", message: "runtime observation adapter failed closed" };
}
