import { existsSync, readFileSync, mkdirSync, openSync, closeSync, writeFileSync, fsyncSync, linkSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AdmissionStore, deriveAdmissionCandidateId, type AdmissionCheckpointV1 } from './admission-store.ts';
import { MemoryObservationLedger, ObservationLedgerError, sha256, deriveTraceId, inspectMemoryObservationAdmission, sanitizeEvidence,
  type Digest, type JsonValue, type TrustedCompletedTurn, type LedgerFaultPoint } from './ledger.ts';
import { memoryObservationBinding, resolveMemoryObservationProjection } from './projection.ts';
import { RUNTIME_AUTHORITY, RUNTIME_POLICY, RUNTIME_REGISTRY } from './runtime-authority.ts';

export const GAP_RECOVERY_SCHEMA = 'engram.memory-admission-gap-recovery.v1';
const digest = (v: unknown): Digest => sha256(v as JsonValue);
function fail(code: string, text: string): never { throw new ObservationLedgerError(code, text); }
const read = (path: string): any => JSON.parse(readFileSync(path, 'utf8'));
const token = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= 2048;
const timestamp = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
const instant = (v: string) => Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;

/** Operator-pinned sanitized history export. Not an agent/model supplied assertion. */
export type GapSourceInventory = {
  schema: 'iss19.gap-source-review.v1'; source: 'OpenClaw sessions_history (sanitized)';
  sessionKey: string; sessionId: string; canonicalWrites: 0;
  records: { messageId: string; source: any; finalCandidates: any[]; checkpointComparison?: unknown }[];
};
export type GapRecoveryOptions = {
  workspace: string; inventory: GapSourceInventory; inventoryDigest: Digest; messageId: string;
  authorizedBy: string; authorizedAt: string; reason: string; apply?: boolean; now?: Date;
  faultAt?: 'after_authorization' | 'after_admission' | LedgerFaultPoint;
};

function textContent(record: any): string {
  if (typeof record?.content === 'string') return record.content;
  if (!Array.isArray(record?.content)) return '';
  return record.content.filter((v: any) => v?.type === 'text' && typeof v.text === 'string').map((v: any) => v.text).join('\n');
}

function checkHistory(record: any, role: 'user' | 'assistant') {
  const m = record?.__openclaw;
  if (record?.role !== role || !timestamp(record.timestamp) || !m || !token(m.runId)
    || m.mirrorOrigin !== 'codex-app-server' || !token(m.mirrorIdentity)
    || !m.mirrorIdentity.endsWith(role === 'user' ? ':prompt' : ':assistant')
    || !token(m.transcriptPosition?.source) || !Number.isSafeInteger(m.transcriptPosition?.rawSeq)
    || m.transcriptPosition.rawSeq < 0) fail('IMPORT_INVALID', 'record lacks exact runtime transcript provenance');
}

function checkSource(inventory: GapSourceInventory, row: GapSourceInventory['records'][number], cp: AdmissionCheckpointV1, requireOwner: boolean) {
  checkHistory(row.source, 'user');
  const s = row.source, m = s.__openclaw, t = m.transport;
  const sourceId = s.idempotencyKey;
  const route = /^agent:([^:]+):telegram:(?:group:(-?\d+)(?::topic:(\d+))?|direct:(\d+))$/.exec(inventory.sessionKey);
  if (!route || route[1] !== cp.scope.workspaceId || !/^channel-user:v1:[a-f0-9]{64}$/.test(sourceId)
    || m.idempotencyKey !== sourceId || t?.channel !== 'telegram' || cp.channel !== 'telegram'
    || t.messageId !== row.messageId || cp.inboundMessageId !== row.messageId || m.senderId !== cp.actorId
    || (requireOwner && m.senderIsOwner !== true) || (route[3] && String(t.threadId) !== route[3])
    || (!route[3] && t.threadId != null) || (route[4] && cp.actorId !== route[4])
    || (cp.sourceTurnId !== null && cp.sourceTurnId !== sourceId)
    || (cp.runId !== null && cp.runId !== m.runId) || (cp.sessionId !== null && cp.sessionId !== inventory.sessionId)
    || (cp.replyToId !== null && cp.replyToId !== (t.replyToId ?? null))
    || (cp.sourceText !== null && cp.sourceText !== textContent(s))) fail('SOURCE_CONFLICT', 'source does not match the exact gap identity');
  const text = textContent(s);
  if (!text.trim() || text.length > 50000) fail('IMPORT_INVALID', 'bounded nonempty source text required');
  return { text, sourceId, metadata: m };
}

function writeImmutable(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = path + '.tmp-' + randomUUID();
  const fd = openSync(tmp, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
  try { linkSync(tmp, path); }
  catch (error: any) { if (error.code !== 'EEXIST') throw error; if (digest(read(path)) !== digest(value)) fail('CONTENT_CONFLICT', 'recovery artifact differs'); }
  finally { unlinkSync(tmp); }
  if (process.platform !== 'win32') {
    const dir = openSync(dirname(path), 'r'); try { fsyncSync(dir); } finally { closeSync(dir); }
  }
}

/** Re-admission only: original terminal checkpoint/receipt stay immutable; no inference or canonical write. */
export function recoverAdmissionGap(options: GapRecoveryOptions) {
  const now = options.now ?? new Date(), workspace = resolve(options.workspace), inv = options.inventory;
  if (!token(options.authorizedBy) || !token(options.reason) || !instant(options.authorizedAt)
    || Date.parse(options.authorizedAt) > now.getTime()) fail('INVALID_AUTHORIZATION', 'dated operator authorization required');
  if (digest(inv) !== options.inventoryDigest || inv?.schema !== 'iss19.gap-source-review.v1'
    || inv.source !== 'OpenClaw sessions_history (sanitized)' || !token(inv.sessionId) || !token(inv.sessionKey)
    || inv.canonicalWrites !== 0 || !Array.isArray(inv.records) || inv.records.length > 100
    || new Set(inv.records.map(r => r.messageId)).size !== inv.records.length) fail('IMPORT_INVALID', 'exact pinned history inventory required');
  const row = inv.records.find(r => r.messageId === options.messageId);
  if (!row || !Array.isArray(row.finalCandidates)) fail('IMPORT_INVALID', 'exact requested record missing');
  const workspaceId = read(join(workspace, 'engram.json'))?.workspace?.id;
  const projection = resolveMemoryObservationProjection({ workspace, workspaceId });
  const binding = memoryObservationBinding(projection, inv.sessionKey);
  if (!projection.enabled || projection.captureOwnership?.owner !== 'observer' || !binding
    || Date.parse(projection.captureOwnership.effectiveAfter) > now.getTime()
    || projection.evaluation?.mode !== 'batch-cron' || !binding.allowedChannels.includes('telegram')
    || projection.evaluation.batch?.sourcePolicyDigest !== digest(RUNTIME_POLICY)) fail('SCOPE_REVOKED', 'active exact-scope runtime policy required');
  const candidateId = deriveAdmissionCandidateId({ workspaceId, runtimeSessionKey: inv.sessionKey, channel: 'telegram', inboundMessageId: options.messageId });
  const store = new AdmissionStore(workspace, RUNTIME_AUTHORITY);
  const prepare = () => {
    const cp = store.readCheckpoint(candidateId), gap = store.readGapReceiptForCandidate(candidateId);
    const fingerprint = digest({ workspaceId, scopeClass: binding.scopeClass, scopeId: binding.scopeId,
      requireOwner: binding.requireOwner, ...(binding.topicDomain ? { topicDomain: binding.topicDomain } : {}),
      ...(binding.groupDomain ? { groupDomain: binding.groupDomain } : {}), allowedChannels: [...binding.allowedChannels].sort() });
    if (!cp || !gap || cp.stage !== 'terminal_gap' || cp.bindingFingerprint !== fingerprint || gap.bindingFingerprint !== fingerprint
      || cp.scope.scopeId !== binding.scopeId || cp.scope.scopeClass !== binding.scopeClass || digest(gap.scope) !== digest(cp.scope)
      || !['identity_ambiguous', 'identity_conflict', 'evidence_missing', 'restart_before_completion', 'expired_before_completion'].includes(gap.reasonCode)) {
      fail('GAP_INELIGIBLE', 'retained matching terminal gap required');
    }
    const sourceInfo = checkSource(inv, row, cp, binding.requireOwner);
    if (row.source.timestamp > now.getTime()) fail('IMPORT_INVALID', 'source timestamp is in the future');
    if (row.finalCandidates.length === 0) return { status: 'blocked_missing_completion' as const, candidateId, messageId: row.messageId };
    if (row.finalCandidates.length !== 1) fail('COMPLETION_AMBIGUOUS', 'one exact final record required');
    const final = row.finalCandidates[0]; checkHistory(final, 'assistant');
    const m = sourceInfo.metadata, f = final.__openclaw;
    if (final.stopReason !== 'stop' || f.runTerminal !== true || f.runId !== m.runId || f.mirrorIdentity.slice(0, -10) !== m.mirrorIdentity.slice(0, -7)
      || f.transcriptPosition.source !== m.transcriptPosition.source || f.transcriptPosition.rawSeq <= m.transcriptPosition.rawSeq
      || final.timestamp < row.source.timestamp || final.timestamp > Date.parse(options.authorizedAt)) fail('COMPLETION_CONFLICT', 'completion must belong to the same exact source run');
    const body = { schema: GAP_RECOVERY_SCHEMA, candidateId, gapReceiptDigest: gap.receiptDigest, checkpointDigest: cp.checkpointDigest,
      inventoryDigest: options.inventoryDigest, recordDigest: digest(row), scope: cp.scope,
      sourceTurnId: sourceInfo.sourceId, runId: m.runId, sessionId: inv.sessionId,
      authorizedBy: options.authorizedBy, authorizedAt: options.authorizedAt, reason: options.reason };
    const recoveryId = digest(body);
    const traceId = deriveTraceId(workspaceId, inv.sessionKey, sourceInfo.sourceId);
    const reply = m.transport.replyToId && m.transport.replyToId !== binding.topicDomain?.topicId ? m.transport.replyToId : null;
    const assistantText = textContent(final);
    if (assistantText.length > 50000) fail('IMPORT_INVALID', 'bounded final text required');
    const evidence = sanitizeEvidence({
      source: { role: 'user', text: sourceInfo.text, messageId: row.messageId,
        actorId: cp.actorId, attribution: 'speaker-only', ...(reply ? { replyToMessageId: reply } : {}) },
      outcome: { role: 'assistant', text: assistantText, status: assistantText ? 'reported_not_verified' : 'unknown',
        ...(!assistantText ? { reasonCode: 'assistant_text_unavailable' } : {}) },
      ...(reply ? { replyContext: { status: 'partial', requestedReplyToId: reply, maxPairs: 2, pairs: [], reasonCode: 'historical_reply_unresolved' } } : {}),
      recovery: { recoveryId, inventoryDigest: options.inventoryDigest, runId: m.runId,
        sourcePosition: m.transcriptPosition, finalPosition: f.transcriptPosition, kind: 'operator_authorized_runtime_history_replay' },
    } as JsonValue);
    const source: TrustedCompletedTurn = { sourceTurnId: sourceInfo.sourceId, scope: cp.scope,
      sourceCompletedAt: new Date(final.timestamp).toISOString(), authority: RUNTIME_AUTHORITY,
      evidenceRefs: [{ kind: 'source-turn', ref: sourceInfo.sourceId, digest: digest(evidence) }], redactedEvidence: evidence,
      trustedInputs: ['completed-source-turn','runtime-session-key','workspace-binding','source-completion-time'] };
    return { status: 'planned' as const, candidateId, messageId: row.messageId, recoveryId, traceId, body, source };
  };
  const plan = prepare();
  if (plan.status !== 'planned') return plan;
  const root = join(store.root, 'receipts/admission-recovery', candidateId.slice(7));
  const authPath = join(root, 'authorization.json'), completedPath = join(root, 'completed.json');
  const authorization = { ...plan.body, recoveryId: plan.recoveryId, traceId: plan.traceId, sourceDigest: digest(plan.source) };
  const result = { schema: GAP_RECOVERY_SCHEMA, status: 'admitted' as const, candidateId, recoveryId: plan.recoveryId,
    traceId: plan.traceId, messageId: plan.messageId, canonicalWrites: 0, inferenceRun: false };
  const ledger = new MemoryObservationLedger({ workspace, workspaceId, exactSessionKeys: [inv.sessionKey],
    producerRegistry: RUNTIME_REGISTRY, authorityPolicy: RUNTIME_POLICY,
    limits: { evidenceTtlMs: projection.limits.evidenceTtlHours * 3600000, maxJobs: projection.limits.maxJobs,
      maxBytes: projection.limits.maxBytes, maxQueueAgeMs: projection.limits.maxQueueAgeHours * 3600000,
      maxAttempts: projection.limits.maxAttempts, claimTtlMs: projection.limits.claimTtlSeconds * 1000, maxInferenceCalls: 0 },
    fault: point => { if (options.faultAt === point) fail('FAULT_INJECTED', point); } });
  const inspect = () => {
    if (existsSync(authPath) && digest(read(authPath)) !== digest(authorization)) fail('CONTENT_CONFLICT', 'candidate already has another authorized recovery');
    const admission = inspectMemoryObservationAdmission(workspace, plan.source);
    if (admission !== 'absent' && !existsSync(authPath)) fail('CONTENT_CONFLICT', 'source admission predates this recovery');
    if (existsSync(completedPath)) {
      const completed = read(completedPath);
      if (digest(completed.result) !== digest(result) || completed.authorizationDigest !== digest(authorization)
        || completed.envelopeDigest !== digest(read(join(store.root, 'envelopes', plan.traceId.slice(7) + '.json')))
        || admission !== 'admitted') fail('CONTENT_CONFLICT', 'completed recovery is not backed by durable admission');
      return result;
    }
    return null;
  };
  const existing = inspect(); if (existing) return existing;
  if (now.getTime() - Date.parse(options.authorizedAt) >= projection.limits.evidenceTtlHours * 3600000)
    fail('AUTHORIZATION_EXPIRED', 'recovery evidence window expired; re-review required');
  if (!options.apply) return { ...result, status: 'planned' as const };
  return store.withCandidateDisposition(candidateId, () => {
    if (digest(resolveMemoryObservationProjection({ workspace, workspaceId })) !== digest(projection)
      || digest(prepare()) !== digest(plan)) fail('STATE_CHANGED', 'scope or import changed before recovery');
    const existing = inspect(); if (existing) return existing;
    writeImmutable(authPath, authorization);
    if (options.faultAt === 'after_authorization') fail('FAULT_INJECTED', 'after_authorization');
    ledger.admit(plan.source, new Date(options.authorizedAt));
    if (options.faultAt === 'after_admission') fail('FAULT_INJECTED', 'after_admission');
    if (inspectMemoryObservationAdmission(workspace, plan.source) !== 'admitted') fail('STATE_CORRUPT', 'admission incomplete');
    writeImmutable(completedPath, { result, authorizationDigest: digest(authorization),
      envelopeDigest: digest(read(join(store.root, 'envelopes', plan.traceId.slice(7) + '.json'))) });
    return result;
  });
}

/** A replay receipt alone cannot hide a gap: require matching immutable source admission. */
export function isAdmissionGapRecovered(workspace: string, checkpoint: AdmissionCheckpointV1): boolean {
  try {
    const store = new AdmissionStore(workspace, RUNTIME_AUTHORITY);
    const cp = store.readCheckpoint(checkpoint.candidateId);
    if (!cp || digest(cp) !== digest(checkpoint)) return false;
    const gap = store.readGapReceiptForCandidate(cp.candidateId);
    const root = join(store.root, 'receipts/admission-recovery', cp.candidateId.slice(7));
    const auth = read(join(root, 'authorization.json')), completed = read(join(root, 'completed.json'));
    const { recoveryId, traceId, sourceDigest, ...body } = auth;
    const envelope = read(join(store.root, 'envelopes', String(traceId).slice(7) + '.json'));
    const expected = { schema: GAP_RECOVERY_SCHEMA, status: 'admitted', candidateId: cp.candidateId,
      recoveryId, traceId, messageId: cp.inboundMessageId, canonicalWrites: 0, inferenceRun: false };
    return !!gap && auth.schema === GAP_RECOVERY_SCHEMA && digest(body) === recoveryId
      && auth.candidateId === cp.candidateId && auth.checkpointDigest === cp.checkpointDigest
      && auth.gapReceiptDigest === gap.receiptDigest && digest(auth.scope) === digest(cp.scope)
      && traceId === deriveTraceId(cp.scope.workspaceId, cp.scope.runtimeSessionKey, auth.sourceTurnId)
      && envelope.schema === 'engram.memory-observation-job.v1' && envelope.traceId === traceId
      && envelope.sourceTurnId === auth.sourceTurnId && digest(envelope.scope) === digest(cp.scope)
      && digest(envelope.authority) === digest(RUNTIME_AUTHORITY) && envelope.policyDigest === digest(RUNTIME_POLICY)
      && completed.envelopeDigest === digest(envelope) && completed.authorizationDigest === digest(auth)
      && digest(completed.result) === digest(expected);
  } catch { return false; }
}
