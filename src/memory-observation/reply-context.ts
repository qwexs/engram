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
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  deriveTraceId,
  sha256,
  type Digest,
  type JsonValue,
  type ObservationJobV1,
  type ObservationScope,
} from "./ledger.ts";

const ROOT_SEGMENTS = ["memory-state", "memory-observation", "v1"] as const;
const LINK_SCHEMA = "engram.memory-observation-transport-link.v1" as const;
export const MAX_REPLY_CONTEXT_PAIRS = 5;

export type ReplyContextPair = {
  traceId: Digest;
  sourceTurnId: string;
  transportMessageId: string;
  evidenceDigest: Digest;
  source: { role: "user"; text: string };
  outcome: { role: "assistant"; text: string };
};

export type ReplyContextResult = {
  status: "none" | "complete" | "partial" | "truncated";
  requestedReplyToId: string | null;
  maxPairs: number;
  pairs: ReplyContextPair[];
  reasonCode: string | null;
};

export type TransportLinkV1 = {
  schema: typeof LINK_SCHEMA;
  linkId: Digest;
  workspaceId: string;
  runtimeSessionKey: string;
  channel: "telegram" | "openclaw";
  transportMessageId: string;
  messageRole: "user" | "assistant";
  sourceTurnId: string;
  traceId: Digest;
  evidenceDigest: Digest;
  parentTransportMessageId: string | null;
  createdAt: string;
  expiresAt: string;
};

type EvidenceRecord = {
  schema: "engram.memory-evidence-envelope.v1";
  traceId: Digest;
  scope: ObservationScope;
  payload: JsonValue;
  createdAt: string;
  expiresAt: string;
};

export class ReplyContextError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ReplyContextError";
  }
}

function token(label: string, value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 2_048) {
    throw new ReplyContextError("INVALID_REPLY_CONTEXT", `${label} is missing or invalid`);
  }
  return value;
}

function digestKey(value: Digest): string {
  if (!/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new ReplyContextError("INVALID_REPLY_CONTEXT", "reply context digest is invalid");
  }
  return value.slice("sha256:".length);
}

function readJson<T>(path: string): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    throw new ReplyContextError("STATE_CORRUPT", `invalid JSON state: ${path}`);
  }
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}

function flushDirectory(path: string): void {
  if (process.platform === "win32") return;
  const descriptor = openSync(path, "r");
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
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

function sameScope(left: ObservationScope, right: ObservationScope): boolean {
  return left.workspaceId === right.workspaceId
    && left.runtimeSessionKey === right.runtimeSessionKey
    && left.scopeClass === right.scopeClass
    && left.scopeId === right.scopeId;
}

function pairFromEvidence(link: TransportLinkV1, evidence: EvidenceRecord): ReplyContextPair {
  if (evidence.schema !== "engram.memory-evidence-envelope.v1"
    || evidence.traceId !== link.traceId
    || sha256({
      schema: evidence.schema,
      traceId: evidence.traceId,
      scope: evidence.scope,
      payload: evidence.payload,
    } as unknown as JsonValue) !== link.evidenceDigest) {
    throw new ReplyContextError("CONTENT_CONFLICT", "reply context evidence digest mismatch");
  }
  const payload = evidence.payload && typeof evidence.payload === "object" && !Array.isArray(evidence.payload)
    ? evidence.payload as Record<string, JsonValue>
    : null;
  const source = payload?.source && typeof payload.source === "object" && !Array.isArray(payload.source)
    ? payload.source as Record<string, JsonValue>
    : null;
  const outcome = payload?.outcome && typeof payload.outcome === "object" && !Array.isArray(payload.outcome)
    ? payload.outcome as Record<string, JsonValue>
    : null;
  if (source?.role !== "user" || typeof source.text !== "string"
    || outcome?.role !== "assistant" || typeof outcome.text !== "string") {
    throw new ReplyContextError("STATE_CORRUPT", "reply context evidence lacks a completed turn pair");
  }
  return {
    traceId: link.traceId,
    sourceTurnId: link.sourceTurnId,
    transportMessageId: link.transportMessageId,
    evidenceDigest: link.evidenceDigest,
    source: { role: "user", text: source.text },
    outcome: { role: "assistant", text: outcome.text },
  };
}

export class ReplyContextStore {
  readonly workspace: string;
  readonly workspaceId: string;
  readonly root: string;
  private readonly exactSessionKeys: Set<string>;

  constructor(options: { workspace: string; workspaceId: string; exactSessionKeys: string[] }) {
    this.workspace = resolve(options.workspace);
    this.workspaceId = token("workspaceId", options.workspaceId);
    this.root = join(this.workspace, ...ROOT_SEGMENTS);
    this.exactSessionKeys = new Set(options.exactSessionKeys.map((value) => token("runtimeSessionKey", value)));
    if (this.exactSessionKeys.size < 1) {
      throw new ReplyContextError("INVALID_CONFIG", "reply context store requires an exact session allowlist");
    }
  }

  record(params: {
    scope: ObservationScope;
    channel: "telegram" | "openclaw";
    transportMessageId: string;
    messageRole: "user" | "assistant";
    sourceTurnId: string;
    parentTransportMessageId?: string;
  }): { status: "recorded" | "duplicate"; link: TransportLinkV1 } {
    this.validateScope(params.scope);
    const transportMessageId = token("transportMessageId", params.transportMessageId);
    const parentTransportMessageId = params.parentTransportMessageId === undefined
      ? null
      : token("parentTransportMessageId", params.parentTransportMessageId);
    if (params.messageRole !== "user" && params.messageRole !== "assistant") {
      throw new ReplyContextError("INVALID_REPLY_CONTEXT", "transport message role is invalid");
    }
    const sourceTurnId = token("sourceTurnId", params.sourceTurnId);
    if (!/^channel-user:v1:[a-f0-9]{64}$/.test(sourceTurnId)) {
      throw new ReplyContextError("INVALID_REPLY_CONTEXT", "source turn identity is invalid");
    }
    const traceId = deriveTraceId(this.workspaceId, params.scope.runtimeSessionKey, sourceTurnId);
    const envelope = readJson<ObservationJobV1>(this.envelopePath(traceId));
    const evidence = readJson<EvidenceRecord>(this.evidencePath(traceId));
    if (envelope.traceId !== traceId || envelope.sourceTurnId !== sourceTurnId
      || !sameScope(envelope.scope, params.scope) || !sameScope(evidence.scope, params.scope)
      || envelope.evidenceDigest !== sha256({
        schema: evidence.schema,
        traceId: evidence.traceId,
        scope: evidence.scope,
        payload: evidence.payload,
      } as unknown as JsonValue)) {
      throw new ReplyContextError("CONTENT_CONFLICT", "transport link does not match admitted evidence");
    }
    const linkId = this.deriveLinkId(params.scope.runtimeSessionKey, params.channel, transportMessageId);
    const link: TransportLinkV1 = {
      schema: LINK_SCHEMA,
      linkId,
      workspaceId: this.workspaceId,
      runtimeSessionKey: params.scope.runtimeSessionKey,
      channel: params.channel,
      transportMessageId,
      messageRole: params.messageRole,
      sourceTurnId,
      traceId,
      evidenceDigest: envelope.evidenceDigest,
      parentTransportMessageId,
      createdAt: evidence.createdAt,
      expiresAt: evidence.expiresAt,
    };
    const path = this.linkPath(linkId);
    if (!writeImmutable(path, link)) {
      const current = readJson<TransportLinkV1>(path);
      if (canonical(current) !== canonical(link)) {
        throw new ReplyContextError("CONTENT_CONFLICT", "transport message identity maps to different evidence");
      }
      return { status: "duplicate", link: current };
    }
    return { status: "recorded", link };
  }

  resolve(params: {
    scope: ObservationScope;
    channel: "telegram" | "openclaw";
    replyToId?: string;
    maxPairs: number;
    now?: Date;
  }): ReplyContextResult {
    this.validateScope(params.scope);
    if (params.replyToId === undefined) {
      return { status: "none", requestedReplyToId: null, maxPairs: params.maxPairs, pairs: [], reasonCode: null };
    }
    const requestedReplyToId = token("replyToId", params.replyToId);
    if (!Number.isInteger(params.maxPairs) || params.maxPairs < 1 || params.maxPairs > MAX_REPLY_CONTEXT_PAIRS) {
      throw new ReplyContextError("INVALID_CONFIG", `reply context pair limit must be between 1 and ${MAX_REPLY_CONTEXT_PAIRS}`);
    }
    const now = params.now ?? new Date();
    const pairs: ReplyContextPair[] = [];
    const visited = new Set<string>();
    let currentMessageId: string | null = requestedReplyToId;
    let reasonCode: string | null = null;
    while (currentMessageId && pairs.length < params.maxPairs) {
      if (visited.has(currentMessageId)) {
        reasonCode = "reply_cycle";
        break;
      }
      visited.add(currentMessageId);
      const linkPath = this.linkPath(this.deriveLinkId(params.scope.runtimeSessionKey, params.channel, currentMessageId));
      if (!existsSync(linkPath)) {
        reasonCode = "reply_link_missing";
        break;
      }
      const link = readJson<TransportLinkV1>(linkPath);
      this.validateLink(link, params.scope, params.channel, currentMessageId);
      if (Date.parse(link.expiresAt) <= now.getTime()) {
        reasonCode = "reply_evidence_expired";
        break;
      }
      const evidencePath = this.evidencePath(link.traceId);
      if (!existsSync(evidencePath)) {
        reasonCode = "reply_evidence_missing";
        break;
      }
      const evidence = readJson<EvidenceRecord>(evidencePath);
      if (!sameScope(evidence.scope, params.scope)) {
        throw new ReplyContextError("SCOPE_MISMATCH", "reply context crossed an exact session scope");
      }
      pairs.push(pairFromEvidence(link, evidence));
      currentMessageId = link.parentTransportMessageId;
    }
    if (currentMessageId && pairs.length === params.maxPairs && !reasonCode) reasonCode = "reply_pair_limit";
    pairs.reverse();
    return {
      status: reasonCode === "reply_pair_limit" ? "truncated" : reasonCode ? "partial" : "complete",
      requestedReplyToId,
      maxPairs: params.maxPairs,
      pairs,
      reasonCode,
    };
  }

  purgeExpired(now = new Date()): number {
    const directory = join(this.root, "transport-links");
    if (!existsSync(directory)) return 0;
    let removed = 0;
    for (const name of readdirSync(directory)) {
      if (!name.endsWith(".json")) continue;
      const path = join(directory, name);
      const link = readJson<TransportLinkV1>(path);
      if (Date.parse(link.expiresAt) <= now.getTime()) {
        unlinkSync(path);
        removed++;
      }
    }
    if (removed) flushDirectory(directory);
    return removed;
  }

  private validateScope(scope: ObservationScope): void {
    if (scope.workspaceId !== this.workspaceId || !this.exactSessionKeys.has(scope.runtimeSessionKey)) {
      throw new ReplyContextError("SCOPE_MISMATCH", "reply context scope is not exactly admitted");
    }
  }

  private validateLink(
    link: TransportLinkV1,
    scope: ObservationScope,
    channel: "telegram" | "openclaw",
    transportMessageId: string,
  ): void {
    if (link.schema !== LINK_SCHEMA || link.workspaceId !== this.workspaceId
      || link.runtimeSessionKey !== scope.runtimeSessionKey || link.channel !== channel
      || link.transportMessageId !== transportMessageId
      || link.linkId !== this.deriveLinkId(scope.runtimeSessionKey, channel, transportMessageId)) {
      throw new ReplyContextError("SCOPE_MISMATCH", "transport link identity or scope is invalid");
    }
  }

  private deriveLinkId(runtimeSessionKey: string, channel: "telegram" | "openclaw", transportMessageId: string): Digest {
    return sha256(`engram.memory-transport-link.v1\0${this.workspaceId}\0${runtimeSessionKey}\0${channel}\0${transportMessageId}`);
  }

  private linkPath(linkId: Digest): string {
    return join(this.root, "transport-links", `${digestKey(linkId)}.json`);
  }

  private envelopePath(traceId: Digest): string {
    return join(this.root, "envelopes", `${digestKey(traceId)}.json`);
  }

  private evidencePath(traceId: Digest): string {
    return join(this.root, "evidence", `${digestKey(traceId)}.json`);
  }
}
