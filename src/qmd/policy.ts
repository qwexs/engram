import { policyError } from "../cli/errors.ts";
import type {
  QmdCallerCapability,
  QmdCallerContext,
  QmdContext,
  QmdInvocation,
  QmdPolicyDecision,
  QmdPolicyDecisionCode,
  QmdPolicyDecisionSummary,
} from "./types.ts";

export const OPERATOR_CALLER: QmdCallerContext = {
  kind: "operator",
  allowedCollections: [],
  capabilities: ["diagnostics"],
};

const DIAGNOSTIC_OPERATIONS = new Set(["capabilities", "status"]);
const READ_OPERATIONS = new Set(["search", "query", "vsearch"]);
const MAINTENANCE_CALLERS = new Set<QmdCallerContext["kind"]>(["heartbeat", "provisioning", "coordinator"]);

function snapshotCaller(caller: QmdCallerContext): QmdCallerContext {
  return {
    kind: caller.kind,
    ...(caller.sessionKey ? { sessionKey: caller.sessionKey } : {}),
    ...(caller.domain ? { domain: caller.domain } : {}),
    allowedCollections: [...caller.allowedCollections],
    capabilities: [...caller.capabilities],
  };
}

function decision(
  invocation: QmdInvocation,
  caller: QmdCallerContext,
  allowed: boolean,
  code: QmdPolicyDecisionCode,
  reason: string,
): QmdPolicyDecision {
  return {
    schema: "engram.qmd.policy-decision.v1",
    allowed,
    code,
    reason,
    caller: snapshotCaller(caller),
    operation: invocation.operation,
    effectiveScope: invocation.effectiveScope,
    collections: [...invocation.collections],
  };
}

function hasCapability(caller: QmdCallerContext, capability: QmdCallerCapability): boolean {
  return caller.capabilities.includes(capability);
}

function sameSet(left: string[], right: string[]): boolean {
  const actual = new Set(left);
  const expected = new Set(right);
  if (actual.size !== left.length || expected.size !== right.length || actual.size !== expected.size) return false;
  return [...actual].every((value) => expected.has(value));
}

export function summarizeQmdPolicyDecision(decision: QmdPolicyDecision): QmdPolicyDecisionSummary {
  return { ...decision, caller: { kind: decision.caller.kind } };
}

export function decideQmdPolicy(
  context: QmdContext,
  invocation: QmdInvocation,
  caller: QmdCallerContext,
): QmdPolicyDecision {
  if (DIAGNOSTIC_OPERATIONS.has(invocation.operation)) {
    if (invocation.effectiveScope !== "index" || invocation.collections.length > 0) {
      return decision(invocation, caller, false, "DENY_EFFECTIVE_SCOPE", "Diagnostics must be index-scoped.");
    }
    if (caller.kind === "operator") {
      return decision(invocation, caller, true, "ALLOW_OPERATOR_DIAGNOSTIC", "Operator diagnostics are read-only.");
    }
    if (hasCapability(caller, "diagnostics")) {
      return decision(invocation, caller, true, "ALLOW_INTERNAL_DIAGNOSTIC", "Trusted caller has diagnostics capability.");
    }
    return decision(invocation, caller, false, "DENY_CALLER_CAPABILITY", "Internal diagnostics capability is required.");
  }

  if (READ_OPERATIONS.has(invocation.operation)) {
    if (invocation.effectiveScope !== "collections") {
      return decision(invocation, caller, false, "DENY_EFFECTIVE_SCOPE", "Search operations must be collection-scoped.");
    }
    if (invocation.collections.length === 0) {
      return decision(invocation, caller, false, "DENY_EMPTY_COLLECTION_SCOPE", "Explicit collections are required.");
    }
    if (!hasCapability(caller, "read")) {
      return decision(invocation, caller, false, "DENY_CALLER_CAPABILITY", "Caller read capability is required.");
    }
    const workspaceReadable = new Set(context.policy.readableCollections);
    const callerAllowed = new Set(caller.allowedCollections);
    const denied = invocation.collections.filter((collection) => (
      !workspaceReadable.has(collection) || !callerAllowed.has(collection)
    ));
    if (denied.length > 0) {
      return decision(
        invocation,
        caller,
        false,
        "DENY_COLLECTION_SCOPE",
        `Collections are outside the caller's readable intersection: ${denied.join(", ")}`,
      );
    }
    return decision(invocation, caller, true, "ALLOW_COLLECTION_READ", "Collections are readable by workspace and caller.");
  }

  if (invocation.operation === "embed") {
    if (!MAINTENANCE_CALLERS.has(caller.kind)) {
      return decision(invocation, caller, false, "DENY_MAINTENANCE_CALLER", "Embed is limited to trusted maintenance callers.");
    }
    if (!hasCapability(caller, "maintenance")) {
      return decision(invocation, caller, false, "DENY_CALLER_CAPABILITY", "Explicit maintenance capability is required.");
    }
    if (invocation.effectiveScope !== "collections") {
      return decision(invocation, caller, false, "DENY_EFFECTIVE_SCOPE", "Embed must be collection-scoped.");
    }
    if (caller.kind === "coordinator") {
      if (invocation.collections.length === 0) {
        return decision(invocation, caller, false, "DENY_EMPTY_COLLECTION_SCOPE", "Coordinator embed requires explicit collections.");
      }
      const allowed = new Set(caller.allowedCollections);
      const denied = invocation.collections.filter((collection) => !allowed.has(collection));
      if (denied.length > 0) {
        return decision(
          invocation,
          caller,
          false,
          "DENY_COLLECTION_SCOPE",
          `Coordinator embed collections are outside its trusted allowlist: ${denied.join(", ")}`,
        );
      }
      return decision(invocation, caller, true, "ALLOW_COORDINATED_EMBED", "Coordinator may embed its explicit trusted collection scope.");
    }
    if (!sameSet(invocation.collections, context.policy.ownedCollections)) {
      return decision(invocation, caller, false, "DENY_COLLECTION_SCOPE", "Embed scope must exactly match owned collections.");
    }
    return decision(invocation, caller, true, "ALLOW_OWNED_EMBED", "Maintenance caller may embed owned collections.");
  }

  if (invocation.operation === "update") {
    if (!MAINTENANCE_CALLERS.has(caller.kind)) {
      return decision(invocation, caller, false, "DENY_MAINTENANCE_CALLER", "Update is limited to heartbeat and provisioning callers.");
    }
    if (!hasCapability(caller, "maintenance")) {
      return decision(invocation, caller, false, "DENY_CALLER_CAPABILITY", "Explicit maintenance capability is required.");
    }
    if (invocation.effectiveScope !== "index" || invocation.collections.length > 0) {
      return decision(invocation, caller, false, "DENY_EFFECTIVE_SCOPE", "Update must be index-scoped without collections.");
    }
    return decision(invocation, caller, true, "ALLOW_INDEX_UPDATE", "Maintenance caller may update the resolved index.");
  }

  if (invocation.operation === "collection-add") {
    if (caller.kind !== "provisioning" || !hasCapability(caller, "provisioning")) {
      return decision(invocation, caller, false, "DENY_CALLER_CAPABILITY", "Collection provisioning requires its dedicated trusted capability.");
    }
    if (invocation.effectiveScope !== "collections" || invocation.collections.length !== 1) {
      return decision(invocation, caller, false, "DENY_EFFECTIVE_SCOPE", "Collection provisioning must identify exactly one collection.");
    }
    if (!caller.allowedCollections.includes(invocation.collections[0]!)) {
      return decision(invocation, caller, false, "DENY_COLLECTION_SCOPE", "Collection is outside the provisioning manifest allowlist.");
    }
    return decision(invocation, caller, true, "ALLOW_COLLECTION_PROVISION", "Trusted provisioning caller may add the manifest collection.");
  }

  return decision(invocation, caller, false, "DENY_UNSUPPORTED_OPERATION", "Operation is not present in the QMD policy matrix.");
}

export function authorizeQmdInvocation(
  context: QmdContext,
  invocation: QmdInvocation,
  caller: QmdCallerContext,
): QmdPolicyDecision {
  const result = decideQmdPolicy(context, invocation, caller);
  if (!result.allowed) {
    throw policyError(result.reason, { decision: summarizeQmdPolicyDecision(result) });
  }
  return result;
}
