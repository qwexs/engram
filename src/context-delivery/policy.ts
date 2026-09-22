import { existsSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import {
  parseCanonicalSessionKey,
  parseDeliveryOwnerPolicy,
  sealDeliveryOwnerPolicy,
  type DeliveryOwnerPolicyV2,
} from "./contracts.ts";

export const DELIVERY_OWNER_POLICY_RELATIVE_PATH = "memory-state/context-delivery/owner-policy.json";

export function defaultLegacyDeliveryOwnerPolicy(): DeliveryOwnerPolicyV2 {
  return sealDeliveryOwnerPolicy({
    schema: "engram.context-delivery-owner-policy.v2",
    revision: 1,
    mode: "legacy",
    canarySessionKeys: [],
    caps: {
      totalBytes: 24 * 1024,
      sourceBytes: { oll: 8 * 1024, domain: 12 * 1024, session: 8 * 1024, kg: 12 * 1024 },
      minContextTokenBudget: 16_000,
    },
  });
}

function policyPath(workspace: string): string {
  const root = resolve(workspace);
  const path = resolve(join(root, DELIVERY_OWNER_POLICY_RELATIVE_PATH));
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  if (!path.startsWith(prefix)) throw new Error("delivery owner policy path escapes workspace");
  return path;
}

/** Missing policy preserves the installed legacy owner. Malformed policy fails. */
export function readDeliveryOwnerPolicy(workspace: string): DeliveryOwnerPolicyV2 {
  const path = policyPath(workspace);
  if (!existsSync(path)) return defaultLegacyDeliveryOwnerPolicy();
  return parseDeliveryOwnerPolicy(JSON.parse(readFileSync(path, "utf8")));
}

export type DeliveryOwnershipDecision = {
  legacyMayDeliver: boolean;
  pluginMayDeliver: boolean;
  pluginObserves: boolean;
};

export function deliveryOwnershipDecision(policy: DeliveryOwnerPolicyV2, sessionKey: string): DeliveryOwnershipDecision {
  if (!parseCanonicalSessionKey(sessionKey)) throw new Error("delivery owner policy received a non-canonical session key");
  if (policy.mode === "legacy") return { legacyMayDeliver: true, pluginMayDeliver: false, pluginObserves: false };
  if (policy.mode === "shadow") return { legacyMayDeliver: true, pluginMayDeliver: false, pluginObserves: true };
  if (policy.mode === "active") return { legacyMayDeliver: false, pluginMayDeliver: true, pluginObserves: true };
  const selected = policy.canarySessionKeys.includes(sessionKey);
  return {
    legacyMayDeliver: !selected,
    pluginMayDeliver: selected,
    pluginObserves: true,
  };
}
