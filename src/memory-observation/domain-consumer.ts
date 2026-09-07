import { acquireProcessLease } from "./process-lease.ts";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { withDailyNoteLock } from "../daily-note-lock.ts";
import { splitCanonicalSessionKey } from "../session-key.ts";
import { markWorkspaceQmdDirty } from "../qmd/maintenance-integration.ts";
import { resolveQmdContext } from "../qmd/context.ts";
import { resolveCanaryQmdRuntimeBinding } from "./qmd-binding-preflight.ts";
import { memoryObservationBinding, resolveMemoryObservationProjection, MEMORY_OBSERVATION_PROJECTION_SCHEMA_V4 } from "./projection.ts";
import { validateBatchObservation, type BatchObservationV1 } from "./batch-observation.ts";
import { DAILY_NOTE_APPLICATOR, renderDailyNoteEntry, type MemoryApplyReceiptV1 } from "./daily-note-applicator.ts";
import { sha256, type JsonValue, type Digest } from "./ledger.ts";

const STATUS_START = "<!-- engram-domain-recent:start -->";
const STATUS_END = "<!-- engram-domain-recent:end -->";
const digest = (value: unknown) => sha256(value as JsonValue);
const json = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const key = (hash: string) => { if (!/^sha256:[a-f0-9]{64}$/.test(hash)) throw new Error("invalid domain receipt identity"); return hash.slice(7); };

function durableWrite(path: string, value: string, immutable = false): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = path + ".tmp-" + randomUUID();
  const fd = openSync(tmp, "wx", 0o600);
  try { writeFileSync(fd, value); fsyncSync(fd); } finally { closeSync(fd); }
  try {
    if (immutable) {
      try { linkSync(tmp, path); } catch (error: any) {
        if (error.code !== "EEXIST" || readFileSync(path, "utf8") !== value) throw new Error("immutable domain receipt conflict");
      }
    } else renameSync(tmp, path);
    const dir = openSync(dirname(path), "r"); try { fsyncSync(dir); } finally { closeSync(dir); }
  } finally { if (existsSync(tmp)) unlinkSync(tmp); }
}
function immutableJson(path: string, value: unknown): void { durableWrite(path, JSON.stringify(value, null, 2) + "\n", true); }
function safeFile(path: string): string {
  if (!existsSync(path)) return "";
  if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) throw new Error("domain file is not a canonical regular file");
  return readFileSync(path, "utf8");
}
function entryBlock(receipt: MemoryApplyReceiptV1, observation: BatchObservationV1): string {
  const text = observation.payload.text.replace(/<!--/g, "&lt;!--").split(/\r?\n/).join("\n  ");
  return "<!-- engram-domain-entry:" + receipt.operationId + " -->\n- " + observation.sourceCompletedAt
    + " [" + observation.payload.section + "] " + text + "\n  Источник: " + receipt.destinationRef + "\n";
}

export type DomainConsumerOptions = {
  workspace: string;
  workspaceId: string;
  maxRecords?: number;
  expectedPluginDigest?: Digest;
  fault?: (point: "after_changelog" | "after_status" | "after_receipt" | "after_dirty") => void;
  qmdPreflight?: (observation: BatchObservationV1, domain: string) => { indexKey: string; collections: string[] };
  dirtyMarker?: typeof markWorkspaceQmdDirty;
};

/** Projects verified post-apply records, irrespective of their original dates. No model, KG or OLL calls. */
export async function consumeTopicDomainReceipts(options: DomainConsumerOptions) {
  const release = acquireProcessLease(join(realpathSync(options.workspace), "memory-state/domain-effects/consumer-lock"));
  if (!release) return { status: "busy", applied: 0, indexedPending: 0 };
  try { return await consumeLocked(options); } finally { release(); }
}

async function consumeLocked(options: DomainConsumerOptions) {
  const workspace = realpathSync(options.workspace);
  const root = join(workspace, "memory-state/memory-observation/v1");
  const state = join(workspace, "memory-state/domain-effects/v1");
  const projection = () => resolveMemoryObservationProjection({ workspace, workspaceId: options.workspaceId, expectedPluginDigest: options.expectedPluginDigest });
  const initial = projection();
  if (initial.schema !== MEMORY_OBSERVATION_PROJECTION_SCHEMA_V4) return { status: "not-applicable", applied: 0, indexedPending: 0 };
  function qmdForRoute(route: Pick<BatchObservationV1, "scope" | "sourceCompletedAt">, domain: string, active: typeof initial) {
    const domainDir = join(workspace, "memory/domains", domain);
    return options.qmdPreflight ? options.qmdPreflight(route as BatchObservationV1, domain) : (() => {
      const context = resolveQmdContext({ value: workspace, source: "explicit" });
      const resolver = active.consumers!.dailyNote.qmdBinding!;
      if (!("resolver" in resolver)) throw new Error("domain consumer requires pinned QMD resolver");
      resolveCanaryQmdRuntimeBinding({ workspace, runtimeSessionKey: route.scope.runtimeSessionKey,
        timezone: active.consumers!.dailyNote.timezone, destinationAt: route.sourceCompletedAt, resolver, context });
      const manifest = json(resolver.manifestPath), registry = manifest.registry ?? manifest;
      const exact = registry.collections.filter((c: any) => c.owner === options.workspaceId && c.path === domainDir);
      if (exact.length !== 1) throw new Error("domain requires one exact owned QMD collection");
      const collections = registry.collections.filter((c: any) => c.owner === options.workspaceId
        && (c.path === domainDir || c.path === join(workspace, "memory/domains"))).map((c: any) => c.name).sort();
      if (collections.some((name: string) => !context.policy.ownedCollections.includes(name) || !context.policy.readableCollections.includes(name))) throw new Error("domain collection is not owned/readable");
      return { indexKey: context.physicalIndex.key, collections };
    })();
  }
  async function publishDirty(applyPath: string, dirtyPath: string, qmd: {indexKey: string; collections: string[]}) {
    const applied = json(applyPath);
    const dirty = await (options.dirtyMarker ?? markWorkspaceQmdDirty)({ workspace, collections: qmd.collections,
      expectedIndexKey: qmd.indexKey, reason: "domain-receipt:" + applied.operationId, bm25: true, vectors: true });
    if (dirty.status !== "marked" || dirty.indexKey !== qmd.indexKey || digest(dirty.collections) !== digest(qmd.collections)) return false;
    options.fault?.("after_dirty");
    immutableJson(dirtyPath, { schema: "engram.domain-dirty-receipt.v1", operationId: applied.operationId,
      domainApplyReceiptDigest: digest(applied), canonicalApplied: true, qmdDirtyMarked: true,
      indexKey: dirty.indexKey, generation: dirty.generation, collections: dirty.collections });
    return true;
  }
  // Canonical domain receipts survive raw evidence/source retention. Retry only their QMD effect.
  let recoveredDirtyPending = 0;
  const appliedDir = join(state, "receipts");
  for (const name of existsSync(appliedDir) ? readdirSync(appliedDir).filter(n => /^[a-f0-9]{64}\.json$/.test(n)) : []) {
    const applyPath = join(appliedDir, name), dirtyPath = join(state, "dirty", name);
    if (existsSync(dirtyPath)) continue;
    const saved = json(applyPath), active = projection();
    const binding = memoryObservationBinding(active, saved.scope?.runtimeSessionKey);
    if (!binding?.topicDomain || binding.topicDomain.domain !== saved.domain || saved.scope.workspaceId !== options.workspaceId
      || saved.scope.scopeId !== binding.scopeId || saved.scope.scopeClass !== binding.scopeClass
      || saved.schema !== "engram.domain-apply-receipt.v1" || saved.canonicalApplied !== true) throw new Error("domain recovery receipt scope mismatch");
    const log = safeFile(join(workspace, "memory/domains", saved.domain, "changelog.md"));
    const start = log.indexOf("<!-- engram-domain-entry:" + saved.operationId + " -->\n");
    const candidate = start < 0 ? "" : log.slice(start).match(/^<!--[^\n]+-->\n- [^\n]*(?:\n  [^\n]*)*\n/)?.[0];
    if (!candidate || sha256(candidate) !== saved.entryDigest) throw new Error("domain recovery read-back failed");
    if (!await publishDirty(applyPath, dirtyPath, qmdForRoute(saved, saved.domain, active))) recoveredDirtyPending++;
  }
  const paths = existsSync(join(root, "receipts/by-operation")) ? readdirSync(join(root, "receipts/by-operation"))
    .filter(name => /^[a-f0-9]{64}\.json$/.test(name)).map(name => join(root, "receipts/by-operation", name)) : [];
  let applied = 0, indexedPending = recoveredDirtyPending, processed = 0;
  for (const path of paths.sort()) {
    const receipt = json(path) as MemoryApplyReceiptV1;
    const active = projection();
    const binding = memoryObservationBinding(active, receipt.scope?.runtimeSessionKey);
    if (!binding?.topicDomain || receipt.scope.workspaceId !== options.workspaceId) continue;
    const operationKey = key(receipt.operationId);
    const applyPath = join(state, "receipts", operationKey + ".json"), dirtyPath = join(state, "dirty", operationKey + ".json");
    if (existsSync(applyPath)) continue;
    if (processed++ >= (options.maxRecords ?? 50)) break;
    const observation = json(join(root, "observations/batch", key(receipt.sourceObservationRef) + ".json")) as BatchObservationV1;
    validateBatchObservation(observation);
    const split = splitCanonicalSessionKey(observation.scope.runtimeSessionKey)!;
    const expectedEntryId = sha256("engram.daily-note-entry.v1\0" + observation.observationId);
    const expectedOperation = sha256("engram.memory-apply.v1\0daily-note\0" + observation.observationId + "\0" + receipt.destinationEntryId);
    const notePath = join(workspace, "memory", "agent-" + split.agentId, split.sessionKey, receipt.destinationDate + ".md");
    const rendered = renderDailyNoteEntry(observation, receipt.destinationEntryId);
    if (receipt.schema !== "engram.memory-apply-receipt.v1" || receipt.consumer !== "daily-note" || receipt.status !== "applied"
      || receipt.canonicalMutation !== true || digest(receipt.producer) !== digest(DAILY_NOTE_APPLICATOR)
      || receipt.operationId !== expectedOperation || receipt.receiptId !== sha256("engram.memory-apply-receipt.v1\0" + expectedOperation)
      || receipt.destinationEntryId !== expectedEntryId || receipt.sourceProvenance.observationDigest !== observation.observationDigest
      || digest(receipt.scope) !== digest(observation.scope) || binding.scopeId !== receipt.scope.scopeId || binding.scopeClass !== receipt.scope.scopeClass
      || observation.evaluationPolicyDigest !== active.evaluation?.policyDigest
      || Date.parse(receipt.completedAt) < Date.parse(active.consumers!.dailyNote.applyAfter)
      || !/^\d{4}-\d{2}-\d{2}$/.test(receipt.destinationDate)
      || resolve(workspace, receipt.destinationRef.split("#")[0]!) !== notePath
      || realpathSync(notePath) !== notePath
      || receipt.readBackDigest !== sha256(rendered) || !safeFile(notePath).includes(rendered)) {
      throw new Error("domain source receipt/observation/destination join failed");
    }
    const domain = binding.topicDomain.domain, domainDir = join(workspace, "memory/domains", domain);
    const qmd = qmdForRoute(observation, domain, active);
    const block = entryBlock(receipt, observation);
    withDailyNoteLock(join(domainDir, ".engram-domain"), () => {
      if (digest(projection().bindings) !== digest(active.bindings)) throw new Error("domain authorization changed before write");
      const changelogPath = join(domainDir, "changelog.md"), statusPath = join(domainDir, "status.md");
      let changelog = safeFile(changelogPath);
      const marker = "<!-- engram-domain-entry:" + receipt.operationId + " -->";
      if (changelog.includes(marker) && !changelog.includes(block)) throw new Error("domain entry content conflict");
      if (!changelog.includes(marker)) { changelog = changelog.trimEnd() + "\n\n" + block; durableWrite(changelogPath, changelog); }
      options.fault?.("after_changelog");
      const recent = [...changelog.matchAll(/<!-- engram-domain-entry:sha256:[a-f0-9]{64} -->\n(- [^\n]*(?:\n  [^\n]*)*)/g)]
        .map(match => match[1]!).sort().slice(-20).join("\n");
      const managed = STATUS_START + "\n## Последние подтверждённые записи\n\n" + recent + "\n" + STATUS_END;
      const status = safeFile(statusPath);
      const starts = status.split(STATUS_START).length - 1, ends = status.split(STATUS_END).length - 1;
      if (starts !== ends || starts > 1) throw new Error("domain status managed block is ambiguous");
      const updated = starts ? status.replace(/<!-- engram-domain-recent:start -->[\s\S]*?<!-- engram-domain-recent:end -->/, () => managed)
        : status.trimEnd() + "\n\n" + managed + "\n";
      if (updated !== status) durableWrite(statusPath, updated);
      options.fault?.("after_status");
      if (!safeFile(changelogPath).includes(block) || !safeFile(statusPath).includes(managed)) throw new Error("domain destination read-back failed");
      immutableJson(applyPath, { schema: "engram.domain-apply-receipt.v1", operationId: receipt.operationId, sourceReceiptId: receipt.receiptId,
        sourceObservationId: observation.observationId, sourceObservationDigest: observation.observationDigest, scope: receipt.scope,
        domain, destination: "memory/domains/" + domain + "/changelog.md#" + marker, entryDigest: sha256(block),
        sourceCompletedAt: observation.sourceCompletedAt, canonicalApplied: true });
    });
    applied++;
    options.fault?.("after_receipt");
    if (!await publishDirty(applyPath, dirtyPath, qmd)) indexedPending++;
  }
  return { status: indexedPending ? "qmd-pending" : "ok", applied, indexedPending };
}
