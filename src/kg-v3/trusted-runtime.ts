import type { KgReceipt, KgRetractionRequest, KgWriteRequest, TrustedKgCallerContext } from "./types.ts";

export interface InboundMetadataEnvelope {
  transport: "telegram" | "openclaw";
  accountId: string;
  workspaceId: string;
  sessionKey: string;
  actorId: string;
  messageId: string;
  contextKind: "direct" | "group" | "topic";
}

export type AttestedInboundMetadata = Readonly<InboundMetadataEnvelope>;

/** Non-serializable attestation: structural JSON cannot enter this WeakSet. */
export class TrustedInboundVerifier {
  readonly #attested = new WeakSet<object>();
  constructor(readonly verifyTransportEnvelope: (metadata: InboundMetadataEnvelope) => boolean) {}
  attest(metadata: InboundMetadataEnvelope): AttestedInboundMetadata {
    if (!this.verifyTransportEnvelope(metadata)) throw new TrustedKgRuntimeError("UNVERIFIED_INBOUND", "transport verifier rejected inbound metadata");
    const attested = Object.freeze({ ...metadata });
    this.#attested.add(attested);
    return attested;
  }
  isAttested(metadata: unknown): metadata is AttestedInboundMetadata {
    return Boolean(metadata && typeof metadata === "object" && this.#attested.has(metadata as object));
  }
}

export interface KgRuntimeGrantRegistryV1 {
  schema: "engram.kg-v3-runtime-grants.v1";
  workspaceId: string;
  revision: number;
  principals: Array<{
    principalId: string;
    bindings: Array<{ transport: "telegram" | "openclaw"; accountId: string; actorId: string }>;
    grants: Array<{ sessionKey: string; capabilities: Array<"kg:v3:write" | "kg:v3:retract"> }>;
  }>;
}

export interface KgTypedCoreApi {
  write(request: KgWriteRequest, caller: TrustedKgCallerContext): Promise<KgReceipt>;
  retract(request: KgRetractionRequest, caller: TrustedKgCallerContext): Promise<KgReceipt>;
}

export class TrustedKgRuntimeError extends Error {
  constructor(readonly code: "UNVERIFIED_INBOUND" | "WORKSPACE_MISMATCH" | "ACTOR_UNRESOLVED" | "GRANT_MISSING" | "PROVENANCE_MISMATCH", message: string) {
    super(message);
    this.name = "TrustedKgRuntimeError";
  }
}

function callerFromVerifiedInbound(metadata: AttestedInboundMetadata, registry: KgRuntimeGrantRegistryV1, verifier: TrustedInboundVerifier, capability: "kg:v3:write" | "kg:v3:retract"): TrustedKgCallerContext {
  if (!verifier.isAttested(metadata)) throw new TrustedKgRuntimeError("UNVERIFIED_INBOUND", "runtime-attested inbound metadata is required");
  if (registry.schema !== "engram.kg-v3-runtime-grants.v1" || registry.workspaceId !== metadata.workspaceId) throw new TrustedKgRuntimeError("WORKSPACE_MISMATCH", "runtime grant registry workspace mismatch");
  const principals = registry.principals.filter((principal) => principal.bindings.some((binding) => binding.transport === metadata.transport && binding.accountId === metadata.accountId && binding.actorId === metadata.actorId));
  if (principals.length !== 1) throw new TrustedKgRuntimeError("ACTOR_UNRESOLVED", "verified actor binding must resolve exactly once");
  const grants = principals[0].grants.filter((grant) => grant.sessionKey === metadata.sessionKey && grant.capabilities.includes(capability));
  if (grants.length !== 1) throw new TrustedKgRuntimeError("GRANT_MISSING", "exact session capability grant is required");
  return { trusted: true, workspaceId: metadata.workspaceId, sessionKey: metadata.sessionKey, actorId: metadata.actorId, capabilities: [capability] };
}

/** Transport-neutral boundary. Adapters verify Telegram/OpenClaw metadata before calling this API. */
export class TrustedKgRuntime {
  constructor(readonly core: KgTypedCoreApi, readonly grants: KgRuntimeGrantRegistryV1, readonly verifier: TrustedInboundVerifier) {}

  async write(request: KgWriteRequest, metadata: AttestedInboundMetadata): Promise<KgReceipt> {
    const caller = callerFromVerifiedInbound(metadata, this.grants, this.verifier, "kg:v3:write");
    const provenance = request.assertion.provenance;
    if (provenance.sourceKind !== "user_message" || provenance.sessionKey !== metadata.sessionKey || provenance.actorId !== metadata.actorId || provenance.messageId !== metadata.messageId || request.assertion.workspaceId !== metadata.workspaceId) {
      throw new TrustedKgRuntimeError("PROVENANCE_MISMATCH", "request provenance must equal verified inbound metadata");
    }
    return this.core.write(request, caller);
  }

  async retract(request: KgRetractionRequest, metadata: AttestedInboundMetadata): Promise<KgReceipt> {
    const caller = callerFromVerifiedInbound(metadata, this.grants, this.verifier, "kg:v3:retract");
    const provenance = request.provenance;
    if (provenance.sourceKind !== "user_message" || provenance.sessionKey !== metadata.sessionKey || provenance.actorId !== metadata.actorId || provenance.messageId !== metadata.messageId || request.workspaceId !== metadata.workspaceId) {
      throw new TrustedKgRuntimeError("PROVENANCE_MISMATCH", "request provenance must equal verified inbound metadata");
    }
    return this.core.retract(request, caller);
  }
}
