import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { normalizeSessionSegment } from "../_lib/parse-agent-id.ts";
import { resolveKgDefaultContext } from "../../src/kg-v3/context.ts";
import type { KgRuntimeGrantRegistryV1 } from "../../src/kg-v3/trusted-runtime.ts";
import { legacyDeliveryAllowed } from "../../src/context-delivery/legacy-policy.ts";

const MAX_CONTEXT_BYTES = 32 * 1024;
const SESSION_KEY_CONTRACT = "engram.kg-context.session-key.v3";
const BOOTSTRAP_FILE_CONTRACT = "engram.kg-context.bootstrap-file.v1";

function authorizedSession(enabled: Array<{ sessionKey: string }>, sessionKey: string): boolean {
  return enabled.some((entry) => normalizeSessionSegment(entry.sessionKey) === sessionKey);
}

function authorizedDirectSession(
  enabled: Array<{ sessionKey: string }>,
  grants: KgRuntimeGrantRegistryV1,
  workspaceId: string,
  segment: string,
): boolean {
  const direct = segment.match(/^telegram-direct-(\d+)$/);
  if (!direct || grants?.schema !== "engram.kg-v3-runtime-grants.v1" || grants.workspaceId !== workspaceId) return false;
  const principals = Array.isArray(grants.principals)
    ? grants.principals.filter((principal) => Array.isArray(principal?.bindings)
      && principal.bindings.some((binding) => binding?.transport === "telegram" && String(binding?.actorId || "") === direct[1]))
    : [];
  if (principals.length !== 1 || !Array.isArray(principals[0].grants)) return false;
  return principals[0].grants.some((grant) => {
    const grantedSession = normalizeSessionSegment(grant?.sessionKey);
    return (grantedSession === segment || grantedSession === "main")
      && authorizedSession(enabled, grantedSession);
  });
}

function primarySession(
  event: any,
  enabled: Array<{ sessionKey: string }>,
  grants: KgRuntimeGrantRegistryV1,
  workspaceId: string,
): boolean {
  const segment = normalizeSessionSegment(
    String(event?.context?.sessionKey || event?.sessionKey || ""),
  ) || "";
  if (!segment || /^telegram-group-|topic-/.test(segment)) return false;
  if (segment === "main") return authorizedSession(enabled, "main");
  const trustedDirect = event?.context?.trustedActorContext;
  if (trustedDirect && (trustedDirect.trusted !== true || trustedDirect.contextKind !== "direct"
    || String(trustedDirect.actorId || "") !== segment.match(/^telegram-direct-(\d+)$/)?.[1])) return false;
  return authorizedDirectSession(enabled, grants, workspaceId, segment);
}

const handler = async (event: any) => {
  if (event?.type !== "agent" || event?.action !== "bootstrap") return;
  const messageCarrier = Array.isArray(event.messages);
  const bootstrapFileCarrier = Array.isArray(event?.context?.bootstrapFiles);
  if (!messageCarrier && !bootstrapFileCarrier) return;
  const workspace = event?.context?.workspaceDir;
  if (!workspace) return;
  if (!legacyDeliveryAllowed(workspace, event)) return;
  const configPath = join(workspace, "engram.json");
  const authorityPath = join(workspace, "memory-state", "kg-v3", "authority.json");
  const runtimeGrantsPath = join(workspace, "memory-state", "kg-v3", "runtime-grants.json");
  if (!existsSync(configPath) || !existsSync(authorityPath) || !existsSync(runtimeGrantsPath)) return;
  try {
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    const authority = JSON.parse(readFileSync(authorityPath, "utf8"));
    const grants = JSON.parse(readFileSync(runtimeGrantsPath, "utf8"));
    const workspaceId = String(config?.workspace?.id || "");
    if (!workspaceId || !primarySession(event, authority.enabledSessionCapabilities || [], grants, workspaceId)) return;
    const context = resolveKgDefaultContext({ workspace, workspaceId });
    if (context.mode !== "v3-current" || context.sources.length !== 1) return;
    const projection = join(workspace, context.sources[0]);
    const size = statSync(projection).size;
    if (size <= 0 || size > MAX_CONTEXT_BYTES) return;
    const body = readFileSync(projection, "utf8");
    if (/items\.json|\blife\/(?!v3\/)|\bv2\b|historical[ -]?archive/i.test(body)) return;
    const injected = `<!-- engram-kg-v3-current -->\n<!-- ${SESSION_KEY_CONTRACT} -->\n<!-- ${BOOTSTRAP_FILE_CONTRACT} -->\n${body}`;
    if (messageCarrier) event.messages.push(injected);
    if (bootstrapFileCarrier) {
      event.context.bootstrapFiles = [
        ...event.context.bootstrapFiles,
        {
          name: "BOOTSTRAP.md",
          path: projection,
          content: injected,
          missing: false,
        },
      ];
    }
  } catch {
    return;
  }
};

export default handler;
