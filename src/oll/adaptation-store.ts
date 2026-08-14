import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { atomicWriteJson } from "./legacy-migration";
import {
  AdaptationRisk,
  AdaptationScope,
  classifyAdaptationRisk,
  loadActorRegistry,
  authorizeAdaptationAction,
  TrustedActorContext,
} from "./authorization";

type JsonObject = Record<string, any>;
type SignalType = "correction" | "preference" | "workflow" | "quality";
type SignalStatus = "pending" | "review_required" | "reviewed" | "applied" | "rejected" | "superseded";
type RuleStatus = "proposed" | "active" | "rejected" | "suspended" | "superseded";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const STORE_LOCK_STALE_MS = 30_000;
const STORE_LOCK_WAIT_MS = 5_000;

export class AdaptationStoreError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "AdaptationStoreError";
    this.code = code;
  }
}

function hash(value: string | Buffer): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function normalizeText(value: unknown, max: number, field: string): string {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) throw new AdaptationStoreError("invalid_input", `${field} is required`);
  if (Buffer.byteLength(text, "utf8") > max * 4 || text.length > max) {
    throw new AdaptationStoreError("invalid_input", `${field} exceeds ${max} characters`);
  }
  return text;
}

function readJson(path: string): JsonObject {
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must contain an object`);
  return value;
}

function assertInside(root: string, path: string): void {
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  if (path !== root && !path.startsWith(prefix)) throw new AdaptationStoreError("path_escape", `path escapes allowed root: ${path}`);
}

function safeId(id: string, field = "id"): string {
  if (!UUID_RE.test(id)) throw new AdaptationStoreError("invalid_id", `${field} must be a UUID`);
  return id;
}

function pathsForRoot(workspace: string, root: string) {
  const workspaceRoot = resolve(workspace);
  const managedRoot = resolve(root);
  return {
    workspace: workspaceRoot,
    root: managedRoot,
    signals: join(managedRoot, "signals"),
    rules: join(managedRoot, "rules"),
    reviews: join(managedRoot, "reviews"),
    operations: join(managedRoot, "operations"),
    audit: join(managedRoot, "audit"),
    lock: join(managedRoot, ".adaptation-store.lock"),
  };
}

function storePaths(workspace: string) {
  const workspaceRoot = resolve(workspace);
  return pathsForRoot(workspaceRoot, join(workspaceRoot, "memory-state", "oll"));
}

function sleepSync(ms: number): void {
  const wait = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(wait, 0, 0, ms);
}

function withPathsLock<T>(paths: ReturnType<typeof storePaths>, fn: () => T): T {
  mkdirSync(paths.root, { recursive: true });
  const started = Date.now();
  while (true) {
    try {
      mkdirSync(paths.lock);
      break;
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
      let stale = false;
      try { stale = Date.now() - statSync(paths.lock).mtimeMs > STORE_LOCK_STALE_MS; } catch { stale = false; }
      if (stale) {
        rmSync(paths.lock, { recursive: true, force: true });
        continue;
      }
      if (Date.now() - started >= STORE_LOCK_WAIT_MS) throw new AdaptationStoreError("lock_timeout", "adaptation store lock timeout");
      sleepSync(20);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(paths.lock, { recursive: true, force: true });
  }
}

function withStoreLock<T>(workspace: string, fn: () => T): T {
  return withPathsLock(storePaths(workspace), fn);
}

function workspaceConfig(workspace: string, stateRoot: string): {
  config: JsonObject;
  workspaceId: string;
  actorRegistryPath: string;
  companyRuleStorePath: string;
  mode: "disabled" | "observe-only" | "active";
} {
  const root = resolve(workspace);
  const config = readJson(join(root, "engram.json"));
  const workspaceId = String(config?.workspace?.id || "");
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(workspaceId)) throw new AdaptationStoreError("invalid_workspace", "engram.json workspace.id is required");
  const actorSetting = String(config?.oll?.adaptation?.actorRegistry || "${ENGRAM_STATE_ROOT}/oll/actors.v1.json");
  const actorRegistryPath = resolve(actorSetting.replaceAll("${ENGRAM_STATE_ROOT}", resolve(stateRoot)));
  assertInside(resolve(stateRoot), actorRegistryPath);
  const companySetting = String(config?.oll?.adaptation?.companyRuleStore || "${ENGRAM_STATE_ROOT}/oll/company-rules");
  const companyRuleStorePath = resolve(companySetting.replaceAll("${ENGRAM_STATE_ROOT}", resolve(stateRoot)));
  assertInside(resolve(stateRoot), companyRuleStorePath);
  const mode = config?.oll?.adaptation?.mode;
  if (!["disabled", "observe-only", "active"].includes(mode)) throw new AdaptationStoreError("invalid_config", "oll.adaptation.mode is invalid");
  return { config, workspaceId, actorRegistryPath, companyRuleStorePath, mode };
}

function scopeForSignal(scope: AdaptationScope): { level: AdaptationScope["level"]; subject: string; domain: string | null } {
  const subject = normalizeText(scope.subject, 300, "scope.subject");
  return { level: scope.level, subject, domain: scope.domain == null ? null : normalizeText(scope.domain, 300, "scope.domain") };
}

function scopeForRule(scope: AdaptationScope): { level: AdaptationScope["level"]; subject: string } {
  return { level: scope.level, subject: normalizeText(scope.subject, 300, "scope.subject") };
}

function assertScopeOwned(paths: ReturnType<typeof storePaths>, workspaceId: string, scope: AdaptationScope): void {
  if (scope.level === "workspace" && scope.subject !== workspaceId) {
    throw new AdaptationStoreError("cross_workspace", "workspace scope subject does not match the owning workspace");
  }
  if (scope.level === "domain") {
    const domain = String(scope.domain || scope.subject || "");
    const domainPath = resolve(paths.workspace, "memory", "domains", domain);
    assertInside(resolve(paths.workspace, "memory", "domains"), domainPath);
    if (!existsSync(domainPath)) throw new AdaptationStoreError("unknown_domain", `domain is not owned by this workspace: ${domain}`);
  }
}

function nextAuditSequence(path: string): number {
  if (!existsSync(path)) return 1;
  let max = 0;
  for (const name of readdirSync(path)) {
    const match = name.match(/^(\d+)-/);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max + 1;
}

function writeAudit(paths: ReturnType<typeof storePaths>, event: JsonObject): string {
  mkdirSync(paths.audit, { recursive: true });
  const idempotencyKey = event.operationId || event.mutationId || null;
  if (idempotencyKey) {
    for (const name of readdirSync(paths.audit).filter((entry) => entry.endsWith(".json"))) {
      const candidatePath = join(paths.audit, name);
      const candidate = readJson(candidatePath);
      if (
        candidate.type === event.type
        && (candidate.operationId || candidate.mutationId) === idempotencyKey
        && (!event.operationId || candidate.artifactRef === event.artifactRef)
      ) return candidatePath;
    }
  }
  const sequence = nextAuditSequence(paths.audit);
  const eventId = randomUUID();
  const path = join(paths.audit, `${String(sequence).padStart(8, "0")}-${eventId}.json`);
  atomicWriteJson(path, {
    schema: "oll.adaptation-audit-event.v1",
    eventId,
    sequence,
    ...event,
  });
  return path;
}

function listRecords(path: string): JsonObject[] {
  if (!existsSync(path)) return [];
  return readdirSync(path)
    .filter((name) => UUID_RE.test(name.replace(/\.json$/, "")) && name.endsWith(".json"))
    .sort()
    .map((name) => readJson(join(path, name)));
}

function loadRegistryOrNull(path: string) {
  try { return loadActorRegistry(path); } catch { return null; }
}

function evidenceRecord(options: {
  sourceType: "message" | "daily-note" | "transcript" | "import" | "system";
  sourceRef: string;
  evidenceContent: string;
  actorContext?: TrustedActorContext | null;
  redactionClass?: "minimal" | "sensitive" | "restricted";
  capturedAt: string;
}) {
  return {
    sourceType: options.sourceType,
    sourceRef: normalizeText(options.sourceRef, 1000, "evidence.sourceRef"),
    actorRef: options.actorContext?.trusted
      ? `${options.actorContext.channel}:user:${options.actorContext.actorId}`
      : null,
    contentDigest: hash(String(options.evidenceContent || "")),
    redactionClass: options.redactionClass || "minimal",
    capturedAt: options.capturedAt,
  };
}

export function captureAdaptationSignal(options: {
  workspace: string;
  stateRoot: string;
  type: SignalType;
  scope: AdaptationScope;
  statement: string;
  expectedBehavior: string;
  sourceType: "message" | "daily-note" | "transcript" | "import" | "system";
  sourceRef: string;
  evidenceContent: string;
  actorContext?: TrustedActorContext | null;
  capturedBy: string;
  redactionClass?: "minimal" | "sensitive" | "restricted";
  confidence?: number;
  explicit?: boolean;
  now?: string;
}): JsonObject {
  if (!["correction", "preference", "workflow", "quality"].includes(options.type)) throw new AdaptationStoreError("invalid_input", "invalid signal type");
  const now = options.now || new Date().toISOString();
  if (!Number.isFinite(Date.parse(now))) throw new AdaptationStoreError("invalid_input", "invalid capture timestamp");
  const paths = storePaths(options.workspace);
  const resolved = workspaceConfig(paths.workspace, options.stateRoot);
  if (resolved.mode === "disabled") throw new AdaptationStoreError("disabled", "adaptation capture is disabled");
  const scope = scopeForSignal(options.scope);
  assertScopeOwned(paths, resolved.workspaceId, scope);
  const statement = normalizeText(options.statement, 2000, "statement");
  const expectedBehavior = normalizeText(options.expectedBehavior, 4000, "expectedBehavior");
  const evidence = evidenceRecord({ ...options, capturedAt: now });
  const registry = loadRegistryOrNull(resolved.actorRegistryPath);
  const risk = classifyAdaptationRisk({ scope, statement, expectedBehavior });
  const authorization = authorizeAdaptationAction({
    registry,
    actorContext: options.actorContext || null,
    workspaceId: resolved.workspaceId,
    scope,
    action: "signal:create",
    risk: risk.risk,
    sourceType: options.sourceType,
  });
  const normalizedStatement = statement.toLocaleLowerCase("und");
  const dedupKey = hash(JSON.stringify({
    workspaceId: resolved.workspaceId,
    statement: normalizedStatement,
    scope,
    actor: authorization.principalId || evidence.actorRef,
    evidenceDigest: evidence.contentDigest,
  }));
  return withStoreLock(paths.workspace, () => {
    mkdirSync(paths.signals, { recursive: true });
    const duplicate = listRecords(paths.signals).find((record) => record.dedupKey === dedupKey);
    if (duplicate) return { status: "deduplicated", created: false, signal: duplicate, risk };
    const id = randomUUID();
    const inferredPreference = options.type === "preference" && options.explicit === false;
    const status: SignalStatus = authorization.status === "authorized" && !inferredPreference
      ? "pending"
      : "review_required";
    const confidence = options.confidence ?? (options.type === "correction" && options.explicit !== false ? 1 : 0.8);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new AdaptationStoreError("invalid_input", "confidence must be between 0 and 1");
    const signal = {
      schema: "oll.adaptation-signal.v1",
      id,
      workspaceId: resolved.workspaceId,
      type: options.type,
      scope,
      statement,
      expectedBehavior,
      evidence: [evidence],
      capturedBy: normalizeText(options.capturedBy, 200, "capturedBy"),
      authorizationDecision: authorization,
      dedupKey,
      confidence,
      status,
      createdAt: now,
      reviewedAt: null,
      revision: 1,
    };
    writeAudit(paths, {
      workspaceId: resolved.workspaceId,
      type: "signal_captured",
      mutationId: dedupKey,
      artifactRef: `signals/${id}.json`,
      artifactDigest: hash(JSON.stringify(signal)),
      authorization: {
        status: authorization.status,
        principalId: authorization.principalId,
        grantId: authorization.grantId,
        registryRevision: authorization.registryRevision,
      },
      createdAt: now,
    });
    atomicWriteJson(join(paths.signals, `${id}.json`), signal);
    return {
      status: "created",
      created: true,
      signal,
      risk,
      autoActivationEligible: status === "pending" && !risk.reviewRequired && authorization.status === "authorized",
    };
  });
}

export function listPendingAdaptationSignals(options: { workspace: string; stateRoot: string }): JsonObject[] {
  const paths = storePaths(options.workspace);
  const resolved = workspaceConfig(paths.workspace, options.stateRoot);
  return listRecords(paths.signals).filter((signal) => {
    if (signal.workspaceId !== resolved.workspaceId) throw new AdaptationStoreError("cross_workspace", `foreign signal projection ${signal.id}`);
    return signal.status === "pending" || signal.status === "review_required";
  });
}

export function transitionAdaptationSignal(options: {
  workspace: string;
  stateRoot: string;
  signalId: string;
  expectedRevision: number;
  status: SignalStatus;
  now?: string;
}): JsonObject {
  const paths = storePaths(options.workspace);
  const resolved = workspaceConfig(paths.workspace, options.stateRoot);
  const id = safeId(options.signalId, "signalId");
  const now = options.now || new Date().toISOString();
  return withStoreLock(paths.workspace, () => {
    const path = join(paths.signals, `${id}.json`);
    if (!existsSync(path)) throw new AdaptationStoreError("not_found", "signal not found");
    const current = readJson(path);
    if (current.workspaceId !== resolved.workspaceId) throw new AdaptationStoreError("cross_workspace", "signal belongs to another workspace");
    if (current.revision !== options.expectedRevision) throw new AdaptationStoreError("revision_conflict", "signal revision mismatch");
    const allowed: Record<string, SignalStatus[]> = {
      pending: ["reviewed", "applied", "rejected", "superseded"],
      review_required: ["reviewed", "rejected", "superseded"],
      reviewed: ["applied", "rejected", "superseded"],
      applied: ["superseded"],
      rejected: [],
      superseded: [],
    };
    if (!allowed[current.status]?.includes(options.status)) throw new AdaptationStoreError("invalid_transition", `${current.status} -> ${options.status} is not allowed`);
    const next = { ...current, status: options.status, reviewedAt: ["reviewed", "rejected"].includes(options.status) ? now : current.reviewedAt, revision: current.revision + 1 };
    writeAudit(paths, { workspaceId: resolved.workspaceId, type: "signal_transition", artifactRef: `signals/${id}.json`, from: current.status, to: options.status, revision: next.revision, createdAt: now });
    atomicWriteJson(path, next);
    return next;
  });
}

function contentDigestForRule(input: JsonObject): `sha256:${string}` {
  return hash(JSON.stringify({
    workspaceId: input.workspaceId,
    scope: input.scope,
    rule: input.rule,
    priority: Number(input.priority || 0),
    sourceSignals: [...input.sourceSignals].sort(),
    sourceCandidates: [...(input.sourceCandidates || [])].sort(),
    risk: input.risk,
    expectedImprovement: input.expectedImprovement,
    costOfInaction: input.costOfInaction,
  }));
}

function createReview(paths: ReturnType<typeof storePaths>, input: {
  workspaceId: string;
  scope: { level: AdaptationScope["level"]; subject: string };
  risk: AdaptationRisk;
  actionId: string;
  evaluationId?: string | null;
  runId?: string | null;
  now: string;
}): JsonObject {
  mkdirSync(paths.reviews, { recursive: true });
  const existing = listRecords(paths.reviews).find((review) => (
    review.workspaceId === input.workspaceId
      && review.actionId === input.actionId
      && review.evaluationId === (input.evaluationId || null)
      && review.runId === (input.runId || null)
  ));
  if (existing) return existing;
  const reviewId = randomUUID();
  const expiresAt = new Date(Date.parse(input.now) + 30 * 86_400_000).toISOString();
  const review = {
    schema: "oll.adaptation-review.v1",
    reviewId,
    workspaceId: input.workspaceId,
    evaluationId: input.evaluationId || null,
    runId: input.runId || null,
    actionId: input.actionId,
    requestedScope: input.scope,
    risk: input.risk,
    requiredGrant: "rule:approve",
    status: "pending",
    requestedAt: input.now,
    expiresAt,
    decision: null,
    revision: 1,
  };
  atomicWriteJson(join(paths.reviews, `${reviewId}.json`), review);
  return review;
}

export function proposeAdaptationRule(options: {
  workspace: string;
  stateRoot: string;
  scope: AdaptationScope;
  rule: string;
  sourceSignals: string[];
  sourceCandidates?: string[];
  expectedImprovement: string;
  costOfInaction: string;
  rollbackRef: string;
  runId: string;
  actionId: string;
  operationId?: string | null;
  ruleId?: string | null;
  rolloutBatchId?: string | null;
  reason?: string | null;
  forceReview?: boolean;
  evaluationId?: string | null;
  actorContext?: TrustedActorContext | null;
  now?: string;
}): JsonObject {
  const paths = storePaths(options.workspace);
  const resolved = workspaceConfig(paths.workspace, options.stateRoot);
  const scope = scopeForRule(options.scope);
  assertScopeOwned(paths, resolved.workspaceId, { ...scope, domain: options.scope.domain });
  const projectionPaths = scope.level === "company"
    ? pathsForRoot(paths.workspace, resolved.companyRuleStorePath)
    : paths;
  const ruleText = normalizeText(options.rule, 4000, "rule");
  const expectedImprovement = normalizeText(options.expectedImprovement, 2000, "expectedImprovement");
  const costOfInaction = normalizeText(options.costOfInaction, 2000, "costOfInaction");
  const rollbackRef = normalizeText(options.rollbackRef, 500, "rollbackRef");
  const runId = safeId(options.runId, "runId");
  if (!DIGEST_RE.test(options.actionId)) throw new AdaptationStoreError("invalid_input", "actionId must be a sha256 digest");
  if (options.operationId && !DIGEST_RE.test(options.operationId)) throw new AdaptationStoreError("invalid_input", "operationId must be a sha256 digest");
  const now = options.now || new Date().toISOString();
  const risk = classifyAdaptationRisk({ scope, statement: ruleText, expectedBehavior: expectedImprovement });
  return withPathsLock(projectionPaths, () => {
    const signals = options.sourceSignals.map((id) => {
      const signalId = safeId(id, "sourceSignal");
      const path = join(paths.signals, `${signalId}.json`);
      if (!existsSync(path)) throw new AdaptationStoreError("not_found", `source signal not found: ${signalId}`);
      const signal = readJson(path);
      if (signal.workspaceId !== resolved.workspaceId) throw new AdaptationStoreError("cross_workspace", "source signal belongs to another workspace");
      if (signal.scope.level !== scope.level || signal.scope.subject !== scope.subject) throw new AdaptationStoreError("scope_mismatch", "rule scope does not match its source signal");
      return signal;
    });
    const registry = loadRegistryOrNull(resolved.actorRegistryPath);
    const autoAuthorization = authorizeAdaptationAction({
      registry,
      actorContext: options.actorContext || null,
      workspaceId: resolved.workspaceId,
      scope,
      action: "rule:auto-activate",
      risk: risk.risk,
      sourceType: "message",
    });
    const id = options.ruleId ? safeId(options.ruleId, "ruleId") : randomUUID();
    const draft: JsonObject = {
      schema: "oll.adaptation-rule.v1",
      id,
      workspaceId: resolved.workspaceId,
      scope,
      rule: ruleText,
      priority: 0,
      sourceSignals: [...new Set(options.sourceSignals)],
      sourceCandidates: [...new Set(options.sourceCandidates || [])],
      risk: risk.risk,
      status: "proposed",
      expectedImprovement,
      costOfInaction,
      rollbackRef,
      decision: {
        action: "propose_rule",
        runId,
        actionId: options.actionId,
        reason: normalizeText(options.reason || "proposal recorded for deterministic policy evaluation", 2000, "reason"),
        decidedAt: now,
      },
      activatedAt: null,
      reviewDueAt: null,
      expiresAt: null,
      rolloutBatchId: normalizeText(options.rolloutBatchId || "pr3-observe-only", 300, "rolloutBatchId"),
      supersededBy: null,
      revision: 1,
      contentDigest: "",
    };
    draft.contentDigest = contentDigestForRule(draft);
    mkdirSync(projectionPaths.rules, { recursive: true });
    const fixedPath = join(projectionPaths.rules, `${id}.json`);
    if (existsSync(fixedPath)) {
      const existing = readJson(fixedPath);
      if (existing.contentDigest !== draft.contentDigest) throw new AdaptationStoreError("operation_conflict", "preassigned ruleId has different content");
      const existingReview = listRecords(projectionPaths.reviews).find((review) => review.actionId === options.actionId) || null;
      return {
        status: "deduplicated",
        created: false,
        rule: existing,
        risk,
        review: existingReview,
        autoActivationEligible: !existingReview && existing.status === "proposed" && !risk.reviewRequired && autoAuthorization.status === "authorized" && resolved.mode === "active",
        policyDisposition: existingReview ? "review_required" : resolved.mode === "active" ? "auto_activation_permitted" : "observe_only",
        mode: resolved.mode,
        store: scope.level === "company" ? "company" : "workspace",
      };
    }
    const duplicate = listRecords(projectionPaths.rules).find((record) => record.contentDigest === draft.contentDigest && !["rejected", "superseded"].includes(record.status));
    if (duplicate) return { status: "deduplicated", created: false, rule: duplicate, risk };

    const sourceNeedsReview = signals.some((signal) => signal.status === "review_required" || signal.authorizationDecision?.status !== "authorized");
    const needsReview = options.forceReview === true || risk.reviewRequired || sourceNeedsReview || autoAuthorization.status !== "authorized";
    let review: JsonObject | null = null;
    if (needsReview) {
      review = createReview(projectionPaths, {
        workspaceId: resolved.workspaceId,
        scope,
        risk: risk.risk,
        actionId: options.actionId,
        evaluationId: options.evaluationId,
        runId,
        now,
      });
      draft.reviewDueAt = review.expiresAt;
    }
    writeAudit(projectionPaths, {
      workspaceId: resolved.workspaceId,
      type: "rule_proposed",
      artifactRef: `rules/${id}.json`,
      artifactDigest: draft.contentDigest,
      risk: risk.risk,
      reviewId: review?.reviewId || null,
      autoAuthorization: {
        status: autoAuthorization.status,
        principalId: autoAuthorization.principalId,
        grantId: autoAuthorization.grantId,
      },
      operationId: options.operationId || null,
      createdAt: now,
    });
    atomicWriteJson(join(projectionPaths.rules, `${id}.json`), draft);
    return {
      status: "created",
      created: true,
      rule: draft,
      risk,
      review,
      autoActivationEligible: !needsReview && resolved.mode === "active",
      policyDisposition: needsReview ? "review_required" : resolved.mode === "active" ? "auto_activation_permitted" : "observe_only",
      mode: resolved.mode,
      store: scope.level === "company" ? "company" : "workspace",
    };
  });
}

export function createAdaptationActionReview(options: {
  workspace: string;
  stateRoot: string;
  scope: AdaptationScope;
  risk: AdaptationRisk;
  actionId: string;
  evaluationId: string;
  runId: string;
  now?: string;
}): JsonObject {
  const paths = storePaths(options.workspace);
  const resolved = workspaceConfig(paths.workspace, options.stateRoot);
  const scope = scopeForRule(options.scope);
  assertScopeOwned(paths, resolved.workspaceId, { ...scope, domain: options.scope.domain });
  if (!DIGEST_RE.test(options.actionId)) throw new AdaptationStoreError("invalid_input", "actionId must be a sha256 digest");
  safeId(options.evaluationId, "evaluationId");
  safeId(options.runId, "runId");
  const projectionPaths = scope.level === "company" ? pathsForRoot(paths.workspace, resolved.companyRuleStorePath) : paths;
  return withPathsLock(projectionPaths, () => createReview(projectionPaths, {
    workspaceId: resolved.workspaceId,
    scope,
    risk: options.risk,
    actionId: options.actionId,
    evaluationId: options.evaluationId,
    runId: options.runId,
    now: options.now || new Date().toISOString(),
  }));
}

export function decideAdaptationReview(options: {
  workspace: string;
  stateRoot: string;
  reviewId: string;
  expectedRevision: number;
  decision: "approved" | "rejected";
  reason: string;
  actorContext?: TrustedActorContext | null;
  now?: string;
}): JsonObject {
  const paths = storePaths(options.workspace);
  const resolved = workspaceConfig(paths.workspace, options.stateRoot);
  const companyPaths = pathsForRoot(paths.workspace, resolved.companyRuleStorePath);
  const reviewId = safeId(options.reviewId, "reviewId");
  const now = options.now || new Date().toISOString();
  const localPath = join(paths.reviews, `${reviewId}.json`);
  const companyPath = join(companyPaths.reviews, `${reviewId}.json`);
  if (existsSync(localPath) && existsSync(companyPath)) throw new AdaptationStoreError("ambiguous_projection", "review exists in both workspace and company stores");
  const projectionPaths = existsSync(companyPath) ? companyPaths : paths;
  return withPathsLock(projectionPaths, () => {
    const path = join(projectionPaths.reviews, `${reviewId}.json`);
    if (!existsSync(path)) throw new AdaptationStoreError("not_found", "review not found");
    const review = readJson(path);
    if (review.workspaceId !== resolved.workspaceId) throw new AdaptationStoreError("cross_workspace", "review belongs to another workspace");
    if (review.revision !== options.expectedRevision) throw new AdaptationStoreError("revision_conflict", "review revision mismatch");
    if (review.status !== "pending") throw new AdaptationStoreError("invalid_transition", "review is already terminal");
    if (Date.parse(review.expiresAt) <= Date.parse(now)) throw new AdaptationStoreError("review_expired", "review has expired");
    const registry = loadRegistryOrNull(resolved.actorRegistryPath);
    const authorization = authorizeAdaptationAction({
      registry,
      actorContext: options.actorContext || null,
      workspaceId: resolved.workspaceId,
      scope: review.requestedScope,
      action: "rule:approve",
      risk: review.risk,
      sourceType: "message",
    });
    if (authorization.status !== "authorized") throw new AdaptationStoreError("authorization_failed", authorization.reason);
    const next: JsonObject = {
      ...review,
      status: options.decision,
      decision: {
        result: options.decision,
        principalId: authorization.principalId,
        grantId: authorization.grantId,
        registryRevision: authorization.registryRevision,
        registryDigest: authorization.registryDigest,
        reason: normalizeText(options.reason, 2000, "reason"),
        decidedAt: now,
      },
      revision: review.revision + 1,
    };
    writeAudit(projectionPaths, { workspaceId: resolved.workspaceId, type: "review_decided", artifactRef: `reviews/${reviewId}.json`, result: options.decision, principalId: authorization.principalId, grantId: authorization.grantId, createdAt: now });
    atomicWriteJson(path, next);
    return next;
  });
}

export function expireAdaptationReviews(options: { workspace: string; stateRoot: string; now?: string }): JsonObject[] {
  const paths = storePaths(options.workspace);
  const resolved = workspaceConfig(paths.workspace, options.stateRoot);
  const companyPaths = pathsForRoot(paths.workspace, resolved.companyRuleStorePath);
  const now = options.now || new Date().toISOString();
  const expireFrom = (projectionPaths: ReturnType<typeof storePaths>, shared: boolean): JsonObject[] => withPathsLock(projectionPaths, () => {
    const expired: JsonObject[] = [];
    for (const review of listRecords(projectionPaths.reviews)) {
      if (review.workspaceId !== resolved.workspaceId) {
        if (shared) continue;
        throw new AdaptationStoreError("cross_workspace", "foreign review projection");
      }
      if (review.status !== "pending" || Date.parse(review.expiresAt) > Date.parse(now)) continue;
      const next = {
        ...review,
        status: "expired",
        decision: {
          result: "expired",
          principalId: null,
          grantId: null,
          registryRevision: 1,
          registryDigest: hash(""),
          reason: "review expired without explicit approval",
          decidedAt: now,
        },
        revision: review.revision + 1,
      };
      writeAudit(projectionPaths, { workspaceId: resolved.workspaceId, type: "review_expired", artifactRef: `reviews/${review.reviewId}.json`, createdAt: now });
      atomicWriteJson(join(projectionPaths.reviews, `${review.reviewId}.json`), next);
      expired.push(next);
    }
    return expired;
  });
  const localExpired = expireFrom(paths, false);
  const companyExpired = companyPaths.root === paths.root ? [] : expireFrom(companyPaths, true);
  return [...localExpired, ...companyExpired];
}

export function transitionAdaptationRule(options: {
  workspace: string;
  stateRoot: string;
  ruleId: string;
  expectedRevision: number;
  status: RuleStatus;
  actorContext?: TrustedActorContext | null;
  supersededBy?: string | null;
  operationId?: string | null;
  decision?: {
    action: "activate_rule" | "supersede_rule" | "suspend_rule" | "reject_rule";
    runId: string;
    actionId: string;
    reason: string;
  } | null;
  now?: string;
}): JsonObject {
  const paths = storePaths(options.workspace);
  const resolved = workspaceConfig(paths.workspace, options.stateRoot);
  const companyPaths = pathsForRoot(paths.workspace, resolved.companyRuleStorePath);
  const ruleId = safeId(options.ruleId, "ruleId");
  if (options.operationId && !DIGEST_RE.test(options.operationId)) throw new AdaptationStoreError("invalid_input", "operationId must be a sha256 digest");
  if (options.decision) {
    safeId(options.decision.runId, "decision.runId");
    if (!DIGEST_RE.test(options.decision.actionId)) throw new AdaptationStoreError("invalid_input", "decision.actionId must be a sha256 digest");
  }
  const now = options.now || new Date().toISOString();
  const localPath = join(paths.rules, `${ruleId}.json`);
  const companyPath = join(companyPaths.rules, `${ruleId}.json`);
  if (existsSync(localPath) && existsSync(companyPath)) throw new AdaptationStoreError("ambiguous_projection", "rule exists in both workspace and company stores");
  const projectionPaths = existsSync(companyPath) ? companyPaths : paths;
  return withPathsLock(projectionPaths, () => {
    const path = join(projectionPaths.rules, `${ruleId}.json`);
    if (!existsSync(path)) throw new AdaptationStoreError("not_found", "rule not found");
    const current = readJson(path);
    if (current.workspaceId !== resolved.workspaceId) throw new AdaptationStoreError("cross_workspace", "rule belongs to another workspace");
    if (current.revision !== options.expectedRevision) throw new AdaptationStoreError("revision_conflict", "rule revision mismatch");
    const allowed: Record<string, RuleStatus[]> = {
      proposed: ["active", "rejected"],
      active: ["suspended", "superseded"],
      suspended: ["active", "superseded"],
      rejected: [],
      superseded: [],
    };
    if (!allowed[current.status]?.includes(options.status)) throw new AdaptationStoreError("invalid_transition", `${current.status} -> ${options.status} is not allowed`);
    if (options.status === "active") {
      if (resolved.mode !== "active") throw new AdaptationStoreError("observe_only", "rule activation is disabled outside active mode");
      if (current.risk !== "low") throw new AdaptationStoreError("review_required", "only low-risk rules may auto-activate");
      const authorization = authorizeAdaptationAction({
        registry: loadRegistryOrNull(resolved.actorRegistryPath),
        actorContext: options.actorContext || null,
        workspaceId: resolved.workspaceId,
        scope: current.scope,
        action: "rule:auto-activate",
        risk: current.risk,
        sourceType: "message",
      });
      if (authorization.status !== "authorized") throw new AdaptationStoreError("authorization_failed", authorization.reason);
    }
    let supersededBy = current.supersededBy;
    if (options.status === "superseded") {
      supersededBy = safeId(String(options.supersededBy || ""), "supersededBy");
      const replacementPath = join(projectionPaths.rules, `${supersededBy}.json`);
      if (!existsSync(replacementPath)) throw new AdaptationStoreError("not_found", "replacement rule not found");
      const replacement = readJson(replacementPath);
      if (replacement.workspaceId !== resolved.workspaceId) throw new AdaptationStoreError("cross_workspace", "replacement rule belongs to another workspace");
    }
    const next: JsonObject = {
      ...current,
      status: options.status,
      activatedAt: options.status === "active" ? now : current.activatedAt,
      supersededBy,
      decision: options.decision ? {
        action: options.decision.action,
        runId: options.decision.runId,
        actionId: options.decision.actionId,
        reason: normalizeText(options.decision.reason, 2000, "decision.reason"),
        decidedAt: now,
      } : current.decision,
      revision: current.revision + 1,
    };
    next.contentDigest = contentDigestForRule(next);
    writeAudit(projectionPaths, {
      workspaceId: resolved.workspaceId,
      type: "rule_transition",
      artifactRef: `rules/${ruleId}.json`,
      from: current.status,
      to: options.status,
      revision: next.revision,
      operationId: options.operationId || null,
      actionId: options.decision?.actionId || null,
      createdAt: now,
    });
    atomicWriteJson(path, next);
    return next;
  });
}
