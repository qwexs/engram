import { readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { KG_V3_SCHEMA_DIGEST, KgV3Core } from "./core.ts";
import {
  KgCanaryError, kgCanaryDigest, planKgCanary, recordCanaryExplicitReceipt,
  type KgCanaryManifestV1, type KgCanaryOptions,
} from "./canary.ts";
import {
  TrustedInboundVerifier, TrustedKgRuntime,
  type InboundMetadataEnvelope, type KgRuntimeGrantRegistryV1,
} from "./trusted-runtime.ts";

export interface KgCanaryReplayOptions extends KgCanaryOptions {
  runtimeGrantsPath: string;
  acknowledge?: boolean;
}

function inside(workspace: string, path: string): string {
  const root = resolve(workspace);
  const target = resolve(path);
  const rel = relative(root, target);
  if (rel === "" || rel.startsWith("..")) throw new KgCanaryError("PATH_ESCAPE", `path escapes workspace: ${path}`);
  return target;
}

function readObject<T>(path: string): T {
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new KgCanaryError("INVALID_JSON", `${path} must contain an object`);
  return value as T;
}

function exactMetadata(a: InboundMetadataEnvelope, b: InboundMetadataEnvelope): boolean {
  return a.transport === b.transport && a.accountId === b.accountId && a.workspaceId === b.workspaceId
    && a.sessionKey === b.sessionKey && a.actorId === b.actorId && a.messageId === b.messageId
    && a.contextKind === b.contextKind;
}

function replayInputs(options: KgCanaryReplayOptions) {
  const canaryPlan = planKgCanary(options);
  const workspace = resolve(options.workspace);
  const manifest = readObject<KgCanaryManifestV1>(inside(workspace, options.manifestPath));
  const grants = readObject<KgRuntimeGrantRegistryV1>(inside(workspace, options.runtimeGrantsPath));
  if (kgCanaryDigest(grants) !== manifest.runtimeGrantsDigest) throw new KgCanaryError("RUNTIME_GRANTS_DIGEST_MISMATCH", "runtime grants do not match the approved canary manifest");
  if (grants.schema !== "engram.kg-v3-runtime-grants.v1" || grants.workspaceId !== options.workspaceId || !Number.isInteger(grants.revision) || grants.revision < 1 || !Array.isArray(grants.principals)) {
    throw new KgCanaryError("RUNTIME_GRANTS_INVALID", "runtime grants identity is invalid");
  }
  const operationIds = new Set<string>();
  const replay = manifest.explicitRequests.map((request) => {
    const provenance = request.assertion.provenance;
    if (provenance.sourceKind !== "user_message" || operationIds.has(provenance.operationId) || !manifest.humanApprovedOperationIds.includes(provenance.operationId)) {
      throw new KgCanaryError("REPLAY_REQUEST_INVALID", "replay accepts only unique, human-approved user_message manifest entries");
    }
    operationIds.add(provenance.operationId);
    const principals = grants.principals.filter((principal) => principal.bindings.some((binding) => binding.actorId === provenance.actorId));
    if (principals.length !== 1) throw new KgCanaryError("REPLAY_BINDING_INVALID", "request actor must resolve to exactly one runtime principal");
    const bindings = principals[0].bindings.filter((binding) => binding.actorId === provenance.actorId);
    const grantsForSession = principals[0].grants.filter((grant) => grant.sessionKey === provenance.sessionKey && grant.capabilities.includes("kg:v3:write"));
    if (bindings.length !== 1 || grantsForSession.length !== 1) throw new KgCanaryError("REPLAY_BINDING_INVALID", "request requires one exact transport binding and one exact session write grant");
    const metadata: InboundMetadataEnvelope = {
      transport: bindings[0].transport,
      accountId: bindings[0].accountId,
      workspaceId: options.workspaceId,
      sessionKey: provenance.sessionKey,
      actorId: provenance.actorId,
      messageId: provenance.messageId,
      contextKind: "direct",
    };
    return { request, metadata };
  });
  return { canaryPlan, workspace, manifest, grants, replay };
}

function assertCollecting(value: ReturnType<typeof replayInputs>, options: KgCanaryReplayOptions): void {
  const root = join(value.workspace, "memory-state", "kg-v3");
  const state = readObject<any>(join(root, "canary", value.manifest.releaseDigest.slice(7), "state.json"));
  const authority = readObject<any>(join(root, "authority.json"));
  if (state.schema !== "engram.kg-v3-canary-state.v1" || state.workspaceId !== options.workspaceId
    || state.status !== "collecting" || state.releaseDigest !== value.manifest.releaseDigest
    || state.manifestDigest !== kgCanaryDigest(value.manifest)) {
    throw new KgCanaryError("CANARY_STATE_MISMATCH", "replay requires the exact immutable manifest in collecting state");
  }
  if (authority.workspaceId !== options.workspaceId || authority.mode !== "canary"
    || authority.releaseDigest !== value.manifest.releaseDigest || authority.schemaDigest !== KG_V3_SCHEMA_DIGEST) {
    throw new KgCanaryError("CANARY_STATE_MISMATCH", "replay authority does not match the collecting canary");
  }
}

/** Read-only, deterministic replay preview. This function never creates runtime attestations or writes files. */
export function planKgCanaryReplay(options: KgCanaryReplayOptions) {
  const value = replayInputs(options);
  return {
    schema: "engram.kg-v3-canary-replay-plan.v1",
    workspaceId: options.workspaceId,
    releaseDigest: value.manifest.releaseDigest,
    explicitRequestManifestDigest: value.manifest.explicitRequestManifestDigest,
    runtimeGrantsDigest: value.manifest.runtimeGrantsDigest,
    requestCount: value.replay.length,
    operationIds: value.replay.map(({ request }) => request.assertion.provenance.operationId),
    action: "operator-controlled-replay-of-previously-explicit-user-statements",
    mutatesWorkspace: false,
  } as const;
}

/**
 * Executes only immutable approved requests. Metadata is constructed internally
 * from each request's provenance plus its unique runtime binding; caller JSON is
 * never accepted as an authority input.
 */
export async function executeKgCanaryReplay(options: KgCanaryReplayOptions) {
  if (options.acknowledge !== true) throw new KgCanaryError("ACK_REQUIRED", "replay requires --ack-reviewed-replay");
  const value = replayInputs(options);
  assertCollecting(value, options);
  const core = new KgV3Core({ workspace: value.workspace, workspaceId: options.workspaceId });
  const receipts = [];
  let ledgerEntryCount = 0;
  for (const entry of value.replay) {
    const verifier = new TrustedInboundVerifier((candidate) => exactMetadata(candidate, entry.metadata));
    const runtime = new TrustedKgRuntime(core, value.grants, verifier);
    const receipt = await runtime.write(entry.request, verifier.attest(entry.metadata));
    if (receipt.status !== "committed") throw new KgCanaryError("REPLAY_WRITE_REJECTED", `approved replay write ${receipt.operationId} returned ${receipt.status}:${receipt.reason}`);
    const ledger = recordCanaryExplicitReceipt({ ...options, operationId: entry.request.assertion.provenance.operationId });
    ledgerEntryCount = ledger.entries.length;
    receipts.push({ operationId: receipt.operationId, status: receipt.status, assertionId: receipt.assertionId });
  }
  return {
    schema: "engram.kg-v3-canary-replay-result.v1",
    workspaceId: options.workspaceId,
    releaseDigest: value.manifest.releaseDigest,
    requestedCount: value.replay.length,
    receiptCount: receipts.length,
    ledgerEntryCount,
    receipts,
  } as const;
}
