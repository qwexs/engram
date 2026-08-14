import { describe, expect, test } from "bun:test";
import {
  isHeartbeatIneligibleSession,
  runtimeSessionSkipReason,
} from "./runtime-session.js";

describe("runtime session lifecycle classification", () => {
  test("uses runtime metadata for labeled one-shot workers", () => {
    expect(runtimeSessionSkipReason({ context: { sessionType: "subagent" } }, "human-readable-worker"))
      .toBe("ephemeral");
  });

  test("keeps canonical interactive sessions eligible", () => {
    expect(isHeartbeatIneligibleSession("main")).toBeFalse();
    expect(isHeartbeatIneligibleSession("telegram-direct-42")).toBeFalse();
    expect(isHeartbeatIneligibleSession("telegram-group--10042-topic-7")).toBeFalse();
  });

  test("rejects historical, test, archive, and unstable contours", () => {
    expect(isHeartbeatIneligibleSession("_archive-openai-sessions")).toBeTrue();
    expect(isHeartbeatIneligibleSession("websearch-native-test")).toBeTrue();
    expect(isHeartbeatIneligibleSession("telegram-42")).toBeTrue();
    expect(isHeartbeatIneligibleSession("skill-workshop-review-incognito-run-id")).toBeTrue();
    expect(isHeartbeatIneligibleSession("fc6e7e0b-4a74-4147-b45e-c3d9be5025bb")).toBeTrue();
  });
});
