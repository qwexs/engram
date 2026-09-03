import { describe, expect, test } from "bun:test";
import {
  resolveObservationAgentRunIdentity,
  resolveObservationMessageReceivedIdentity,
  resolveObservationMessageSentIdentity,
  resolveObservationPersistedUserIdentity,
} from "./hook-identity.ts";

const sourceTurnId = `channel-user:v1:${"a".repeat(64)}`;

describe("memory observation OpenClaw hook identity", () => {
  test("normalizes duplicated server-owned identity and protected persisted metadata", () => {
    expect(resolveObservationMessageReceivedIdentity(
      { sessionKey: "agent:main:telegram:direct:1", messageId: "m1", senderId: "1", metadata: { messageId: "m1" } },
      { sessionKey: "agent:main:telegram:direct:1", senderId: "1" },
    )).toEqual({ runtimeSessionKey: "agent:main:telegram:direct:1", messageId: "m1", actorId: "1" });
    expect(resolveObservationPersistedUserIdentity({
      sessionKey: "agent:main:telegram:direct:1",
      message: {
        role: "user",
        idempotencyKey: sourceTurnId,
        __openclaw: { senderIsOwner: true, transport: { channel: "telegram", messageId: "m1" } },
      },
    }, {})).toMatchObject({ sourceTurnId, senderIsOwner: true, transport: "telegram", messageId: "m1" });
    expect(resolveObservationAgentRunIdentity({}, { sessionKey: "agent:main:telegram:direct:1", runId: "r1" })).toEqual({
      runtimeSessionKey: "agent:main:telegram:direct:1",
      runId: "r1",
    });
    expect(resolveObservationMessageSentIdentity({
      sessionKey: "agent:main:telegram:direct:1",
      runId: "r1",
      sourceReply: { sourceTurnId, toolCallId: "call-1", final: true },
    }, { sessionKey: "agent:main:telegram:direct:1", runId: "r1" })).toEqual({
      runtimeSessionKey: "agent:main:telegram:direct:1",
      runId: "r1",
      sourceTurnId,
      toolCallId: "call-1",
    });
  });

  test("fails closed on disagreement, unprotected ownership, or invalid source identity", () => {
    expect(() => resolveObservationMessageReceivedIdentity(
      { sessionKey: "agent:main:telegram:direct:1", messageId: "m1", senderId: "1" },
      { sessionKey: "agent:main:telegram:direct:2", messageId: "m1", senderId: "1" },
    )).toThrow("differs");
    expect(() => resolveObservationPersistedUserIdentity({
      sessionKey: "agent:main:telegram:direct:1",
      message: { role: "user", idempotencyKey: "prompt-value", __openclaw: { transport: { channel: "telegram", messageId: "m1" } } },
    }, {})).toThrow();
    expect(() => resolveObservationMessageSentIdentity({
      sessionKey: "agent:main:telegram:direct:1",
      runId: "r1",
      sourceReply: { sourceTurnId, toolCallId: "call-1", final: false },
    }, {})).toThrow("not a terminal source reply");
  });
});
