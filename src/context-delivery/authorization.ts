import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import { loadActorRegistry } from "../oll/authorization.ts";
import type { RuleContextTargetV1 } from "../oll/rule-context.ts";
import { normalizeSessionSegment } from "../session-key.ts";
import type { CanonicalDeliveryScope } from "./contracts.ts";

type JsonObject = Record<string, any>;

function readJson(path: string): JsonObject {
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected JSON object");
  return value;
}

function expandInsideStateRoot(setting: string, stateRoot: string): string {
  const root = realpathSync(resolve(stateRoot));
  const path = realpathSync(resolve(setting.replaceAll("${ENGRAM_STATE_ROOT}", root)));
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  if (path !== root && !path.startsWith(prefix)) throw new Error("actor registry path escapes Engram state root");
  return path;
}

export function authorizeKgContext(options: {
  workspace: string;
  workspaceId: string;
  scope: CanonicalDeliveryScope;
}): boolean {
  if (options.scope.kind === "group-direct" || options.scope.kind === "topic-thread") return false;
  const authority = readJson(resolve(options.workspace, "memory-state/kg-v3/authority.json"));
  const grants = readJson(resolve(options.workspace, "memory-state/kg-v3/runtime-grants.json"));
  if (authority.schema !== "engram.kg-v3-authority.v1" || authority.workspaceId !== options.workspaceId
    || grants.schema !== "engram.kg-v3-runtime-grants.v1" || grants.workspaceId !== options.workspaceId) return false;
  const enabled = Array.isArray(authority.enabledSessionCapabilities) ? authority.enabledSessionCapabilities : [];
  const enabledFor = (segment: string): boolean => enabled.filter((entry: any) => (
    normalizeSessionSegment(entry?.sessionKey) === segment
      && Array.isArray(entry?.capabilities)
      && entry.capabilities.includes("kg:v3:write")
  )).length === 1;
  if (options.scope.kind === "main") return enabledFor("main");

  const actorId = options.scope.actorId!;
  const segment = normalizeSessionSegment(options.scope.sessionKey);
  if (!segment || !/^telegram-direct-[1-9][0-9]*$/.test(segment)) return false;
  const principals = Array.isArray(grants.principals) ? grants.principals.filter((principal: any) => (
    Array.isArray(principal?.bindings)
      && principal.bindings.some((binding: any) => binding?.transport === "telegram" && String(binding.actorId) === actorId)
  )) : [];
  if (principals.length !== 1 || !Array.isArray(principals[0].grants)) return false;
  const matchingGrants = principals[0].grants.filter((grant: any) => {
    const granted = normalizeSessionSegment(grant?.sessionKey);
    return (granted === segment || granted === "main")
      && Array.isArray(grant?.capabilities)
      && grant.capabilities.includes("kg:v3:write")
      && enabledFor(granted);
  });
  return matchingGrants.length === 1;
}

export function resolvePersonSubjects(options: {
  workspace: string;
  stateRoot: string;
  scope: CanonicalDeliveryScope;
  accountId?: string;
}): string[] {
  if (options.scope.kind !== "peer-direct" || !options.scope.actorId) return [];
  if (!isAbsolute(options.stateRoot)) throw new Error("Engram state root must be absolute");
  const config = readJson(resolve(options.workspace, "engram.json"));
  const setting = String(config?.oll?.adaptation?.actorRegistry || "${ENGRAM_STATE_ROOT}/oll/actors.v1.json");
  const loaded = loadActorRegistry(expandInsideStateRoot(setting, options.stateRoot));
  const principals = (loaded.registry.principals as any[]).filter((principal) => (
    Array.isArray(principal?.transportBindings)
      && principal.transportBindings.some((binding: any) => (
        binding.channel === "telegram"
          && String(binding.accountId || "default") === String(options.accountId || "default")
          && String(binding.actorId) === options.scope.actorId
      ))
  ));
  if (principals.length !== 1) return [];
  return [
    String(principals[0].principalId),
    `telegram:${options.scope.actorId}`,
    `telegram:user:${options.scope.actorId}`,
  ];
}

export function buildRuleContextTarget(options: {
  workspaceId: string;
  scope: CanonicalDeliveryScope;
  domainName?: string | null;
  personSubjects?: string[];
}): RuleContextTargetV1 {
  const multiPerson = options.scope.kind === "group-direct" || options.scope.kind === "topic-thread";
  return {
    workspaceId: options.workspaceId,
    sessionKind: options.scope.kind,
    domainSubjects: options.domainName ? [options.domainName] : [],
    personSubjects: multiPerson ? [] : [...(options.personSubjects ?? [])],
    multiPerson,
  };
}
