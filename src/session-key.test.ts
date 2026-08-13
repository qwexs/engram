import { describe, expect, test } from "bun:test";
import {
  normalizeSessionSegment,
  splitCanonicalSessionKey,
} from "./session-key.ts";

describe("normalizeSessionSegment", () => {
  const canonical = "telegram-group--1001-topic-4";

  for (const input of [
    canonical,
    "telegram--1001-topic-4",
    "telegram:-1001:topic:4",
    "telegram:group:-1001:topic:4",
    "agent:sample-agent:telegram:group:-1001:topic:4",
    "telegram-1001-thread-4",
    "telegram--1001-4",
  ]) {
    test(`canonicalizes ${input}`, () => {
      expect(normalizeSessionSegment(input)).toBe(canonical);
    });
  }

  test("normalizes leading zeroes in numeric identifiers", () => {
    expect(normalizeSessionSegment("telegram:group:-00100:topic:004"))
      .toBe("telegram-group--100-topic-4");
  });

  test("preserves safe non-topic sessions", () => {
    expect(normalizeSessionSegment("main")).toBe("main");
    expect(normalizeSessionSegment("agent:main:cron-hourly-run-1"))
      .toBe("cron-hourly-run-1");
  });

  for (const input of ["", ".", "..", "../main", "foo/bar", "foo\\bar", "main\u0000x"]) {
    test(`rejects unsafe segment ${JSON.stringify(input)}`, () => {
      expect(normalizeSessionSegment(input)).toBeNull();
    });
  }
});

describe("splitCanonicalSessionKey", () => {
  test("returns agent id and canonical topic segment", () => {
    expect(splitCanonicalSessionKey(
      "agent:sample-agent:telegram:group:-1001:topic:1",
    )).toEqual({
      agentId: "sample-agent",
      sessionKey: "telegram-group--1001-topic-1",
    });
  });

  test("requires a full agent key", () => {
    expect(splitCanonicalSessionKey("telegram:-100:topic:1")).toBeNull();
  });
});
