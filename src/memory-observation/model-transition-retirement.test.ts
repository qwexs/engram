import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { sha256 } from "./ledger.ts";
import { readModelTransition } from "./model-transition.ts";
import { assertModelTransitionRetirable, modelTransitionBlockReason, publishAfterModelTransitionDrain } from "./model-transition-retirement.ts";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })));
function fixture() {
  const workspace = mkdtempSync(join(tmpdir(), "engram-transition-retirement-")); roots.push(workspace);
  const root = join(workspace, "memory-state/memory-observation");
  const put = (path: string, value: unknown) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value)); };
  const before: any = { workspaceId: "project", enabled: true, mode: "canary", schema: "engram.memory-observation-rollout.v4",
    pluginDigest: sha256("new-plugin"), bindings: [{ runtimeSessionKey: "agent:project:telegram:group:-1001:topic:1",
      scopeId: "domain:project:general", scopeClass: "project", topicDomain: { domain: "general", chatId: "-1001", topicId: "1" } }],
    inference: { model: "openai/gpt-6-luna", provider: "openai" },
    evaluation: { policyDigest: sha256("new-policy"), batch: { sourcePolicyDigest: sha256("source") } },
    consumers: { dailyNote: { qmdBinding: { manifestPath: "/before.json" } } } };
  const previousProjection = structuredClone(before);
  previousProjection.pluginDigest = sha256("old-plugin"); previousProjection.inference.model = "openai/gpt-5.6-terra";
  previousProjection.evaluation.policyDigest = sha256("old-policy");
  const body = { schema: "engram.memory-model-transition.v1", targetProjectionDigest: sha256(before),
    previousProjection, previousQuality: null, approvedBy: "operator", approvedAt: "2026-10-01T00:00:00.000Z" };
  const transition = { ...body, digest: sha256(body) };
  put(join(root, "projection.json"), before); put(join(root, "model-transition.json"), transition);
  const after = structuredClone(before); after.consumers.dailyNote.qmdBinding.manifestPath = "/after.json";
  return { workspace, root, before, after, transition, put,
    publish: () => put(join(root, "projection.json"), after),
    bytes: (name: string) => readFileSync(join(root, name), "utf8") };
}

test("a completed transition is archived before QMD/plugin refresh and the new projection is readable", () => {
  const f = fixture(); f.after.pluginDigest = sha256("refreshed-plugin");
  const historicalJob = { jobId: sha256("job"), evaluationPolicyDigest: sha256("old-policy"), partition: {}, bundle: { bundleId: sha256("bundle"), sourceRefs: [] } };
  f.put(join(f.root, "batch-live-store/memory-batch-live/v1/jobs/job.json"), historicalJob);
  const terminal = { schema: "engram.memory-batch-live-terminal.v2", jobId: historicalJob.jobId, bundleId: historicalJob.bundle.bundleId };
  f.put(join(f.root, "batch-live-store/memory-batch-live/v1/done/job.json"), { ...terminal, terminalId: sha256(terminal) });
  publishAfterModelTransitionDrain(f.workspace, f.before, f.after, f.publish);
  expect(readModelTransition(f.workspace, f.after)).toBeNull();
  expect(JSON.parse(f.bytes("projection.json"))).toEqual(f.after);
  expect(JSON.parse(f.bytes("model-transition-history/" + f.transition.digest.slice(7) + ".json"))).toEqual(f.transition);
  expect(JSON.parse(f.bytes("batch-live-store/memory-batch-live/v1/jobs/job.json"))).toEqual(historicalJob);
  expect(readdirSync(join(f.root, "model-transition-history"))).toHaveLength(2);
  publishAfterModelTransitionDrain(f.workspace, f.after, f.after, f.publish);
  expect(readdirSync(join(f.root, "model-transition-history"))).toHaveLength(2);
});

test("unfinished evaluator, batch, daily and unconsumed observation debt cannot be retired", () => {
  for (const [path, record] of [
    ["v1/queues/evaluator/source.json", { traceId: sha256("source"), status: "queued" }],
    ["batch-live-store/memory-batch-live/v1/jobs/job.json", { jobId: sha256("job"), bundle: { sourceRefs: [] } }],
    ["v1/consumers/daily-note/queue/entry.json", { observationId: sha256("observation"), status: "claimed" }],
    ["v1/observations/batch/entry.json", { observationId: sha256("observation") }],
  ] as const) {
    const f = fixture(), original = f.bytes("model-transition.json"); f.put(join(f.root, path), record);
    expect(() => publishAfterModelTransitionDrain(f.workspace, f.before, f.after, f.publish)).toThrow("MODEL_TRANSITION_DRAIN_REQUIRED");
    expect(f.bytes("model-transition.json")).toBe(original);
    expect(JSON.parse(f.bytes("projection.json"))).toEqual(f.before);
    expect(existsSync(join(f.root, "model-transition-history"))).toBe(false);
  }
});

test("domain apply and dirty receipts must finish and match before dropping old policy readability", () => {
  const f = fixture(), operationId = sha256("operation"), receiptId = sha256("receipt");
  f.put(join(f.root, "v1/receipts/by-operation/" + operationId.slice(7) + ".json"),
    { operationId, receiptId, scope: { runtimeSessionKey: f.before.bindings[0].runtimeSessionKey } });
  expect(() => assertModelTransitionRetirable(f.workspace, f.before)).toThrow("MODEL_TRANSITION_DOMAIN_DRAIN_REQUIRED");
  const applied = { schema: "engram.domain-apply-receipt.v1", operationId, sourceReceiptId: receiptId, canonicalApplied: true };
  const domain = join(f.workspace, "memory-state/domain-effects/v1");
  f.put(join(domain, "receipts/" + operationId.slice(7) + ".json"), applied);
  expect(() => assertModelTransitionRetirable(f.workspace, f.before)).toThrow("MODEL_TRANSITION_DOMAIN_DRAIN_REQUIRED");
  const dirty = { schema: "engram.domain-dirty-receipt.v1", operationId, canonicalApplied: true, qmdDirtyMarked: true,
    domainApplyReceiptDigest: sha256(applied) };
  f.put(join(domain, "dirty/" + operationId.slice(7) + ".json"), { ...dirty, domainApplyReceiptDigest: sha256("wrong") });
  expect(() => assertModelTransitionRetirable(f.workspace, f.before)).toThrow("MODEL_TRANSITION_DOMAIN_RECEIPT_INVALID");
  f.put(join(domain, "dirty/" + operationId.slice(7) + ".json"), dirty);
  publishAfterModelTransitionDrain(f.workspace, f.before, f.after, f.publish);
  expect(readModelTransition(f.workspace, f.after)).toBeNull();
});

test("a publish failure after archival is safe and a retry finishes without losing history", () => {
  const f = fixture();
  expect(() => publishAfterModelTransitionDrain(f.workspace, f.before, f.after, () => { throw Error("crash before projection write"); })).toThrow("crash");
  expect(JSON.parse(f.bytes("projection.json"))).toEqual(f.before);
  expect(readModelTransition(f.workspace, f.before)).toBeNull();
  publishAfterModelTransitionDrain(f.workspace, f.before, f.after, f.publish);
  expect(JSON.parse(f.bytes("projection.json"))).toEqual(f.after);
  expect(JSON.parse(f.bytes("model-transition-history/" + f.transition.digest.slice(7) + ".json"))).toEqual(f.transition);
});

test("stale identities and changed projections remain fail-closed, even with no pending jobs", () => {
  const f = fixture();
  f.put(join(f.root, "model-transition.json"), { ...f.transition, targetProjectionDigest: sha256("different") });
  expect(() => publishAfterModelTransitionDrain(f.workspace, f.before, f.after, f.publish)).toThrow("MODEL_TRANSITION_IDENTITY_CHANGED");
  expect(JSON.parse(f.bytes("projection.json"))).toEqual(f.before);
  f.put(join(f.root, "projection.json"), f.after);
  expect(() => publishAfterModelTransitionDrain(f.workspace, f.before, f.after, f.publish)).toThrow("MODEL_TRANSITION_PROJECTION_CHANGED");
});

test("an unverified done marker cannot turn an unfinished job into a completed transition", () => {
  const f = fixture(), jobId = sha256("job");
  f.put(join(f.root, "batch-live-store/memory-batch-live/v1/jobs/job.json"), { jobId, bundle: { bundleId: sha256("bundle"), sourceRefs: [] } });
  f.put(join(f.root, "batch-live-store/memory-batch-live/v1/done/job.json"), { jobId });
  expect(() => publishAfterModelTransitionDrain(f.workspace, f.before, f.after, f.publish)).toThrow("MODEL_TRANSITION_ACCOUNTING_INVALID");
  expect(JSON.parse(f.bytes("model-transition.json"))).toEqual(f.transition);
});

test("blocker diagnostics keep machine codes without exposing arbitrary exception text", () => {
  expect(modelTransitionBlockReason(Error("MODEL_TRANSITION_IDENTITY_CHANGED"))).toBe("MODEL_TRANSITION_IDENTITY_CHANGED");
  expect(modelTransitionBlockReason(Error("secret /private/path"))).toBe("MODEL_TRANSITION_VALIDATION_FAILED");
  expect(modelTransitionBlockReason(Error("MODEL_TRANSITION_PRIVATE_TOKEN"))).toBe("MODEL_TRANSITION_VALIDATION_FAILED");
  expect(modelTransitionBlockReason(null)).toBe("MODEL_TRANSITION_VALIDATION_FAILED");
});
