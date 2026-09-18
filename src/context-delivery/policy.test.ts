import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  DELIVERY_OWNER_POLICY_RELATIVE_PATH,
  defaultLegacyDeliveryOwnerPolicy,
  deliveryOwnershipDecision,
  readDeliveryOwnerPolicy,
} from "./policy.ts";
import { sealDeliveryOwnerPolicy } from "./contracts.ts";

const roots: string[] = [];

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "engram-delivery-policy-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("delivery owner policy", () => {
  test("preserves legacy ownership when no policy has been installed", () => {
    const policy = readDeliveryOwnerPolicy(fixture());
    expect(policy).toEqual(defaultLegacyDeliveryOwnerPolicy());
    expect(deliveryOwnershipDecision(policy, "agent:main:main")).toEqual({
      legacyMayDeliver: true, pluginMayDeliver: false, pluginObserves: false,
    });
  });

  test("splits an exact canary from legacy scopes", () => {
    const selected = "agent:main:telegram:direct:10001";
    const policy = sealDeliveryOwnerPolicy({
      ...defaultLegacyDeliveryOwnerPolicy(),
      revision: 2,
      mode: "canary",
      canarySessionKeys: [selected],
    });
    expect(deliveryOwnershipDecision(policy, selected)).toEqual({
      legacyMayDeliver: false, pluginMayDeliver: true, pluginObserves: true,
    });
    expect(deliveryOwnershipDecision(policy, "agent:main:main")).toEqual({
      legacyMayDeliver: true, pluginMayDeliver: false, pluginObserves: true,
    });
  });

  test("reads a sealed policy and rejects drifted bytes", () => {
    const root = fixture();
    const path = join(root, DELIVERY_OWNER_POLICY_RELATIVE_PATH);
    mkdirSync(dirname(path), { recursive: true });
    const policy = sealDeliveryOwnerPolicy({
      ...defaultLegacyDeliveryOwnerPolicy(),
      revision: 3,
      mode: "shadow",
    });
    writeFileSync(path, `${JSON.stringify(policy)}\n`);
    expect(readDeliveryOwnerPolicy(root).mode).toBe("shadow");
    writeFileSync(path, `${JSON.stringify({ ...policy, revision: 4 })}\n`);
    expect(() => readDeliveryOwnerPolicy(root)).toThrow("digest mismatch");
  });

  test("rejects non-canonical scope checks", () => {
    expect(() => deliveryOwnershipDecision(defaultLegacyDeliveryOwnerPolicy(), "telegram:direct:1")).toThrow("non-canonical");
  });

  test("rejects the unreleased v1 shape instead of reinterpreting its digest", () => {
    const root = fixture();
    const path = join(root, DELIVERY_OWNER_POLICY_RELATIVE_PATH);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify({ ...defaultLegacyDeliveryOwnerPolicy(), schema: "engram.context-delivery-owner-policy.v1" })}\n`);
    expect(() => readDeliveryOwnerPolicy(root)).toThrow("schema");
  });
});
