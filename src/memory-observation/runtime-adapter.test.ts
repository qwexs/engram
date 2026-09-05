import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryObservationLedger, purgeMemoryObservationLifecycle, sha256, type TrustedCompletedTurn } from "./ledger.ts";
import {
  OpenClawObservationRuntimeAdapter,
  observationRuntimeAdapterError,
  type RuntimeAdapterFaultPoint,
  type RuntimeObservationBinding,
} from "./runtime-adapter.ts";

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

const repo = join(import.meta.dir, "..", "..");
const registry = JSON.parse(readFileSync(join(repo, "contracts", "memory-observation", "v1", "producer-registry.json"), "utf8"));
const policy = JSON.parse(readFileSync(join(repo, "contracts", "memory-observation", "v1", "authority-policy.json"), "utf8"));
const authority = registry.producers.find((entry: any) => entry.id === "openclaw-runtime");
const sessionKey = "agent:fixture-main:telegram:direct:100000001";
const sourceTurnId = `channel-user:v1:${"a".repeat(64)}`;

function workspace(): string {
  const path = join(tmpdir(), `engram-observation-runtime-${crypto.randomUUID()}`);
  roots.push(path);
  return path;
}

function ledger(root: string): MemoryObservationLedger {
  return new MemoryObservationLedger({
    workspace: root,
    workspaceId: "fixture-main",
    exactSessionKeys: [sessionKey],
    producerRegistry: registry,
    authorityPolicy: policy,
    limits: {
      evidenceTtlMs: 72 * 60 * 60 * 1_000,
      maxJobs: 100,
      maxBytes: 1_000_000,
      maxQueueAgeMs: 7 * 24 * 60 * 60 * 1_000,
      maxAttempts: 3,
      claimTtlMs: 30_000,
      maxInferenceCalls: 0,
    },
  });
}

function hookFixtures() {
  return {
    receivedEvent: { messageId: "42", senderId: "100000001", timestamp: 1_787_599_200, content: "operator content" },
    receivedContext: { sessionKey, messageId: "42", senderId: "100000001", channelId: "telegram" },
    persistedEvent: {
      sessionKey,
      message: {
        role: "user",
        idempotencyKey: sourceTurnId,
        content: [{ type: "text", text: "Принято: запускаем PR2 runtime adapter" }],
        __openclaw: { senderIsOwner: true, transport: { channel: "telegram", messageId: "42" } },
      },
    },
    runContext: { runId: "run-1", sessionKey, trigger: "user" },
    endEvent: {
      runId: "run-1",
      success: true,
      messages: [
        { role: "user", idempotencyKey: sourceTurnId, content: "Принято: запускаем PR2 runtime adapter" },
        { role: "tool", content: "raw private tool result" },
        { role: "assistant", content: [{ type: "text", text: "PR2 runtime adapter реализован" }, { type: "image", url: "private" }] },
      ],
    },
  };
}

function adapter(options: {
  binding?: RuntimeObservationBinding | null;
  now?: () => Date;
  admitted?: TrustedCompletedTurn[];
  spoolRoot?: string;
  fault?: (point: RuntimeAdapterFaultPoint) => void;
} = {}) {
  const admitted = options.admitted ?? [];
  const binding = options.binding === undefined ? {
    workspaceId: "fixture-main",
    scopeClass: "self" as const,
    scopeId: "telegram:100000001",
    requireOwner: true,
    allowedChannels: ["telegram"] as const,
    admit: (source: TrustedCompletedTurn) => { admitted.push(source); return { status: "admitted" }; },
  } : options.binding;
  return new OpenClawObservationRuntimeAdapter({
    authority: { id: authority.id, version: authority.version, digest: authority.digest },
    resolveBinding: (key) => key === sessionKey ? binding : null,
    now: options.now ?? (() => new Date("2026-08-24T19:35:00.000Z")),
    ...(options.spoolRoot ? { spoolRoot: options.spoolRoot } : {}),
    ...(options.fault ? { fault: options.fault } : {}),
  });
}

function complete(adapterValue: OpenClawObservationRuntimeAdapter) {
  const fixture = hookFixtures();
  adapterValue.captureMessageReceived(fixture.receivedEvent, fixture.receivedContext);
  adapterValue.adoptPersistedUser(fixture.persistedEvent, { sessionKey });
  adapterValue.attachRun({}, fixture.runContext);
  return adapterValue.completeAgentEnd(fixture.endEvent, fixture.runContext);
}

function attach(adapterValue: OpenClawObservationRuntimeAdapter) {
  const fixture = hookFixtures();
  adapterValue.captureMessageReceived(fixture.receivedEvent, fixture.receivedContext);
  adapterValue.adoptPersistedUser(fixture.persistedEvent, { sessionKey });
  adapterValue.attachRun({}, fixture.runContext);
  return fixture;
}

describe("OpenClaw PR2 runtime adapter", () => {
  test("recovers a completed source across crashes on both sides of ledger admission", () => {
    for (const faultPoint of ["after_completed_spool", "after_admission"] as const) {
      const root = workspace();
      const store = ledger(root);
      const spoolRoot = join(root, "memory-state", "memory-observation", "v1", "pre-admission");
      const binding: RuntimeObservationBinding = {
        workspaceId: "fixture-main",
        scopeClass: "self",
        scopeId: "telegram:100000001",
        requireOwner: true,
        allowedChannels: ["telegram"],
        admit: (source, now) => store.admit(source, now),
      };
      let injected = false;
      const crashing = adapter({
        binding,
        spoolRoot,
        fault: (point) => {
          if (!injected && point === faultPoint) { injected = true; throw new Error(`fault:${faultPoint}`); }
        },
      });
      expect(() => complete(crashing)).toThrow(`fault:${faultPoint}`);
      expect(crashing.listSpool()).toContainEqual(expect.objectContaining({ status: "completed", sourceTurnId }));

      const recovered = adapter({ binding, spoolRoot });
      expect(recovered.reconcileCompleted()).toEqual({ admitted: 1, retained: 0, terminal: 0 });
      expect(store.listQueue()).toHaveLength(1);
      expect(recovered.listSpool()).toContainEqual(expect.objectContaining({
        status: "admitted",
        sourceTurnId,
        reasonCode: "ledger_admitted_after_recovery",
      }));
      expect(recovered.reconcileCompleted()).toEqual({ admitted: 0, retained: 0, terminal: 0 });
    }
  });

  test("rejects the same durable source identity with different completed content", () => {
    const root = workspace();
    const spoolRoot = join(root, "pre-admission");
    const first = adapter({ spoolRoot, fault: (point) => {
      if (point === "after_completed_spool") throw new Error("fault:after_completed_spool");
    } });
    expect(() => complete(first)).toThrow("fault:after_completed_spool");

    const conflicting = adapter({ spoolRoot });
    const fixture = attach(conflicting);
    expect(() => conflicting.completeAgentEnd({
      ...fixture.endEvent,
      messages: fixture.endEvent.messages.map((message) => message.role === "assistant"
        ? { ...message, content: "Different terminal content" }
        : message),
    }, fixture.runContext)).toThrow("different durable admission content");
    expect(conflicting.listSpool()).toContainEqual(expect.objectContaining({ status: "completed", sourceTurnId }));
  });

  test("retains incomplete recovery work and purges only old terminal spool records", () => {
    const root = workspace();
    const spoolRoot = join(root, "memory-state", "memory-observation", "v1", "pre-admission");
    const completed = adapter({ spoolRoot });
    expect(complete(completed).status).toBe("admitted");
    expect(completed.listSpool()).toHaveLength(1);
    expect(purgeMemoryObservationLifecycle(root, new Date("2026-09-24T19:35:00.001Z"))).toMatchObject({ preAdmission: 1 });
    expect(completed.listSpool()).toHaveLength(0);
  });

  test("converts only the trusted four-hook chain into one neutral completed turn", () => {
    const admitted: TrustedCompletedTurn[] = [];
    const runtime = adapter({ admitted });
    expect(complete(runtime)).toEqual({ status: "admitted", sourceTurnId, result: { status: "admitted" } });
    expect(admitted).toHaveLength(1);
    expect(admitted[0]!.scope).toEqual({
      workspaceId: "fixture-main",
      runtimeSessionKey: sessionKey,
      scopeClass: "self",
      scopeId: "telegram:100000001",
    });
    expect(admitted[0]!.redactedEvidence).toEqual({
      source: { role: "user", text: "Принято: запускаем PR2 runtime adapter" },
      outcome: { role: "assistant", text: "PR2 runtime adapter реализован" },
    });
    expect(admitted[0]!.trustedInputs).toEqual(["completed-source-turn", "runtime-session-key", "workspace-binding", "source-completion-time"]);
    expect(runtime.stateCounts()).toEqual({ pending: 0, adopted: 0, runs: 0 });
  });

  test("integrates with PR1 ledger and creates no observation, receipt, consumer or canonical mutation", () => {
    const root = workspace();
    const store = ledger(root);
    const binding: RuntimeObservationBinding = {
      workspaceId: "fixture-main",
      scopeClass: "self",
      scopeId: "telegram:100000001",
      requireOwner: true,
      allowedChannels: ["telegram"],
      admit: (source, now) => store.admit(source, now),
    };
    expect(complete(adapter({ binding })).status).toBe("admitted");
    const stateRoot = join(root, "memory-state", "memory-observation", "v1");
    expect(store.listQueue()).toHaveLength(1);
    for (const absent of ["observations", "receipts", "consumers"]) {
      expect(() => readFileSync(join(stateRoot, absent), "utf8")).toThrow();
    }
    expect(() => readFileSync(join(root, "memory", "agent-main", "main", "2026-08-24.md"), "utf8")).toThrow();
    expect(() => readFileSync(join(root, "life", "v3", "current-summary.md"), "utf8")).toThrow();
  });

  test("admits a terminal message-tool reply only after provider-settled message_sent", () => {
    const admitted: TrustedCompletedTurn[] = [];
    const runtime = adapter({ admitted });
    const fixture = attach(runtime);
    expect(runtime.completeMessageSent({
      success: true,
      content: "Delivered terminal reply",
      sessionKey,
      runId: fixture.runContext.runId,
      sourceReply: { sourceTurnId, toolCallId: "call-1", final: true },
    }, fixture.runContext)).toEqual({
      status: "admitted",
      sourceTurnId,
      result: { status: "admitted" },
    });
    expect(admitted[0]!.redactedEvidence.outcome).toEqual({
      role: "assistant",
      text: "Delivered terminal reply",
    });
    expect(runtime.completeAgentEnd(fixture.endEvent, fixture.runContext)).toEqual({
      status: "ignored",
      reason: "unbound_run",
    });
  });

  test("adds up to five resolved reply pairs and records the delivered parent link", () => {
    const admitted: TrustedCompletedTurn[] = [];
    const deliveries: unknown[] = [];
    const resolverCalls: unknown[] = [];
    const parentEvidenceDigest = `sha256:${"b".repeat(64)}` as const;
    const binding: RuntimeObservationBinding = {
      workspaceId: "fixture-main",
      scopeClass: "self",
      scopeId: "telegram:100000001",
      requireOwner: true,
      allowedChannels: ["telegram"],
      resolveReplyContext: (params) => {
        resolverCalls.push(params);
        return {
          status: "complete",
          requestedReplyToId: "parent-message",
          maxPairs: 5,
          reasonCode: null,
          pairs: [{
            traceId: `sha256:${"c".repeat(64)}`,
            sourceTurnId: `channel-user:v1:${"d".repeat(64)}`,
            transportMessageId: "parent-message",
            evidenceDigest: parentEvidenceDigest,
            source: { role: "user", text: "Кто такой сборщик?" },
            outcome: { role: "assistant", text: "Это программный плагин." },
          }],
        };
      },
      admit: (source, _now, transport) => {
        admitted.push(source);
        deliveries.push(transport);
        return { status: "admitted" };
      },
    };
    const runtime = adapter({ binding });
    const fixture = hookFixtures();
    runtime.captureMessageReceived(
      { ...fixture.receivedEvent, replyToId: "parent-message" },
      { ...fixture.receivedContext, replyToId: "parent-message" },
    );
    runtime.adoptPersistedUser({
      ...fixture.persistedEvent,
      message: {
        ...fixture.persistedEvent.message,
        __openclaw: {
          senderIsOwner: true,
          transport: { channel: "telegram", messageId: "42", replyToId: "parent-message" },
        },
      },
    }, { sessionKey });
    runtime.attachRun({}, fixture.runContext);
    expect(runtime.completeMessageSent({
      success: true,
      messageId: "outbound-43",
      content: "Расширяю цепочку reply_to.",
      sessionKey,
      runId: fixture.runContext.runId,
      sourceReply: { sourceTurnId, toolCallId: "call-1", final: true },
    }, fixture.runContext).status).toBe("admitted");
    expect(resolverCalls).toHaveLength(1);
    expect(resolverCalls[0]).toMatchObject({ replyToId: "parent-message", maxPairs: 5 });
    expect(admitted[0]!.redactedEvidence).toMatchObject({
      replyContext: {
        status: "complete",
        maxPairs: 5,
        pairs: [{ transportMessageId: "parent-message" }],
      },
    });
    expect(admitted[0]!.evidenceRefs).toHaveLength(2);
    expect(admitted[0]!.evidenceRefs[1]).toEqual({
      kind: "message",
      ref: `${sessionKey}#parent-message`,
      digest: parentEvidenceDigest,
    });
    expect(deliveries).toEqual([{
      channel: "telegram",
      inboundMessageId: "42",
      parentMessageId: "parent-message",
      deliveryMessageId: "outbound-43",
    }]);
  });

  test("attaches post-agent_end delivery ids for ordinary assistant replies", () => {
    const recorded: unknown[] = [];
    const binding: RuntimeObservationBinding = {
      workspaceId: "fixture-main",
      scopeClass: "self",
      scopeId: "telegram:100000001",
      requireOwner: true,
      allowedChannels: ["telegram"],
      admit: () => ({ status: "admitted" }),
      recordTransportLink: (params) => recorded.push(params),
    };
    const runtime = adapter({ binding });
    const result = complete(runtime);
    expect(result.status).toBe("admitted");
    expect(runtime.recordMessageSent({
      success: true,
      messageId: "ordinary-outbound-1",
      sessionKey,
      runId: "run-1",
    }, { sessionKey, runId: "run-1" })).toEqual({
      status: "attached",
      sourceTurnId,
    });
    expect(recorded).toEqual([{
      scope: {
        workspaceId: "fixture-main",
        runtimeSessionKey: sessionKey,
        scopeClass: "self",
        scopeId: "telegram:100000001",
      },
      channel: "telegram",
      messageId: "ordinary-outbound-1",
      messageRole: "assistant",
      sourceTurnId,
    }]);
  });

  test("keeps progress replies bound and consumes failed terminal deliveries", () => {
    const progress = adapter();
    const progressFixture = attach(progress);
    expect(progress.completeMessageSent({
      success: true,
      content: "Progress",
      sessionKey,
      runId: progressFixture.runContext.runId,
      sourceReply: { sourceTurnId, toolCallId: "call-progress", final: false },
    }, progressFixture.runContext)).toEqual({
      status: "ignored",
      reason: "non_terminal_source_reply",
    });
    expect(progress.stateCounts().runs).toBe(1);

    const failed = adapter();
    const failedFixture = attach(failed);
    expect(failed.completeMessageSent({
      success: false,
      content: "Not delivered",
      sessionKey,
      runId: failedFixture.runContext.runId,
      sourceReply: { sourceTurnId, toolCallId: "call-failed", final: true },
    }, failedFixture.runContext)).toEqual({ status: "ignored", reason: "delivery_failed" });
    expect(failed.stateCounts().runs).toBe(0);
  });

  test("fails closed on missing, reordered, conflicting or non-owner trust surfaces", () => {
    const fixture = hookFixtures();
    expect(() => adapter().adoptPersistedUser(fixture.persistedEvent, { sessionKey })).toThrow("no trusted inbound capture");

    const conflict = adapter();
    conflict.captureMessageReceived(fixture.receivedEvent, fixture.receivedContext);
    expect(() => conflict.captureMessageReceived({ ...fixture.receivedEvent, messageId: "43" }, { ...fixture.receivedContext, messageId: "43" }))
      .toThrow("multiple inbound turns");

    const nonOwner = adapter();
    nonOwner.captureMessageReceived(fixture.receivedEvent, fixture.receivedContext);
    expect(() => nonOwner.adoptPersistedUser({
      ...fixture.persistedEvent,
      message: { ...fixture.persistedEvent.message, __openclaw: { senderIsOwner: false, transport: { channel: "telegram", messageId: "42" } } },
    }, { sessionKey })).toThrow("requires an owner turn");

    const replyConflict = adapter();
    replyConflict.captureMessageReceived(
      { ...fixture.receivedEvent, replyToId: "parent-1" },
      { ...fixture.receivedContext, replyToId: "parent-1" },
    );
    expect(() => replyConflict.adoptPersistedUser({
      ...fixture.persistedEvent,
      message: {
        ...fixture.persistedEvent.message,
        __openclaw: {
          senderIsOwner: true,
          transport: { channel: "telegram", messageId: "42", replyToId: "parent-2" },
        },
      },
    }, { sessionKey })).toThrow("reply target does not match");

    const adjacent = adapter();
    expect(adjacent.captureMessageReceived(fixture.receivedEvent, { ...fixture.receivedContext, sessionKey: `${sessionKey}-adjacent` }))
      .toEqual({ status: "ignored", reason: "scope_disabled" });
  });

  test("ignores failed/unbound runs, rejects transcript mismatch and consumes a run once", () => {
    const fixture = hookFixtures();
    expect(adapter().completeAgentEnd(fixture.endEvent, fixture.runContext)).toEqual({ status: "ignored", reason: "unbound_run" });

    const failed = adapter();
    failed.captureMessageReceived(fixture.receivedEvent, fixture.receivedContext);
    failed.adoptPersistedUser(fixture.persistedEvent, { sessionKey });
    failed.attachRun({}, fixture.runContext);
    expect(failed.completeAgentEnd({ ...fixture.endEvent, success: false }, fixture.runContext)).toEqual({ status: "ignored", reason: "run_failed" });
    expect(failed.completeAgentEnd(fixture.endEvent, fixture.runContext)).toEqual({ status: "ignored", reason: "unbound_run" });

    const mismatch = adapter();
    mismatch.captureMessageReceived(fixture.receivedEvent, fixture.receivedContext);
    mismatch.adoptPersistedUser(fixture.persistedEvent, { sessionKey });
    mismatch.attachRun({}, fixture.runContext);
    expect(() => mismatch.completeAgentEnd({ ...fixture.endEvent, messages: [{ role: "assistant", content: "done" }] }, fixture.runContext))
      .toThrow("exactly one bound source turn");
  });

  test("deduplicates repeated hook delivery and rejects cross-surface identity drift", () => {
    const fixture = hookFixtures();
    const runtime = adapter();
    expect(runtime.captureMessageReceived(fixture.receivedEvent, fixture.receivedContext).status).toBe("captured");
    expect(runtime.captureMessageReceived(fixture.receivedEvent, fixture.receivedContext).status).toBe("duplicate");
    expect(runtime.adoptPersistedUser(fixture.persistedEvent, { sessionKey }).status).toBe("adopted");
    expect(runtime.adoptPersistedUser(fixture.persistedEvent, { sessionKey }).status).toBe("duplicate");
    expect(runtime.attachRun({}, fixture.runContext).status).toBe("attached");
    expect(runtime.attachRun({}, fixture.runContext).status).toBe("duplicate");

    expect(() => adapter().captureMessageReceived(fixture.receivedEvent, { ...fixture.receivedContext, messageId: "different" }))
      .toThrow("differs across runtime surfaces");
  });

  test("rechecks the complete exact binding immediately before admission", () => {
    const fixture = hookFixtures();
    let scopeId = "telegram:100000001";
    const runtime = new OpenClawObservationRuntimeAdapter({
      authority: { id: authority.id, version: authority.version, digest: authority.digest },
      resolveBinding: (key) => key === sessionKey ? {
        workspaceId: "fixture-main",
        scopeClass: "self",
        scopeId,
        requireOwner: true,
        allowedChannels: ["telegram"],
        admit: () => ({ status: "admitted" }),
      } : null,
      now: () => new Date("2026-08-24T19:35:00.000Z"),
    });
    runtime.captureMessageReceived(fixture.receivedEvent, fixture.receivedContext);
    runtime.adoptPersistedUser(fixture.persistedEvent, { sessionKey });
    runtime.attachRun({}, fixture.runContext);
    scopeId = "telegram:adjacent";
    expect(() => runtime.completeAgentEnd(fixture.endEvent, fixture.runContext)).toThrow("scope changed before admission");
  });

  test("keeps platform conversion at the edge and exposes content-free errors", () => {
    const ledgerSource = readFileSync(join(import.meta.dir, "ledger.ts"), "utf8");
    expect(ledgerSource).not.toContain("runtime-adapter");
    expect(ledgerSource).not.toContain("OpenClaw");
    expect(observationRuntimeAdapterError(new Error("private\nsecret"))).toEqual({
      code: "RUNTIME_ADAPTER_FAILED",
      message: "runtime observation adapter failed closed",
    });
    expect(sha256("neutral request")).toMatch(/^sha256:[a-f0-9]{64}$/);
  });
});
