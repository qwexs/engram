import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AdmissionStore, deriveAdmissionGapReceiptId } from "./admission-store.ts";
import { tmpdir } from "node:os";
import {
  inspectMemoryObservationAdmission,
  deriveTraceId,
  MemoryObservationLedger,
  purgeMemoryObservationLifecycle,
  sha256,
  type LedgerFaultPoint,
  type TrustedCompletedTurn,
} from "./ledger.ts";
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

function ledger(root: string, fault?: (point: LedgerFaultPoint) => void): MemoryObservationLedger {
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
    ...(fault ? { fault } : {}),
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
  workspaceRoot?: string;
  classifyMissingBinding?: (runtimeSessionKey: string) => "revoked" | "unavailable";
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
    ...(options.classifyMissingBinding ? { classifyMissingBinding: options.classifyMissingBinding } : {}),
    now: options.now ?? (() => new Date("2026-08-24T19:35:00.000Z")),
    ...(options.spoolRoot ? { spoolRoot: options.spoolRoot } : {}),
    ...(options.workspaceRoot ? { workspace: options.workspaceRoot } : {}),
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
  test("ignores the trusted native command contour without creating admission gaps", () => {
    const root = workspace();
    const runtime = adapter({ workspaceRoot: root });
    const fixture = hookFixtures();
    expect(runtime.captureMessageReceived(fixture.receivedEvent, {
      ...fixture.receivedContext, sessionKey: "agent:fixture-main:telegram:slash:100000001",
    })).toEqual({ status: "ignored", reason: "native_command_session" });
    expect(new AdmissionStore(root, authority).scanCheckpoints().records).toHaveLength(0);
    // Slash-shaped content in an ordinary conversation is not a routing signal.
    expect(runtime.captureMessageReceived({ ...fixture.receivedEvent, content: "/my-document" },
      fixture.receivedContext)).toEqual({ status: "captured" });
  });

  test("preserves verified user evidence when successful completion has no assistant text", () => {
    const root = workspace(), observed = ledger(root);
    const runtime = adapter({ workspaceRoot: root, spoolRoot: join(root, "spool"),
      binding: { workspaceId: "fixture-main", scopeClass: "self", scopeId: "telegram:100000001",
        requireOwner: true, allowedChannels: ["telegram"],
        admit: (source, now) => observed.admit(source, now) } });
    const fixture = attach(runtime);
    const result = runtime.completeAgentEnd({ ...fixture.endEvent,
      messages: [fixture.endEvent.messages[0], { role: "assistant", content: [{ type: "image", url: "unread" }] }],
    }, fixture.runContext);
    expect(result.status).toBe("admitted");
    expect(new AdmissionStore(root, authority).scanCheckpoints().records[0]?.stage).toBe("ledger_admitted");
    expect(runtime.completeAgentEnd(fixture.endEvent, fixture.runContext).status).toBe("ignored");
  });

  test("marks absent assistant outcome unknown, without extracting tool arguments as text", () => {
    const admitted: TrustedCompletedTurn[] = [];
    const runtime = adapter({ admitted });
    const fixture = attach(runtime);
    runtime.completeAgentEnd({ ...fixture.endEvent, messages: [fixture.endEvent.messages[0],
      { role: "assistant", content: [{ type: "toolCall", name: "message", arguments: { message: "unverified" } }] },
    ] }, fixture.runContext);
    expect(admitted[0]?.redactedEvidence).toMatchObject({
      source: { text: "Принято: запускаем PR2 runtime adapter" },
      outcome: { text: "", status: "unknown", reasonCode: "assistant_text_unavailable" },
    });
  });

  test("missing assistant text does not relax completion or exact source checks", () => {
    for (const kind of ["failed", "missing-source", "changed-source"] as const) {
      const admitted: TrustedCompletedTurn[] = [], root = workspace();
      const runtime = adapter({ admitted, workspaceRoot: root });
      const fixture = attach(runtime);
      const event = { ...fixture.endEvent, success: kind !== "failed",
        messages: kind === "missing-source" ? [] : [{ ...fixture.endEvent.messages[0],
          ...(kind === "changed-source" ? { content: "Different source" } : {}) }] };
      if (kind === "failed") expect(runtime.completeAgentEnd(event, fixture.runContext).status).toBe("ignored");
      else expect(() => runtime.completeAgentEnd(event, fixture.runContext)).toThrow();
      expect(admitted).toHaveLength(0);
      expect(new AdmissionStore(root, authority).scanCheckpoints().records[0]?.stage).toBe("terminal_gap");
    }
  });

  test("group evidence preserves each trusted speaker across restart, not identities claimed in text", () => {
    const root = workspace(), admitted: TrustedCompletedTurn[] = [];
    const topicKey = "agent:fixture-main:telegram:group:-100123:topic:2";
    const binding: RuntimeObservationBinding = { workspaceId: "fixture-main", scopeClass: "project",
      scopeId: "domain:fixture-main:smm", requireOwner: false, allowedChannels: ["telegram"],
      topicDomain: { domain: "smm", chatId: "-100123", topicId: "2" },
      admit: source => { admitted.push(source); return { status: "admitted" }; } };
    const make = () => new OpenClawObservationRuntimeAdapter({
      authority: { id: authority.id, version: authority.version, digest: authority.digest },
      resolveBinding: key => key === topicKey ? binding : null,
      now: () => new Date("2026-08-24T19:35:00.000Z"), workspace: root,
      spoolRoot: join(root, "memory-state/memory-observation/v1/pre-admission"),
    });
    for (const [index, actorId] of ["111", "222"].entries()) {
      const sourceId = "channel-user:v1:" + String(index + 1).repeat(64);
      const messageId = String(index + 1), runId = "group-run-" + index;
      const content = "Я говорю от имени другого участника";
      make().captureMessageReceived({ messageId, senderId: actorId, content }, { sessionKey: topicKey, messageId, senderId: actorId, channelId: "telegram" });
      make().adoptPersistedUser({ sessionKey: topicKey, message: { role: "user", idempotencyKey: sourceId, content,
        __openclaw: { senderIsOwner: false, transport: { channel: "telegram", messageId } } } }, { sessionKey: topicKey });
      const context = { runId, sessionKey: topicKey, trigger: "user" };
      make().attachRun({}, context);
      expect(make().completeAgentEnd({ runId, success: true, messages: [
        { role: "user", idempotencyKey: sourceId, content }, { role: "assistant", content: "Утверждение записано как слова отправителя." },
      ] }, context).status).toBe("admitted");
    }
    expect(admitted.map(source => (source.redactedEvidence as any).source.actorId)).toEqual(["111", "222"]);
    expect(admitted.every(source => (source.redactedEvidence as any).source.attribution === "speaker-only")).toBe(true);
  });
  test("admits a non-admin user only when the exact binding permits personal capture", () => {
    const admitted: TrustedCompletedTurn[] = [];
    const value = adapter({ binding: {
      workspaceId: "fixture-main", scopeClass: "self", scopeId: "telegram:100000001",
      requireOwner: false, allowedChannels: ["telegram"],
      admit: (source) => { admitted.push(source); return { status: "admitted" }; },
    } });
    const fixture = hookFixtures();
    fixture.persistedEvent.message.__openclaw.senderIsOwner = false;
    value.captureMessageReceived(fixture.receivedEvent, fixture.receivedContext);
    expect(value.adoptPersistedUser(fixture.persistedEvent, { sessionKey }).status).toBe("adopted");
    value.attachRun({}, fixture.runContext);
    expect(value.completeAgentEnd(fixture.endEvent, fixture.runContext).status).toBe("admitted");
    expect(admitted).toHaveLength(1);
    expect(value.captureMessageReceived(fixture.receivedEvent, {
      ...fixture.receivedContext, sessionKey: "agent:another:telegram:direct:100000001",
    }).status).toBe("ignored");
  });
  test("recovers the trusted hook chain from durable checkpoints before completed spool", () => {
    const root = workspace();
    const spoolRoot = join(root, "memory-state", "memory-observation", "v1", "pre-admission");
    const store = ledger(root);
    const binding: RuntimeObservationBinding = {
      workspaceId: "fixture-main",
      scopeClass: "self",
      scopeId: "telegram:100000001",
      requireOwner: true,
      allowedChannels: ["telegram"],
      admit: (source, now) => store.admit(source, now),
    };
    const fixture = hookFixtures();
    adapter({ binding, spoolRoot, workspaceRoot: root })
      .captureMessageReceived(fixture.receivedEvent, fixture.receivedContext);
    adapter({ binding, spoolRoot, workspaceRoot: root })
      .adoptPersistedUser(fixture.persistedEvent, { sessionKey });
    adapter({ binding, spoolRoot, workspaceRoot: root })
      .attachRun({}, { ...fixture.runContext, sessionId: "session-generation-1" });
    const completed = adapter({ binding, spoolRoot, workspaceRoot: root })
      .completeAgentEnd(fixture.endEvent, fixture.runContext);
    expect(completed.status).toBe("admitted");
    expect(store.listQueue()).toHaveLength(1);
    const checkpoints = new AdmissionStore(root, authority).scanCheckpoints();
    expect(checkpoints.corrupt).toHaveLength(0);
    expect(checkpoints.records).toContainEqual(expect.objectContaining({
      stage: "ledger_admitted",
      sourceText: null,
      runId: "run-1",
      sessionId: "session-generation-1",
    }));
  });

  test("turns every checkpointed pre-completion restart into one durable gap", () => {
    for (const stage of ["received", "persisted", "run_attached"] as const) {
      const root = workspace();
      const spoolRoot = join(root, "memory-state", "memory-observation", "v1", "pre-admission");
      const fixture = hookFixtures();
      const first = adapter({ spoolRoot, workspaceRoot: root });
      first.captureMessageReceived(fixture.receivedEvent, fixture.receivedContext);
      if (stage !== "received") first.adoptPersistedUser(fixture.persistedEvent, { sessionKey });
      if (stage === "run_attached") first.attachRun({}, fixture.runContext);

      const restarted = adapter({ spoolRoot, workspaceRoot: root });
      expect(restarted.reconcileOrphanedCheckpoints(new Date("2026-08-24T19:35:00.000Z"), "periodic"))
        .toMatchObject({ gaps: 0, retained: 1 });
      expect(restarted.reconcileOrphanedCheckpoints()).toMatchObject({ gaps: 1, corrupt: 0 });
      const durable = new AdmissionStore(root, authority);
      expect(durable.scanGapReceipts().records).toContainEqual(expect.objectContaining({
        failureStage: stage,
        reasonCode: "restart_before_completion",
      }));
      expect(durable.scanCheckpoints().records).toContainEqual(expect.objectContaining({
        stage: "terminal_gap",
        sourceText: null,
      }));
      expect(restarted.reconcileOrphanedCheckpoints()).toMatchObject({ gaps: 0 });
    }
  });

  test("independent inbound messages survive overlap and one candidate conflict", () => {
    const root = workspace(), runtime = adapter({ workspaceRoot: root }), fixture = hookFixtures();
    runtime.captureMessageReceived(fixture.receivedEvent, fixture.receivedContext);
    expect(runtime.captureMessageReceived({ ...fixture.receivedEvent, messageId: "43" },
      { ...fixture.receivedContext, messageId: "43" }).status).toBe("captured");
    expect(runtime.stateCounts().pending).toBe(2);
    expect(() => runtime.captureMessageReceived({ ...fixture.receivedEvent, senderId: "bad" },
      { ...fixture.receivedContext, senderId: "bad" })).toThrow();
    expect(runtime.stateCounts().pending).toBe(1);
    const persisted = structuredClone(fixture.persistedEvent);
    persisted.message.__openclaw.transport.messageId = "43";
    expect(runtime.adoptPersistedUser(persisted, { sessionKey }).status).toBe("adopted");
    expect(runtime.attachRun({}, fixture.runContext).status).toBe("attached");
    expect(runtime.completeAgentEnd(fixture.endEvent, fixture.runContext).status).toBe("admitted");
    expect(runtime.captureMessageReceived({ ...fixture.receivedEvent, messageId: "44" },
      { ...fixture.receivedContext, messageId: "44" }).status).toBe("captured");
    expect(new AdmissionStore(root, authority).scanGapReceipts().records).toHaveLength(1);
  });

  test("trusted inbound run IDs disambiguate concurrent persisted messages across restart", () => {
    const root = workspace(), admitted: TrustedCompletedTurn[] = [], first = adapter({ workspaceRoot: root, admitted });
    const fixtures = [hookFixtures(), hookFixtures()];
    fixtures[1]!.receivedEvent.messageId = "43";
    fixtures[1]!.receivedContext.messageId = "43";
    fixtures[1]!.persistedEvent.message.__openclaw.transport.messageId = "43";
    fixtures[1]!.persistedEvent.message.idempotencyKey = "channel-user:v1:" + "b".repeat(64);
    fixtures[1]!.runContext.runId = "run-2";
    fixtures[1]!.endEvent.runId = "run-2";
    (fixtures[1]!.endEvent.messages[0] as any).idempotencyKey = fixtures[1]!.persistedEvent.message.idempotencyKey;
    for (const f of fixtures) {
      first.captureMessageReceived({ ...f.receivedEvent, runId: f.runContext.runId }, f.receivedContext);
      first.adoptPersistedUser(f.persistedEvent, { sessionKey });
    }
    const restarted = adapter({ workspaceRoot: root, admitted });
    for (const f of fixtures.reverse()) {
      expect(restarted.attachRun({}, f.runContext).status).toBe("attached");
      expect(restarted.completeAgentEnd(f.endEvent, f.runContext).status).toBe("admitted");
    }
    expect(admitted.map(source => (source.redactedEvidence as any).source.messageId)).toEqual(["43", "42"]);
  });

  test("outbound event without run identity never guesses the latest completed image", () => {
    const runtime = adapter(); complete(runtime);
    expect(runtime.recordMessageSent({ success: true, messageId: "100", content: "" }, { sessionKey })).toEqual({
      status: "ignored", reason: "delivery_run_id_missing",
    });
  });

  test("persisted reply conflict clears only its candidate without waiting for TTL", () => {
    const root = workspace(), runtime = adapter({ workspaceRoot: root }), fixture = hookFixtures();
    runtime.captureMessageReceived({ ...fixture.receivedEvent, replyToId: "10" }, fixture.receivedContext);
    expect(() => runtime.adoptPersistedUser({ ...fixture.persistedEvent, message: {
      ...fixture.persistedEvent.message, __openclaw: { senderIsOwner: true,
        transport: { channel: "telegram", messageId: "42", replyToId: "11" } },
    } }, { sessionKey })).toThrow("reply target");
    expect(runtime.stateCounts()).toEqual({ pending: 0, adopted: 0, runs: 0 });
    expect(runtime.captureMessageReceived({ ...fixture.receivedEvent, messageId: "43" },
      { ...fixture.receivedContext, messageId: "43" }).status).toBe("captured");
  });

  test("terminalizes same-candidate identity drift instead of merging it", () => {
    const root = workspace();
    const runtime = adapter({ workspaceRoot: root });
    const fixture = hookFixtures();
    runtime.captureMessageReceived(fixture.receivedEvent, fixture.receivedContext);
    expect(() => runtime.captureMessageReceived(
      { ...fixture.receivedEvent, senderId: "different-actor" },
      { ...fixture.receivedContext, senderId: "different-actor" },
    )).toThrow("candidate identity changed");

    const durable = new AdmissionStore(root, authority);
    expect(durable.scanCheckpoints().records).toContainEqual(expect.objectContaining({ stage: "terminal_gap", sourceText: null }));
    expect(durable.scanGapReceipts().records).toContainEqual(expect.objectContaining({ reasonCode: "identity_conflict" }));
    expect(runtime.stateCounts()).toEqual({ pending: 0, adopted: 0, runs: 0 });
  });

  test("treats a reordered received hook as a duplicate after durable progress", () => {
    const root = workspace();
    const runtime = adapter({ workspaceRoot: root });
    const fixture = hookFixtures();
    runtime.captureMessageReceived(fixture.receivedEvent, fixture.receivedContext);
    runtime.adoptPersistedUser(fixture.persistedEvent, { sessionKey });
    expect(runtime.captureMessageReceived(fixture.receivedEvent, fixture.receivedContext))
      .toEqual({ status: "duplicate", sourceTurnId });
    runtime.attachRun({}, fixture.runContext);
    const restarted = adapter({ workspaceRoot: root });
    expect(restarted.adoptPersistedUser(fixture.persistedEvent, { sessionKey }))
      .toEqual({ status: "duplicate", sourceTurnId });
    expect(restarted.attachRun({}, fixture.runContext))
      .toEqual({ status: "duplicate", sourceTurnId });
    expect(new AdmissionStore(root, authority).scanGapReceipts().records).toHaveLength(0);
  });

  test("sanitizes completed spool evidence and strips it after terminal admission", () => {
    const root = workspace();
    const spoolRoot = join(root, "memory-state", "memory-observation", "v1", "pre-admission");
    const fixture = hookFixtures();
    fixture.persistedEvent.message.content = [{ type: "text", text: "api_key=super-secret-value" }];
    fixture.endEvent.messages[0] = { role: "user", idempotencyKey: sourceTurnId, content: "api_key=super-secret-value" };
    let injected = false;
    const crashing = adapter({ workspaceRoot: root, spoolRoot, fault: (point) => {
      if (!injected && point === "after_completed_spool") { injected = true; throw new Error("fault:after_completed_spool"); }
    } });
    crashing.captureMessageReceived(fixture.receivedEvent, fixture.receivedContext);
    crashing.adoptPersistedUser(fixture.persistedEvent, { sessionKey });
    crashing.attachRun({}, fixture.runContext);
    expect(() => crashing.completeAgentEnd(fixture.endEvent, fixture.runContext)).toThrow("fault:after_completed_spool");
    expect(JSON.stringify(crashing.listSpool())).not.toContain("super-secret-value");
    const recovered = adapter({ workspaceRoot: root, spoolRoot });
    expect(recovered.reconcileCompleted().admitted).toBe(1);
    expect(recovered.listSpool()).toContainEqual(expect.objectContaining({ status: "admitted", source: null }));
  });

  test("terminalizes an expired admission retry and removes retained evidence", () => {
    const root = workspace();
    const spoolRoot = join(root, "memory-state", "memory-observation", "v1", "pre-admission");
    const failingBinding: RuntimeObservationBinding = {
      workspaceId: "fixture-main",
      scopeClass: "self",
      scopeId: "telegram:100000001",
      requireOwner: true,
      allowedChannels: ["telegram"],
      admit: () => { throw new Error("temporary admission failure"); },
    };
    expect(() => complete(adapter({ binding: failingBinding, workspaceRoot: root, spoolRoot })))
      .toThrow("temporary admission failure");

    const expired = adapter({
      binding: failingBinding,
      workspaceRoot: root,
      spoolRoot,
      now: () => new Date("2026-08-27T20:00:00.000Z"),
    });
    expect(expired.reconcileCompleted()).toEqual({ admitted: 0, retained: 0, terminal: 1 });
    expect(expired.listSpool()).toContainEqual(expect.objectContaining({
      status: "terminal",
      source: null,
      reasonCode: "admission_retry_expired",
    }));
    expect(new AdmissionStore(root, authority).scanGapReceipts().records)
      .toContainEqual(expect.objectContaining({ reasonCode: "evidence_invalid", failureStage: "completion_observed" }));
  });

  test("isolates a corrupt spool record while recovering valid completed work", () => {
    const root = workspace();
    const spoolRoot = join(root, "memory-state", "memory-observation", "v1", "pre-admission");
    let injected = false;
    const crashing = adapter({ workspaceRoot: root, spoolRoot, fault: (point) => {
      if (!injected && point === "after_completed_spool") { injected = true; throw new Error("fault:after_completed_spool"); }
    } });
    expect(() => complete(crashing)).toThrow("fault:after_completed_spool");
    writeFileSync(join(spoolRoot, `${"f".repeat(64)}.json`), "{broken", "utf8");
    const recovered = adapter({ workspaceRoot: root, spoolRoot });
    expect(recovered.scanSpool().corrupt).toHaveLength(1);
    expect(recovered.reconcileCompleted()).toEqual({ admitted: 1, retained: 0, terminal: 0 });
  });

  test("isolates a poison receipt while reconciling the next valid checkpoint", () => {
    const root = workspace();
    const fixture = hookFixtures();
    adapter({ workspaceRoot: root }).captureMessageReceived(fixture.receivedEvent, fixture.receivedContext);
    adapter({ workspaceRoot: root }).captureMessageReceived(
      { ...fixture.receivedEvent, messageId: "43" },
      { ...fixture.receivedContext, messageId: "43" },
    );
    const store = new AdmissionStore(root, authority);
    const poisoned = store.scanCheckpoints().records.find((entry) => entry.inboundMessageId === "42")!;
    const receiptId = deriveAdmissionGapReceiptId(poisoned.candidateId);
    const receiptDir = join(root, "memory-state", "memory-observation", "v1", "receipts", "admission-gap");
    mkdirSync(receiptDir, { recursive: true });
    writeFileSync(join(receiptDir, `${receiptId.slice(7)}.json`), "{broken", "utf8");

    expect(adapter({ workspaceRoot: root }).reconcileOrphanedCheckpoints()).toMatchObject({
      gaps: 1,
      errors: 1,
      corrupt: 0,
    });
    expect(store.scanGapReceipts()).toMatchObject({ records: [{ reasonCode: "restart_before_completion" }], corrupt: [{ path: expect.any(String) }] });
  });

  test("treats an immutable gap receipt as authoritative over a completed spool", () => {
    const root = workspace();
    const spoolRoot = join(root, "memory-state", "memory-observation", "v1", "pre-admission");
    let injected = false;
    const crashing = adapter({ workspaceRoot: root, spoolRoot, fault: (point) => {
      if (!injected && point === "after_completed_spool") { injected = true; throw new Error("fault:after_completed_spool"); }
    } });
    expect(() => complete(crashing)).toThrow("fault:after_completed_spool");
    const store = new AdmissionStore(root, authority);
    const checkpoint = store.scanCheckpoints().records[0]!;
    store.publishGapReceipt({
      checkpoint,
      failureStage: "completion_observed",
      reasonCode: "evidence_invalid",
      terminalAt: new Date("2026-08-24T19:36:00.000Z"),
    });

    const admitted: TrustedCompletedTurn[] = [];
    const recovered = adapter({ admitted, workspaceRoot: root, spoolRoot });
    expect(recovered.reconcileCompleted()).toEqual({ admitted: 0, retained: 0, terminal: 1 });
    expect(admitted).toHaveLength(0);
    expect(recovered.listSpool()).toContainEqual(expect.objectContaining({
      status: "terminal",
      source: null,
      reasonCode: "admission_gap_evidence_invalid",
    }));
  });

  test("terminalizes completed work when the exact binding is removed", () => {
    const root = workspace();
    const spoolRoot = join(root, "memory-state", "memory-observation", "v1", "pre-admission");
    let injected = false;
    const crashing = adapter({ workspaceRoot: root, spoolRoot, fault: (point) => {
      if (!injected && point === "after_completed_spool") { injected = true; throw new Error("fault:after_completed_spool"); }
    } });
    expect(() => complete(crashing)).toThrow("fault:after_completed_spool");
    const disabled = adapter({ binding: null, workspaceRoot: root, spoolRoot });
    expect(disabled.reconcileCompleted()).toEqual({ admitted: 0, retained: 0, terminal: 1 });
    expect(disabled.listSpool()).toContainEqual(expect.objectContaining({ status: "terminal", source: null }));
    expect(new AdmissionStore(root, authority).scanGapReceipts().records)
      .toContainEqual(expect.objectContaining({ reasonCode: "scope_revoked", failureStage: "completion_observed" }));
  });

  test("retains completed work while binding resolution is transiently unavailable", () => {
    const root = workspace();
    const spoolRoot = join(root, "memory-state", "memory-observation", "v1", "pre-admission");
    let injected = false;
    const crashing = adapter({ workspaceRoot: root, spoolRoot, fault: (point) => {
      if (!injected && point === "after_completed_spool") { injected = true; throw new Error("fault:after_completed_spool"); }
    } });
    expect(() => complete(crashing)).toThrow("fault:after_completed_spool");
    const unavailable = adapter({
      binding: null,
      workspaceRoot: root,
      spoolRoot,
      classifyMissingBinding: () => "unavailable",
    });
    expect(unavailable.reconcileCompleted()).toEqual({ admitted: 0, retained: 1, terminal: 0 });
    expect(new AdmissionStore(root, authority).scanGapReceipts().records).toHaveLength(0);
  });

  test("retains completed work when durable admission inspection is unavailable", () => {
    const root = workspace();
    const spoolRoot = join(root, "memory-state", "memory-observation", "v1", "pre-admission");
    let injected = false;
    const crashing = adapter({ workspaceRoot: root, spoolRoot, fault: (point) => {
      if (!injected && point === "after_completed_spool") { injected = true; throw new Error("fault:after_completed_spool"); }
    } });
    expect(() => complete(crashing)).toThrow("fault:after_completed_spool");
    const source = crashing.listSpool()[0]!.source!;
    const traceId = deriveTraceId(source.scope.workspaceId, source.scope.runtimeSessionKey, source.sourceTurnId);
    const envelopeDir = join(root, "memory-state", "memory-observation", "v1", "envelopes");
    mkdirSync(envelopeDir, { recursive: true });
    writeFileSync(join(envelopeDir, `${traceId.slice(7)}.json`), "{broken", "utf8");

    const recovered = adapter({ binding: null, workspaceRoot: root, spoolRoot });
    expect(recovered.reconcileCompleted()).toEqual({ admitted: 0, retained: 1, terminal: 0 });
    expect(new AdmissionStore(root, authority).scanGapReceipts().records).toHaveLength(0);
  });

  test("recognizes durable admission before a later binding removal or retry expiry", () => {
    for (const recoveryAt of ["2026-08-24T19:35:00.000Z", "2026-08-27T20:00:00.000Z"]) {
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
      const crashing = adapter({
        binding,
        workspaceRoot: root,
        spoolRoot,
        fault: (point) => { if (point === "after_admission") throw new Error("fault:after_admission"); },
      });
      expect(() => complete(crashing)).toThrow("fault:after_admission");
      expect(store.listQueue()).toHaveLength(1);

      const recovered = adapter({
        binding: null,
        workspaceRoot: root,
        spoolRoot,
        now: () => new Date(recoveryAt),
      });
      expect(recovered.reconcileCompleted()).toEqual({ admitted: 1, retained: 0, terminal: 0 });
      expect(recovered.listSpool()).toContainEqual(expect.objectContaining({
        status: "admitted",
        source: null,
        reasonCode: "ledger_admission_confirmed_after_recovery",
      }));
      expect(new AdmissionStore(root, authority).scanGapReceipts().records).toHaveLength(0);
    }
  });

  test("retains a partial ledger admission until an active binding repairs queue and trace", () => {
    const root = workspace();
    const spoolRoot = join(root, "memory-state", "memory-observation", "v1", "pre-admission");
    const interruptedLedger = ledger(root, (point) => {
      if (point === "after_envelope") throw new Error("fault:after_envelope");
    });
    const binding: RuntimeObservationBinding = {
      workspaceId: "fixture-main",
      scopeClass: "self",
      scopeId: "telegram:100000001",
      requireOwner: true,
      allowedChannels: ["telegram"],
      admit: (source, now) => interruptedLedger.admit(source, now),
    };
    const interrupted = adapter({ binding, workspaceRoot: root, spoolRoot });
    expect(() => complete(interrupted)).toThrow("fault:after_envelope");
    const source = interrupted.listSpool()[0]!.source!;
    expect(inspectMemoryObservationAdmission(root, source)).toBe("partial");

    const disabled = adapter({ binding: null, workspaceRoot: root, spoolRoot });
    expect(disabled.reconcileCompleted()).toEqual({ admitted: 0, retained: 1, terminal: 0 });
    expect(new AdmissionStore(root, authority).scanGapReceipts().records).toHaveLength(0);

    const healthyLedger = ledger(root);
    const healthyBinding: RuntimeObservationBinding = { ...binding, admit: (value, now) => healthyLedger.admit(value, now) };
    expect(adapter({ binding: healthyBinding, workspaceRoot: root, spoolRoot }).reconcileCompleted())
      .toEqual({ admitted: 1, retained: 0, terminal: 0 });
    expect(inspectMemoryObservationAdmission(root, source)).toBe("admitted");
  });

  test("reuses the first durable completion timestamp on a later duplicate completion", () => {
    const root = workspace();
    const spoolRoot = join(root, "memory-state", "memory-observation", "v1", "pre-admission");
    let injected = false;
    const first = adapter({ workspaceRoot: root, spoolRoot, fault: (point) => {
      if (!injected && point === "after_completed_spool") { injected = true; throw new Error("fault:after_completed_spool"); }
    } });
    const fixture = attach(first);
    expect(() => first.completeAgentEnd(fixture.endEvent, fixture.runContext)).toThrow("fault:after_completed_spool");

    const admitted: TrustedCompletedTurn[] = [];
    const later = adapter({
      admitted,
      workspaceRoot: root,
      spoolRoot,
      now: () => new Date("2026-08-24T20:35:00.000Z"),
    });
    expect(later.completeAgentEnd(fixture.endEvent, fixture.runContext).status).toBe("admitted");
    expect(admitted[0]!.sourceCompletedAt).toBe("2026-08-24T19:35:00.000Z");
  });

  test("migrates a legacy v1 completed spool before recovery", () => {
    const root = workspace();
    const spoolRoot = join(root, "memory-state", "memory-observation", "v1", "pre-admission");
    let injected = false;
    const crashing = adapter({ workspaceRoot: root, spoolRoot, fault: (point) => {
      if (!injected && point === "after_completed_spool") { injected = true; throw new Error("fault:after_completed_spool"); }
    } });
    expect(() => complete(crashing)).toThrow("fault:after_completed_spool");
    const path = join(spoolRoot, `${"a".repeat(64)}.json`);
    const current = JSON.parse(readFileSync(path, "utf8"));
    current.schema = "engram.memory-runtime-admission-spool.v1";
    delete current.candidateId;
    delete current.sealedPayloadDigest;
    writeFileSync(path, `${JSON.stringify(current, null, 2)}\n`, "utf8");

    const recovered = adapter({ workspaceRoot: root, spoolRoot });
    expect(recovered.reconcileCompleted()).toEqual({ admitted: 1, retained: 0, terminal: 0 });
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
      schema: "engram.memory-runtime-admission-spool.v2",
      candidateId: expect.stringMatching(/^sha256:/),
      sealedPayloadDigest: expect.stringMatching(/^sha256:/),
      source: null,
    });
  });

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

  test("retains terminal spool replay protection for 180 days", () => {
    const root = workspace();
    const spoolRoot = join(root, "memory-state", "memory-observation", "v1", "pre-admission");
    const completed = adapter({ spoolRoot });
    expect(complete(completed).status).toBe("admitted");
    expect(completed.listSpool()).toHaveLength(1);
    expect(purgeMemoryObservationLifecycle(root, new Date("2027-02-21T19:35:00.001Z"))).toMatchObject({ preAdmission: 1 });
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
      source: { role: "user", text: "Принято: запускаем PR2 runtime adapter", messageId: "42" },
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
    expect(conflict.captureMessageReceived({ ...fixture.receivedEvent, messageId: "43" }, { ...fixture.receivedContext, messageId: "43" }).status)
      .toBe("captured");

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

  test("rejects changed persisted or terminal source content under the same identity", () => {
    const persistedRoot = workspace();
    const persisted = adapter({ workspaceRoot: persistedRoot });
    const fixture = hookFixtures();
    persisted.captureMessageReceived(fixture.receivedEvent, fixture.receivedContext);
    persisted.adoptPersistedUser(fixture.persistedEvent, { sessionKey });
    expect(() => persisted.adoptPersistedUser({
      ...fixture.persistedEvent,
      message: { ...fixture.persistedEvent.message, content: "changed persisted content" },
    }, { sessionKey })).toThrow("source identity changed after durable progress");
    expect(new AdmissionStore(persistedRoot, authority).scanGapReceipts().records)
      .toContainEqual(expect.objectContaining({ reasonCode: "identity_conflict", failureStage: "persisted" }));

    const terminalRoot = workspace();
    const terminal = adapter({ workspaceRoot: terminalRoot });
    const attached = attach(terminal);
    expect(() => terminal.completeAgentEnd({
      ...attached.endEvent,
      messages: attached.endEvent.messages.map((message) => message.role === "user"
        ? { ...message, content: "changed terminal source content" }
        : message),
    }, attached.runContext)).toThrow("source content changed");
    expect(new AdmissionStore(terminalRoot, authority).scanGapReceipts().records)
      .toContainEqual(expect.objectContaining({ reasonCode: "identity_conflict", failureStage: "run_attached" }));
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
