import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  KG_V3_ACCESS_STATE_SCHEMA,
  readKgV3AccessState,
  reconcileKgV3Access,
  recordKgV3AccessEvent,
  type KgV3AccessState,
} from "./access.ts";
import { renderKgV3Projection } from "./projection.ts";
import { KG_V3_ASSERTION_SCHEMA, type KgAssertionV3 } from "./types.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) if (existsSync(root)) rmSync(root, { recursive: true, force: true }); });

const decisionId = "11111111-1111-4111-8111-111111111111";
const identityId = "22222222-2222-4222-8222-222222222222";

function assertion(id: string, kind: KgAssertionV3["kind"]): KgAssertionV3 {
  return {
    schema: KG_V3_ASSERTION_SCHEMA,
    id,
    workspaceId: "main",
    entityId: "people/example",
    entityType: "person",
    kind,
    predicate: kind === "decision" ? "deliveryPolicy" : "displayName",
    object: { type: "string", value: kind === "decision" ? "Use concise delivery" : "Example" },
    scope: ["personal"],
    lifecycle: { status: "active", replacesId: null, supersededById: null, changedAt: "2026-06-01T00:00:00.000Z" },
    provenance: {
      sourceKind: "user_message",
      sessionKey: "main",
      messageId: id,
      actorId: "owner",
      operationId: `sha256:${id.replaceAll("-", "").padEnd(64, "0")}`,
      observedAt: "2026-06-01T00:00:00.000Z",
    },
    createdAt: "2026-06-01T00:00:00.000Z",
  };
}

function fixture(): { root: string; assertions: KgAssertionV3[] } {
  const root = mkdtempSync(join(tmpdir(), "kg-v3-access-"));
  roots.push(root);
  const assertions = [assertion(decisionId, "decision"), assertion(identityId, "identity")];
  const dir = join(root, "life", "v3", "assertions");
  mkdirSync(dir, { recursive: true });
  for (const item of assertions) writeFileSync(join(dir, `${item.id}.json`), `${JSON.stringify(item, null, 2)}\n`);
  return { root, assertions };
}

function emptyState(): KgV3AccessState {
  return { schema: KG_V3_ACCESS_STATE_SCHEMA, workspaceId: "main", revision: 0, appliedEventIds: [], assertions: {}, updatedAt: null };
}

describe("KG v3 native access and decay", () => {
  test("keeps stable identity, omits cold decision, and revives it after one idempotent access event", () => {
    const { root, assertions } = fixture();
    const before = renderKgV3Projection(assertions, emptyState(), new Date("2026-08-13T12:00:00.000Z"));
    expect(before.body).toContain(identityId);
    expect(before.body).not.toContain(decisionId);
    expect(before.searchBody).toContain(decisionId);
    expect(before.stats).toMatchObject({ coldIncluded: 1, coldOmitted: 1 });

    const input = { workspace: root, workspaceId: "main", sessionKey: "main", messageId: "8554", assertionIds: [decisionId], observedAt: "2026-08-13T16:40:47.000Z" };
    expect(recordKgV3AccessEvent(input).status).toBe("recorded");
    expect(recordKgV3AccessEvent(input).status).toBe("duplicate");
    const first = reconcileKgV3Access({ workspace: root, workspaceId: "main" });
    expect(first).toMatchObject({ applied: 1, assertionTouches: 1, invalid: 0 });
    expect(first.state.assertions[decisionId]).toMatchObject({ accessCount: 1, lastAccessed: input.observedAt });
    const second = reconcileKgV3Access({ workspace: root, workspaceId: "main" });
    expect(second).toMatchObject({ applied: 0, alreadyApplied: 1 });
    expect(readKgV3AccessState(root, "main").assertions[decisionId]?.accessCount).toBe(1);

    const after = renderKgV3Projection(assertions, second.state, new Date("2026-08-13T20:00:00.000Z"));
    expect(after.body).toContain(decisionId);
    expect(after.stats.hot).toBe(1);
  });

  test("frequency resistance promotes a cold preference after ten actual uses", () => {
    const { assertions } = fixture();
    const state = emptyState();
    state.assertions[decisionId] = { lastAccessed: "2026-06-01T00:00:00.000Z", accessCount: 10 };
    const projection = renderKgV3Projection(assertions, state, new Date("2026-08-13T12:00:00.000Z"));
    expect(projection.body).toContain(decisionId);
    expect(projection.stats.warm).toBe(1);
  });

  test("rejects unknown or non-active assertion ids before buffering", () => {
    const { root } = fixture();
    expect(() => recordKgV3AccessEvent({
      workspace: root,
      workspaceId: "main",
      sessionKey: "main",
      messageId: "unknown",
      assertionIds: ["33333333-3333-4333-8333-333333333333"],
      observedAt: "2026-08-13T16:40:47.000Z",
    })).toThrow("unknown KG v3 assertion");
  });
});
