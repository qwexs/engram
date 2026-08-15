import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { computeContextHash, type DomainSourceFiles } from "../_lib/domain-inject.js";
import { resolveDomainFromEvent } from "../_lib/domain-resolve.js";
import { normalizeSessionSegment } from "../_lib/parse-agent-id.js";
import { loadActorRegistry } from "../../src/oll/authorization";
import {
  composeBootstrapContextHash,
  persistRuleContextConflicts,
  resolveRuleContext,
  type RuleContextSessionKindV1,
  type RuleContextTargetV1,
} from "../../src/oll/rule-context";

type JsonObject = Record<string, any>;

export const RULE_CONTEXT_BOOTSTRAP_NAME = "ENGRAM_RULES.md";

function readJson(path: string): JsonObject | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function sessionSegment(event: any): string {
  return normalizeSessionSegment(
    String(event?.context?.sessionKey || event?.sessionKey || ""),
  ) || "";
}

function classifySession(segment: string): RuleContextSessionKindV1 | null {
  if (/^telegram-group--?\d+-topic-\d+$/.test(segment)) return "topic-thread";
  if (/^telegram-group--?\d+$/.test(segment)) return "group-direct";
  if (/^telegram-direct-\d+$/.test(segment)) return "peer-direct";
  if (segment === "main") return "main";
  return null;
}

function directActor(event: any, kind: RuleContextSessionKindV1): {
  channel: string;
  accountId: string;
  actorId: string;
} | null {
  if (kind === "peer-direct") {
    const match = sessionSegment(event).match(/^telegram-direct-(\d+)$/);
    return match ? {
      channel: "telegram",
      accountId: String(event?.context?.accountId || "default"),
      actorId: match[1],
    } : null;
  }
  const trusted = event?.context?.trustedActorContext;
  if (
    kind === "main"
    && trusted?.trusted === true
    && typeof trusted.channel === "string"
    && typeof trusted.accountId === "string"
    && typeof trusted.actorId === "string"
  ) {
    return { channel: trusted.channel, accountId: trusted.accountId, actorId: trusted.actorId };
  }
  return null;
}

function expandStatePath(setting: string, stateRoot: string): string {
  return resolve(setting.replaceAll("${ENGRAM_STATE_ROOT}", resolve(stateRoot)));
}

function resolvePersonSubjects(config: JsonObject, stateRoot: string, actor: ReturnType<typeof directActor>): string[] {
  if (!actor) return [];
  const setting = String(config?.oll?.adaptation?.actorRegistry || "${ENGRAM_STATE_ROOT}/oll/actors.v1.json");
  try {
    const loaded = loadActorRegistry(expandStatePath(setting, stateRoot));
    const principals = (loaded.registry.principals as any[]).filter((principal) => (
      principal.transportBindings.some((binding: any) => (
        binding.channel === actor.channel
          && binding.accountId === actor.accountId
          && String(binding.actorId) === actor.actorId
      ))
    ));
    if (principals.length !== 1) return [];
    return [
      String(principals[0].principalId),
      `${actor.channel}:${actor.actorId}`,
      `${actor.channel}:user:${actor.actorId}`,
    ];
  } catch {
    return [];
  }
}

export function resolveBootstrapRuleTarget(event: any, config: JsonObject, stateRoot: string): RuleContextTargetV1 | null {
  if (event?.type !== "agent" || event?.action !== "bootstrap") return null;
  const workspaceId = String(config?.workspace?.id || "");
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(workspaceId)) return null;
  const domain = resolveDomainFromEvent(event);
  const kind = domain?.sessionKind || classifySession(sessionSegment(event));
  if (!kind) return null;
  const multiPerson = kind === "group-direct" || kind === "topic-thread";
  return {
    workspaceId,
    sessionKind: kind,
    domainSubjects: domain ? [domain.domainName] : [],
    personSubjects: multiPerson ? [] : resolvePersonSubjects(config, stateRoot, directActor(event, kind)),
    multiPerson,
  };
}

function domainHash(event: any): string | null {
  const domain = resolveDomainFromEvent(event);
  if (!domain) return null;
  const root = join(domain.workspaceDir, "memory", "domains", domain.domainName);
  const files: DomainSourceFiles = {
    decisionsPath: join(root, "decisions.md"),
    statusPath: join(root, "status.md"),
    changelogPath: join(root, "changelog.md"),
    agentsPath: join(root, "agents.md"),
  };
  return computeContextHash(files);
}

const handler = async (event: any) => {
  if (event?.type !== "agent" || event?.action !== "bootstrap") return;
  const bootstrapFiles = event?.context?.bootstrapFiles;
  if (!Array.isArray(bootstrapFiles)) return;
  const baseBootstrapFiles = bootstrapFiles.filter((file: any) => file?.name !== RULE_CONTEXT_BOOTSTRAP_NAME);
  event.context.bootstrapFiles = baseBootstrapFiles;
  const workspace = event?.context?.workspaceDir;
  if (!workspace) return;
  const configPath = join(workspace, "engram.json");
  if (!existsSync(configPath)) return;
  const config = readJson(configPath);
  if (!config || config?.oll?.adaptation?.mode !== "active") return;
  const stateRoot = String(
    event?.context?.engramStateRoot
      || process.env.ENGRAM_STATE_ROOT
      || "/opt/openclaw/state/engram",
  );
  const target = resolveBootstrapRuleTarget(event, config, stateRoot);
  if (!target) return;
  const resolution = resolveRuleContext({ workspace, stateRoot, target });
  if (resolution.conflicts.length) {
    persistRuleContextConflicts({ workspace, conflicts: resolution.conflicts });
  }
  if (!resolution.payload) {
    if (resolution.status === "overflow") {
      console.error(`[engram-rule-context-load] blocked oversized context (${resolution.requiredBytes}/${resolution.maxBytes} bytes)`);
    }
    return;
  }
  const bootstrapHash = composeBootstrapContextHash({
    domainContextHash: domainHash(event),
    ruleContextHash: resolution.contextHash,
  });
  event.context.bootstrapFiles = [...baseBootstrapFiles, {
    name: RULE_CONTEXT_BOOTSTRAP_NAME,
    path: join(workspace, "memory-state", "oll", "bootstrap", RULE_CONTEXT_BOOTSTRAP_NAME),
    content: `<!-- engram-bootstrap-context-hash:${bootstrapHash} -->\n${resolution.payload}`,
    missing: false,
  }];
  console.log(`[engram-rule-context-load] injected ${resolution.rules.length} active rules (${resolution.requiredBytes} bytes, hash ${resolution.contextHash})`);
};

export default handler;
