import { resolve } from "node:path";
import { resolveQmdContext } from "../../src/qmd/context.ts";
import { createBootstrapQmdContext } from "../../src/qmd/bootstrap.ts";
import { buildQmdInvocation } from "../../src/qmd/invocation.ts";
import { authorizeQmdInvocation } from "../../src/qmd/policy.ts";
import { runQmdInvocation, runQmdInvocationSync } from "../../src/qmd/runner.ts";

function diagnosticsCaller() {
  return { kind: "provisioning", allowedCollections: [], capabilities: ["diagnostics"] };
}

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

export function addQmdCollectionSync({ workspace, collection, path, mask, timeoutMs }) {
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
  return runQmdInvocationSync(context, invocation, { caller, decision });
}

export function listQmdCollections({ workspace, timeoutMs }) {
  const context = resolveQmdContext({ value: resolve(workspace), source: "explicit" });
  const caller = diagnosticsCaller();
  const invocation = buildQmdInvocation(context, {
    operation: "collection-list",
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  const decision = authorizeQmdInvocation(context, invocation, caller);
  return runQmdInvocationSync(context, invocation, { caller, decision });
}

export function readQmdCapabilities({ workspace, timeoutMs }) {
  const context = resolveQmdContext({ value: resolve(workspace), source: "explicit" });
  const caller = diagnosticsCaller();
  const invocation = buildQmdInvocation(context, {
    operation: "capabilities",
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  const decision = authorizeQmdInvocation(context, invocation, caller);
  return runQmdInvocationSync(context, invocation, { caller, decision });
}

export function probeQmdExecutable({ workspace, executable, prefixArgs, probe = "help", timeoutMs }) {
  const context = createBootstrapQmdContext({ workspace: resolve(workspace), executable, prefixArgs });
  const caller = diagnosticsCaller();
  const invocation = buildQmdInvocation(context, {
    operation: "probe",
    probe,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  const decision = authorizeQmdInvocation(context, invocation, caller);
  return runQmdInvocationSync(context, invocation, { caller, decision });
}
