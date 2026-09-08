import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { MemoryObservationBindingV1 } from "./projection.ts";
import { assertTopicDomainRegistry, assertTopicHostRoutes, validTopicBinding } from "./topic-bindings.ts";

export type GroupDirectDomainBinding = { domain: string; chatId: string };
const GROUP_KEY = /^agent:([A-Za-z0-9._-]+):telegram:group:(-[1-9][0-9]*)$/;

export function isGroupProjectionSchema(schema: unknown): boolean {
  return schema === "engram.memory-observation-rollout.v4" || schema === "engram.memory-observation-rollout.v5";
}

export function groupDomainOf(binding: { topicDomain?: { domain: string; chatId: string }; groupDomain?: GroupDirectDomainBinding } | null | undefined) {
  return binding?.topicDomain ?? binding?.groupDomain;
}

export function validGroupDirectBinding(binding: MemoryObservationBindingV1, workspaceId?: string): boolean {
  const match = GROUP_KEY.exec(binding.runtimeSessionKey), group = binding.groupDomain;
  return Boolean(match && group && !binding.topicDomain && (!workspaceId || match[1] === workspaceId)
    && Object.keys(group).sort().join(",") === "chatId,domain"
    && /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(group.domain) && match[2] === group.chatId
    && binding.scopeClass !== "self" && binding.scopeId === `domain:${match[1]}:${group.domain}`
    && binding.requireOwner === false && binding.allowedChannels?.length === 1 && binding.allowedChannels[0] === "telegram");
}

export function assertGroupDomainRegistry(workspace: string, workspaceId: string, bindings: MemoryObservationBindingV1[]): void {
  const registry = JSON.parse(readFileSync(join(workspace, "memory/domains/registry.json"), "utf8"));
  const domains = Object.entries<any>(registry.domains ?? {});
  if (new Set(bindings.map(b => b.runtimeSessionKey)).size !== bindings.length) throw new Error("duplicate group binding");
  for (const binding of bindings) {
    if (!binding.groupDomain) { assertTopicDomainRegistry(workspace, workspaceId, [binding]); continue; }
    if (!validGroupDirectBinding(binding, workspaceId)) throw new Error("invalid exact group-direct binding");
    const group = binding.groupDomain;
    const matches = domains.filter(([, entry]) => entry?.group && String(entry.group.chatId) === group.chatId);
    if (matches.length !== 1 || matches[0]![0] !== group.domain || matches[0]![1].type !== "group-direct"
      || matches[0]![1].topic || matches[0]![1].peer || matches[0]![1].archived === true || matches[0]![1].enabled === false
      || domains.some(([, entry]) => String(entry?.topic?.chatId) === group.chatId)) {
      throw new Error("group-direct domain is missing, ambiguous, inactive, or changed");
    }
    const expected = join(realpathSync(workspace), "memory/domains", group.domain);
    if (realpathSync(expected) !== expected) throw new Error("group-direct domain is not a canonical directory");
  }
}

export function assertGroupHostRoutes(config: any, workspace: string, workspaceId: string, bindings: MemoryObservationBindingV1[]): void {
  const entries = config?.agents?.entries;
  const agent = Array.isArray(entries) ? entries.find((entry: any) => entry.id === workspaceId) : entries?.[workspaceId];
  if (!agent?.workspace || realpathSync(agent.workspace) !== realpathSync(workspace)) throw new Error("group agent workspace mismatch");
  for (const binding of bindings) {
    if (!binding.groupDomain) { assertTopicHostRoutes(config, workspace, workspaceId, [binding]); continue; }
    if (!validGroupDirectBinding(binding, workspaceId)) throw new Error("invalid group-direct host binding");
    const group = config?.channels?.telegram?.groups?.[binding.groupDomain.chatId];
    const routes = (Array.isArray(config?.bindings) ? config.bindings : []).filter((route: any) =>
      route?.match?.channel === "telegram" && route.match.peer?.kind === "group" && route.match.peer.id === binding.groupDomain!.chatId);
    if (group?.enabled !== true || (group.topics && Object.keys(group.topics).length)
      || routes.length !== 1 || routes[0].type !== "route" || routes[0].agentId !== workspaceId
      || Object.keys(routes[0].match).some(key => !["channel", "peer"].includes(key))) {
      throw new Error("unique explicit enabled group-direct route is missing or changed");
    }
  }
}

export function configuredGroupDirectBindings(config: any, workspace: string, workspaceId: string, names: string[]): MemoryObservationBindingV1[] {
  if (!names.length || names.length > 20 || new Set(names).size !== names.length || workspaceId === "main") throw new Error("group rollout requires unique non-main domains");
  const registry = JSON.parse(readFileSync(join(workspace, "memory/domains/registry.json"), "utf8"));
  const scopeClass = workspaceId === "managers" ? "managers" : workspaceId === "company" ? "company" : "project";
  const bindings = names.map((domain): MemoryObservationBindingV1 => {
    const group = registry.domains?.[domain]?.group;
    if (!group) throw new Error(`group-direct domain not found: ${domain}`);
    return { runtimeSessionKey: `agent:${workspaceId}:telegram:group:${group.chatId}`, scopeClass,
      scopeId: `domain:${workspaceId}:${domain}`, requireOwner: false, allowedChannels: ["telegram"],
      groupDomain: { domain, chatId: String(group.chatId) } };
  }).sort((a, b) => a.runtimeSessionKey.localeCompare(b.runtimeSessionKey));
  assertGroupDomainRegistry(workspace, workspaceId, bindings);
  assertGroupHostRoutes(config, workspace, workspaceId, bindings);
  return bindings;
}

export function validV5GroupBinding(binding: MemoryObservationBindingV1): boolean {
  return binding.groupDomain ? validGroupDirectBinding(binding) : validTopicBinding(binding);
}
