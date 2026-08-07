import { resolve } from "node:path";
import { resolveQmdContext } from "../../src/qmd/context.ts";
import { buildQmdInvocation } from "../../src/qmd/invocation.ts";
import { authorizeQmdInvocation } from "../../src/qmd/policy.ts";
import { runQmdInvocation } from "../../src/qmd/runner.ts";

/**
 * Trusted script-side collection registration. Provisioning remains an
 * explicit, collection-scoped core operation; it never refreshes the index or
 * starts embedding. Callers decide separately when the coordinator may make
 * indexed content fresh.
 */
export async function addQmdCollection({ workspace, collection, path, mask, timeoutMs }) {
  const root = resolve(workspace);
  const context = resolveQmdContext({ value: root, source: "explicit" });
  const caller = {
    kind: "provisioning",
    allowedCollections: [collection],
    capabilities: ["provisioning"],
  };
  const invocation = buildQmdInvocation(context, {
    operation: "collection-add",
    collection,
    path: resolve(path),
    mask,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  const decision = authorizeQmdInvocation(context, invocation, caller);
  return runQmdInvocation(context, invocation, { caller, decision });
}
