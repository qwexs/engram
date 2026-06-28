import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/**
 * Resolve the workspace directory for an OpenClaw agent by reading
 * `~/.openclaw/openclaw.json`. The `message:received` hook context in OpenClaw
 * does not carry `workspaceDir` or `agentId` — only `sessionKey` on the
 * top-level event. This helper is a third fallback after
 * `event.context.workspaceDir` and the `OPENCLAW_WORKSPACE` env var, and
 * makes the hook work for every registered agent without per-agent env
 * wiring.
 *
 * Exported for unit testing. No side effects on success or failure.
 *
 * @param agentId - OpenClaw agent id (the value of `agents.list[].id` in
 *               `~/.openclaw/openclaw.json`)
 * @param home - override for the home directory (used by tests); defaults
 *               to $HOME / $USERPROFILE / os.homedir()
 * @returns the agent's workspace path, or null if it cannot be resolved
 */
export function resolveWorkspaceByAgentId(
  agentId: string,
  home: string = process.env.HOME || process.env.USERPROFILE || homedir(),
): string | null {
  if (!agentId) return null;
  const configPath = join(home, ".openclaw", "openclaw.json");
  if (!existsSync(configPath)) return null;
  try {
    const cfg = JSON.parse(readFileSync(configPath, "utf-8"));
    const list = cfg?.agents?.list;
    if (!Array.isArray(list)) return null;
    const agent = list.find((a: any) => a?.id === agentId);
    return typeof agent?.workspace === "string" ? agent.workspace : null;
  } catch {
    return null;
  }
}

/**
 * Extract the agentId from a sessionKey of the form
 * `agent:<id>:<channel>:<rest>`. Returns null if sessionKey is empty or does
 * not match the expected format.
 *
 * DEPRECATED: moved to `../_lib/parse-agent-id.ts` so all hooks share one
 * implementation. This re-export is kept for backwards compatibility with
 * any callers/tests that still import from `./workspace-resolver.js`.
 */
export { parseAgentIdFromSessionKey } from "../_lib/parse-agent-id.js";
