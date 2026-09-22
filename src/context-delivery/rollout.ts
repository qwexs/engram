import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  parseCanonicalSessionKey,
  sealDeliveryOwnerPolicy,
  type DeliveryOwnerMode,
  type DeliveryOwnerPolicyV2,
} from "./contracts.ts";
import {
  DELIVERY_OWNER_POLICY_RELATIVE_PATH,
  defaultLegacyDeliveryOwnerPolicy,
  readDeliveryOwnerPolicy,
} from "./policy.ts";

export type PolicyTransition = {
  from: DeliveryOwnerMode;
  to: DeliveryOwnerMode;
  policy: DeliveryOwnerPolicyV2;
};

export function planDeliveryPolicyTransition(options: {
  current: DeliveryOwnerPolicyV2;
  mode: DeliveryOwnerMode;
  canarySessionKeys?: string[];
}): PolicyTransition {
  const keys = [...new Set(options.canarySessionKeys ?? [])].sort();
  if (keys.some((key) => !parseCanonicalSessionKey(key))) throw new Error("canary contains a non-canonical session key");
  if (options.mode === "canary" && keys.length === 0) throw new Error("canary mode requires at least one exact session key");
  if (options.mode !== "canary" && keys.length > 0) throw new Error("only canary mode may carry selected session keys");
  const allowed: Record<DeliveryOwnerMode, DeliveryOwnerMode[]> = {
    legacy: ["legacy", "shadow"],
    shadow: ["legacy", "shadow", "canary"],
    canary: ["legacy", "shadow", "canary", "active"],
    active: ["legacy", "shadow", "active"],
  };
  if (!allowed[options.current.mode].includes(options.mode)) {
    throw new Error(`delivery owner transition ${options.current.mode} -> ${options.mode} is not allowed`);
  }
  const policy = sealDeliveryOwnerPolicy({
    schema: "engram.context-delivery-owner-policy.v2",
    revision: options.current.revision + 1,
    mode: options.mode,
    canarySessionKeys: keys,
    caps: options.current.caps,
  });
  return { from: options.current.mode, to: options.mode, policy };
}

export function readInstalledDeliveryPolicy(workspace: string): DeliveryOwnerPolicyV2 {
  return readDeliveryOwnerPolicy(workspace);
}

export function writeDeliveryPolicyAtomic(options: {
  workspace: string;
  expectedPolicyDigest: string;
  policy: DeliveryOwnerPolicyV2;
}): DeliveryOwnerPolicyV2 {
  const current = existsSync(join(options.workspace, DELIVERY_OWNER_POLICY_RELATIVE_PATH))
    ? readDeliveryOwnerPolicy(options.workspace)
    : defaultLegacyDeliveryOwnerPolicy();
  if (current.policyDigest !== options.expectedPolicyDigest) throw new Error("delivery owner policy changed after planning");
  const path = join(options.workspace, DELIVERY_OWNER_POLICY_RELATIVE_PATH);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temporary, `${JSON.stringify(options.policy, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  renameSync(temporary, path);
  const readBack = readDeliveryOwnerPolicy(options.workspace);
  if (readBack.policyDigest !== options.policy.policyDigest) throw new Error("delivery owner policy read-back mismatch");
  return readBack;
}
