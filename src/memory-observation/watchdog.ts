import { readFileSync, realpathSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { memoryObservationBinding, memoryObservationCaptureOwner, resolveMemoryObservationProjection, type MemoryObservationProjectionV1 } from "./projection.ts";
import { memoryWorkerHealth, memoryWorkerSnapshot, readWorkerRows, WORKER_STALE_AFTER_SECONDS, type WorkerStateRow } from "./worker-health.ts";
import { renderDailyNoteEntry, validateDailyNoteObservation } from "./daily-note-applicator.ts";
import { sha256 } from "./ledger.ts";
import { groupDomainOf, isGroupProjectionSchema } from "./group-bindings.ts";
import { readIndexHandoff, readIndexGeneration } from "../qmd/index-provenance.ts";

export type MemoryObservationFinding = { code: string; level: "error" | "warn" | "info"; message: string; path?: string; details?: unknown };
/** Read-only reconciliation. Does not construct consumers, invoke inference, recover, or publish dirty state. */
export function auditMemoryObservation(workspace: string, options: { now?: Date; expectedPluginDigest?: string; staleAfterSeconds?: number } = {}): MemoryObservationFinding[] {
  const now = options.now ?? new Date();
  const staleAfterSeconds = options.staleAfterSeconds ?? WORKER_STALE_AFTER_SECONDS;
  const findings: MemoryObservationFinding[] = [];
  const add = (code: string, level: MemoryObservationFinding["level"], message: string, path?: string, details?: unknown) => findings.push({ code, level, message, ...(path ? { path } : {}), ...(details !== undefined ? { details } : {}) });
  const snapshot = memoryWorkerSnapshot(workspace);
  if (!snapshot.observed) { add("WD-MW-001", "info", "Memory Worker state not observed; capture health is unverified", snapshot.root); return findings; }
  const projectionPath = join(snapshot.root, "projection.json");
  let projection: MemoryObservationProjectionV1 | undefined;
  let disabled = false;
  try {
    const config = JSON.parse(readFileSync(join(workspace, "engram.json"), "utf8"));
    const raw = JSON.parse(readFileSync(projectionPath, "utf8"));
    if (raw?.enabled === false && /^engram\.memory-observation-rollout\.v[1-5]$/.test(raw.schema) && raw.workspaceId === config.workspace?.id) {
      disabled = true;
      add("WD-MW-002", "info", "Memory Worker is explicitly disabled; historical state is audited without claiming active capture", projectionPath);
    } else {
    projection = resolveMemoryObservationProjection({ workspace, workspaceId: config.workspace?.id, expectedPluginDigest: options.expectedPluginDigest as any });
    const observer = projection.bindings.filter(binding => memoryObservationCaptureOwner(projection!, binding.runtimeSessionKey, now) === "observer");
    add("WD-MW-002", "info", `Validated ${projection.mode} projection; observer-owned bindings: ${observer.length}/${projection.bindings.length}`, projectionPath);
    if (projection.captureOwnership && observer.length === 0) add("WD-MW-003", "info", "Observer ownership is not yet effective; foreground capture remains authoritative", projectionPath);
    if (!options.expectedPluginDigest) add("WD-MW-004", "info", "Installed/loaded plugin digest not supplied; runtime producer identity unverified", projectionPath);
    }
  } catch { add("WD-MW-005", "error", "Memory Worker projection/configuration missing, invalid, or plugin digest mismatch", projectionPath); }
  const health = memoryWorkerHealth(workspace, now, { staleAfterSeconds, claimTtlSeconds: projection?.limits.claimTtlSeconds });
  add("WD-MW-006", "info", `Memory Worker accounting: ${health.status}`, snapshot.root, health);
  if (disabled && health.totalPending > 0) add("WD-MW-025", "warn", "Disabled worker retains unfinished work; capture ownership/recovery handover requires review", snapshot.root, { totalPending: health.totalPending });
  for (const error of health.errors) add("WD-MW-007", "error", `Memory Worker state cannot be fully accounted: ${error.error}`, error.path);
  for (const [stage, data] of Object.entries(health.stages)) if (data.stale || data.overdue) add("WD-MW-008", "warn", `${stage} backlog exceeds ${staleAfterSeconds}s operational threshold`, snapshot.root, { stage, ...data });
  if (health.expiredClaims) add("WD-MW-009", "warn", "Memory Worker has expired claims", snapshot.root, { count: health.expiredClaims });
  if (health.terminalFailures || health.dailyFailures || health.admissionGaps) add("WD-MW-010", "warn", "Unresolved historical terminal outcomes/admission gaps remain; not evidence of new message loss", snapshot.root, { terminalFailures: health.terminalFailures, dailyFailures: health.dailyFailures, admissionGaps: health.admissionGaps, recoveredAdmissionGaps: health.recoveredAdmissionGaps });
  const errors = [...snapshot.errors];
  const read = (path: string) => readWorkerRows(join(snapshot.root, "v1", path), errors);
  const envelopes = read("envelopes"), observations = [...read("observations/typed"), ...read("observations/batch")];
  const receipts = read("receipts/by-operation"), aliases = read("receipts/by-entry");
  const oldEnough = (row: WorkerStateRow) => {
    const timestamp = Date.parse(row.value.completedAt ?? row.value.terminalAt ?? row.value.admittedAt ?? row.value.updatedAt ?? row.value.createdAt);
    // Unknown age is not a reason to suppress a missing join indefinitely.
    return !Number.isFinite(timestamp) || now.getTime() - timestamp > 300_000;
  };
  const evaluatorIds = new Set(snapshot.evaluator.map(row => row.value.traceId));
  const dailyIds = new Set(snapshot.daily.map(row => row.value.observationId));
  for (const row of envelopes) if (oldEnough(row) && !evaluatorIds.has(row.value.traceId)) add("WD-MW-011", "warn", "Admitted envelope has no evaluator queue record after publication grace", row.path);
  for (const row of observations) {
    try { validateDailyNoteObservation(row.value as any); }
    catch { add("WD-MW-012", "error", "Persisted observation fails its schema/digest contract", row.path); }
    if (projection?.mode === "canary" && Date.parse(row.value.sourceCompletedAt) >= Date.parse(projection.consumers!.dailyNote.applyAfter)
      && oldEnough(row) && !dailyIds.has(row.value.observationId)) add("WD-MW-013", "warn", "Canary observation has no daily-note queue record after publication grace", row.path);
  }
  const observationMap = new Map(observations.map(row => [row.value.observationId, row]));
  const envelopeMap = new Map(envelopes.map(row => [row.value.traceId, row]));
  const receiptMap = new Map(receipts.map(row => [row.value.sourceObservationRef, row]));
  const aliasMap = new Map(aliases.map(row => [row.value.destinationEntryId, row]));
  const checkScope = (row: WorkerStateRow, scope: any) => {
    if (!projection) return;
    const binding = scope && memoryObservationBinding(projection, scope.runtimeSessionKey);
    if (!binding || scope.workspaceId !== projection.workspaceId || scope.scopeClass !== binding.scopeClass || scope.scopeId !== binding.scopeId)
      add("WD-MW-014", "warn", "Pending work has no matching active projection scope", row.path);
  };
  for (const row of snapshot.evaluator.filter(row => row.value.status !== "terminal")) checkScope(row, envelopeMap.get(row.value.traceId)?.value.scope);
  for (const row of snapshot.admission.filter(row => !["terminal_gap", "ledger_admitted"].includes(row.value.stage))) checkScope(row, row.value.scope);
  for (const row of snapshot.daily) {
    if (row.value.status !== "terminal") checkScope(row, observationMap.get(row.value.observationId)?.value.scope ?? receiptMap.get(row.value.observationId)?.value.scope);
    if (oldEnough(row) && row.value.status === "terminal" && ["canonical_applied", "duplicate_receipt"].includes(row.value.reasonCode) && !receiptMap.has(row.value.observationId))
      add("WD-MW-015", "error", "Successful daily-note terminal has no immutable apply receipt", row.path);
  }
  const missingGenerations: string[] = [];
  for (const row of receipts) {
    const receipt = row.value;
    if (!oldEnough(row)) continue;
    try {
      const entryId = sha256(`engram.daily-note-entry.v1\0${receipt.sourceObservationRef}`);
      const operationId = sha256(`engram.memory-apply.v1\0daily-note\0${receipt.sourceObservationRef}\0${entryId}`);
      if (receipt.schema !== "engram.memory-apply-receipt.v1" || receipt.status !== "applied" || receipt.canonicalMutation !== true
        || receipt.destinationEntryId !== entryId || receipt.operationId !== operationId
        || receipt.receiptId !== sha256(`engram.memory-apply-receipt.v1\0${operationId}`)) throw new Error("receipt_identity");
      const alias = aliasMap.get(receipt.destinationEntryId);
      if (!alias || sha256(alias.value as any) !== sha256(receipt as any)) add("WD-MW-016", "error", "Apply receipt entry alias missing or inconsistent", row.path);
      const observation = observationMap.get(receipt.sourceObservationRef)?.value;
      if (observation && (receipt.sourceProvenance?.observationDigest !== observation.observationDigest || sha256(receipt.scope) !== sha256(observation.scope))) throw new Error("source_join");
      // Never follow a corrupted destination outside the workspace, including symlink escapes.
      const destination = resolve(workspace, String(receipt.destinationRef).split("#", 1)[0]);
      const contained = (path: string) => { const rel = relative(realpathSync(workspace), path); return rel !== ".." && !rel.startsWith(`..${sep}`) && !resolve(path).startsWith(`${resolve(workspace)}${sep}..${sep}`); };
      if (!contained(realpathSync(destination))) throw new Error("destination_outside_workspace");
      const content = readFileSync(destination, "utf8");
      const anchor = `<!-- engram-entry:${entryId} -->`;
      const rendered = observation ? renderDailyNoteEntry(observation as any, entryId) : content.match(new RegExp(`<!-- engram-entry:${entryId} -->\\n- [^\\n]*(?:\\n  [^\\n]*)*`))?.[0];
      if (!rendered || !content.includes(rendered) || content.split(anchor).length !== 2 || sha256(rendered) !== receipt.readBackDigest) throw new Error("canonical_readback");
      if (receipt.qmdBinding) {
        const handoff = readIndexHandoff(workspace, receipt.receiptId);
        if (!handoff) add("WD-MW-017", "warn", "Applied note has no QMD handoff after publication grace", row.path);
        else if (!readIndexGeneration(workspace, receipt.receiptId)) missingGenerations.push(row.path);
      }
    } catch { add("WD-MW-019", "error", "Apply receipt identity, source join, canonical read-back, or QMD provenance failed validation", row.path); }
  }
  if (missingGenerations.length) add("WD-MW-018", "info", "QMD handoffs lack persisted verified index-generation receipts; actual indexing remains unverified, not proven failed", snapshot.root, { count: missingGenerations.length });
  if (projection && isGroupProjectionSchema(projection.schema)) {
    const domainRoot = join(workspace, "memory-state/domain-effects/v1");
    const applied = readWorkerRows(join(domainRoot, "receipts"), errors);
    const dirty = readWorkerRows(join(domainRoot, "dirty"), errors);
    const appliedMap = new Map(applied.map(row => [row.value.operationId, row]));
    const dirtyMap = new Map(dirty.map(row => [row.value.operationId, row]));
    const dailyByOperation = new Map(receipts.map(row => [row.value.operationId, row]));
    for (const row of receipts) {
      const binding = row.value.scope && memoryObservationBinding(projection, row.value.scope.runtimeSessionKey);
      if (binding && groupDomainOf(binding) && oldEnough(row) && !appliedMap.has(row.value.operationId))
        add("WD-MW-021", "warn", "Applicable daily-note receipt has no domain-effect receipt after publication grace", row.path);
    }
    for (const row of applied) {
      const record = row.value, source = dailyByOperation.get(record.operationId)?.value;
      try {
        const binding = record.scope && memoryObservationBinding(projection, record.scope.runtimeSessionKey);
        const domain = binding && groupDomainOf(binding)?.domain;
        if (!domain || record.domain !== domain || record.schema !== "engram.domain-apply-receipt.v1" || record.canonicalApplied !== true
          || record.scope.workspaceId !== projection.workspaceId || record.scope.scopeId !== binding!.scopeId || record.scope.scopeClass !== binding!.scopeClass
          || !/^sha256:[a-f0-9]{64}$/.test(record.operationId)) throw new Error("domain_scope");
        if (!source || source.receiptId !== record.sourceReceiptId || source.sourceObservationRef !== record.sourceObservationId
          || source.sourceProvenance?.observationDigest !== record.sourceObservationDigest || sha256(source.scope) !== sha256(record.scope)) throw new Error("domain_source");
        const path = join(workspace, "memory/domains", domain, "changelog.md");
        const real = realpathSync(path), rel = relative(realpathSync(workspace), real);
        if (rel === ".." || rel.startsWith(`..${sep}`)) throw new Error("domain_path");
        const content = readFileSync(real, "utf8"), anchor = `<!-- engram-domain-entry:${record.operationId} -->`;
        const start = content.indexOf(anchor + "\n"), block = start < 0 ? null : content.slice(start).match(/^<!--[^\n]+-->\n- [^\n]*(?:\n  [^\n]*)*\n/)?.[0];
        if (!block || content.split(anchor).length !== 2 || sha256(block) !== record.entryDigest) throw new Error("domain_readback");
        const dirtyReceipt = dirtyMap.get(record.operationId);
        if (!dirtyReceipt) {
          if (oldEnough(dailyByOperation.get(record.operationId)!)) add("WD-MW-022", "warn", "Domain effect has no durable dirty-publication receipt", row.path);
        } else {
          const mark = dirtyReceipt.value;
          if (mark.schema !== "engram.domain-dirty-receipt.v1" || mark.domainApplyReceiptDigest !== sha256(record)
            || mark.canonicalApplied !== true || mark.qmdDirtyMarked !== true || !Number.isSafeInteger(mark.generation) || mark.generation < 1
            || typeof mark.indexKey !== "string" || !Array.isArray(mark.collections) || mark.collections.length === 0)
            add("WD-MW-023", "error", "Domain dirty-publication receipt is invalid or disconnected from apply receipt", dirtyReceipt.path);
        }
      } catch { add("WD-MW-024", "error", "Domain effect scope/source receipt/canonical read-back validation failed", row.path); }
    }
  }
  for (const error of errors) if (!health.errors.some(value => value.path === error.path)) add("WD-MW-007", "error", `Memory Worker artifact cannot be read: ${error.error}`, error.path);
  if (snapshot.evaluator.length === 0 && snapshot.admission.length === 0 && receipts.length === 0)
    add("WD-MW-020", "info", "No persisted natural capture evidence; end-to-end capture remains unverified", snapshot.root);
  return findings;
}
