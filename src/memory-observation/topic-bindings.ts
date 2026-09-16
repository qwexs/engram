import { readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import type { MemoryObservationBindingV1 } from "./projection.ts";

export type TopicDomainBinding = { domain: string; chatId: string; topicId: string };
const TOPIC_KEY = /^agent:([A-Za-z0-9._-]+):telegram:group:(-[1-9][0-9]*):topic:([1-9][0-9]*)$/;

function samePath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

export function validTopicBinding(binding: MemoryObservationBindingV1, workspaceId?: string): boolean {
  const match = TOPIC_KEY.exec(binding.runtimeSessionKey);
  const topic = binding.topicDomain;
  return Boolean(match && topic && (!workspaceId || match[1] === workspaceId)
    && /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(topic.domain)
    && match[2] === topic.chatId && match[3] === topic.topicId
    && binding.scopeClass !== "self" && binding.scopeId === `domain:${match[1]}:${topic.domain}`
    && binding.requireOwner === false && binding.allowedChannels.length === 1
    && binding.allowedChannels[0] === "telegram");
}

export function assertTopicDomainRegistry(workspace: string, workspaceId: string, bindings: MemoryObservationBindingV1[]): void {
  const registry = JSON.parse(readFileSync(join(workspace, "memory/domains/registry.json"), "utf8"));
  const domains = Object.entries<any>(registry.domains ?? {});
  const seen = new Set<string>();
  for (const binding of bindings) {
    if (!validTopicBinding(binding, workspaceId)) throw new Error("invalid exact topic binding");
    const topic = binding.topicDomain!;
    if (seen.has(binding.runtimeSessionKey)) throw new Error("duplicate topic binding");
    seen.add(binding.runtimeSessionKey);
    const matches = domains.filter(([, entry]) => entry?.topic
      && String(entry.topic.chatId) === topic.chatId && String(entry.topic.topicId) === topic.topicId);
    if (matches.length !== 1 || matches[0]![0] !== topic.domain
      || !["topic-thread", "meta-domain"].includes(matches[0]![1].type)
      || matches[0]![1].archived === true || matches[0]![1].enabled === false) {
      throw new Error("topic domain is missing, ambiguous, inactive, or changed");
    }
    const expected = join(realpathSync(workspace), "memory/domains", topic.domain);
    if (realpathSync(expected) !== expected) throw new Error("topic domain is not a canonical directory");
  }
}

export function assertTopicHostRoutes(config: any, workspace: string, workspaceId: string, bindings: MemoryObservationBindingV1[]): void {
  const entries = config?.agents?.entries;
  const agent = Array.isArray(entries) ? entries.find((entry: any) => entry.id === workspaceId) : entries?.[workspaceId];
  if (!agent?.workspace || !samePath(realpathSync(agent.workspace), realpathSync(workspace))) throw new Error("topic agent workspace mismatch");
  for (const binding of bindings) {
    if (!validTopicBinding(binding, workspaceId)) throw new Error("invalid topic host binding");
    const topic = binding.topicDomain!;
    const group = config?.channels?.telegram?.groups?.[topic.chatId];
    const route = group?.topics?.[topic.topicId];
    // Explicit topic routes are required. Never authorize through a default main route.
    if (group?.enabled !== true || route?.enabled !== true || route?.agentId !== workspaceId) {
      throw new Error("explicit enabled topic route is missing or changed");
    }
  }
}

export function configuredTopicBindings(config: any, workspace: string, workspaceId: string, names: string[]): MemoryObservationBindingV1[] {
  if (!names.length || names.length > 20 || new Set(names).size !== names.length || workspaceId === "main") {
    throw new Error("topic rollout requires 1–20 unique domains in a non-main workspace");
  }
  const registry = JSON.parse(readFileSync(join(workspace, "memory/domains/registry.json"), "utf8"));
  const scopeClass = workspaceId === "managers" ? "managers" : workspaceId === "company" ? "company" : "project";
  const bindings: MemoryObservationBindingV1[] = names.map((domain): MemoryObservationBindingV1 => {
    const topic = registry.domains?.[domain]?.topic;
    if (!topic) throw new Error(`topic domain not found: ${domain}`);
    return {
      runtimeSessionKey: `agent:${workspaceId}:telegram:group:${topic.chatId}:topic:${topic.topicId}`,
      scopeClass, scopeId: `domain:${workspaceId}:${domain}`, requireOwner: false,
      allowedChannels: ["telegram"],
      topicDomain: { domain, chatId: String(topic.chatId), topicId: String(topic.topicId) },
    };
  }).sort((a, b) => a.runtimeSessionKey.localeCompare(b.runtimeSessionKey));
  assertTopicDomainRegistry(workspace, workspaceId, bindings);
  assertTopicHostRoutes(config, workspace, workspaceId, bindings);
  return bindings;
}
