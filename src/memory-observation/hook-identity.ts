type Row = Record<string, unknown>;

export type MessageReceivedIdentity = {
  runtimeSessionKey: string;
  messageId: string;
  actorId: string;
};

export type PersistedUserIdentity = {
  runtimeSessionKey: string;
  transport: "telegram" | "openclaw";
  messageId: string;
  sourceTurnId: string;
  senderIsOwner: boolean;
};

export type AgentRunIdentity = {
  runtimeSessionKey: string;
  runId: string;
};

export type MessageSentIdentity = AgentRunIdentity & {
  sourceTurnId: string;
  toolCallId: string;
};

export class ObservationHookIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ObservationHookIdentityError";
  }
}

function row(value: unknown): Row | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : null;
}

function optionalToken(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim() || value.length > 2_048) return null;
  return value;
}

function requiredToken(label: string, value: unknown): string {
  const token = optionalToken(value);
  if (!token) throw new ObservationHookIdentityError(`${label} is missing or invalid`);
  return token;
}

function sharedToken(label: string, left: unknown, right: unknown): string {
  const leftToken = optionalToken(left);
  const rightToken = optionalToken(right);
  if (leftToken === null || rightToken === null) throw new ObservationHookIdentityError(`${label} is invalid`);
  if (leftToken && rightToken && leftToken !== rightToken) {
    throw new ObservationHookIdentityError(`${label} differs between runtime surfaces`);
  }
  const value = leftToken || rightToken;
  if (!value) throw new ObservationHookIdentityError(`${label} is missing from runtime surfaces`);
  return value;
}

export function resolveObservationMessageReceivedIdentity(eventValue: unknown, contextValue: unknown): MessageReceivedIdentity {
  const event = row(eventValue) ?? {};
  const context = row(contextValue) ?? {};
  const metadata = row(event.metadata) ?? {};
  const messageId = sharedToken("messageId", event.messageId, context.messageId);
  const actorId = sharedToken("senderId", event.senderId, context.senderId);
  if (metadata.messageId !== undefined && requiredToken("metadata.messageId", metadata.messageId) !== messageId) {
    throw new ObservationHookIdentityError("messageId differs from message metadata");
  }
  if (metadata.senderId !== undefined && requiredToken("metadata.senderId", metadata.senderId) !== actorId) {
    throw new ObservationHookIdentityError("senderId differs from message metadata");
  }
  return {
    runtimeSessionKey: sharedToken("sessionKey", event.sessionKey, context.sessionKey),
    messageId,
    actorId,
  };
}

export function resolveObservationPersistedUserIdentity(eventValue: unknown, contextValue: unknown): PersistedUserIdentity {
  const event = row(eventValue) ?? {};
  const context = row(contextValue) ?? {};
  const message = row(event.message);
  if (!message || message.role !== "user") throw new ObservationHookIdentityError("persisted turn is not a user message");
  const metadata = row(message.__openclaw);
  const transport = row(metadata?.transport);
  const channel = requiredToken("transport.channel", transport?.channel);
  if (channel !== "telegram" && channel !== "openclaw") throw new ObservationHookIdentityError("persisted transport is unsupported");
  const sourceTurnId = requiredToken("sourceTurnId", message.idempotencyKey);
  if (!/^channel-user:v1:[a-f0-9]{64}$/.test(sourceTurnId)) throw new ObservationHookIdentityError("source turn identity is invalid");
  if (typeof metadata?.senderIsOwner !== "boolean") throw new ObservationHookIdentityError("sender ownership is missing");
  return {
    runtimeSessionKey: sharedToken("sessionKey", event.sessionKey, context.sessionKey),
    transport: channel,
    messageId: requiredToken("transport.messageId", transport?.messageId),
    sourceTurnId,
    senderIsOwner: metadata.senderIsOwner,
  };
}

export function resolveObservationAgentRunIdentity(_eventValue: unknown, contextValue: unknown): AgentRunIdentity {
  const context = row(contextValue) ?? {};
  return {
    runtimeSessionKey: requiredToken("sessionKey", context.sessionKey),
    runId: requiredToken("runId", context.runId),
  };
}

export function resolveObservationMessageSentIdentity(
  eventValue: unknown,
  contextValue: unknown,
): MessageSentIdentity {
  const event = row(eventValue) ?? {};
  const context = row(contextValue) ?? {};
  const sourceReply = row(event.sourceReply);
  if (!sourceReply || sourceReply.final !== true) {
    throw new ObservationHookIdentityError("message_sent is not a terminal source reply");
  }
  const sourceTurnId = requiredToken("sourceTurnId", sourceReply.sourceTurnId);
  if (!/^channel-user:v1:[a-f0-9]{64}$/.test(sourceTurnId)) {
    throw new ObservationHookIdentityError("source turn identity is invalid");
  }
  return {
    runtimeSessionKey: sharedToken("sessionKey", event.sessionKey, context.sessionKey),
    runId: sharedToken("runId", event.runId, context.runId),
    sourceTurnId,
    toolCallId: requiredToken("toolCallId", sourceReply.toolCallId),
  };
}
