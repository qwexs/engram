import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { CanonicalDeliveryScope } from "./contracts.ts";

type DomainRegistryEntry = {
  type?: unknown;
  enabled?: unknown;
  archived?: unknown;
  pending?: unknown;
  kgEntity?: unknown;
  topic?: { chatId?: unknown; topicId?: unknown };
  peer?: { chatId?: unknown };
  group?: { chatId?: unknown };
};

export type ExactDomainBinding = {
  domainName: string;
  domainType: "topic-thread" | "meta-domain" | "peer-direct" | "group-direct";
  domainDir: string;
  kgEntity: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function matches(entry: DomainRegistryEntry, scope: CanonicalDeliveryScope): boolean {
  if (scope.kind === "topic-thread") {
    return Boolean(scope.chatId && /^-[1-9][0-9]*$/.test(scope.chatId)
      && scope.topicId && /^[1-9][0-9]*$/.test(scope.topicId)
      && entry.topic
      && String(entry.topic.chatId) === scope.chatId
      && String(entry.topic.topicId) === scope.topicId
      && (entry.type === "topic-thread" || entry.type === "meta-domain")
      && !entry.peer && !entry.group);
  }
  if (scope.kind === "peer-direct") {
    return Boolean(scope.actorId && /^[1-9][0-9]*$/.test(scope.actorId)
      && entry.peer
      && String(entry.peer.chatId) === scope.actorId
      && (entry.type === "peer-direct" || entry.type === "meta-domain")
      && !entry.topic && !entry.group);
  }
  if (scope.kind === "group-direct") {
    return Boolean(scope.chatId && /^-[1-9][0-9]*$/.test(scope.chatId)
      && entry.group
      && String(entry.group.chatId) === scope.chatId
      && entry.type === "group-direct"
      && !entry.topic && !entry.peer);
  }
  return false;
}

/** Exact, read-only domain lookup. It never unarchives or falls back to main. */
export function resolveExactDomainBinding(options: {
  workspace: string;
  workspaceId: string;
  scope: CanonicalDeliveryScope;
}): ExactDomainBinding | null {
  if (options.scope.agentId !== options.workspaceId || options.scope.kind === "main") return null;
  const workspace = realpathSync(options.workspace);
  const registryPath = join(workspace, "memory", "domains", "registry.json");
  const registry = JSON.parse(readFileSync(registryPath, "utf8"));
  if (!isRecord(registry) || !isRecord(registry.domains)) throw new Error("invalid domain registry");

  const matchesFound = Object.entries(registry.domains).filter(([name, raw]) => {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name) || !isRecord(raw)) return false;
    const entry = raw as DomainRegistryEntry;
    if (entry.enabled === false || entry.archived === true || entry.pending === true) return false;
    return matches(entry, options.scope);
  });
  if (!matchesFound.length) return null;
  if (matchesFound.length !== 1) throw new Error("ambiguous exact domain binding");

  if (options.scope.kind === "group-direct" && Object.values(registry.domains).some((raw) => (
    isRecord(raw) && isRecord(raw.topic) && String(raw.topic.chatId) === options.scope.chatId
  ))) throw new Error("group-direct binding conflicts with a topic binding");

  const [domainName, raw] = matchesFound[0]!;
  const entry = raw as DomainRegistryEntry;
  const domainDir = join(workspace, "memory", "domains", domainName);
  if (realpathSync(domainDir) !== domainDir) throw new Error("domain directory is not canonical");
  return {
    domainName,
    domainType: entry.type as ExactDomainBinding["domainType"],
    domainDir,
    kgEntity: typeof entry.kgEntity === "string" && entry.kgEntity.trim() ? entry.kgEntity.trim() : null,
  };
}
