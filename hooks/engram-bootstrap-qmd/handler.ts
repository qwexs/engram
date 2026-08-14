import { runtimeSessionSkipReason } from "../_lib/runtime-session.js";

export function bootstrapQmdSkipReason(event: any): "cron" | "heartbeat" | "ephemeral" | null {
  return runtimeSessionSkipReason(event);
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
