import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { sealDeliveryOwnerPolicy } from "./contracts.ts";
import { canonicalLegacySessionKey, legacyDeliveryAllowed } from "./legacy-policy.ts";
import { DELIVERY_OWNER_POLICY_RELATIVE_PATH, defaultLegacyDeliveryOwnerPolicy } from "./policy.ts";

const roots: string[] = [];

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "engram-legacy-policy-"));
  roots.push(root);
  writeFileSync(join(root, "engram.json"), JSON.stringify({ workspace: { id: "main" } }));
  return root;
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("legacy context delivery policy", () => {
  test("canonicalizes legacy main, direct, group, and topic keys", () => {
    const root = fixture();
    expect(canonicalLegacySessionKey(root, { context: { sessionKey: "main" } })).toBe("agent:main:main");
    expect(canonicalLegacySessionKey(root, { context: { sessionKey: "telegram:direct:42" } })).toBe("agent:main:telegram:direct:42");
    expect(canonicalLegacySessionKey(root, { context: { sessionKey: "telegram:group:-100" } })).toBe("agent:main:telegram:group:-100");
    expect(canonicalLegacySessionKey(root, { context: { sessionKey: "telegram:-100:topic:7" } })).toBe("agent:main:telegram:group:-100:topic:7");
  });

  test("disables only the exact canary and fails back to legacy on malformed policy", () => {
    const root = fixture();
    const selected = "agent:main:telegram:direct:42";
    const policy = sealDeliveryOwnerPolicy({
      ...defaultLegacyDeliveryOwnerPolicy(), revision: 2, mode: "canary", canarySessionKeys: [selected],
    });
    const path = join(root, DELIVERY_OWNER_POLICY_RELATIVE_PATH);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(policy));
    expect(legacyDeliveryAllowed(root, { context: { sessionKey: selected } })).toBe(false);
    expect(legacyDeliveryAllowed(root, { context: { sessionKey: "agent:main:telegram:direct:43" } })).toBe(true);
    writeFileSync(path, "{bad-json}");
    expect(legacyDeliveryAllowed(root, { context: { sessionKey: selected } })).toBe(true);
  });
});
