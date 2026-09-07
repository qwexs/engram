/** Explicit operator repair of ONE applied short user quotation. No inference,
 * arbitrary replacement text, new event capture, KG writes or receipt rewrites. */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync, realpathSync, lstatSync, renameSync, linkSync, unlinkSync, openSync, closeSync, fsyncSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { withDailyNoteLock } from "../daily-note-lock.ts";
import { splitCanonicalSessionKey } from "../session-key.ts";
import { markWorkspaceQmdDirty } from "../qmd/maintenance-integration.ts";
import { resolveQmdContext } from "../qmd/context.ts";
import { validateBatchObservation, type BatchObservationV1 } from "./batch-observation.ts";
import { validateCompiledBatchBundle } from "./batch-shadow-runner.ts";
import { groupAssertionAttribution } from "./group-attribution.ts";
import { DAILY_NOTE_APPLICATOR, renderDailyNoteEntry, type MemoryApplyReceiptV1 } from "./daily-note-applicator.ts";
import { memoryObservationBinding, resolveMemoryObservationProjection } from "./projection.ts";
import { acquireProcessLease } from "./process-lease.ts";
import { renderRecentDomainStatus } from "./domain-recent.ts";
import { sha256, type Digest, type JsonValue } from "./ledger.ts";
const hash = (x: unknown) => sha256(x as JsonValue);
const key = (x: string) => { if (!/^sha256:[a-f0-9]{64}$/.test(x)) throw new Error("invalid observation digest"); return x.slice(7); };
const json = (p: string) => JSON.parse(readFileSync(p, "utf8"));
function text(p: string) {
  if (!lstatSync(p).isFile() || lstatSync(p).isSymbolicLink() || realpathSync(p) !== resolve(p)) throw new Error("repair target must be a canonical regular file");
  return readFileSync(p, "utf8");
}
function durable(p: string, value: string, immutable = false) {
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
  if (immutable && existsSync(p)) { if (text(p) !== value) throw new Error("correction authorization conflict"); return; }
  const tmp = p + ".tmp-" + randomUUID(), fd = openSync(tmp, "wx", 0o600);
  try { writeFileSync(fd, value); fsyncSync(fd); } finally { closeSync(fd); }
  try { if (immutable) linkSync(tmp, p); else renameSync(tmp, p); }
  finally { if (existsSync(tmp)) unlinkSync(tmp); }
  const dir = openSync(dirname(p), "r"); try { fsyncSync(dir); } finally { closeSync(dir); }
}
const serialized = (x: unknown) => JSON.stringify(x, null, 2) + "\n";
export type SourceQuoteCorrectionOptions = {
  workspace: string; session: string; observationId: Digest; bundleFile: string;
  authorizedBy: string; authorizedAt: string; apply?: boolean; now?: Date;
  fault?: (point: "after_intent" | "after_note" | "after_changelog" | "after_status" | "after_completed") => void;
  qmdPreflight?: (receipt: MemoryApplyReceiptV1, domain: string | null) => { indexKey: string; collections: string[] };
  dirtyMarker?: typeof markWorkspaceQmdDirty;
};
export async function restoreAppliedSourceQuote(o: SourceQuoteCorrectionOptions) {
  const workspace = realpathSync(o.workspace), root = join(workspace, "memory-state/memory-observation/v1");
  if (!/^[A-Za-z0-9:_./-]{1,200}$/.test(o.authorizedBy)
    || !Number.isFinite(Date.parse(o.authorizedAt)) || new Date(o.authorizedAt).toISOString() !== o.authorizedAt
    || Date.parse(o.authorizedAt) > (o.now ?? new Date()).getTime()) throw new Error("explicit operator authorization is required");
  const observationPath = join(root, "observations/batch", key(o.observationId) + ".json");
  const observation = JSON.parse(text(observationPath)) as BatchObservationV1; validateBatchObservation(observation);
  if (observation.observationId !== o.observationId || observation.scope.runtimeSessionKey !== o.session || observation.payload.actorRef !== "user" || observation.sourceRefs.length !== 1) throw new Error("repair requires one exact user source");
  const workspaceId = json(join(workspace, "engram.json")).workspace.id;
  const projection = () => resolveMemoryObservationProjection({ workspace, workspaceId });
  const active = projection(), binding = memoryObservationBinding(active, observation.scope.runtimeSessionKey);
  if (!active.enabled || active.captureOwnership?.owner !== "observer" || !binding || observation.scope.workspaceId !== workspaceId
    || binding.scopeId !== observation.scope.scopeId || binding.scopeClass !== observation.scope.scopeClass) throw new Error("correction scope is not active");
  const source = observation.sourceRefs[0]!;
  const jobsRoot = join(workspace, "memory-state/memory-observation/batch-live-store/memory-batch-live/v1/jobs");
  if (dirname(resolve(o.bundleFile)) !== jobsRoot) throw new Error("bundle must be an owned immutable batch job");
  const bundle = validateCompiledBatchBundle(JSON.parse(text(o.bundleFile)).bundle, o.now ?? new Date());
  if (bundle.bundleId !== observation.bundleId || bundle.partition.workspaceId !== workspaceId
    || bundle.partition.runtimeSessionKey !== observation.scope.runtimeSessionKey
    || bundle.partition.scopeClass !== observation.scope.scopeClass || bundle.partition.scopeId !== observation.scope.scopeId
    || !bundle.sourceRefs.some(s => hash(s) === hash(source))) throw new Error("source bundle join failed");
  const input = bundle.inputs.find(i => i.traceId === source.traceId)!;
  if (!input || observation.citations.some(c => c.traceId !== source.traceId || !input.evidenceRefs.some(r => hash(r) === hash(c.evidenceRef)))
    || !observation.citations.some(c => c.evidenceRef.kind === "source-turn" && c.evidenceRef.ref === source.sourceTurnId)) throw new Error("exact source citation missing");
  const sourcePayload = (input.evidence as any).source;
  if (sourcePayload?.role !== "user" || typeof sourcePayload.text !== "string") throw new Error("source quotation unavailable");
  const quote = sourcePayload.text.replace(/\s+/gu, " ").trim();
  if (!quote || quote.length > 700) throw new Error("only complete short quotations can be restored");
  const attribution = groupAssertionAttribution(bundle, "user", observation.citations) || "Пользователь: ";
  const replyId = (input.evidence as any).replyContext?.requestedReplyToId;
  const correctedText = attribution + "Слова пользователя: «" + quote + "»"
    + (typeof replyId === "string" && /^-?[0-9]+$/.test(replyId) ? " (ответ на сообщение " + replyId + "; содержание объекта не интерпретировано)" : "");
  const entryId = sha256("engram.daily-note-entry.v1\0" + observation.observationId);
  const operationId = sha256("engram.memory-apply.v1\0daily-note\0" + observation.observationId + "\0" + entryId);
  const receiptPath = join(root, "receipts/by-operation", key(operationId) + ".json");
  const receipt = JSON.parse(text(receiptPath)) as MemoryApplyReceiptV1;
  const split = splitCanonicalSessionKey(observation.scope.runtimeSessionKey)!;
  const notePath = join(workspace, "memory", "agent-" + split.agentId, split.sessionKey, receipt.destinationDate + ".md");
  const original = renderDailyNoteEntry(observation, entryId);
  if (receipt.schema !== "engram.memory-apply-receipt.v1" || receipt.consumer !== "daily-note" || receipt.status !== "applied" || !receipt.canonicalMutation
    || hash(receipt.producer) !== hash(DAILY_NOTE_APPLICATOR) || receipt.operationId !== operationId
    || receipt.receiptId !== sha256("engram.memory-apply-receipt.v1\0" + operationId) || receipt.sourceObservationRef !== observation.observationId
    || receipt.destinationEntryId !== entryId || receipt.sourceProvenance.observationDigest !== observation.observationDigest
    || hash(receipt.scope) !== hash(observation.scope) || !/^\d{4}-\d{2}-\d{2}$/.test(receipt.destinationDate)
    || resolve(workspace, receipt.destinationRef.split("#")[0]!) !== notePath || receipt.readBackDigest !== sha256(original)
    || text(notePath).split(original).length !== 2) throw new Error("applied source receipt/note join failed");
  const domain = binding.topicDomain?.domain ?? null, domainDir = domain ? join(workspace, "memory/domains", domain) : null;
  const correctionId = hash({ schema: "engram.source-quote-correction.v1", observationId: observation.observationId, correctedText });
  const correctionDir = join(root, "corrections/source-quote", key(observation.observationId));
  const intent = { schema: "engram.source-quote-correction.v1", correctionId, scope: observation.scope,
    sourceObservationId: observation.observationId, sourceObservationDigest: observation.observationDigest, sourceReceiptDigest: hash(receipt),
    sourceRefs: observation.sourceRefs, citations: observation.citations, status: "superseded", supersededBy: correctionId,
    replacement: { text: correctedText, actorRef: "user", outcomeStatus: "unknown" }, destinationRef: receipt.destinationRef,
    authorizedBy: o.authorizedBy, authorizedAt: o.authorizedAt };
  const escaped = correctedText.replace(/<!--/g, "&lt;!--").replace(/[\r\n]/g, " ");
  const replacementNote = "<!-- engram-entry:" + correctionId + " -->\n- Исправление записи по исходнику: " + escaped + "\n";
  const noteAnnotation = "<!-- engram-superseded:" + entryId + " by:" + correctionId + " -->\n> Следующая запись заменена исправлением " + correctionId + "; её прежняя формулировка ниже сохранена только для истории.\n";
  const domainOriginal = "<!-- engram-domain-entry:" + operationId + " -->\n- " + observation.sourceCompletedAt + " [" + observation.payload.section + "] "
    + observation.payload.text.replace(/<!--/g, "&lt;!--").split(/\r?\n/).join("\n  ") + "\n  Источник: " + receipt.destinationRef + "\n";
  const domainAnnotation = "<!-- engram-domain-superseded:" + operationId + " by:" + correctionId + " -->\n> Следующая запись заменена исправлением " + correctionId + "; сохранена только для истории.\n";
  const domainReplacement = "<!-- engram-domain-entry:" + correctionId + " -->\n- " + observation.sourceCompletedAt + " [" + observation.payload.section + "] " + escaped
    + "\n  Исправление по исходнику; заменяет " + operationId + ".\n  Источник: " + receipt.destinationRef.split("#")[0] + "#engram-entry:" + correctionId + "\n";
  if (domainDir) {
    const domainReceipt = json(join(workspace, "memory-state/domain-effects/v1/receipts", key(operationId) + ".json"));
    if (domainReceipt.operationId !== operationId || domainReceipt.sourceObservationId !== observation.observationId
      || hash(domainReceipt.scope) !== hash(observation.scope) || domainReceipt.entryDigest !== sha256(domainOriginal)
      || text(join(domainDir, "changelog.md")).split(domainOriginal).length !== 2) throw new Error("domain receipt/changelog join failed");
    // Validate the manual/managed boundary before any mutation.
    renderRecentDomainStatus(text(join(domainDir, "status.md")), text(join(domainDir, "changelog.md")));
  }
  const qmd = o.qmdPreflight ? o.qmdPreflight(receipt, domain) : (() => {
    const context = resolveQmdContext({ value: workspace, source: "explicit" });
    const resolver = active.consumers!.dailyNote.qmdBinding!;
    if (!("resolver" in resolver) || !receipt.qmdBinding) throw new Error("pinned QMD binding required");
    const manifest = json(resolver.manifestPath), registry = manifest.registry ?? manifest;
    const collections = [receipt.qmdBinding.collection, ...registry.collections.filter((c: any) => c.owner === workspaceId
      && domainDir && (c.path === domainDir || c.path === join(workspace, "memory/domains"))).map((c: any) => c.name)];
    if (receipt.qmdBinding.indexKey !== context.physicalIndex.key || collections.some((c: string) => !context.policy.ownedCollections.includes(c))) throw new Error("correction QMD scope mismatch");
    return { indexKey: context.physicalIndex.key, collections: [...new Set(collections)].sort() as string[] };
  })();
  if (!o.apply) return { ...intent, status: "planned", canonicalMutation: false };
  const release = acquireProcessLease(join(workspace, "memory-state/domain-effects/consumer-lock"));
  if (!release) throw new Error("domain consumer busy; retry correction later");
  const intentPath = join(correctionDir, "intent.json"), completePath = join(correctionDir, "completed.json");
  try {
    if (hash(projection()) !== hash(active) || hash(json(observationPath)) !== hash(observation) || hash(json(receiptPath)) !== hash(receipt)) throw new Error("correction authorization changed");
    durable(intentPath, serialized(intent), true); o.fault?.("after_intent");
    withDailyNoteLock(notePath, () => {
      if (hash(projection()) !== hash(active)) throw new Error("correction scope changed before note write");
      const before = text(notePath);
      if (!before.includes(original)) throw new Error("original note changed");
      let after = before;
      const marker = "<!-- engram-superseded:" + entryId + " by:";
      if (before.includes(marker) && !before.includes(noteAnnotation + original)) throw new Error("note correction conflict");
      if (!before.includes(noteAnnotation)) after = after.replace(original, () => noteAnnotation + original);
      if (after.includes("<!-- engram-entry:" + correctionId + " -->") && !after.includes(replacementNote)) throw new Error("replacement note conflict");
      if (!after.includes(replacementNote)) after = after.replace(noteAnnotation + original, () => noteAnnotation + original + replacementNote);
      if (after !== before) durable(notePath, after);
      if (!text(notePath).includes(noteAnnotation + original + replacementNote)) throw new Error("correction note read-back failed");
    });
    o.fault?.("after_note");
    if (domainDir) withDailyNoteLock(join(domainDir, ".engram-domain"), () => {
      if (hash(projection()) !== hash(active)) throw new Error("correction scope changed before domain write");
      const logPath = join(domainDir, "changelog.md"), statusPath = join(domainDir, "status.md");
      let log = text(logPath);
      if (!log.includes(domainOriginal)) throw new Error("original domain changed");
      if (log.includes("<!-- engram-domain-superseded:" + operationId + " by:") && !log.includes(domainAnnotation + domainOriginal)) throw new Error("domain correction conflict");
      if (!log.includes(domainAnnotation)) log = log.replace(domainOriginal, () => domainAnnotation + domainOriginal);
      if (log.includes("<!-- engram-domain-entry:" + correctionId + " -->") && !log.includes(domainReplacement)) throw new Error("domain replacement conflict");
      if (!log.includes(domainReplacement)) log = log.trimEnd() + "\n\n" + domainReplacement;
      durable(logPath, log); o.fault?.("after_changelog");
      durable(statusPath, renderRecentDomainStatus(text(statusPath), log)); o.fault?.("after_status");
      if (!text(logPath).includes(domainAnnotation + domainOriginal) || !text(logPath).includes(domainReplacement)
        || !text(statusPath).includes(escaped)) throw new Error("correction domain read-back failed");
    });
    const completion = { schema: "engram.source-quote-correction-completed.v1", correctionId, intentDigest: hash(intent),
      canonicalMutation: true, originalObservationUnchanged: true, originalReceiptUnchanged: true };
    durable(completePath, serialized(completion), true); o.fault?.("after_completed");
  } finally { release(); }
  const dirty = await (o.dirtyMarker ?? markWorkspaceQmdDirty)({ workspace, collections: qmd.collections, expectedIndexKey: qmd.indexKey,
    reason: "source-quote-correction:" + correctionId, bm25: true, vectors: true });
  if (dirty.status === "marked") durable(join(correctionDir, "qmd-dirty.json"), serialized({ correctionId, indexKey: dirty.indexKey, generation: dirty.generation }));
  return { status: dirty.status === "marked" ? "corrected" : "qmd-pending", correctionId, supersededObservationId: observation.observationId,
    correctedText, canonicalMutation: true, domain, notePath };
}
