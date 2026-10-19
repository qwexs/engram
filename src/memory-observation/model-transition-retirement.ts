import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { sha256, type JsonValue } from "./ledger.ts";
import { readModelTransition } from "./model-transition.ts";
import { acquireProcessLease } from "./process-lease.ts";
import { qualityTransitionInventory } from "./quality-rollout.ts";
import { memoryObservationBinding, type MemoryObservationProjectionV1 } from "./projection.ts";
import { memoryWorkerHealth } from "./worker-health.ts";

const hash = (value: unknown) => sha256(value as JsonValue);
const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const statePath = (workspace: string) => join(workspace, "memory-state/memory-observation");

/** Preflight only. Never infer completion from a cron status or delete debt. */
export function assertModelTransitionRetirable(workspace: string, current: MemoryObservationProjectionV1) {
  const transition = readModelTransition(workspace, current);
  if (!transition) return null;
  const inventory = qualityTransitionInventory(workspace);
  if (inventory.evaluator.length || inventory.batches.length || inventory.consumer.length || inventory.unconsumed.length) {
    throw Error("MODEL_TRANSITION_DRAIN_REQUIRED");
  }
  // Inventory alone must not trust a forged/invalid done marker as completion.
  const health = memoryWorkerHealth(workspace);
  if (health.corruptRecords || health.batchPending) throw Error("MODEL_TRANSITION_ACCOUNTING_INVALID");
  // Daily apply is not the end of the domain pipeline. Retaining the transition
  // is necessary until all applicable domain effects have their own receipts.
  const receipts = join(statePath(workspace), "v1/receipts/by-operation");
  for (const name of existsSync(receipts) ? readdirSync(receipts).filter(n => /^[a-f0-9]{64}\.json$/.test(n)) : []) {
    const receipt = read(join(receipts, name));
    const binding = memoryObservationBinding(current, receipt.scope?.runtimeSessionKey);
    if (!binding || !(binding.topicDomain || binding.groupDomain)) continue;
    if (current.workspaceId === "main"
      && receipt.scope.scopeClass === "self" && receipt.scope.scopeId === "workspace:main") continue;
    if (!/^sha256:[a-f0-9]{64}$/.test(receipt.operationId)) throw Error("MODEL_TRANSITION_DOMAIN_RECEIPT_INVALID");
    for (const directory of ["receipts", "dirty"]) {
      if (!existsSync(join(workspace, "memory-state/domain-effects/v1", directory, receipt.operationId.slice(7) + ".json"))) {
        throw Error("MODEL_TRANSITION_DOMAIN_DRAIN_REQUIRED");
      }
    }
    const applied = read(join(workspace, "memory-state/domain-effects/v1/receipts", receipt.operationId.slice(7) + ".json"));
    const dirty = read(join(workspace, "memory-state/domain-effects/v1/dirty", receipt.operationId.slice(7) + ".json"));
    if (applied.schema !== "engram.domain-apply-receipt.v1" || applied.operationId !== receipt.operationId
      || applied.sourceReceiptId !== receipt.receiptId || applied.canonicalApplied !== true
      || dirty.schema !== "engram.domain-dirty-receipt.v1" || dirty.operationId !== receipt.operationId
      || dirty.domainApplyReceiptDigest !== hash(applied) || dirty.qmdDirtyMarked !== true || dirty.canonicalApplied !== true) {
      throw Error("MODEL_TRANSITION_DOMAIN_RECEIPT_INVALID");
    }
  }
  return { transition, inventoryDigest: inventory.inventoryDigest };
}

function immutable(path: string, value: unknown): void {
  const bytes = JSON.stringify(value, null, 2) + "\n";
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = path + ".tmp-" + randomUUID();
  const fd = openSync(temp, "wx", 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  try {
    try { linkSync(temp, path); } catch (error: any) {
      if (error.code !== "EEXIST" || hash(read(path)) !== hash(value)) throw Error("MODEL_TRANSITION_ARCHIVE_CONFLICT");
    }
    const dir = openSync(dirname(path), "r");
    try { fsyncSync(dir); } finally { closeSync(dir); }
  } finally { unlinkSync(temp); }
}

/** Called only by authorized projection mutations. Archive before removing the
 * active marker; a crash before publish leaves the old projection usable and
 * the exact historical transition recoverable. No unknown/stale marker bypass. */
export function publishAfterModelTransitionDrain(workspace: string, before: MemoryObservationProjectionV1,
  after: MemoryObservationProjectionV1, publish: () => void): void {
  const projectionPath = join(statePath(workspace), "projection.json");
  const assertUnchanged = () => {
    if (hash(read(projectionPath)) !== hash(before)) throw Error("MODEL_TRANSITION_PROJECTION_CHANGED");
  };
  assertUnchanged();
  if (!existsSync(join(statePath(workspace), "model-transition.json")) || hash(before) === hash(after)) {
    // Even an idempotent request must not bless a corrupt transition.
    readModelTransition(workspace, before);
    publish(); return;
  }
  const releaseInference = acquireProcessLease(join(tmpdir(), "engram-memory-batch-inference-" + (process.getuid?.() ?? "user")));
  if (!releaseInference) throw Error("MODEL_TRANSITION_WORKER_BUSY");
  let releaseDomain: (() => void) | null = null;
  try {
    releaseDomain = acquireProcessLease(join(workspace, "memory-state/domain-effects/consumer-lock"));
    if (!releaseDomain) throw Error("MODEL_TRANSITION_WORKER_BUSY");
    assertUnchanged();
    const plan = assertModelTransitionRetirable(workspace, before)!;
    const history = join(statePath(workspace), "model-transition-history");
    const key = plan.transition.digest.slice(7);
    immutable(join(history, key + ".json"), plan.transition);
    const receiptPath = join(history, key + ".retirement.json");
    const body = { schema: "engram.memory-model-transition-retirement.v1", transitionDigest: plan.transition.digest,
      beforeProjectionDigest: hash(before), afterProjectionDigest: hash(after), inventoryDigest: plan.inventoryDigest,
      reason: "projection_change_after_verified_drain" };
    const receipt = existsSync(receiptPath) ? read(receiptPath) : { ...body, recordedAt: new Date().toISOString() };
    const { recordedAt, ...saved } = receipt;
    if (hash(saved) !== hash(body) || !Number.isFinite(Date.parse(recordedAt))) throw Error("MODEL_TRANSITION_ARCHIVE_CONFLICT");
    immutable(receiptPath, receipt);
    const checked = assertModelTransitionRetirable(workspace, before)!;
    if (checked.transition.digest !== plan.transition.digest || checked.inventoryDigest !== plan.inventoryDigest) {
      throw Error("MODEL_TRANSITION_INVENTORY_CHANGED");
    }
    assertUnchanged();
    unlinkSync(join(statePath(workspace), "model-transition.json"));
    const dir = openSync(statePath(workspace), "r");
    try { fsyncSync(dir); } finally { closeSync(dir); }
    publish();
  } finally { releaseDomain?.(); releaseInference(); }
}

/** Never include arbitrary exception text (paths, model output or secrets). */
export function modelTransitionBlockReason(error: unknown): string {
  const code = error instanceof Error ? error.message : "";
  return ["MODEL_TRANSITION_IDENTITY_CHANGED", "MODEL_TRANSITION_SCOPE_CHANGED", "MODEL_TRANSITION_PENDING_POLICY_DENIED"].includes(code)
    ? code : "MODEL_TRANSITION_VALIDATION_FAILED";
}
