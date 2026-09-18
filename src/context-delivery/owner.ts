import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import {
  authorizeKgContext,
  buildRuleContextTarget,
  resolvePersonSubjects,
} from "./authorization.ts";
import {
  planDelivery,
  resolveDeliveryScope,
  type DeliveryHookIdentity,
  type DeliveryReason,
  type DeliveryReceiptV1,
  type DeliverySource,
  type DeliverySourceOutcome,
} from "./contracts.ts";
import { resolveExactDomainBinding } from "./domain-source.ts";
import { deliveryOwnershipDecision, readDeliveryOwnerPolicy } from "./policy.ts";
import {
  DeliverySourceAdapterError,
  resolveDomainContextSource,
  resolveKgContextSource,
  resolveOllContextSource,
  splitSourceOutcomes,
} from "./source-adapters.ts";
import { resolveSessionContextSource } from "./session-source.ts";

type HookEvent = { prompt?: unknown; messages?: unknown };
type HookContext = {
  runId?: unknown;
  agentId?: unknown;
  sessionKey?: unknown;
  sessionId?: unknown;
  workspaceDir?: unknown;
  channel?: unknown;
  accountId?: unknown;
  chatId?: unknown;
  senderId?: unknown;
  trigger?: unknown;
  contextTokenBudget?: unknown;
};

export type ContextDeliveryOwnerResult = {
  context: string | null;
  receipt: DeliveryReceiptV1 | null;
};

export type ContextDeliveryOwnerDependencies = {
  resolveAgentWorkspaceDir: (agentId: string) => string;
  stateRoot: string;
  now?: () => string;
};

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function omitted(source: DeliverySource, reason: DeliveryReason): DeliverySourceOutcome {
  return { source, status: "omitted", reason };
}

function safeSource(source: DeliverySource, fn: () => DeliverySourceOutcome, reason: DeliveryReason): DeliverySourceOutcome {
  try {
    return fn();
  } catch (error) {
    return omitted(source, error instanceof DeliverySourceAdapterError ? error.reason : reason);
  }
}

function workspaceId(workspace: string): string {
  const config = JSON.parse(readFileSync(join(workspace, "engram.json"), "utf8"));
  const id = typeof config?.workspace?.id === "string" ? config.workspace.id.trim() : "";
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(id)) throw new Error("invalid Engram workspace id");
  return id;
}

export class ContextDeliveryOwner {
  constructor(private readonly dependencies: ContextDeliveryOwnerDependencies) {
    if (!isAbsolute(dependencies.stateRoot)) throw new Error("Engram state root must be absolute");
  }

  prepare(_event: HookEvent, ctx: HookContext): ContextDeliveryOwnerResult {
    if (ctx.trigger !== undefined && ctx.trigger !== "user") return { context: null, receipt: null };
    const runId = stringField(ctx.runId);
    const agentId = stringField(ctx.agentId);
    const sessionKey = stringField(ctx.sessionKey);
    const workspaceValue = stringField(ctx.workspaceDir);
    if (!runId || !agentId || !sessionKey || !workspaceValue) return { context: null, receipt: null };

    const workspace = realpathSync(resolve(workspaceValue));
    const expectedWorkspace = realpathSync(resolve(this.dependencies.resolveAgentWorkspaceDir(agentId)));
    const identity: DeliveryHookIdentity = {
      runId,
      agentId,
      sessionKey,
      workspaceDir: workspace,
      expectedWorkspaceDir: expectedWorkspace,
      channel: stringField(ctx.channel) ?? undefined,
      chatId: stringField(ctx.chatId) ?? undefined,
      senderId: stringField(ctx.senderId) ?? undefined,
    };
    const scope = resolveDeliveryScope(identity);
    if (!scope) return { context: null, receipt: null };
    const policy = readDeliveryOwnerPolicy(workspace);
    const ownership = deliveryOwnershipDecision(policy, sessionKey);
    if (!ownership.pluginObserves) return { context: null, receipt: null };

    const id = workspaceId(workspace);
    let domainName: string | null = null;
    try {
      domainName = resolveExactDomainBinding({ workspace, workspaceId: id, scope })?.domainName ?? null;
    } catch {
      domainName = null;
    }

    let personSubjects: string[] = [];
    try {
      personSubjects = resolvePersonSubjects({
        workspace,
        stateRoot: this.dependencies.stateRoot,
        scope,
        accountId: stringField(ctx.accountId) ?? undefined,
      });
    } catch {
      personSubjects = [];
    }
    const target = buildRuleContextTarget({ workspaceId: id, scope, domainName, personSubjects });

    let kgAuthorized = false;
    try {
      kgAuthorized = authorizeKgContext({ workspace, workspaceId: id, scope });
    } catch {
      kgAuthorized = false;
    }
    const outcomes: DeliverySourceOutcome[] = [
      safeSource("kg", () => resolveKgContextSource({
        workspace,
        workspaceId: id,
        scope,
        trustedPeer: kgAuthorized,
      }), kgAuthorized ? "SOURCE_INVALID" : "AUTH_DENIED"),
      safeSource("domain", () => resolveDomainContextSource({
        workspace,
        workspaceId: id,
        scope,
        maxRenderedBytes: policy.caps.sourceBytes.domain,
      }), "SOURCE_INVALID"),
      safeSource("session", () => resolveSessionContextSource({
        workspace,
        scope,
        now: this.dependencies.now?.(),
      }), "SOURCE_INVALID"),
      safeSource("oll", () => resolveOllContextSource({
        workspace,
        stateRoot: this.dependencies.stateRoot,
        target,
        now: this.dependencies.now?.(),
      }), "SOURCE_INVALID"),
    ];
    const sourceSet = splitSourceOutcomes(outcomes);
    const plan = planDelivery({
      identity,
      policy,
      ...sourceSet,
      contextTokenBudget: Number.isSafeInteger(ctx.contextTokenBudget) ? ctx.contextTokenBudget as number : undefined,
    });
    return {
      context: ownership.pluginMayDeliver ? plan.context : null,
      receipt: plan.receipt,
    };
  }
}
