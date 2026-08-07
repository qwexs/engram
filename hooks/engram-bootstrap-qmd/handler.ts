import { splitAgentAndSession } from "../_lib/parse-agent-id.js";

export function bootstrapQmdSkipReason(event: any): "cron" | "heartbeat" | "ephemeral" | null {
  const rawKey = String(event?.context?.sessionKey || event?.sessionKey || "").trim();
  const parsed = splitAgentAndSession(rawKey);
  const sessionSegment = String(parsed?.sessionKey || rawKey.replace(/^agent:[^:]+:/, "").replace(/:/g, "-")).toLowerCase();

  if (/^cron(?:-|$)/.test(sessionSegment)) return "cron";
  if (/^heartbeat(?:-|$)/.test(sessionSegment)) return "heartbeat";
  if (/^(?:subagent|ephemeral)(?:-|$)/.test(sessionSegment)) return "ephemeral";

  const runtimeHint = String(
    event?.context?.runKind ||
    event?.context?.sessionType ||
    event?.context?.triggerKind ||
    "",
  ).toLowerCase();
  if (runtimeHint === "cron") return "cron";
  if (runtimeHint === "heartbeat") return "heartbeat";
  if (runtimeHint === "subagent" || runtimeHint === "ephemeral") return "ephemeral";
  return null;
}

const handler = async (event: any) => {
  if (event.type !== "agent" || event.action !== "bootstrap") return;

  const skipReason = bootstrapQmdSkipReason(event);
  if (skipReason) {
    console.log(`[engram-bootstrap-qmd] skipped (${skipReason} session)`);
    return;
  }

  const workspaceDir = event.context?.workspaceDir;
  if (!workspaceDir) return;
  console.log("[engram-bootstrap-qmd] maintenance deferred to the configured scheduler");
};

export default handler;
