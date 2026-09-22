import { describe, expect, test } from "bun:test";
import {
  deliveryOwnerPolicyDigest,
  parseCanonicalSessionKey,
  parseDeliveryOwnerPolicy,
  planDelivery,
  resolveDeliveryScope,
  sealDeliveryOwnerPolicy,
  type DeliveryOwnerPolicyV2,
  type DeliverySourceBlock,
} from "./contracts.ts";

const digest = (character: string) => `sha256:${character.repeat(64)}` as const;

const policy = (mode: DeliveryOwnerPolicyV2["mode"] = "active"): DeliveryOwnerPolicyV2 => sealDeliveryOwnerPolicy({
  schema: "engram.context-delivery-owner-policy.v2",
  revision: 1,
  mode,
  canarySessionKeys: ["agent:main:telegram:direct:10001"],
  caps: {
    totalBytes: 24 * 1024,
    sourceBytes: { oll: 8 * 1024, domain: 12 * 1024, session: 8 * 1024, kg: 12 * 1024 },
    minContextTokenBudget: 16_000,
  },
});

const identity = {
  runId: "run-1",
  agentId: "main",
  sessionKey: "agent:main:telegram:direct:10001",
  workspaceDir: "/opt/openclaw/workspace",
  expectedWorkspaceDir: "/opt/openclaw/workspace",
  channel: "telegram",
  chatId: "10001",
  senderId: "10001",
};

const sources: DeliverySourceBlock[] = [
  { source: "kg", artifactDigest: digest("c"), content: "KG body" },
  { source: "session", artifactDigest: digest("d"), content: "Session body" },
  { source: "domain", artifactDigest: digest("b"), content: "Domain body" },
  { source: "oll", artifactDigest: digest("a"), content: "OLL body" },
];

describe("context delivery contracts", () => {
  test("parses the canonical main, direct, group and topic session-key family", () => {
    expect(parseCanonicalSessionKey("agent:main:main")).toEqual({
      sessionKey: "agent:main:main", agentId: "main", kind: "main",
    });
    expect(parseCanonicalSessionKey("agent:main:telegram:direct:10001")?.kind).toBe("peer-direct");
    expect(parseCanonicalSessionKey("agent:alpha:telegram:group:-100123")?.kind).toBe("group-direct");
    expect(parseCanonicalSessionKey("agent:alpha:telegram:group:-100123:topic:42")).toMatchObject({
      kind: "topic-thread", chatId: "-100123", topicId: "42",
    });
    expect(parseCanonicalSessionKey("agent:main:telegram:group:-100123:topic")).toBeNull();
  });

  test("cross-checks host identity instead of trusting only the session key", () => {
    expect(resolveDeliveryScope(identity)?.kind).toBe("peer-direct");
    expect(resolveDeliveryScope({ ...identity, agentId: "other" })).toBeNull();
    expect(resolveDeliveryScope({ ...identity, workspaceDir: "relative" })).toBeNull();
    expect(resolveDeliveryScope({ ...identity, expectedWorkspaceDir: "/opt/openclaw/other" })).toBeNull();
    expect(resolveDeliveryScope({ ...identity, senderId: "999" })).toBeNull();
    expect(resolveDeliveryScope({ ...identity, channel: "discord" })).toBeNull();
  });

  test.skipIf(process.platform !== "win32")("accepts case-insensitive Windows workspace identity", () => {
    expect(resolveDeliveryScope({
      ...identity,
      workspaceDir: "C:\\Engram\\Workspace",
      expectedWorkspaceDir: "c:/engram/workspace",
    })?.kind).toBe("peer-direct");
  });

  test("validates the whole policy and produces an order-stable digest", () => {
    const parsed = parseDeliveryOwnerPolicy(policy());
    const reordered = sealDeliveryOwnerPolicy({ ...parsed, canarySessionKeys: [...parsed.canarySessionKeys].reverse() });
    expect(deliveryOwnerPolicyDigest(parsed)).toBe(deliveryOwnerPolicyDigest(reordered));
    expect(() => parseDeliveryOwnerPolicy({ ...policy(), mode: "maybe" })).toThrow("mode");
    expect(() => parseDeliveryOwnerPolicy({ ...policy(), unexpected: true })).toThrow("shape");
    expect(() => parseDeliveryOwnerPolicy({ ...policy(), canarySessionKeys: ["bad"] })).toThrow("canary");
    expect(() => parseDeliveryOwnerPolicy({ ...policy(), revision: 2 })).toThrow("digest mismatch");
  });

  test("renders sources once in OLL, domain, session, KG order with deterministic markers", () => {
    const first = planDelivery({ identity, policy: policy(), sources, contextTokenBudget: 272_000 });
    const second = planDelivery({ identity, policy: policy(), sources: [...sources].reverse(), contextTokenBudget: 272_000 });
    expect(first.context).toBe(second.context);
    expect(first.receipt.envelopeDigest).toBe(second.receipt.envelopeDigest);
    expect(first.context).toContain("<!-- engram-context-delivery:v1");
    expect(first.context!.indexOf("OLL body")).toBeLessThan(first.context!.indexOf("Domain body"));
    expect(first.context!.indexOf("Domain body")).toBeLessThan(first.context!.indexOf("Session body"));
    expect(first.context!.indexOf("Session body")).toBeLessThan(first.context!.indexOf("KG body"));
    expect(first.context).toContain(`<!-- engram-session-context:v1 digest=${digest("d")} -->`);
    expect(first.context?.match(/engram-context-delivery:v1/g)).toHaveLength(1);
    expect(first.receipt.reason).toBe("DELIVERED");
  });

  test("observes without injecting and selects only an exact canary", () => {
    const shadow = planDelivery({ identity, policy: policy("shadow"), sources, contextTokenBudget: 272_000 });
    expect(shadow.context).toBeNull();
    expect(shadow.prospectiveContext).toContain("KG body");
    expect(shadow.receipt.reason).toBe("OBSERVED_WOULD_DELIVER");

    const missed = planDelivery({
      identity: { ...identity, sessionKey: "agent:main:telegram:direct:1", chatId: "1", senderId: "1" },
      policy: policy("canary"),
      sources,
      contextTokenBudget: 272_000,
    });
    expect(missed.context).toBeNull();
    expect(missed.receipt.reason).toBe("CANARY_NOT_SELECTED");
  });

  test("omits complete blocks at caps and never truncates source content", () => {
    const base = policy();
    const constrained = sealDeliveryOwnerPolicy({
      ...base,
      caps: { ...base.caps, sourceBytes: { ...base.caps.sourceBytes, oll: 128 } },
    });
    const longOll = "x".repeat(256);
    const result = planDelivery({
      identity,
      policy: constrained,
      sources: sources.map((source) => source.source === "oll" ? { ...source, content: longOll } : source),
      contextTokenBudget: 272_000,
    });
    expect(result.context).not.toContain(longOll);
    expect(result.receipt.sources.find((source) => source.source === "oll")).toMatchObject({
      selected: false, reason: "BUDGET_SOURCE_CAP",
    });
  });

  test("fails closed for an unavailable minimum host budget and keeps receipts metadata-only", () => {
    const result = planDelivery({ identity, policy: policy(), sources, contextTokenBudget: 8_000 });
    expect(result.context).toBeNull();
    expect(result.receipt.reason).toBe("HOST_CONTEXT_BUDGET_TOO_SMALL");
    const serialized = JSON.stringify(result.receipt);
    expect(serialized).not.toContain(identity.sessionKey);
    expect(serialized).not.toContain(identity.workspaceDir);
    expect(serialized).not.toContain("KG body");
    expect(serialized).not.toContain(identity.senderId);
  });

  test("rejects duplicate and malformed source material without rendering it twice", () => {
    const duplicate = planDelivery({
      identity,
      policy: policy(),
      sources: [...sources, { ...sources[0]!, content: "second KG" }],
      contextTokenBudget: 272_000,
    });
    expect(duplicate.context).not.toContain("KG body");
    expect(duplicate.context).not.toContain("second KG");
    expect(duplicate.receipt.sources.find((source) => source.source === "kg")?.reason).toBe("DUPLICATE_SOURCE");
    expect(() => planDelivery({
      identity,
      policy: policy(),
      sources: [{ source: "kg", artifactDigest: "sha256:nope" as `sha256:${string}`, content: "x" }],
    })).toThrow("invalid kg source block");
  });

  test("does not report delivery when no source is available", () => {
    const result = planDelivery({ identity, policy: policy(), sources: [], contextTokenBudget: 272_000 });
    expect(result.context).toBeNull();
    expect(result.prospectiveContext).toBeNull();
    expect(result.receipt.reason).toBe("SOURCE_MISSING");
    expect(result.receipt.sources).toHaveLength(4);
  });

  test("carries fail-closed adapter omissions into the metadata receipt", () => {
    const result = planDelivery({
      identity,
      policy: policy(),
      sources: [],
      omissions: [{ source: "kg", reason: "SCOPE_DENIED" }],
      contextTokenBudget: 272_000,
    });
    expect(result.receipt.reason).toBe("SCOPE_DENIED");
    expect(result.receipt.sources.find((source) => source.source === "kg")).toEqual({
      source: "kg", artifactDigest: null, renderedBytes: 0, selected: false, reason: "SCOPE_DENIED",
    });
  });
});
