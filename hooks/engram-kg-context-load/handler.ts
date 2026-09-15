import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { normalizeSessionSegment } from "../_lib/parse-agent-id.ts";
import { resolveKgDefaultContext } from "../../src/kg-v3/context.ts";

const MAX_CONTEXT_BYTES = 32 * 1024;
const SESSION_KEY_CONTRACT = "engram.kg-context.session-key.v2";

function authorizedSession(enabled: Array<{ sessionKey: string }>, sessionKey: string): boolean {
  return enabled.some((entry) => normalizeSessionSegment(entry.sessionKey) === sessionKey);
}

function primarySession(event: any, enabled: Array<{ sessionKey: string }>): boolean {
  const segment = normalizeSessionSegment(
    String(event?.context?.sessionKey || event?.sessionKey || ""),
  ) || "";
  if (!segment || /^telegram-group-|topic-/.test(segment)) return false;
  const trustedDirect = event?.context?.trustedActorContext;
  const runtimeDirect = trustedDirect?.trusted === true && trustedDirect?.contextKind === "direct";
  if (segment === "main") return authorizedSession(enabled, "main");
  if (!runtimeDirect) return false;

  const direct = segment.match(/^telegram-direct-(\d+)$/);
  if (!direct || String(trustedDirect?.actorId || "") !== direct[1]) return false;

  return authorizedSession(enabled, segment) || authorizedSession(enabled, "main");
}

const handler = async (event: any) => {
  if (event?.type !== "agent" || event?.action !== "bootstrap" || !Array.isArray(event.messages)) return;
  const workspace = event?.context?.workspaceDir;
  if (!workspace) return;
  const configPath = join(workspace, "engram.json");
  const authorityPath = join(workspace, "memory-state", "kg-v3", "authority.json");
  if (!existsSync(configPath) || !existsSync(authorityPath)) return;
  try {
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    const authority = JSON.parse(readFileSync(authorityPath, "utf8"));
    const workspaceId = String(config?.workspace?.id || "");
    if (!workspaceId || !primarySession(event, authority.enabledSessionCapabilities || [])) return;
    const context = resolveKgDefaultContext({ workspace, workspaceId });
    if (context.mode !== "v3-current" || context.sources.length !== 1) return;
    const projection = join(workspace, context.sources[0]);
    const size = statSync(projection).size;
    if (size <= 0 || size > MAX_CONTEXT_BYTES) return;
    const body = readFileSync(projection, "utf8");
    if (/items\.json|\blife\/(?!v3\/)|\bv2\b|historical[ -]?archive/i.test(body)) return;
    event.messages.push(`<!-- engram-kg-v3-current -->\n<!-- ${SESSION_KEY_CONTRACT} -->\n${body}`);
  } catch {
    return;
  }
};

export default handler;
