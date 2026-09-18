import { resolve } from "node:path";
import { definePluginEntry } from "openclaw/plugin-sdk/core";
import { ContextDeliveryOwner } from "../../src/context-delivery/owner.ts";

const PLUGIN_ID = "engram-context-delivery";

export default definePluginEntry({
  id: PLUGIN_ID,
  name: "Engram Context Delivery",
  description: "Read-only, policy-gated KG, OLL, domain, and exact-session context owner.",
  register(api: any) {
    const stateRoot = resolve(process.env.ENGRAM_STATE_ROOT || "/opt/openclaw/state/engram");
    const owner = new ContextDeliveryOwner({
      stateRoot,
      resolveAgentWorkspaceDir: (agentId) => api.runtime.agent.resolveAgentWorkspaceDir(
        api.runtime.config.current(),
        agentId,
      ),
    });
    const loggedReceipts = new Map<string, string>();

    api.on("before_prompt_build", (event: any, ctx: any) => {
      try {
        const result = owner.prepare(event || {}, ctx || {});
        if (result.receipt && typeof ctx?.runId === "string") {
          const key = result.receipt.envelopeDigest || `${result.receipt.policyDigest}:${result.receipt.reason}`;
          if (loggedReceipts.get(ctx.runId) !== key) {
            loggedReceipts.set(ctx.runId, key);
            api.logger.info?.(`${PLUGIN_ID}: ${JSON.stringify(result.receipt)}`);
          }
        }
        return result.context ? { prependContext: result.context } : undefined;
      } catch {
        api.logger.warn?.(`${PLUGIN_ID}: context preparation failed closed`);
        return undefined;
      }
    });

    api.on("agent_end", (_event: any, ctx: any) => {
      if (typeof ctx?.runId === "string") loggedReceipts.delete(ctx.runId);
    });
  },
});
