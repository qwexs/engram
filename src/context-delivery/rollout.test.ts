import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultLegacyDeliveryOwnerPolicy } from "./policy.ts";
import { planDeliveryPolicyTransition, readInstalledDeliveryPolicy, writeDeliveryPolicyAtomic } from "./rollout.ts";

const roots: string[] = [];

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "engram-context-rollout-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("context delivery policy rollout", () => {
  test("enforces shadow before canary and exact keys before active", () => {
    const legacy = defaultLegacyDeliveryOwnerPolicy();
    expect(() => planDeliveryPolicyTransition({ current: legacy, mode: "canary", canarySessionKeys: ["agent:main:main"] })).toThrow("not allowed");
    const shadow = planDeliveryPolicyTransition({ current: legacy, mode: "shadow" }).policy;
    const canary = planDeliveryPolicyTransition({ current: shadow, mode: "canary", canarySessionKeys: ["agent:main:telegram:direct:42"] }).policy;
    expect(canary.revision).toBe(3);
    expect(canary.canarySessionKeys).toEqual(["agent:main:telegram:direct:42"]);
    expect(planDeliveryPolicyTransition({ current: canary, mode: "active" }).to).toBe("active");
  });

  test("writes with compare-and-swap semantics and reads the sealed policy back", () => {
    const root = workspace();
    const legacy = readInstalledDeliveryPolicy(root);
    const shadow = planDeliveryPolicyTransition({ current: legacy, mode: "shadow" }).policy;
    expect(writeDeliveryPolicyAtomic({ workspace: root, expectedPolicyDigest: legacy.policyDigest, policy: shadow })).toEqual(shadow);
    expect(readInstalledDeliveryPolicy(root)).toEqual(shadow);
    expect(() => writeDeliveryPolicyAtomic({ workspace: root, expectedPolicyDigest: legacy.policyDigest, policy: shadow })).toThrow("changed after planning");
  });

  test("rollback to legacy clears canary keys", () => {
    const legacy = defaultLegacyDeliveryOwnerPolicy();
    const shadow = planDeliveryPolicyTransition({ current: legacy, mode: "shadow" }).policy;
    const canary = planDeliveryPolicyTransition({ current: shadow, mode: "canary", canarySessionKeys: ["agent:main:main"] }).policy;
    const rollback = planDeliveryPolicyTransition({ current: canary, mode: "legacy" }).policy;
    expect(rollback.mode).toBe("legacy");
    expect(rollback.canarySessionKeys).toEqual([]);
  });
});
