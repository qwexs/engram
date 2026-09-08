import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { KG_V3_SCHEMA_DIGEST, validateKgAssertion, KgV3Core, validateKgRegistry } from "./core.ts";
import { KG_V3_LIVE_INGRESS_SCHEMA, resolveKgLiveIngressProjection } from "./live-ingress.ts";
import { readKgV3AccessState } from "./access.ts";
import { KG_V3_AUTHORITY_SCHEMA, type KgAssertionV3 } from "./types.ts";

export interface KgV3WatchdogFinding {
  code: string;
  level: "error" | "warning" | "info";
  message: string;
  path: string;
  details?: Record<string, unknown>;
}
export interface KgV3WatchdogOptions {
  workspace: string;
  workspaceId: string;
  expectActive?: boolean;
  expectLiveIngress?: boolean;
  expectedPluginDigest?: `sha256:${string}`;
  now?: Date;
  maxFiles?: number;
  pendingWarningMs?: number;
}

/** Read-only, non-transactional audit. Never calls Core.current/recover/rebuildProjection:
 * even those apparent reads can acquire locks, recover WAL and publish QMD dirty state.
 * Findings deliberately omit assertion values, provenance and parser error messages.
 * No runtime plugin loading, inbound E2E, access-event reconciliation or actual QMD
 * indexed-generation guarantee is made by this local structural check.
 */
export function auditKgV3(options: KgV3WatchdogOptions): KgV3WatchdogFinding[] {
  const workspace = resolve(options.workspace);
  const root = join(workspace, "memory-state", "kg-v3");
  const store = join(workspace, "life", "v3");
  const findings: KgV3WatchdogFinding[] = [];
  const add = (code: string, level: KgV3WatchdogFinding["level"], message: string, path: string, details?: Record<string, unknown>) => findings.push({ code, level, message, path, ...(details ? { details } : {}) });
  const read = (path: string): any => {
    if (statSync(path).size > 2 * 1024 * 1024) throw new Error("audit file size limit exceeded");
    return JSON.parse(readFileSync(path, "utf8"));
  };
  const authorityPath = join(root, "authority.json");
  const ingressPath = join(root, "live-ingress.json");
  if (!existsSync(root) && !existsSync(store) && !options.expectActive && !options.expectLiveIngress) return findings;
  let authority: any;
  let active = false;
  if (!existsSync(authorityPath)) {
    add("WD-KGV3-001", "error", "KG v3 state or explicit activation has no authority marker; legacy writes must remain disabled.", authorityPath);
  } else {
    try {
      authority = read(authorityPath);
      const token = (v: unknown) => typeof v === "string" && v.trim().length > 0;
      const digest = (v: unknown) => typeof v === "string" && /^sha256:[a-f0-9]{64}$/.test(v);
      if (!authority || authority.schema !== KG_V3_AUTHORITY_SCHEMA || authority.workspaceId !== options.workspaceId
        || !["legacy-contained", "canary", "enabled"].includes(authority.mode)
        || authority.schemaDigest !== KG_V3_SCHEMA_DIGEST || !digest(authority.releaseDigest)
        || authority.currentProjectionVersion !== 1 || !token(authority.approvedBy)
        || typeof authority.approvedAt !== "string" || !Number.isFinite(Date.parse(authority.approvedAt))
        || !Array.isArray(authority.enabledSessionCapabilities)
        || authority.enabledSessionCapabilities.some((v: any) => !v || !token(v.sessionKey) || !Array.isArray(v.capabilities)
          || v.capabilities.some((c: unknown) => !["kg:v3:write", "kg:v3:retract", "kg:v3:seed"].includes(c as string)))) throw new Error("invalid authority");
      active = authority.mode === "canary" || authority.mode === "enabled";
      if (options.expectActive && !active) add("WD-KGV3-001", "error", "KG v3 is expected active but authority is legacy-contained.", authorityPath);
    } catch {
      add("WD-KGV3-001", "error", "KG v3 authority marker is invalid or unreadable.", authorityPath);
    }
  }
  if (existsSync(ingressPath)) {
    try {
      const ingress = read(ingressPath);
      if (ingress?.enabled === false && !options.expectLiveIngress) {
        if (ingress.schema !== KG_V3_LIVE_INGRESS_SCHEMA || ingress.workspaceId !== options.workspaceId) throw new Error("invalid disabled ingress");
        add("WD-KGV3-002", "info", "KG v3 live ingress is explicitly disabled; current store remains separately audited.", ingressPath);
      } else {
        resolveKgLiveIngressProjection({ workspace, workspaceId: options.workspaceId, expectedPluginDigest: options.expectedPluginDigest });
        if (!options.expectedPluginDigest) add("WD-KGV3-003", "info", "KG v3 local ingress is valid; loaded runtime plugin digest was not supplied and remains unverified.", ingressPath);
      }
    } catch {
      add("WD-KGV3-002", "error", "KG v3 live ingress is invalid, disabled contrary to expectation, or mismatched with authority/plugin digest.", ingressPath);
    }
  } else if (options.expectLiveIngress) {
    add("WD-KGV3-002", "error", "KG v3 live ingress was expected but its projection is absent.", ingressPath);
  } else if (active) {
    add("WD-KGV3-002", "info", "No KG v3 live ingress is declared; authority alone does not require live writes (read-only rollout is valid).", ingressPath);
  }
  if (!active && !existsSync(store)) return findings;
  const registryPath = join(root, "registry.json");
  try { validateKgRegistry(read(registryPath), options.workspaceId); }
  catch { add("WD-KGV3-004", "error", "KG v3 registry is missing, invalid or unreadable.", registryPath); }
  try { readKgV3AccessState(workspace, options.workspaceId); }
  catch { add("WD-KGV3-005", "error", "KG v3 access state is invalid or unreadable.", join(root, "access", "state.json")); }

  const maxFiles = Math.max(1, options.maxFiles ?? 10_000);
  let complete = true;
  const files = (dir: string) => {
    if (!existsSync(dir)) return [];
    try {
      const names = readdirSync(dir).filter((name) => name.endsWith(".json")).sort();
      if (names.length > maxFiles) {
        complete = false;
        add("WD-KGV3-006", "warning", "KG v3 audit file limit reached; integrity coverage is partial.", dir, { limit: maxFiles, files: names.length });
      }
      return names.slice(0, maxFiles);
    } catch {
      complete = false;
      add("WD-KGV3-006", "error", "KG v3 state directory is unreadable.", dir);
      return [];
    }
  };
  const assertions = new Map<string, KgAssertionV3>();
  const assertionsRoot = join(store, "assertions");
  for (const name of files(assertionsRoot)) {
    const path = join(assertionsRoot, name);
    try {
      const value = read(path) as KgAssertionV3;
      if (validateKgAssertion(value).length || value.workspaceId !== options.workspaceId || `${value.id}.json` !== name) throw new Error("invalid assertion");
      assertions.set(value.id, value);
    } catch {
      complete = false;
      add("WD-KGV3-007", "error", "KG v3 assertion schema, workspace or filename identity is invalid (content withheld).", path);
    }
  }
  let operations = 0;
  const operationsRoot = join(root, "operations");
  const terminalAssertionIds = new Set<string>();
  for (const name of files(operationsRoot)) {
    const path = join(operationsRoot, name);
    try {
      if (statSync(path).size > 2 * 1024 * 1024) throw new Error("audit file size limit exceeded");
      const record = new KgV3Core({ workspace, workspaceId: options.workspaceId }).readOperation(path);
      if (`${record.operationId.slice(7)}.json` !== name) throw new Error("journal filename mismatch");
      operations++;
      if (record.status === "committed") {
        terminalAssertionIds.add(record.assertionId!);
        if (complete && !assertions.has(record.assertionId!)) add("WD-KGV3-009", "warning", "Committed KG v3 journal references a missing assertion; repeat audit outside an active commit to confirm.", path);
        if (!record.projectionCommitted) add("WD-KGV3-009", "warning", "Committed KG v3 journal lacks projection completion.", path);
        if (["pending", "error"].includes(record.qmdDirty.status)) add("WD-KGV3-010", "warning", "Committed KG v3 operation has unresolved QMD dirty publication; this is not proof of indexed generation.", path, { status: record.qmdDirty.status });
      } else if (record.status !== "skipped") {
        const ageMs = Math.max(0, (options.now ?? new Date()).getTime() - Date.parse(record.actionProvenance.observedAt));
        const stale = ageMs > (options.pendingWarningMs ?? 60 * 60 * 1000);
        add("WD-KGV3-011", stale ? "warning" : "info", "KG v3 journal is nonterminal; read-only audit does not recover it (age is since source observation, not a commit TTL).", path, { status: record.status, ageMs });
      }
    } catch {
      complete = false;
      add("WD-KGV3-008", "error", "KG v3 operation/terminal receipt validation failed (content withheld).", path);
    }
  }
  if (complete) {
    for (const assertion of assertions.values()) {
      if (!terminalAssertionIds.has(assertion.id)) add("WD-KGV3-009", "warning", "Stored KG v3 assertion has no committed operation in the audit snapshot; repeat outside an active commit to confirm.", join(assertionsRoot, `${assertion.id}.json`));
    }
  }
  for (const name of ["current-summary.md", "search-index.md"]) {
    const path = join(store, name);
    if (!existsSync(path) && assertions.size > 0) add("WD-KGV3-012", "warning", "KG v3 has stored assertions but a derived projection is absent.", path);
    else if (existsSync(path)) {
      try {
        if (!statSync(path).isFile() || statSync(path).size === 0) throw new Error("empty projection");
      } catch { add("WD-KGV3-012", "warning", "KG v3 derived projection is empty or unreadable.", path); }
    }
  }
  add("WD-KGV3-013", "info", "KG v3 local structural audit only: projection content/freshness, runtime plugin loading, access-event replay and QMD indexed generations remain unverified; no repair or legacy archive read was performed.", root, { assertions: assertions.size, operations, complete });
  return findings;
}
