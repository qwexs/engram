import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { Database } from "bun:sqlite";
import { resolveQmdContext } from "../../src/qmd/context.ts";
import { createBootstrapQmdContext } from "../../src/qmd/bootstrap.ts";
import { buildQmdInvocation } from "../../src/qmd/invocation.ts";
import { authorizeQmdInvocation } from "../../src/qmd/policy.ts";
import { runQmdInvocation, runQmdInvocationSync } from "../../src/qmd/runner.ts";

function diagnosticsCaller() {
  return { kind: "provisioning", allowedCollections: [], capabilities: ["diagnostics"] };
}

// A resumed provisioning run must not recreate an exact existing collection.
// Read only registration metadata; a name collision with another root/mask
// remains an error, never a successful no-op.
function existingCollection(context, collection, path, mask) {
  if (!existsSync(context.physicalIndex.path)) return null;
  const db = new Database(context.physicalIndex.path, { readonly: true });
  try {
    if (!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='store_collections'").get()) return null;
    const row = db.query("SELECT path, pattern FROM store_collections WHERE name = ?").get(collection);
    if (!row) return null;
    const matches = resolve(row.path) === resolve(path) && row.pattern === mask;
    return { ok: matches, exitCode: matches ? 0 : 1, stdout: "", stderr: matches ? "" : `QMD collection drift: ${collection}` };
  } finally { db.close(); }
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
  const existing = existingCollection(context, collection, path, mask);
  if (existing) return existing;
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
  const existing = existingCollection(context, collection, path, mask);
  if (existing) return existing;
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
