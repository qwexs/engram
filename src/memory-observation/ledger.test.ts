import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  MemoryObservationLedger,
  ObservationLedgerError,
  purgeMemoryObservationLifecycle,
  deriveSourceDigest,
  deriveTraceEventId,
  deriveTraceId,
  sanitizeEvidence,
  sha256,
  type LedgerFaultPoint,
  type TrustedCompletedTurn,
} from "./ledger.ts";

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

const registry = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "contracts", "memory-observation", "v1", "producer-registry.json"), "utf8"));
const policy = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "contracts", "memory-observation", "v1", "authority-policy.json"), "utf8"));
const authority = registry.producers.find((entry: any) => entry.id === "openclaw-runtime");
const sessionKey = "agent:fixture-main:telegram:direct:100000001";
const completedAt = "2026-08-24T18:00:00.000Z";

function workspace(): string {
  const path = join(tmpdir(), `engram-observation-ledger-${crypto.randomUUID()}`);
  roots.push(path);
  return path;
}

function source(seed = "a", overrides: Partial<TrustedCompletedTurn> = {}): TrustedCompletedTurn {
  const sourceTurnId = `channel-user:v1:${seed.repeat(64)}`;
  return {
    sourceTurnId,
    scope: { workspaceId: "fixture-main", runtimeSessionKey: sessionKey, scopeClass: "self", scopeId: "telegram:100000001" },
    sourceCompletedAt: completedAt,
    authority: { id: authority.id, version: authority.version, digest: authority.digest },
    evidenceRefs: [{ kind: "source-turn", ref: sourceTurnId, digest: sha256(`evidence-${seed}`) }],
    redactedEvidence: { user: `turn-${seed}`, assistant: "acknowledged" },
    trustedInputs: ["completed-source-turn", "runtime-session-key", "workspace-binding", "source-completion-time"],
    ...overrides,
  };
}

function ledger(root: string, options: { fault?: (point: LedgerFaultPoint) => void; evaluatorEnabled?: boolean; maxJobs?: number; maxBytes?: number; maxQueueAgeMs?: number; maxAttempts?: number } = {}) {
  return new MemoryObservationLedger({
    workspace: root,
    workspaceId: "fixture-main",
    exactSessionKeys: [sessionKey],
    producerRegistry: registry,
    authorityPolicy: policy,
    evaluatorEnabled: options.evaluatorEnabled,
    ...(options.evaluatorEnabled ? { evaluationStartedAt: "2026-08-24T17:59:00.000Z" } : {}),
    fault: options.fault,
    limits: {
      evidenceTtlMs: 72 * 60 * 60 * 1_000,
      maxJobs: options.maxJobs ?? 100,
      maxBytes: options.maxBytes ?? 1_000_000,
      maxQueueAgeMs: options.maxQueueAgeMs ?? 7 * 24 * 60 * 60 * 1_000,
      maxAttempts: options.maxAttempts ?? 3,
      claimTtlMs: 30_000,
      maxInferenceCalls: options.evaluatorEnabled ? 1 : 0,
    },
  });
}

describe("Memory Observation Layer PR1 identities and admission", () => {
  test("matches the PR0 derivation control vectors", () => {
    const traceId = deriveTraceId("fixture-main", sessionKey, `channel-user:v1:${"a".repeat(64)}`);
    const sourceDigest = deriveSourceDigest(`channel-user:v1:${"a".repeat(64)}`, source().scope, completedAt);
    expect(traceId).toBe("sha256:865a666a87e0d471544f290fed6ce3726d6d65028eddc063e1b1aea39e7114da");
    expect(sourceDigest).toBe("sha256:d739bbc840b67c3e6bd44cb39e336b4826bba8d15140353f9c9408344713cc6d");
    expect(deriveTraceEventId(traceId, "source_completed", sourceDigest)).toBe("sha256:9850b3d56e41aff996302b7ce95ddbd0f36051190135f92b413e646c57139023");
  });

  test("durably admits one trusted source and leaves semantic trace completion to the evaluator", () => {
    const root = workspace();
    const store = ledger(root);
    const result = store.admit(source(), new Date("2026-08-24T18:00:00.100Z"));
    expect(result.status).toBe("admitted");
    expect(store.readEnvelope(result.envelope.traceId)).toEqual(result.envelope);
    expect(store.listQueue()).toHaveLength(1);
    expect(store.readTrace(result.envelope.traceId).map((event) => event.stage)).toEqual(["source_completed"]);
    expect(store.claimNextDue("no-worker", new Date("2026-08-24T18:01:00.000Z"))).toBeNull();

    const stateRoot = join(root, "memory-state", "memory-observation", "v1");
    expect(readdirSync(stateRoot).sort()).toEqual(["envelopes", "evidence", "locks", "queues", "traces"]);
    expect(existsSync(join(stateRoot, "observations"))).toBe(false);
    expect(existsSync(join(stateRoot, "receipts"))).toBe(false);
    expect(existsSync(join(stateRoot, "consumers"))).toBe(false);
  });

  test("fails closed on wrong scope, missing trusted input, unknown policy and unregistered producer", () => {
    const root = workspace();
    const store = ledger(root);
    expect(() => store.admit(source("a", { scope: { ...source().scope, workspaceId: "other" } }))).toThrow("outside the exact workspace/session partition");
    expect(() => store.admit(source("a", { trustedInputs: ["completed-source-turn"] }))).toThrow("required trusted input");
    expect(() => store.admit(source("a", { authority: { ...source().authority, version: "v2" } }))).toThrow("not authorized");
    expect(() => new MemoryObservationLedger({
      workspace: root,
      workspaceId: "fixture-main",
      exactSessionKeys: [sessionKey],
      producerRegistry: registry,
      authorityPolicy: { ...policy, policyVersion: "v2" },
      limits: { evidenceTtlMs: 1, maxJobs: 1, maxBytes: 1, maxQueueAgeMs: 1, maxAttempts: 1, claimTtlMs: 1, maxInferenceCalls: 0 },
    })).toThrow("authority policy is not supported");
  });

  test("redacts deterministic secret forms and denies raw tools, media and attachments", () => {
    expect(sanitizeEvidence({ authorization: "Bearer exposed", text: "Bearer abc.def and sk-1234567890abcdef" })).toEqual({
      authorization: "[REDACTED]",
      text: "Bearer [REDACTED] and [REDACTED]",
    });
    const secretCorpus = sanitizeEvidence({
      text: [
        "jwt=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature123456",
        `telegram ${"123456789"}:${"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi123456"}`,
        "github ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890",
        "aws AKIAABCDEFGHIJKLMNOP",
        "password=hunter2",
        "postgres://user:supersecret@db.internal/app",
        "-----BEGIN PRIVATE KEY-----\nabc123\n-----END PRIVATE KEY-----",
      ].join("\n"),
    }) as { text: string };
    for (const leaked of ["signature123456", "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi123456", "ghp_", "AKIAABCDEFGHIJKLMNOP", "hunter2", "supersecret", "abc123"]) {
      expect(secretCorpus.text).not.toContain(leaked);
    }
    const store = ledger(workspace());
    expect(() => store.admit(source("a", { redactedEvidence: { attachments: [] } }))).toThrow("raw evidence field is denied");
    expect(() => store.admit(source("a", { redactedEvidence: { rawToolOutcome: { result: "private" } } }))).toThrow("raw evidence field is denied");
  });

  test("is idempotent but rejects the same source identity with changed content", () => {
    const root = workspace();
    const store = ledger(root);
    const first = store.admit(source(), new Date("2026-08-24T18:00:00.100Z"));
    const replay = store.admit(source(), new Date("2026-08-24T19:00:00.100Z"));
    expect(replay.status).toBe("duplicate");
    expect(replay.envelope).toEqual(first.envelope);
    expect(() => store.admit(source("a", { redactedEvidence: { user: "changed" } }))).toThrow("different content");
  });
});

describe("Memory Observation Layer PR1 recovery and queue reliability", () => {
  for (const point of ["after_evidence", "after_envelope", "after_queue", "after_source_trace"] as const) {
    test(`reconciles a crash at ${point}`, () => {
      const root = workspace();
      let armed = true;
      const crashing = ledger(root, { fault: (current) => { if (armed && current === point) throw new Error(`crash:${point}`); } });
      expect(() => crashing.admit(source(), new Date("2026-08-24T18:00:00.100Z"))).toThrow(`crash:${point}`);
      armed = false;
      const recovered = ledger(root);
      expect(recovered.reconcile([source()], new Date("2026-08-24T19:00:00.100Z"))).toEqual(point === "after_evidence" ? { admitted: 1, duplicate: 0 } : { admitted: 0, duplicate: 1 });
      const traceId = deriveTraceId("fixture-main", sessionKey, source().sourceTurnId);
      expect(recovered.readEnvelope(traceId)).not.toBeNull();
      expect(recovered.listQueue()).toHaveLength(1);
      expect(recovered.readTrace(traceId)).toHaveLength(1);
    });
  }

  test("uses a single lease, bounded retry, nextAttemptAt and skips a delayed head item", () => {
    const root = workspace();
    const store = ledger(root, { evaluatorEnabled: true, maxAttempts: 2 });
    store.admit(source("a"), new Date("2026-08-24T18:00:00.100Z"));
    store.admit(source("b"), new Date("2026-08-24T18:00:00.200Z"));
    expect(store.acquireWorkerLease("evaluator", "worker-a", 60_000, new Date("2026-08-24T18:00:01.000Z"))).toBe(true);
    expect(store.acquireWorkerLease("evaluator", "worker-b", 60_000, new Date("2026-08-24T18:00:01.000Z"))).toBe(false);

    const first = store.claimNextDue("worker-a", new Date("2026-08-24T18:00:01.000Z"))!;
    const delayed = store.retry(first, 60_000, "transient", new Date("2026-08-24T18:00:02.000Z"));
    expect(delayed.nextAttemptAt).toBe("2026-08-24T18:01:02.000Z");
    const second = store.claimNextDue("worker-a", new Date("2026-08-24T18:00:03.000Z"))!;
    expect(second.traceId).not.toBe(first.traceId);
    store.retry(second, 1, "transient", new Date("2026-08-24T18:00:04.000Z"));
    const secondAgain = store.claimNextDue("worker-a", new Date("2026-08-24T18:00:05.000Z"))!;
    expect(store.retry(secondAgain, 1, "exhausted", new Date("2026-08-24T18:00:06.000Z")).status).toBe("terminal");
    store.releaseWorkerLease("evaluator", "worker-a");
  });

  test("terminalizes pre-activation jobs without inference and exposes the next eligible due time", () => {
    const root = workspace();
    const store = new MemoryObservationLedger({
      workspace: root,
      workspaceId: "fixture-main",
      exactSessionKeys: [sessionKey],
      producerRegistry: registry,
      authorityPolicy: policy,
      evaluatorEnabled: true,
      evaluationStartedAt: "2026-08-24T18:00:01.000Z",
      limits: {
        evidenceTtlMs: 72 * 60 * 60 * 1_000,
        maxJobs: 100,
        maxBytes: 1_000_000,
        maxQueueAgeMs: 7 * 24 * 60 * 60 * 1_000,
        maxAttempts: 2,
        claimTtlMs: 30_000,
        maxInferenceCalls: 1,
      },
    });
    store.admit(source("a"), new Date("2026-08-24T18:00:00.100Z"));
    store.admit(source("b"), new Date("2026-08-24T18:00:02.000Z"));
    expect(store.nextEvaluationAt()?.toISOString()).toBe("2026-08-24T18:00:02.000Z");
    expect(store.acquireWorkerLease("evaluator", "worker", 60_000, new Date("2026-08-24T18:00:03.000Z"))).toBe(true);
    expect(store.claimNextDue("worker", new Date("2026-08-24T18:00:03.000Z"))?.traceId)
      .toBe(deriveTraceId("fixture-main", sessionKey, source("b").sourceTurnId));
    expect(store.listQueue().find((record) => record.traceId === deriveTraceId("fixture-main", sessionKey, source("a").sourceTurnId)))
      .toMatchObject({ status: "terminal", attempt: 0, reasonCode: "pre_activation_not_evaluated" });
    store.releaseWorkerLease("evaluator", "worker");
  });

  test("recovers a stale claim after worker crash without losing the admitted source", () => {
    const root = workspace();
    const store = ledger(root, { evaluatorEnabled: true, maxAttempts: 2 });
    store.admit(source(), new Date("2026-08-24T18:00:00.100Z"));
    expect(store.acquireWorkerLease("evaluator", "worker-a", 1_000, new Date("2026-08-24T18:00:01.000Z"))).toBe(true);
    const abandoned = store.claimNextDue("worker-a", new Date("2026-08-24T18:00:01.100Z"))!;
    expect(abandoned.status).toBe("claimed");
    expect(store.acquireWorkerLease("evaluator", "worker-b", 60_000, new Date("2026-08-24T18:01:00.000Z"))).toBe(true);
    const recovered = store.claimNextDue("worker-b", new Date("2026-08-24T18:01:00.000Z"))!;
    expect(recovered.traceId).toBe(abandoned.traceId);
    expect(recovered.attempt).toBe(2);
    expect(store.retry(recovered, 1, "worker_crashed", new Date("2026-08-24T18:01:01.000Z")).status).toBe("terminal");
  });

  test("enforces jobs, bytes, age, evidence TTL and the evaluator inference gate", () => {
    const jobsRoot = workspace();
    const jobs = ledger(jobsRoot, { maxJobs: 1 });
    jobs.admit(source("a"), new Date("2026-08-24T18:00:00.100Z"));
    expect(() => jobs.admit(source("b"), new Date("2026-08-24T18:00:01.100Z"))).toThrow("job high-water");

    const bytesRoot = workspace();
    expect(() => ledger(bytesRoot, { maxBytes: 100 }).admit(source())).toThrow("byte high-water");

    const ageRoot = workspace();
    const age = ledger(ageRoot, { maxQueueAgeMs: 1_000 });
    age.admit(source("a"), new Date("2026-08-24T18:00:00.100Z"));
    expect(() => age.admit(source("b"), new Date("2026-08-24T18:00:02.100Z"))).toThrow("queue age high-water");

    expect(() => new MemoryObservationLedger({
      workspace: workspace(), workspaceId: "fixture-main", exactSessionKeys: [sessionKey], producerRegistry: registry, authorityPolicy: policy,
      limits: { evidenceTtlMs: 72 * 60 * 60 * 1_000 + 1, maxJobs: 1, maxBytes: 1, maxQueueAgeMs: 1, maxAttempts: 1, claimTtlMs: 1, maxInferenceCalls: 0 },
    })).toThrow("limits or evaluator inference gate are invalid");
  });

  test("purges evidence independently without touching envelope, queue, trace or canonical paths", () => {
    const root = workspace();
    mkdirSync(join(root, "memory"), { recursive: true });
    mkdirSync(join(root, "life"), { recursive: true });
    writeFileSync(join(root, "memory", "sentinel"), "memory\n");
    writeFileSync(join(root, "life", "sentinel"), "life\n");
    const store = ledger(root);
    const admitted = store.admit(source(), new Date("2026-08-24T18:00:00.100Z"));
    expect(store.purgeExpiredEvidence(new Date("2026-08-27T18:00:00.101Z"))).toBe(1);
    expect(store.readEnvelope(admitted.envelope.traceId)).not.toBeNull();
    expect(store.listQueue()).toHaveLength(1);
    expect(store.readTrace(admitted.envelope.traceId)).toHaveLength(1);
    expect(readFileSync(join(root, "memory", "sentinel"), "utf8")).toBe("memory\n");
    expect(readFileSync(join(root, "life", "sentinel"), "utf8")).toBe("life\n");
  });

  test("autonomously enforces 72h evidence, 30d sidecar, and 180d trace/receipt retention", () => {
    const root = workspace();
    mkdirSync(join(root, "memory"), { recursive: true });
    mkdirSync(join(root, "life"), { recursive: true });
    writeFileSync(join(root, "memory", "sentinel"), "memory\n");
    writeFileSync(join(root, "life", "sentinel"), "life\n");
    const store = ledger(root);
    const admitted = store.admit(source(), new Date("2026-01-01T00:00:00.000Z"));
    const key = admitted.envelope.traceId.slice(7);
    const state = join(root, "memory-state", "memory-observation", "v1");
    const queuePath = join(state, "queues", "evaluator", `${key}.json`);
    const queue = JSON.parse(readFileSync(queuePath, "utf8"));
    writeFileSync(queuePath, JSON.stringify({ ...queue, status: "terminal", terminalAt: "2026-01-01T01:00:00.000Z", reasonCode: "semantic_write" }));
    const observationId = sha256("retention-observation");
    mkdirSync(join(state, "observations", "typed"), { recursive: true });
    writeFileSync(join(state, "observations", "typed", `${key}.json`), JSON.stringify({ observationId }));
    const observationKey = observationId.slice(7);
    const consumerPath = join(state, "consumers", "daily-note", "queue", `${observationKey}.json`);
    mkdirSync(join(state, "consumers", "daily-note", "queue"), { recursive: true });
    writeFileSync(consumerPath, JSON.stringify({ schema: "engram.memory-observation-consumer-queue.v1", observationId, status: "terminal", terminalAt: "2026-01-01T01:00:00.000Z" }));
    const linkPath = join(state, "transport-links", `${sha256("link").slice(7)}.json`);
    mkdirSync(join(state, "transport-links"), { recursive: true });
    writeFileSync(linkPath, JSON.stringify({ createdAt: "2026-01-01T00:00:00.000Z", expiresAt: "2026-01-04T00:00:00.000Z" }));
    for (const kind of ["by-operation", "by-entry"]) {
      const directory = join(state, "receipts", kind);
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, `${sha256(kind).slice(7)}.json`), JSON.stringify({ completedAt: "2026-01-01T01:00:00.000Z" }));
    }
    const first = purgeMemoryObservationLifecycle(root, new Date("2026-02-01T01:00:00.001Z"));
    expect(first).toMatchObject({ evidence: 1, transportLinks: 1, envelopes: 1, observations: 1, evaluatorQueue: 1, consumerQueue: 1, traces: 0, receipts: 0 });
    expect(readdirSync(join(state, "traces", key))).toHaveLength(1);
    expect(purgeMemoryObservationLifecycle(root, new Date("2026-07-01T01:00:00.001Z"))).toMatchObject({ traces: 1, receipts: 2 });
    expect(readFileSync(join(root, "memory", "sentinel"), "utf8")).toBe("memory\n");
    expect(readFileSync(join(root, "life", "sentinel"), "utf8")).toBe("life\n");
  });

  test("has no downstream writer import or runtime/plugin registration", () => {
    const implementation = readFileSync(join(import.meta.dir, "ledger.ts"), "utf8");
    for (const forbidden of ["kg-v3/live-ingress", "daily-note-append", "oll-rule-materializer", "qmd-indexer", "openclaw.plugin.json"]) {
      expect(implementation).not.toContain(forbidden);
    }
    expect(implementation).not.toContain("memory-state/post-turn-observer");
  });
});


test("v2 retention never purges an unconsumed result or its source accounting",()=>{
 const root=workspace();const store=ledger(root);
 const admitted=store.admit(source(),new Date("2026-01-01T00:00:00.000Z"));
 const state=join(root,"memory-state/memory-observation/v1"),key=admitted.envelope.traceId.slice(7);
 const qpath=join(state,"queues/evaluator",key+".json"),q=JSON.parse(readFileSync(qpath,"utf8"));
 writeFileSync(qpath,JSON.stringify({...q,status:"terminal",terminalAt:"2026-01-01T01:00:00.000Z"}));
 const observationId=sha256("unconsumed-context");const path=join(state,"observations/batch",observationId.slice(7)+".json");
 mkdirSync(join(state,"observations/batch"),{recursive:true});
 writeFileSync(path,JSON.stringify({schema:"engram.memory-batch-observation.v2",observationId,sourceRefs:[{traceId:admitted.envelope.traceId}]}));
 purgeMemoryObservationLifecycle(root,new Date("2026-02-10T00:00:00.000Z"));
 expect(existsSync(path)).toBe(true);expect(existsSync(qpath)).toBe(true);
});
