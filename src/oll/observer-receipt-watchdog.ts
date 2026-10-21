import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { DAILY_NOTE_APPLICATOR } from "../memory-observation/daily-note-applicator.ts";
import { memoryObservationBinding, memoryObservationCaptureOwner, resolveMemoryObservationProjection } from "../memory-observation/projection.ts";
import {
  observerReceiptRolloutAllowsV1, observerReceiptScopeEqualV1, validateObserverReceiptProducerRegistryV1,
  type ObserverReceiptProducerRegistryV1, type ObserverReceiptScopeV1,
} from "./observer-receipt-bridge-v1.ts";
import { observerBridgeLiveAuthorities } from "./observer-receipt-authorities.ts";
import { verifyObserverReceiptAdmission } from "./memory-candidate-compiler-v2.ts";

export type OllObserverBridgeFinding = {
  code: string; level: "error" | "warn" | "info"; message: string;
  path?: string; fixable: false; details?: Record<string, unknown>;
};

export function observerBridgeRuntimeKey(workspaceId: string, session: string): string | null {
  let m = /^telegram-group-(-?\d+)(?:-topic-(\d+))?$/.exec(session);
  if (m) return `agent:${workspaceId}:telegram:group:${m[1]}${m[2] ? `:topic:${m[2]}` : ""}`;
  m = /^telegram-direct-(\d+)$/.exec(session);
  if (m) return `agent:${workspaceId}:telegram:direct:${m[1]}`;
  return session === "main" ? `agent:${workspaceId}:main` : null;
}

const sameProducer = (a: any, b: any) => !!a && !!b
  && Object.keys(a).length === 3 && a.id === b.id && a.version === b.version && a.digest === b.digest;

/** The same explicit authority gates as the compiler, NOT a canonical receipt/E2E verifier. */
export function observerBridgeGateFailures(
  registry: ObserverReceiptProducerRegistryV1 | undefined, receipt: any, mode: "shadow" | "materialize",
): string[] {
  if (!registry) return ["missing_registry"];
  if (!sameProducer(receipt.producer, registry.canonicalApplicator)) return ["applicator_identity"];
  const provenance = receipt.sourceProvenance;
  const entry = registry.entries.find(e => sameProducer(provenance?.producer, e.producer));
  if (!entry) return ["producer_identity"];
  const reasons: string[] = [];
  if (!entry.allowedObservationClasses.includes(provenance?.observationClass)) reasons.push("observation_class");
  if (!entry.allowedScopeClasses.includes(receipt.scope?.scopeClass)) reasons.push("scope_class");
  if (!receipt.scope || !entry.exactScopeAllowlist.some(s => observerReceiptScopeEqualV1(s, receipt.scope))) reasons.push("exact_scope");
  if (!entry.allowedEvaluationPolicyDigests.includes(provenance?.batchEvaluationPolicyDigest)) reasons.push("evaluation_policy");
  if (!observerReceiptRolloutAllowsV1(entry.rolloutState, mode)) reasons.push("rollout_mode");
  return reasons;
}

/** Read-only and content-free output. Canonical entries may be read for receipt
 * verification; no chat access, inference, compiler materialization or repairs. */
export function auditOllObserverBridge(
  workspaceInput: string, options: { config?: any; now?: Date } = {},
): OllObserverBridgeFinding[] {
  const workspace = resolve(workspaceInput), findings: OllObserverBridgeFinding[] = [];
  const add = (code: string, level: OllObserverBridgeFinding["level"], message: string, path: string, details?: Record<string, unknown>) =>
    findings.push({ code, level, message, path, fixable: false, ...(details ? { details } : {}) });
  const read = (path: string) => {
    const real = realpathSync(path), rel = relative(realpathSync(workspace), real);
    if (rel === ".." || rel.startsWith(`..${sep}`)) throw Error("outside_workspace");
    return JSON.parse(readFileSync(real, "utf8"));
  };
  let config: any;
  try { config = options.config ?? read(join(workspace, "engram.json")); }
  catch { add("WD-OLL-020", "error", "Cannot inspect OLL bridge configuration", "engram.json"); return findings; }
  const oll = config.oll, policy = oll?.candidateCompiler;
  const projectionPath = join(workspace, "memory-state/memory-observation/projection.json");
  if (oll?.enabled === false || oll?.nightly?.enabled !== true || !["shadow", "materialize"].includes(policy?.mode)) {
    // Deliberate disablement is not a missing-registry error and must never trigger activation.
    if (existsSync(projectionPath)) add("WD-OLL-021", "info", "Worker-to-OLL bridge inactive: nightly or memory candidate compiler is disabled", "engram.json");
    return findings;
  }
  const mode = policy.mode as "shadow" | "materialize", workspaceId = config.workspace?.id;
  const now = options.now ?? new Date();
  if (!Array.isArray(policy.daily) || typeof workspaceId !== "string" || !Number.isFinite(now.getTime())) {
    add("WD-OLL-020", "error", "Cannot inspect OLL bridge source policy or workspace identity", "engram.json"); return findings;
  }
  const sources = policy.daily.filter((s: any) => typeof s.session === "string" && Array.isArray(s.sections)
    && s.sections.some((v: string) => v === "decisions" || v === "learnings"));
  if (!sources.length) return findings;
  const required: Array<{ session: string; scope: ObserverReceiptScopeV1; observationClass: "episodic.decision" | "episodic.learning"; authorities: ReturnType<typeof observerBridgeLiveAuthorities> }> = [];
  if (existsSync(projectionPath)) {
    try {
      const raw = read(projectionPath);
      if (raw.enabled !== false) {
        const projection = resolveMemoryObservationProjection({ workspace, workspaceId });
        for (const source of sources) {
          const key = observerBridgeRuntimeKey(workspaceId, source.session);
          const binding = key && memoryObservationBinding(projection, key);
          if (!binding || memoryObservationCaptureOwner(projection, key!, now) !== "observer") continue;
          for (const [section, observationClass] of [["decisions", "episodic.decision"], ["learnings", "episodic.learning"]] as const) {
            if (!source.sections.includes(section) || !(projection.consumers?.dailyNote.allowedObservationClasses as readonly string[] | undefined)?.includes(observationClass)) continue;
            const scope = { workspaceId, runtimeSessionKey: key!, scopeClass: binding.scopeClass, scopeId: binding.scopeId };
            required.push({ session: source.session, scope, observationClass, authorities: observerBridgeLiveAuthorities(workspace, projection, scope) });
          }
        }
      }
    } catch { add("WD-OLL-020", "error", "Worker projection cannot be validated for OLL bridge coverage", "memory-state/memory-observation/projection.json"); }
  }
  const receipts: any[] = [], receiptDir = join(workspace, "memory-state/memory-observation/v1/receipts/by-entry");
  let legacyNonBatchExcluded = 0;
  const lower = Date.parse(policy.forwardOnlySince);
  try {
    if (existsSync(receiptDir)) {
      // Never follow directory/file symlinks to another workspace; read() enforces containment.
      readDirectory: for (const name of readdirSync(receiptDir).sort()) {
        if (!name.endsWith(".json")) continue;
        const receipt = read(join(receiptDir, name)), cls = receipt.sourceProvenance?.observationClass;
        if (!["episodic.decision", "episodic.learning"].includes(cls)) continue;
        const source = sources.find((s: any) => typeof receipt.destinationRef === "string"
          && receipt.destinationRef.startsWith(`memory/agent-${workspaceId}/${s.session}/`)
          && s.sections.includes(cls === "episodic.decision" ? "decisions" : "learnings"));
        if (!source) continue readDirectory;
        // The compiler bridge is deliberately batch-receipt-only. Old single-turn
        // notes are not made eligible by granting a batch producer registry.
        if (!Array.isArray(receipt.sourceProvenance?.batchSourceRefs)) { legacyNonBatchExcluded++; continue; }
        if (receipt.schema !== "engram.memory-apply-receipt.v1" || receipt.status !== "applied" || receipt.canonicalMutation !== true || receipt.consumer !== "daily-note") {
          add("WD-OLL-020", "error", "Invalid applied decision/learning receipt metadata", relative(workspace, join(receiptDir, name))); continue;
        }
        const at = Date.parse(receipt.sourceCompletedAt);
        if (!Number.isFinite(at)) { add("WD-OLL-020", "error", "Invalid decision/learning receipt timestamp", relative(workspace, join(receiptDir, name))); continue; }
        if (at < lower || at > now.getTime()) continue;
        receipts.push(receipt);
      }
    }
  } catch { add("WD-OLL-020", "error", "Cannot fully inspect Worker receipt metadata for OLL bridge", relative(workspace, receiptDir)); }
  let registry: ObserverReceiptProducerRegistryV1 | undefined;
  if (oll.observerReceiptProducerRegistry) {
    try {
      registry = validateObserverReceiptProducerRegistryV1(oll.observerReceiptProducerRegistry);
      if (registry.workspaceId !== workspaceId) throw Error("foreign_registry");
    } catch { registry = undefined; add("WD-OLL-017", "error", "OLL observer receipt registry schema, digest or workspace identity is invalid", "engram.json"); }
  } else if (required.length || receipts.length) {
    add("WD-OLL-016", "error", "Active Worker decision sources have no OLL observer receipt admission registry", "engram.json", { observerSources: required.length, receiptCount: receipts.length });
  }
  if (registry) {
    const gaps: Array<Record<string, unknown>> = [];
    if (!sameProducer(DAILY_NOTE_APPLICATOR, registry.canonicalApplicator)) gaps.push({ reason: "applicator_identity" });
    for (const source of required) {
      const entries = registry.entries.filter(e => e.allowedObservationClasses.includes(source.observationClass)
        && e.allowedScopeClasses.includes(source.scope.scopeClass)
        && e.exactScopeAllowlist.some(s => observerReceiptScopeEqualV1(s, source.scope))
        && observerReceiptRolloutAllowsV1(e.rolloutState, mode));
      if (!entries.length) gaps.push({ session: source.session, reason: "scope_class_or_rollout" });
      else for (const authority of source.authorities) {
        if (!entries.some(e => sameProducer(e.producer, authority.producer) && e.allowedEvaluationPolicyDigests.includes(authority.policyDigest)))
          gaps.push({ session: source.session, reason: "current_producer_or_evaluation_policy", producerVersion: authority.producer.version, policyDigest: authority.policyDigest });
      }
    }
    if (gaps.length) add("WD-OLL-018", "error", "OLL bridge does not cover current Worker authority, scope, class, policy or execution mode", "engram.json", { gaps });
  }
  const rejectionCounts: Record<string, number> = {};
  let rejected = 0, nonCanonicalReceiptsExcluded = 0;
  for (const receipt of receipts) {
    const reasons = observerBridgeGateFailures(registry, receipt, mode);
    if (reasons.length) {
      // Canonical-source validation precedes authority gates in the compiler.
      // Old corrupt/overwritten receipts are separate integrity debt, not a
      // reason to broaden producer/scope/policy grants to make this check green.
      const validation = verifyObserverReceiptAdmission({ workspace, workspaceId, observerReceiptProducerRegistry: registry, executionMode: mode },
        String(receipt.destinationRef).split("#", 1)[0]!, receipt.sourceProvenance.observationClass === "episodic.decision" ? "decisions" : "learnings", receipt.destinationEntryId);
      if (validation.status === "rejected" && validation.reason !== "unsupported_source") { nonCanonicalReceiptsExcluded++; continue; }
    }
    if (reasons.length) rejected++;
    for (const reason of reasons) rejectionCounts[reason] = (rejectionCounts[reason] ?? 0) + 1;
  }
  if (rejected) add("WD-OLL-019", "error", "Allowlisted applied Worker decisions/learnings fail OLL bridge authority gates; not a model threshold or empty-source success", relative(workspace, receiptDir), { receiptCount: receipts.length, rejected, rejectionCounts });
  if (nonCanonicalReceiptsExcluded) add("WD-OLL-023", "warn", "Historical decision/learning receipts fail canonical-source verification; excluded without granting new authority. Inspect Worker integrity findings separately", relative(workspace, receiptDir), { count: nonCanonicalReceiptsExcluded });
  add("WD-OLL-022", "info", "Content-free Worker-to-OLL bridge audit; passing authority gates is not canonical-source or rule-activation E2E proof", "engram.json", { sourceSessions: sources.length, observerSources: required.length, receiptsChecked: receipts.length, receiptsGateRejected: rejected, legacyNonBatchExcluded, nonCanonicalReceiptsExcluded, rejectionCounts });
  return findings;
}
