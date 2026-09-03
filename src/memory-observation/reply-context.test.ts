import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  MemoryObservationLedger,
  type ObservationScope,
  type TrustedCompletedTurn,
} from "./ledger.ts";
import { ReplyContextStore } from "./reply-context.ts";

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

const repo = join(import.meta.dir, "..", "..");
const registry = JSON.parse(readFileSync(join(repo, "contracts", "memory-observation", "v1", "producer-registry.json"), "utf8"));
const policy = JSON.parse(readFileSync(join(repo, "contracts", "memory-observation", "v1", "authority-policy.json"), "utf8"));
const authority = registry.producers.find((entry: any) => entry.id === "openclaw-runtime");
const sessionKey = "agent:fixture-main:telegram:direct:100000001";
const scope: ObservationScope = {
  workspaceId: "fixture-main",
  runtimeSessionKey: sessionKey,
  scopeClass: "self",
  scopeId: "telegram:100000001",
};

function workspace(): string {
  const path = join(tmpdir(), `engram-reply-context-${crypto.randomUUID()}`);
  roots.push(path);
  return path;
}

function setup() {
  const root = workspace();
  const ledger = new MemoryObservationLedger({
    workspace: root,
    workspaceId: "fixture-main",
    exactSessionKeys: [sessionKey],
    producerRegistry: registry,
    authorityPolicy: policy,
    limits: {
      evidenceTtlMs: 72 * 60 * 60 * 1_000,
      maxJobs: 100,
      maxBytes: 10_000_000,
      maxQueueAgeMs: 7 * 24 * 60 * 60 * 1_000,
      maxAttempts: 3,
      claimTtlMs: 30_000,
      maxInferenceCalls: 0,
    },
  });
  const replies = new ReplyContextStore({
    workspace: root,
    workspaceId: "fixture-main",
    exactSessionKeys: [sessionKey],
  });
  return { root, ledger, replies };
}

function admitPair(
  ledger: MemoryObservationLedger,
  replies: ReplyContextStore,
  index: number,
  parentTransportMessageId?: string,
) {
  const sourceTurnId = `channel-user:v1:${index.toString(16).padStart(64, "0")}`;
  const now = new Date(Date.UTC(2026, 7, 24, 12, index));
  const source: TrustedCompletedTurn = {
    sourceTurnId,
    scope,
    sourceCompletedAt: now.toISOString(),
    authority,
    evidenceRefs: [{ kind: "source-turn", ref: sourceTurnId, digest: `sha256:${"a".repeat(64)}` }],
    redactedEvidence: {
      source: { role: "user", text: `user-${index}` },
      outcome: { role: "assistant", text: `assistant-${index}` },
    },
    trustedInputs: ["completed-source-turn", "runtime-session-key", "workspace-binding", "source-completion-time"],
  };
  ledger.admit(source, now);
  return replies.record({
    scope,
    channel: "telegram",
    transportMessageId: `message-${index}`,
    messageRole: "assistant",
    sourceTurnId,
    ...(parentTransportMessageId ? { parentTransportMessageId } : {}),
  });
}

describe("memory observation reply context store", () => {
  test("resolves an ordered reply chain and enforces the five-pair limit", () => {
    const { ledger, replies } = setup();
    for (let index = 1; index <= 6; index++) {
      admitPair(ledger, replies, index, index > 1 ? `message-${index - 1}` : undefined);
    }
    const result = replies.resolve({
      scope,
      channel: "telegram",
      replyToId: "message-6",
      maxPairs: 5,
      now: new Date("2026-08-24T13:00:00.000Z"),
    });
    expect(result.status).toBe("truncated");
    expect(result.reasonCode).toBe("reply_pair_limit");
    expect(result.pairs.map((pair) => pair.transportMessageId)).toEqual([
      "message-2",
      "message-3",
      "message-4",
      "message-5",
      "message-6",
    ]);
    expect(result.pairs[0]!.source.text).toBe("user-2");
    expect(result.pairs[4]!.outcome.text).toBe("assistant-6");
  });

  test("is idempotent, reports missing ancestry, and rejects cross-session resolution", () => {
    const { ledger, replies } = setup();
    const first = admitPair(ledger, replies, 1);
    expect(first.status).toBe("recorded");
    expect(admitPair(ledger, replies, 1).status).toBe("duplicate");
    replies.record({
      scope,
      channel: "telegram",
      transportMessageId: "user-message-1",
      messageRole: "user",
      sourceTurnId: `channel-user:v1:${"1".padStart(64, "0")}`,
    });
    expect(replies.resolve({
      scope,
      channel: "telegram",
      replyToId: "user-message-1",
      maxPairs: 5,
      now: new Date("2026-08-24T13:00:00.000Z"),
    }).pairs[0]).toMatchObject({
      transportMessageId: "user-message-1",
      source: { text: "user-1" },
      outcome: { text: "assistant-1" },
    });
    expect(replies.resolve({
      scope,
      channel: "telegram",
      replyToId: "unknown",
      maxPairs: 5,
      now: new Date("2026-08-24T13:00:00.000Z"),
    })).toMatchObject({ status: "partial", reasonCode: "reply_link_missing", pairs: [] });
    expect(() => replies.resolve({
      scope: { ...scope, runtimeSessionKey: `${sessionKey}-adjacent` },
      channel: "telegram",
      replyToId: "message-1",
      maxPairs: 5,
      now: new Date("2026-08-24T13:00:00.000Z"),
    })).toThrow("scope is not exactly admitted");
  });

  test("expires delivery links with the same TTL as their evidence", () => {
    const { ledger, replies } = setup();
    admitPair(ledger, replies, 1);
    expect(replies.purgeExpired(new Date("2026-08-28T00:00:00.000Z"))).toBe(1);
    expect(replies.resolve({
      scope,
      channel: "telegram",
      replyToId: "message-1",
      maxPairs: 5,
      now: new Date("2026-08-28T00:00:00.000Z"),
    })).toMatchObject({ status: "partial", reasonCode: "reply_link_missing" });
  });
});
