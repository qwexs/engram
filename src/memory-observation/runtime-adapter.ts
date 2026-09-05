import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { JsonValue, ProducerRef, TrustedCompletedTurn } from "./ledger.ts";
import { ObservationLedgerError, sha256 } from "./ledger.ts";
import { MAX_REPLY_CONTEXT_PAIRS, type ReplyContextResult } from "./reply-context.ts";

type Row = Record<string, unknown>;

export type RuntimeObservationBinding = {
  workspaceId: string;
  scopeClass: "self" | "managers" | "company" | "project";
  scopeId: string;
  requireOwner: boolean;
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

export const RUNTIME_ADMISSION_SPOOL_SCHEMA = "engram.memory-runtime-admission-spool.v1" as const;

export type RuntimeAdmissionSpoolRecordV1 = {
  schema: typeof RUNTIME_ADMISSION_SPOOL_SCHEMA;
  sourceTurnId: string;
  runtimeSessionKey: string;
  bindingFingerprint: string;
  source: TrustedCompletedTurn;
  transport: {
    channel: "telegram" | "openclaw";
    inboundMessageId: string;
    parentMessageId?: string;
    deliveryMessageId?: string;
  };
  payloadDigest: string;
  status: "completed" | "admitted" | "terminal";
  createdAt: string;
  updatedAt: string;
  admittedAt: string | null;
  terminalAt: string | null;
  reasonCode: string | null;
};

export type RuntimeAdapterFaultPoint = "after_completed_spool" | "after_admission";

type PendingTurn = {
  runtimeSessionKey: string;
  messageId: string;
  actorId: string;
  channel: "telegram" | "openclaw";
  replyToId?: string;
  observedAt: number;
};

type AdoptedTurn = PendingTurn & {
  sourceTurnId: string;
  userText: string;
  senderIsOwner: boolean;
  bindingFingerprint: string;
};

type BoundRun = AdoptedTurn & {
  runId: string;
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

  constructor(private readonly options: {
    authority: ProducerRef;
    resolveBinding: (runtimeSessionKey: string) => RuntimeObservationBinding | null;
    now?: () => Date;
    stateTtlMs?: number;
    spoolRoot?: string;
    fault?: (point: RuntimeAdapterFaultPoint) => void;
  }) {
    if (options.stateTtlMs !== undefined && (!Number.isInteger(options.stateTtlMs) || options.stateTtlMs < 1)) {
      throw new RuntimeAdapterError("INVALID_CONFIG", "runtime adapter state TTL is invalid");
    }
    this.spoolRoot = options.spoolRoot ? resolve(options.spoolRoot) : null;
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
    const candidate: PendingTurn = {
      runtimeSessionKey,
      messageId: sharedToken("messageId", event.messageId, context.messageId),
      actorId: sharedToken("senderId", event.senderId, context.senderId),
      channel: runtimeChannel,
      ...(replyToId ? { replyToId } : {}),
      observedAt: timestamp(event.timestamp, now.getTime()),
    };
    const current = this.pending.get(runtimeSessionKey);
    if (current) {
      if (this.samePending(current, candidate)) return { status: "duplicate" };
      throw new RuntimeAdapterError("AMBIGUOUS_TURN", "multiple inbound turns compete for one runtime session");
    }
    if (this.adopted.has(runtimeSessionKey)) throw new RuntimeAdapterError("AMBIGUOUS_TURN", "an adopted turn is already waiting for a run");
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
    const current = this.adopted.get(runtimeSessionKey);
    if (current) {
      if (current.sourceTurnId === sourceTurnId && current.messageId === messageId && current.channel === transportChannel) {
        return { status: "duplicate", sourceTurnId };
      }
      throw new RuntimeAdapterError("AMBIGUOUS_TURN", "multiple persisted turns compete for one runtime session");
    }
    const pending = this.pending.get(runtimeSessionKey);
    if (!pending) throw new RuntimeAdapterError("TURN_NOT_FOUND", "persisted user turn has no trusted inbound capture");
    if (pending.channel !== transportChannel || pending.messageId !== messageId) {
      throw new RuntimeAdapterError("IDENTITY_CONFLICT", "persisted turn does not match trusted inbound identity");
    }
    if (pending.replyToId && transportReplyToId && pending.replyToId !== transportReplyToId) {
      throw new RuntimeAdapterError("IDENTITY_CONFLICT", "persisted reply target does not match trusted inbound identity");
    }
    const adopted: AdoptedTurn = {
      ...pending,
      ...(transportReplyToId ? { replyToId: transportReplyToId } : {}),
      sourceTurnId,
      userText,
      senderIsOwner,
      bindingFingerprint: this.bindingFingerprint(binding),
    };
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
    const adopted = this.adopted.get(runtimeSessionKey);
    if (!adopted) throw new RuntimeAdapterError("TURN_NOT_FOUND", "run has no adopted trusted user turn");
    this.adopted.delete(runtimeSessionKey);
    this.runs.set(runId, { ...adopted, runId, attachedAt: now.getTime() });
    return { status: "attached", sourceTurnId: adopted.sourceTurnId };
  }

  completeAgentEnd(eventValue: unknown, contextValue: unknown): RuntimeAdapterResult {
    const now = this.now();
    this.sweep(now.getTime());
    const event = row(eventValue) ?? {};
    const context = row(contextValue) ?? {};
    const runId = sharedToken("runId", event.runId, context.runId);
    const runtimeSessionKey = token("sessionKey", context.sessionKey);
    const bound = this.runs.get(runId);
    if (!bound) return { status: "ignored", reason: "unbound_run" };
    try {
      if (context.trigger !== "user" || event.success !== true || bound.runtimeSessionKey !== runtimeSessionKey) {
        return { status: "ignored", reason: event.success === true ? "runtime_identity_mismatch" : "run_failed" };
      }
      const binding = this.options.resolveBinding(runtimeSessionKey);
      if (!binding || this.bindingFingerprint(binding) !== bound.bindingFingerprint) {
        throw new RuntimeAdapterError("SCOPE_REVOKED", "runtime observation scope changed before admission");
      }
      const messages = Array.isArray(event.messages) ? event.messages : [];
      const sourceIndexes = messages.map((message, index) => ({ message: row(message), index }))
        .filter((entry) => entry.message?.role === "user" && entry.message.idempotencyKey === bound.sourceTurnId);
      if (sourceIndexes.length !== 1) throw new RuntimeAdapterError("TURN_NOT_FOUND", "terminal transcript does not contain exactly one bound source turn");
      let assistantText = "";
      for (const value of messages.slice(sourceIndexes[0]!.index + 1)) {
        const message = row(value);
        if (message?.role !== "assistant") continue;
        const text = extractText(message, 50_000);
        if (text) assistantText = text;
      }
      if (!assistantText) throw new RuntimeAdapterError("INVALID_TURN", "successful run has no terminal assistant text");
      const result = this.admitCompletedTurn({ bound, binding, runtimeSessionKey, assistantText, now });
      this.completed.set(runId, {
        runtimeSessionKey,
        sourceTurnId: bound.sourceTurnId,
        channel: bound.channel,
        ...(bound.replyToId ? { replyToId: bound.replyToId } : {}),
        bindingFingerprint: bound.bindingFingerprint,
        completedAt: now.getTime(),
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
    const bound = this.runs.get(runId);
    if (!bound) return { status: "ignored", reason: "unbound_run" };
    try {
      if (event.success !== true) return { status: "ignored", reason: "delivery_failed" };
      const runtimeSessionKey = sharedToken("sessionKey", event.sessionKey, context.sessionKey);
      const sourceTurnId = token("sourceTurnId", sourceReply.sourceTurnId);
      token("toolCallId", sourceReply.toolCallId);
      if (
        bound.runtimeSessionKey !== runtimeSessionKey ||
        bound.sourceTurnId !== sourceTurnId
      ) {
        throw new RuntimeAdapterError(
          "IDENTITY_CONFLICT",
          "delivered source reply does not match the bound run",
        );
      }
      const binding = this.options.resolveBinding(runtimeSessionKey);
      if (!binding || this.bindingFingerprint(binding) !== bound.bindingFingerprint) {
        throw new RuntimeAdapterError(
          "SCOPE_REVOKED",
          "runtime observation scope changed before admission",
        );
      }
      const assistantText = typeof event.content === "string"
        ? event.content.slice(0, 50_000).trim()
        : "";
      if (!assistantText) {
        throw new RuntimeAdapterError(
          "INVALID_TURN",
          "delivered source reply has no assistant text",
        );
      }
      const deliveryMessageId = optionalToken("messageId", event.messageId);
      return this.admitCompletedTurn({
        bound,
        binding,
        runtimeSessionKey,
        assistantText,
        now,
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
    for (const record of this.listSpool().filter((entry) => entry.status === "completed")) {
      const binding = this.options.resolveBinding(record.runtimeSessionKey);
      if (!binding) { result.retained++; continue; }
      if (this.bindingFingerprint(binding) !== record.bindingFingerprint) {
        this.finishSpool(record, "terminal", now, "scope_revoked_before_admission");
        result.terminal++;
        continue;
      }
      binding.admit(record.source, new Date(record.source.sourceCompletedAt), record.transport);
      this.finishSpool(record, "admitted", now, "ledger_admitted_after_recovery");
      result.admitted++;
    }
    return result;
  }

  listSpool(): RuntimeAdmissionSpoolRecordV1[] {
    if (!this.spoolRoot || !existsSync(this.spoolRoot)) return [];
    return readdirSync(this.spoolRoot).filter((name) => /^[a-f0-9]{64}\.json$/.test(name)).sort()
      .map((name) => this.readSpool(join(this.spoolRoot!, name)));
  }

  private now(): Date { return this.options.now?.() ?? new Date(); }
  private stateTtlMs(): number { return this.options.stateTtlMs ?? 30 * 60 * 1_000; }

  private sweep(nowMs: number): void {
    const cutoff = nowMs - this.stateTtlMs();
    for (const [key, value] of this.pending) if (value.observedAt < cutoff) this.pending.delete(key);
    for (const [key, value] of this.adopted) if (value.observedAt < cutoff) this.adopted.delete(key);
    for (const [key, value] of this.runs) if (value.attachedAt < cutoff) this.runs.delete(key);
    for (const [key, value] of this.completed) if (value.completedAt < cutoff) this.completed.delete(key);
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
      redactedEvidence: {
        source: { role: "user", text: params.bound.userText },
        outcome: { role: "assistant", text: params.assistantText },
        ...(replyContext ? { replyContext } : {}),
      },
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
    const spool = this.persistCompletedSpool(source, params.bound.bindingFingerprint, transport, params.now);
    this.options.fault?.("after_completed_spool");
    const result = params.binding.admit(source, params.now, transport);
    this.options.fault?.("after_admission");
    if (spool) this.finishSpool(spool, "admitted", params.now, "ledger_admitted");
    return {
      status: "admitted",
      sourceTurnId: params.bound.sourceTurnId,
      result,
    };
  }

  private persistCompletedSpool(
    source: TrustedCompletedTurn,
    bindingFingerprint: string,
    transport: RuntimeAdmissionSpoolRecordV1["transport"],
    now: Date,
  ): RuntimeAdmissionSpoolRecordV1 | null {
    if (!this.spoolRoot) return null;
    const payloadDigest = sha256({ source, transport, bindingFingerprint } as unknown as JsonValue);
    const path = this.spoolPath(source.sourceTurnId);
    if (existsSync(path)) {
      const current = this.readSpool(path);
      if (current.sourceTurnId !== source.sourceTurnId || current.payloadDigest !== payloadDigest) {
        throw new RuntimeAdapterError("IDENTITY_CONFLICT", "completed source identity has different durable admission content");
      }
      if (current.status === "terminal") {
        throw new RuntimeAdapterError("SCOPE_REVOKED", "durable completed source already has a terminal disposition");
      }
      return current;
    }
    const record: RuntimeAdmissionSpoolRecordV1 = {
      schema: RUNTIME_ADMISSION_SPOOL_SCHEMA,
      sourceTurnId: source.sourceTurnId,
      runtimeSessionKey: source.scope.runtimeSessionKey,
      bindingFingerprint,
      source,
      transport,
      payloadDigest,
      status: "completed",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      admittedAt: null,
      terminalAt: null,
      reasonCode: null,
    };
    this.writeSpool(path, record);
    return record;
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
      status,
      updatedAt: now.toISOString(),
      admittedAt: status === "admitted" ? now.toISOString() : null,
      terminalAt: status === "terminal" ? now.toISOString() : null,
      reasonCode,
    };
    this.writeSpool(this.spoolPath(record.sourceTurnId), next);
  }

  private spoolPath(sourceTurnId: string): string {
    if (!this.spoolRoot || !/^channel-user:v1:[a-f0-9]{64}$/.test(sourceTurnId)) {
      throw new RuntimeAdapterError("INVALID_TURN", "durable source identity is invalid");
    }
    return join(this.spoolRoot, `${sourceTurnId.slice(-64)}.json`);
  }

  private readSpool(path: string): RuntimeAdmissionSpoolRecordV1 {
    let record: RuntimeAdmissionSpoolRecordV1;
    try { record = JSON.parse(readFileSync(path, "utf8")) as RuntimeAdmissionSpoolRecordV1; }
    catch { throw new RuntimeAdapterError("STATE_CORRUPT", "durable admission spool is unreadable"); }
    if (record.schema !== RUNTIME_ADMISSION_SPOOL_SCHEMA
      || !/^channel-user:v1:[a-f0-9]{64}$/.test(record.sourceTurnId)
      || record.runtimeSessionKey !== record.source?.scope?.runtimeSessionKey
      || record.payloadDigest !== sha256({
        source: record.source,
        transport: record.transport,
        bindingFingerprint: record.bindingFingerprint,
      } as unknown as JsonValue)) {
      throw new RuntimeAdapterError("STATE_CORRUPT", "durable admission spool failed validation");
    }
    return record;
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

  private bindingFingerprint(binding: RuntimeObservationBinding): string {
    return sha256({
      workspaceId: binding.workspaceId,
      scopeClass: binding.scopeClass,
      scopeId: binding.scopeId,
      requireOwner: binding.requireOwner,
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
