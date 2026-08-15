import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  lstatSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { atomicWriteJson } from "./legacy-migration";
import {
  createAdaptationActionReview,
  proposeAdaptationRule,
  queueRuleActivationNotification,
  transitionAdaptationRule,
  transitionAdaptationSignal,
} from "./adaptation-store";
import { classifyAdaptationRisk, loadActorRegistry, TrustedActorContext } from "./authorization";
import {
  canonicalizeJcs,
  computeOperationId,
  Digest,
  ExpectedHandoffV2,
  HandoffValidationError,
  parseRethinkHandoffV2,
  RethinkActionV2,
  RethinkHandoffV2,
  sha256Digest,
} from "./handoff-v2";
import {
  type ExpectedHandoffV3,
  parseRethinkHandoffV3,
  type RethinkActionV3,
  type RethinkHandoffV3,
} from "./handoff-v3";
import { transitionMemoryCandidate } from "./memory-candidates";
import { preflightRuleActivation } from "./rule-context";

type JsonObject = Record<string, any>;
type JournalTransition =
  | "received"
  | "validated"
  | "intent_recorded"
  | "effect_committed"
  | "verified"
  | "review_pending"
  | "policy_rejected"
  | "candidate_dispositions_committed"
  | "terminal";

interface JournalEvent {
  schema: "oll.apply-journal-event.v1";
  eventId: string;
  sequence: number;
  workspaceId: string;
  runId: string;
  transition: JournalTransition;
  actionId: Digest | null;
  operationId: Digest | null;
  payloadDigest: Digest | null;
  artifactRef: string | null;
  artifactDigest: Digest | null;
  projectionDigest: Digest | null;
  createdAt: string;
}

interface OperationRecord {
  schema: "oll.adaptation-operation.v1";
  operationId: Digest;
  workspaceId: string;
  runId: string;
  actionId: Digest;
  payloadDigest: Digest;
  actionType: RethinkActionV2["type"];
  status: "intent_recorded" | "effect_committed" | "verified" | "review_pending" | "policy_rejected";
  intendedArtifactRef: string | null;
  intendedStatus: string | null;
  expectedRuleRevision: number | null;
  artifactRef: string | null;
  artifactDigest: Digest | null;
  disposition: "verified" | "review_pending" | "policy_rejected" | null;
  revision: number;
  updatedAt: string;
}

export interface ApplicatorOptions {
  workspace: string;
  stateRoot: string;
  expected: ExpectedHandoffV2 | ExpectedHandoffV3;
  trustedActorContexts?: Readonly<Record<string, TrustedActorContext>>;
  skipCandidateDispositions?: boolean;
  now?: string;
  faultInjector?: (transition: JournalTransition) => void;
}

type AnyHandoff = RethinkHandoffV2 | RethinkHandoffV3;
type AnyAction = RethinkActionV2 | RethinkActionV3;

function actionCandidateIds(action: AnyAction): Digest[] {
  return "sourceCandidates" in action.payload ? action.payload.sourceCandidates : [];
}

export interface ApplicatorResult {
  status: "terminal" | "replayed" | "rejected";
  workspaceId: string;
  runId: string;
  handoffDigest: Digest | null;
  dispositions: Array<{ actionId: Digest; operationId: Digest; disposition: string; artifactRef: string | null }>;
  projectionDigest: Digest | null;
  appliedPath?: string;
  rejectedPath?: string;
  errorClass?: string;
  reason?: string;
}

const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 5_000;

function readJson(path: string): JsonObject {
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must contain an object`);
  return value;
}

function assertInside(root: string, target: string, label: string): void {
  const absoluteRoot = resolve(root);
  const absoluteTarget = resolve(target);
  const prefix = absoluteRoot.endsWith(sep) ? absoluteRoot : `${absoluteRoot}${sep}`;
  if (absoluteTarget !== absoluteRoot && !absoluteTarget.startsWith(prefix)) throw new HandoffValidationError("correlation_mismatch", `${label} escapes its managed root`);
}

function sleepSync(ms: number): void {
  const wait = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(wait, 0, 0, ms);
}

function withApplicatorLock<T>(root: string, fn: () => T): T {
  mkdirSync(root, { recursive: true });
  const lock = join(root, ".handoff-applicator.lock");
  const started = Date.now();
  while (true) {
    try { mkdirSync(lock); break; }
    catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
      let stale = false;
      try { stale = Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS; } catch { stale = false; }
      if (stale) { rmSync(lock, { recursive: true, force: true }); continue; }
      if (Date.now() - started >= LOCK_WAIT_MS) throw new Error("handoff applicator lock timeout");
      sleepSync(20);
    }
  }
  try { return fn(); }
  finally { rmSync(lock, { recursive: true, force: true }); }
}

function journalEvents(eventsDir: string): JournalEvent[] {
  if (!existsSync(eventsDir)) return [];
  return readdirSync(eventsDir)
    .filter((name) => /^\d{8}-[0-9a-f-]{36}\.json$/i.test(name))
    .sort()
    .map((name) => readJson(join(eventsDir, name)) as JournalEvent);
}

function appendJournal(
  eventsDir: string,
  input: Omit<JournalEvent, "schema" | "eventId" | "sequence">,
  faultInjector?: ApplicatorOptions["faultInjector"],
): JournalEvent {
  mkdirSync(eventsDir, { recursive: true });
  const existing = journalEvents(eventsDir).find((event) => (
    event.transition === input.transition && event.actionId === input.actionId
  ));
  if (existing) return existing;
  const events = journalEvents(eventsDir);
  const sequence = events.reduce((max, event) => Math.max(max, event.sequence), 0) + 1;
  const event: JournalEvent = {
    schema: "oll.apply-journal-event.v1",
    eventId: randomUUID(),
    sequence,
    ...input,
  };
  const path = join(eventsDir, `${String(sequence).padStart(8, "0")}-${event.eventId}.json`);
  atomicWriteJson(path, event);
  faultInjector?.(event.transition);
  return event;
}

function deterministicRuleId(actionId: Digest, suffix = 0): string {
  const hex = actionId.slice("sha256:".length + suffix * 32, "sha256:".length + suffix * 32 + 32).padEnd(32, "0").split("");
  hex[12] = "5";
  hex[16] = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8).join("")}-${hex.slice(8, 12).join("")}-${hex.slice(12, 16).join("")}-${hex.slice(16, 20).join("")}-${hex.slice(20, 32).join("")}`;
}

function workspaceConfig(workspace: string, stateRoot: string): {
  workspaceId: string;
  mode: "disabled" | "observe-only" | "active";
  companyRoot: string;
  actorRegistryPath: string;
  maxInjectedRuleBytes: number;
} {
  const config = readJson(join(workspace, "engram.json"));
  const workspaceId = String(config?.workspace?.id || "");
  const mode = config?.oll?.adaptation?.mode;
  if (!workspaceId || !["disabled", "observe-only", "active"].includes(mode)) throw new Error("invalid OLL adaptation configuration");
  const companyRoot = resolve(String(config?.oll?.adaptation?.companyRuleStore || "${ENGRAM_STATE_ROOT}/oll/company-rules")
    .replaceAll("${ENGRAM_STATE_ROOT}", resolve(stateRoot)));
  assertInside(resolve(stateRoot), companyRoot, "companyRuleStore");
  const actorRegistryPath = resolve(String(config?.oll?.adaptation?.actorRegistry || "${ENGRAM_STATE_ROOT}/oll/actors.v1.json")
    .replaceAll("${ENGRAM_STATE_ROOT}", resolve(stateRoot)));
  assertInside(resolve(stateRoot), actorRegistryPath, "actorRegistry");
  return {
    workspaceId,
    mode,
    companyRoot,
    actorRegistryPath,
    maxInjectedRuleBytes: Number(config?.oll?.adaptation?.maxInjectedRuleBytes || 8192),
  };
}

function rulePath(workspace: string, companyRoot: string, scopeLevel: string, ruleId: string): string {
  return scopeLevel === "company"
    ? join(companyRoot, "rules", `${ruleId}.json`)
    : join(workspace, "memory-state", "oll", "rules", `${ruleId}.json`);
}

function artifactRef(workspace: string, path: string): string {
  const rel = relative(workspace, path);
  return rel && !rel.startsWith("..") && !rel.startsWith(sep) ? rel : resolve(path);
}

function fileDigest(path: string): Digest {
  return sha256Digest(readFileSync(path));
}

function findOperationAudit(workspace: string, companyRoot: string, operationId: Digest): boolean {
  for (const auditRoot of [join(workspace, "memory-state", "oll", "audit"), join(companyRoot, "audit")]) {
    if (!existsSync(auditRoot)) continue;
    for (const name of readdirSync(auditRoot).filter((entry) => entry.endsWith(".json"))) {
      try { if (readJson(join(auditRoot, name)).operationId === operationId) return true; } catch { /* validation handles malformed stores elsewhere */ }
    }
  }
  return false;
}

function terminalActionEvent(events: JournalEvent[], actionId: Digest): JournalEvent | null {
  return events.find((event) => (
    event.actionId === actionId && ["verified", "review_pending", "policy_rejected"].includes(event.transition)
  )) || null;
}

function findActionReview(workspace: string, companyRoot: string, actionId: Digest): { review: JsonObject; path: string } | null {
  for (const root of [join(workspace, "memory-state", "oll", "reviews"), join(companyRoot, "reviews")]) {
    if (!existsSync(root)) continue;
    for (const name of readdirSync(root).filter((entry) => entry.endsWith(".json"))) {
      const path = join(root, name);
      const review = readJson(path);
      if (review.actionId === actionId) return { review, path };
    }
  }
  return null;
}

function validateSources(options: ApplicatorOptions, handoff: AnyHandoff, action: AnyAction): JsonObject[] {
  const signalRoot = join(resolve(options.workspace), "memory-state", "oll", "signals");
  return action.payload.sourceSignals.map((signalId) => {
    const expectedRevision = options.expected.signalRevisions[signalId];
    if (!Number.isInteger(expectedRevision)) throw new HandoffValidationError("policy_rejected", `signal ${signalId} is outside the immutable context snapshot`);
    const path = join(signalRoot, `${signalId}.json`);
    if (!existsSync(path)) throw new HandoffValidationError("policy_rejected", `source signal not found: ${signalId}`);
    const signal = readJson(path);
    if (signal.workspaceId !== handoff.workspaceId) throw new HandoffValidationError("authorization_failed", "source signal belongs to another workspace");
    if (signal.revision !== expectedRevision) throw new HandoffValidationError("policy_rejected", `source signal revision changed: ${signalId}`);
    if (signal.scope?.level !== action.payload.scope.level || signal.scope?.subject !== action.payload.scope.subject) {
      throw new HandoffValidationError("policy_rejected", "action scope does not match its source signals");
    }
    return signal;
  });
}

function validateCandidateSources(options: ApplicatorOptions, handoff: AnyHandoff, action: AnyAction): JsonObject[] {
  const candidateIds = actionCandidateIds(action);
  if (!candidateIds.length) return [];
  if (!("candidateRevisions" in options.expected)) throw new HandoffValidationError("policy_rejected", "candidate evidence requires handoff v3");
  const expected = options.expected;
  const root = join(resolve(options.workspace), "memory-state", "oll", "candidates");
  return candidateIds.map((candidateId) => {
    const expectedRevision = expected.candidateRevisions[candidateId];
    if (!Number.isInteger(expectedRevision)) throw new HandoffValidationError("policy_rejected", `candidate ${candidateId} is outside the immutable context snapshot`);
    const path = join(root, `${candidateId.slice("sha256:".length)}.json`);
    if (!existsSync(path)) throw new HandoffValidationError("policy_rejected", `source candidate not found: ${candidateId}`);
    const candidate = readJson(path);
    if (candidate.workspaceId !== handoff.workspaceId) throw new HandoffValidationError("authorization_failed", "source candidate belongs to another workspace");
    if (candidate.lifecycle?.revision !== expectedRevision || candidate.lifecycle?.status !== "pending") {
      throw new HandoffValidationError("policy_rejected", `source candidate revision changed: ${candidateId}`);
    }
    if (candidate.scopeCeiling?.level !== action.payload.scope.level || candidate.scopeCeiling?.subject !== action.payload.scope.subject) {
      throw new HandoffValidationError("policy_rejected", "action scope must exactly match its memory candidate scope ceiling");
    }
    return candidate;
  });
}

function actorForAction(
  options: ApplicatorOptions,
  config: ReturnType<typeof workspaceConfig>,
  action: AnyAction,
  signals: JsonObject[],
): TrustedActorContext | null {
  const declared = action.payload.authorizationResult;
  const principalId = declared.principalId;
  for (const signal of signals) {
    const captured = signal.authorizationDecision || {};
    if (
      captured.principalId !== principalId
      || captured.status !== declared.status
      || captured.grantId !== declared.grantId
      || captured.registryRevision !== declared.registryRevision
      || captured.registryDigest !== declared.registryDigest
    ) {
      throw new HandoffValidationError("authorization_failed", "handoff authorization does not match frozen source authorization");
    }
    if (!["pending", "review_required", "reviewed"].includes(signal.status)) {
      throw new HandoffValidationError("policy_rejected", `source signal is not eligible: ${signal.id}`);
    }
  }
  if (!principalId) return null;
  const explicit = options.trustedActorContexts?.[principalId];
  if (explicit) return explicit;
  if (!signals.length || signals.some((signal) => signal.scope?.level !== "person")) return null;
  const actorRefs = new Set(signals.flatMap((signal) => (signal.evidence || []).map((evidence: JsonObject) => String(evidence.actorRef || ""))));
  if (actorRefs.size !== 1) return null;
  const match = /^([^:]+):user:(.+)$/.exec([...actorRefs][0]);
  if (!match || signals.some((signal) => signal.scope?.subject !== `${match[1]}:${match[2]}`)) return null;
  const loaded = loadActorRegistry(config.actorRegistryPath);
  if (loaded.registry.revision !== declared.registryRevision || loaded.digest !== declared.registryDigest) return null;
  const principal = (loaded.registry.principals as Array<JsonObject>).filter((entry) => entry.principalId === principalId);
  if (principal.length !== 1) return null;
  const bindings = (principal[0].transportBindings || []).filter((binding: JsonObject) => (
    binding.channel === match[1] && String(binding.actorId) === match[2]
  ));
  if (bindings.length !== 1) return null;
  return {
    trusted: true,
    channel: match[1],
    accountId: String(bindings[0].accountId),
    actorId: match[2],
    contextKind: "direct",
  };
}

function notificationSessionForSignalRule(action: AnyAction): string | null {
  if (!action.payload.sourceSignals.length || action.payload.scope.level !== "person") return null;
  const match = /^telegram:(\d+)$/.exec(action.payload.scope.subject);
  return match ? `telegram-direct-${match[1]}` : null;
}

function finalizeActiveSignalRule(options: {
  applicator: ApplicatorOptions;
  config: ReturnType<typeof workspaceConfig>;
  handoff: AnyHandoff;
  action: AnyAction;
  operationId: Digest;
  rule: JsonObject;
  now: string;
}): void {
  if (options.handoff.schema !== "oll.rethink-handoff.v3"
    || options.config.mode !== "active" || options.action.type !== "propose_rule"
    || !options.action.payload.sourceSignals.length || options.rule.status !== "active") return;
  const notificationSession = notificationSessionForSignalRule(options.action);
  if (!notificationSession) throw new HandoffValidationError("policy_rejected", "active signal rule has no routable notification session");
  queueRuleActivationNotification({
    workspace: options.applicator.workspace,
    ruleId: options.rule.id,
    batchId: options.handoff.batchId,
    planId: options.operationId,
    operationId: options.operationId,
    notificationSession,
    now: options.now,
  });
  for (const signalId of options.action.payload.sourceSignals) {
    const expectedRevision = options.applicator.expected.signalRevisions[signalId];
    const path = join(resolve(options.applicator.workspace), "memory-state", "oll", "signals", `${signalId}.json`);
    const signal = readJson(path);
    if (signal.status === "applied" && signal.revision === expectedRevision + 1) continue;
    if (!["pending", "reviewed"].includes(signal.status) || signal.revision !== expectedRevision) {
      throw new HandoffValidationError("policy_rejected", `source signal finalization conflict: ${signalId}`);
    }
    transitionAdaptationSignal({
      workspace: options.applicator.workspace,
      stateRoot: options.applicator.stateRoot,
      signalId,
      expectedRevision,
      status: "applied",
      now: options.now,
    });
  }
}

function ruleActivationRequiresReview(
  workspace: string,
  stateRoot: string,
  workspaceId: string,
  candidate: JsonObject,
  maxBytes: number,
  now: string,
): boolean {
  return preflightRuleActivation({
    workspace,
    stateRoot,
    workspaceId,
    candidateRule: candidate,
    maxBytes,
    now,
  }).reviewRequired;
}

function operationPath(workspace: string, operationId: Digest): string {
  // `sha256:<hex>` is a namespaced identifier, but `:` is not a valid
  // Windows filename character. The validated digest body remains unique.
  return join(workspace, "memory-state", "oll", "operations", `${operationId.slice("sha256:".length)}.json`);
}

function loadOrCreateOperation(
  workspace: string,
  handoff: AnyHandoff,
  action: AnyAction,
  operationId: Digest,
  payloadDigest: Digest,
  intendedArtifactRef: string | null,
  intendedStatus: string | null,
  now: string,
): OperationRecord {
  const path = operationPath(workspace, operationId);
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) {
    const existing = readJson(path) as OperationRecord;
    if (existing.payloadDigest !== payloadDigest || existing.actionId !== action.actionId || existing.runId !== handoff.runId) {
      throw new HandoffValidationError("policy_rejected", "operationId was reused with different content");
    }
    return existing;
  }
  const record: OperationRecord = {
    schema: "oll.adaptation-operation.v1",
    operationId,
    workspaceId: handoff.workspaceId,
    runId: handoff.runId,
    actionId: action.actionId,
    payloadDigest,
    actionType: action.type,
    status: "intent_recorded",
    intendedArtifactRef,
    intendedStatus,
    expectedRuleRevision: action.payload.expectedRuleRevision,
    artifactRef: null,
    artifactDigest: null,
    disposition: null,
    revision: 1,
    updatedAt: now,
  };
  atomicWriteJson(path, record);
  return record;
}

function updateOperation(workspace: string, current: OperationRecord, patch: Partial<OperationRecord>, now: string): OperationRecord {
  const next = { ...current, ...patch, revision: current.revision + 1, updatedAt: now };
  atomicWriteJson(operationPath(workspace, current.operationId), next);
  return next;
}

function rejectionDisposition(
  options: ApplicatorOptions,
  eventsDir: string,
  handoff: AnyHandoff,
  action: AnyAction,
  operation: OperationRecord,
  payloadDigest: Digest,
  reason: string,
  now: string,
): { event: JournalEvent; operation: OperationRecord } {
  const next = updateOperation(options.workspace, operation, { status: "policy_rejected", disposition: "policy_rejected" }, now);
  const event = appendJournal(eventsDir, {
    workspaceId: handoff.workspaceId,
    runId: handoff.runId,
    transition: "policy_rejected",
    actionId: action.actionId,
    operationId: operation.operationId,
    payloadDigest,
    artifactRef: null,
    artifactDigest: null,
    projectionDigest: sha256Digest(reason),
    createdAt: now,
  }, options.faultInjector);
  return { event, operation: next };
}

function applyAction(
  options: ApplicatorOptions,
  config: ReturnType<typeof workspaceConfig>,
  eventsDir: string,
  handoff: AnyHandoff,
  action: AnyAction,
  now: string,
): { event: JournalEvent; operation: OperationRecord } {
  const payloadDigest = sha256Digest(canonicalizeJcs(action.payload));
  const operationId = computeOperationId(handoff.workspaceId, handoff.runId, action.actionId);
  const replacementId = deterministicRuleId(action.actionId);
  const targetRuleId = action.type === "propose_rule" ? replacementId : String(action.payload.ruleId);
  const targetPath = rulePath(options.workspace, config.companyRoot, action.payload.scope.level, targetRuleId);
  let operation = loadOrCreateOperation(
    options.workspace,
    handoff,
    action,
    operationId,
    payloadDigest,
    artifactRef(options.workspace, targetPath),
    action.type === "propose_rule" ? "proposed" : ({
      activate_rule: "active",
      suspend_rule: "suspended",
      reject_rule: "rejected",
      supersede_rule: "superseded",
    } as Record<string, string>)[action.type],
    now,
  );
  appendJournal(eventsDir, {
    workspaceId: handoff.workspaceId,
    runId: handoff.runId,
    transition: "intent_recorded",
    actionId: action.actionId,
    operationId,
    payloadDigest,
    artifactRef: operation.intendedArtifactRef,
    artifactDigest: null,
    projectionDigest: null,
    createdAt: now,
  }, options.faultInjector);

  const existingTerminal = terminalActionEvent(journalEvents(eventsDir), action.actionId);
  if (existingTerminal) return { event: existingTerminal, operation };
  if (["effect_committed", "verified", "review_pending", "policy_rejected"].includes(operation.status)) {
    if (operation.status === "policy_rejected") {
      return rejectionDisposition(options, eventsDir, handoff, action, operation, payloadDigest, "recovered policy rejection", now);
    }
    if (!operation.artifactRef || !operation.artifactDigest) throw new Error("committed operation is missing artifact evidence");
    const committedPath = resolve(operation.artifactRef.startsWith(sep) ? operation.artifactRef : join(options.workspace, operation.artifactRef));
    if (!existsSync(committedPath) || fileDigest(committedPath) !== operation.artifactDigest) throw new Error("committed operation artifact drift");
    if (operation.status === "review_pending") {
      return {
        operation,
        event: appendJournal(eventsDir, {
          workspaceId: handoff.workspaceId, runId: handoff.runId, transition: "review_pending",
          actionId: action.actionId, operationId, payloadDigest, artifactRef: operation.artifactRef,
          artifactDigest: operation.artifactDigest, projectionDigest: null, createdAt: now,
        }, options.faultInjector),
      };
    }
    if (operation.status === "effect_committed" || operation.status === "verified") {
      if (operation.status === "effect_committed") operation = updateOperation(options.workspace, operation, { status: "verified", disposition: "verified" }, now);
      finalizeActiveSignalRule({
        applicator: options,
        config,
        handoff,
        action,
        operationId,
        rule: readJson(committedPath),
        now,
      });
      return {
        operation,
        event: appendJournal(eventsDir, {
          workspaceId: handoff.workspaceId, runId: handoff.runId, transition: "verified",
          actionId: action.actionId, operationId, payloadDigest, artifactRef: operation.artifactRef,
          artifactDigest: operation.artifactDigest, projectionDigest: null, createdAt: now,
        }, options.faultInjector),
      };
    }
  }
  if (action.payload.reviewDisposition === "reject" || action.payload.authorizationResult.status === "denied") {
    return rejectionDisposition(options, eventsDir, handoff, action, operation, payloadDigest, "model disposition or authorization rejected", now);
  }

  const signals = validateSources(options, handoff, action);
  const candidates = validateCandidateSources(options, handoff, action);
  const actorContext = actorForAction(options, config, action, signals);
  const proposalText = action.payload.rule || (existsSync(targetPath) ? String(readJson(targetPath).rule || "") : "");
  const classified = classifyAdaptationRisk({ scope: action.payload.scope, statement: proposalText, expectedBehavior: action.payload.expectedImprovement });
  if (classified.risk !== action.payload.risk) {
    return rejectionDisposition(options, eventsDir, handoff, action, operation, payloadDigest, "model risk does not match deterministic classifier", now);
  }

  const notificationSession = config.mode === "active" && action.type === "propose_rule"
    ? notificationSessionForSignalRule(action)
    : null;
  const policyNeedsReview = classified.reviewRequired
    || candidates.length > 0
    || action.payload.reviewDisposition === "review_required"
    || action.payload.authorizationResult.status !== "authorized"
    || !actorContext
    || (config.mode === "active" && action.type === "propose_rule" && signals.length > 0 && !notificationSession);

  if (action.type !== "propose_rule") {
    if (!existsSync(targetPath)) return rejectionDisposition(options, eventsDir, handoff, action, operation, payloadDigest, "target rule not found", now);
    const target = readJson(targetPath);
    if (target.workspaceId !== handoff.workspaceId || target.scope?.level !== action.payload.scope.level || target.scope?.subject !== action.payload.scope.subject) {
      return rejectionDisposition(options, eventsDir, handoff, action, operation, payloadDigest, "target rule scope mismatch", now);
    }
    if (target.revision !== action.payload.expectedRuleRevision && !(findOperationAudit(options.workspace, config.companyRoot, operationId) && target.status === operation.intendedStatus)) {
      return rejectionDisposition(options, eventsDir, handoff, action, operation, payloadDigest, "target rule revision mismatch", now);
    }
  }

  if (policyNeedsReview && action.type !== "propose_rule") {
    const review = createAdaptationActionReview({
      workspace: options.workspace,
      stateRoot: options.stateRoot,
      scope: action.payload.scope,
      risk: action.payload.risk,
      actionId: action.actionId,
      evaluationId: handoff.evaluationId,
      runId: handoff.runId,
      now,
    });
    const reviewPath = action.payload.scope.level === "company"
      ? join(config.companyRoot, "reviews", `${review.reviewId}.json`)
      : join(options.workspace, "memory-state", "oll", "reviews", `${review.reviewId}.json`);
    const reviewRef = artifactRef(options.workspace, reviewPath);
    const reviewDigest = fileDigest(reviewPath);
    operation = updateOperation(options.workspace, operation, { status: "review_pending", artifactRef: reviewRef, artifactDigest: reviewDigest, disposition: "review_pending" }, now);
    return {
      operation,
      event: appendJournal(eventsDir, {
        workspaceId: handoff.workspaceId, runId: handoff.runId, transition: "review_pending",
        actionId: action.actionId, operationId, payloadDigest, artifactRef: reviewRef,
        artifactDigest: reviewDigest, projectionDigest: null, createdAt: now,
      }, options.faultInjector),
    };
  }

  let finalRule: JsonObject;
  let review: JsonObject | null = null;
  const recoveredEffect = operation.status === "intent_recorded"
    && findOperationAudit(options.workspace, config.companyRoot, operationId)
    && existsSync(targetPath)
    && (readJson(targetPath).status === operation.intendedStatus || (action.type === "propose_rule" && readJson(targetPath).status === "active"));
  if (recoveredEffect) {
    finalRule = readJson(targetPath);
    review = findActionReview(options.workspace, config.companyRoot, action.actionId)?.review || null;
  } else if (action.type === "propose_rule") {
    const proposed = proposeAdaptationRule({
      workspace: options.workspace,
      stateRoot: options.stateRoot,
      scope: action.payload.scope,
      rule: String(action.payload.rule),
      sourceSignals: action.payload.sourceSignals,
      sourceCandidates: actionCandidateIds(action),
      expectedImprovement: action.payload.expectedImprovement,
      costOfInaction: action.payload.costOfInaction,
      rollbackRef: action.payload.rollbackRef,
      runId: handoff.runId,
      actionId: action.actionId,
      operationId,
      ruleId: replacementId,
      rolloutBatchId: handoff.batchId,
      reason: action.payload.rationale,
      forceReview: policyNeedsReview,
      evaluationId: handoff.evaluationId,
      actorContext,
      now,
    });
    finalRule = proposed.rule;
    review = proposed.review || null;
    if (!review && proposed.autoActivationEligible && action.payload.reviewDisposition === "auto_apply") {
      if (ruleActivationRequiresReview(options.workspace, options.stateRoot, config.workspaceId, finalRule, config.maxInjectedRuleBytes, now)) {
        review = createAdaptationActionReview({
          workspace: options.workspace, stateRoot: options.stateRoot, scope: action.payload.scope,
          risk: action.payload.risk, actionId: action.actionId, evaluationId: handoff.evaluationId,
          runId: handoff.runId, now,
        });
      } else {
        finalRule = transitionAdaptationRule({
          workspace: options.workspace,
          stateRoot: options.stateRoot,
          ruleId: finalRule.id,
          expectedRevision: finalRule.revision,
          status: "active",
          actorContext,
          operationId,
          decision: { action: "activate_rule", runId: handoff.runId, actionId: action.actionId, reason: action.payload.rationale },
          now,
        });
      }
    }
  } else if (action.type === "supersede_rule") {
    const replacement = proposeAdaptationRule({
      workspace: options.workspace, stateRoot: options.stateRoot, scope: action.payload.scope,
      rule: String(action.payload.rule), sourceSignals: action.payload.sourceSignals,
      sourceCandidates: actionCandidateIds(action),
      expectedImprovement: action.payload.expectedImprovement, costOfInaction: action.payload.costOfInaction,
      rollbackRef: action.payload.rollbackRef, runId: handoff.runId, actionId: action.actionId,
      operationId, ruleId: replacementId, rolloutBatchId: handoff.batchId, reason: action.payload.rationale,
      evaluationId: handoff.evaluationId, actorContext, now,
    });
    review = replacement.review || null;
    if (review) {
      finalRule = readJson(targetPath);
    } else {
      let replacementRule = replacement.rule;
      if (replacement.autoActivationEligible && replacementRule.status === "proposed") {
        if (ruleActivationRequiresReview(options.workspace, options.stateRoot, config.workspaceId, replacementRule, config.maxInjectedRuleBytes, now)) {
          review = createAdaptationActionReview({
            workspace: options.workspace, stateRoot: options.stateRoot, scope: action.payload.scope,
            risk: action.payload.risk, actionId: action.actionId, evaluationId: handoff.evaluationId,
            runId: handoff.runId, now,
          });
        } else {
          replacementRule = transitionAdaptationRule({
            workspace: options.workspace, stateRoot: options.stateRoot, ruleId: replacementRule.id,
            expectedRevision: replacementRule.revision, status: "active", actorContext,
            operationId, decision: { action: "activate_rule", runId: handoff.runId, actionId: action.actionId, reason: action.payload.rationale }, now,
          });
        }
      }
      finalRule = review ? readJson(targetPath) : transitionAdaptationRule({
        workspace: options.workspace, stateRoot: options.stateRoot, ruleId: targetRuleId,
        expectedRevision: Number(action.payload.expectedRuleRevision), status: "superseded",
        supersededBy: replacementRule.id, operationId,
        decision: { action: "supersede_rule", runId: handoff.runId, actionId: action.actionId, reason: action.payload.rationale }, now,
      });
    }
  } else {
    const targetStatus = action.type === "activate_rule" ? "active" : action.type === "suspend_rule" ? "suspended" : "rejected";
    finalRule = transitionAdaptationRule({
      workspace: options.workspace,
      stateRoot: options.stateRoot,
      ruleId: targetRuleId,
      expectedRevision: Number(action.payload.expectedRuleRevision),
      status: targetStatus,
      actorContext,
      operationId,
      decision: { action: action.type, runId: handoff.runId, actionId: action.actionId, reason: action.payload.rationale },
      now,
    });
  }

  const finalPath = rulePath(options.workspace, config.companyRoot, finalRule.scope.level, finalRule.id);
  const finalRef = artifactRef(options.workspace, finalPath);
  const finalDigest = fileDigest(finalPath);
  operation = updateOperation(options.workspace, operation, {
    status: "effect_committed", artifactRef: finalRef, artifactDigest: finalDigest,
  }, now);
  appendJournal(eventsDir, {
    workspaceId: handoff.workspaceId, runId: handoff.runId, transition: "effect_committed",
    actionId: action.actionId, operationId, payloadDigest, artifactRef: finalRef,
    artifactDigest: finalDigest, projectionDigest: null, createdAt: now,
  }, options.faultInjector);
  if (review) {
    operation = updateOperation(options.workspace, operation, { status: "review_pending", disposition: "review_pending" }, now);
    return {
      operation,
      event: appendJournal(eventsDir, {
        workspaceId: handoff.workspaceId, runId: handoff.runId, transition: "review_pending",
        actionId: action.actionId, operationId, payloadDigest, artifactRef: finalRef,
        artifactDigest: finalDigest, projectionDigest: null, createdAt: now,
      }, options.faultInjector),
    };
  }
  finalizeActiveSignalRule({ applicator: options, config, handoff, action, operationId, rule: finalRule, now });
  if (!existsSync(finalPath) || fileDigest(finalPath) !== finalDigest) throw new Error("artifact verification failed");
  operation = updateOperation(options.workspace, operation, { status: "verified", disposition: "verified" }, now);
  return {
    operation,
    event: appendJournal(eventsDir, {
      workspaceId: handoff.workspaceId, runId: handoff.runId, transition: "verified",
      actionId: action.actionId, operationId, payloadDigest, artifactRef: finalRef,
      artifactDigest: finalDigest, projectionDigest: null, createdAt: now,
    }, options.faultInjector),
  };
}

function quarantine(options: ApplicatorOptions, reason: string, errorClass: string): ApplicatorResult {
  const workspace = resolve(options.workspace);
  const incomingRoot = join(workspace, "memory-state", "oll", "handoffs", "incoming");
  const rejectedRoot = join(workspace, "memory-state", "oll", "handoffs", "rejected");
  const source = resolve(options.expected.expectedHandoffPath);
  assertInside(incomingRoot, source, "expected handoff path");
  mkdirSync(rejectedRoot, { recursive: true });
  const target = join(rejectedRoot, `${options.expected.runId}.json`);
  if (existsSync(source) && !existsSync(target)) renameSync(source, target);
  const reasonPath = join(rejectedRoot, `${options.expected.runId}.rejection.json`);
  atomicWriteJson(reasonPath, {
    schema: "oll.handoff-rejection.v1",
    workspaceId: options.expected.workspaceId,
    runId: options.expected.runId,
    errorClass,
    reason,
    rejectedAt: options.now || new Date().toISOString(),
  });
  return {
    status: "rejected", workspaceId: options.expected.workspaceId, runId: options.expected.runId,
    handoffDigest: null, dispositions: [], projectionDigest: null,
    rejectedPath: target, errorClass, reason,
  };
}

export function applyRethinkHandoffFile(options: ApplicatorOptions): ApplicatorResult {
  const workspace = resolve(options.workspace);
  const config = workspaceConfig(workspace, options.stateRoot);
  if (config.workspaceId !== options.expected.workspaceId) throw new HandoffValidationError("correlation_mismatch", "workspace configuration ID mismatch");
  const ollRoot = join(workspace, "memory-state", "oll");
  const incomingRoot = join(ollRoot, "handoffs", "incoming");
  const appliedRoot = join(ollRoot, "handoffs", "applied");
  const expectedPath = resolve(options.expected.expectedHandoffPath);
  const canonicalExpected = join(incomingRoot, `${options.expected.runId}.json`);
  if (expectedPath !== canonicalExpected) throw new HandoffValidationError("correlation_mismatch", "expected handoff path is not the canonical incoming path");
  return withApplicatorLock(ollRoot, () => {
    const eventsDir = join(ollRoot, "apply-journal", options.expected.runId, "events");
    const priorEvents = journalEvents(eventsDir);
    const priorTerminal = priorEvents.find((event) => event.transition === "terminal");
    if (priorTerminal) {
      mkdirSync(appliedRoot, { recursive: true });
      const recoveredAppliedPath = join(appliedRoot, `${options.expected.runId}.json`);
      if (existsSync(expectedPath) && !existsSync(recoveredAppliedPath)) renameSync(expectedPath, recoveredAppliedPath);
      return {
        status: "replayed",
        workspaceId: options.expected.workspaceId,
        runId: options.expected.runId,
        handoffDigest: null,
        dispositions: priorEvents.filter((event) => ["verified", "review_pending", "policy_rejected"].includes(event.transition)).map((event) => ({
          actionId: event.actionId!, operationId: event.operationId!, disposition: event.transition, artifactRef: event.artifactRef,
        })),
        projectionDigest: priorTerminal.projectionDigest,
        appliedPath: recoveredAppliedPath,
      };
    }
    const rejectedPath = join(ollRoot, "handoffs", "rejected", `${options.expected.runId}.json`);
    const rejectionPath = join(ollRoot, "handoffs", "rejected", `${options.expected.runId}.rejection.json`);
    if (!existsSync(expectedPath) && existsSync(rejectedPath) && existsSync(rejectionPath)) {
      const rejection = readJson(rejectionPath);
      return {
        status: "rejected", workspaceId: options.expected.workspaceId, runId: options.expected.runId,
        handoffDigest: null, dispositions: [], projectionDigest: null, rejectedPath,
        errorClass: rejection.errorClass, reason: rejection.reason,
      };
    }
    if (!existsSync(expectedPath)) throw new HandoffValidationError("handoff_timeout", "expected handoff file is unavailable");
    if (!lstatSync(expectedPath).isFile() || lstatSync(expectedPath).isSymbolicLink()) {
      return quarantine(options, "handoff target must be a regular non-symlink file", "schema_invalid");
    }
    const now = options.now || new Date().toISOString();
    appendJournal(eventsDir, {
      workspaceId: options.expected.workspaceId, runId: options.expected.runId, transition: "received",
      actionId: null, operationId: null, payloadDigest: null, artifactRef: artifactRef(workspace, expectedPath),
      artifactDigest: fileDigest(expectedPath), projectionDigest: null, createdAt: now,
    }, options.faultInjector);
    let handoff: AnyHandoff;
    try {
      handoff = "candidateRevisions" in options.expected
        ? parseRethinkHandoffV3(readFileSync(expectedPath), options.expected, expectedPath)
        : parseRethinkHandoffV2(readFileSync(expectedPath), options.expected, expectedPath);
    } catch (error) {
      if (error instanceof HandoffValidationError) return quarantine(options, error.message, error.code);
      return quarantine(options, String(error), "schema_invalid");
    }
    appendJournal(eventsDir, {
      workspaceId: handoff.workspaceId, runId: handoff.runId, transition: "validated",
      actionId: null, operationId: null, payloadDigest: null, artifactRef: artifactRef(workspace, expectedPath),
      artifactDigest: handoff.handoffDigest, projectionDigest: null, createdAt: now,
    }, options.faultInjector);
    const dispositions = handoff.actions.map((action) => {
      try {
        const applied = applyAction(options, config, eventsDir, handoff, action, now);
        return {
          actionId: action.actionId,
          operationId: applied.operation.operationId,
          disposition: applied.event.transition,
          artifactRef: applied.event.artifactRef,
        };
      } catch (error) {
        if (!(error instanceof HandoffValidationError)) throw error;
        const payloadDigest = sha256Digest(canonicalizeJcs(action.payload));
        const operationId = computeOperationId(handoff.workspaceId, handoff.runId, action.actionId);
        const operation = loadOrCreateOperation(workspace, handoff, action, operationId, payloadDigest, null, null, now);
        const rejected = rejectionDisposition(options, eventsDir, handoff, action, operation, payloadDigest, error.message, now);
        return { actionId: action.actionId, operationId, disposition: rejected.event.transition, artifactRef: null };
      }
    });
    const candidateDispositions = handoff.schema === "oll.rethink-handoff.v3" && options.skipCandidateDispositions !== true
      ? handoff.candidateDispositions.map((item) => {
          const citedActions = handoff.actions.filter((action) => action.payload.sourceCandidates.includes(item.candidateId));
          const accepted = citedActions.some((action) => dispositions.some((result) => (
            result.actionId === action.actionId && ["verified", "review_pending"].includes(result.disposition)
          )));
          const disposition = item.disposition === "consumed" && !accepted ? "deferred" : item.disposition;
          return transitionMemoryCandidate({
            workspace,
            workspaceId: handoff.workspaceId,
            candidateId: item.candidateId,
            expectedRevision: item.expectedRevision,
            disposition,
            now,
          });
        })
      : [];
    const projectionDigest = handoff.schema === "oll.rethink-handoff.v3"
      ? sha256Digest(canonicalizeJcs({
          actions: dispositions,
          candidates: candidateDispositions.map((candidate) => ({
            candidateId: candidate.candidateId,
            revision: candidate.lifecycle.revision,
            status: candidate.lifecycle.status,
            disposition: candidate.lifecycle.disposition,
          })),
        }))
      : sha256Digest(canonicalizeJcs(dispositions));
    if (handoff.schema === "oll.rethink-handoff.v3") appendJournal(eventsDir, {
      workspaceId: handoff.workspaceId,
      runId: handoff.runId,
      transition: "candidate_dispositions_committed",
      actionId: null,
      operationId: null,
      payloadDigest: null,
      artifactRef: null,
      artifactDigest: null,
      projectionDigest,
      createdAt: now,
    }, options.faultInjector);
    appendJournal(eventsDir, {
      workspaceId: handoff.workspaceId, runId: handoff.runId, transition: "terminal",
      actionId: null, operationId: null, payloadDigest: null, artifactRef: null,
      artifactDigest: null, projectionDigest, createdAt: now,
    }, options.faultInjector);
    mkdirSync(appliedRoot, { recursive: true });
    const appliedPath = join(appliedRoot, `${handoff.runId}.json`);
    if (!existsSync(appliedPath)) renameSync(expectedPath, appliedPath);
    return { status: "terminal", workspaceId: handoff.workspaceId, runId: handoff.runId, handoffDigest: handoff.handoffDigest, dispositions, projectionDigest, appliedPath };
  });
}
