import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { atomicWriteJson } from "./legacy-migration";
import { canonicalizeJcs, type Digest, sha256Digest } from "./handoff-v2";
import { kgV3DecayTier } from "../kg-v3/projection";
import { readKgV3AccessState } from "../kg-v3/access";
import type { KgAssertionV3 } from "../kg-v3/types";

export const MEMORY_CANDIDATE_SCHEMA = "oll.memory-candidate.v1" as const;
export const MEMORY_CANDIDATE_REPORT_SCHEMA = "oll.memory-candidate-report.v1" as const;
export const MEMORY_CANDIDATE_POLICY_SCHEMA = "oll.memory-candidate-policy.v1" as const;
export const MEMORY_CANDIDATE_COMPILER_VERSION = 1 as const;

export type MemoryCandidateSourceClass =
  | "daily-decision"
  | "daily-learning"
  | "retrieval-card"
  | "domain-decision"
  | "domain-proposal"
  | "kg-assertion";

export type MemoryCandidateKind = "decision" | "learning" | "preference" | "constraint" | "proposal";
export type MemoryCandidateDisposition = "consumed" | "ignored" | "deferred";

export interface MemoryCandidateScopeCeilingV1 {
  level: "domain" | "workspace";
  subject: string;
}

export interface MemoryCandidateV1 {
  schema: typeof MEMORY_CANDIDATE_SCHEMA;
  candidateId: Digest;
  workspaceId: string;
  sourceClass: MemoryCandidateSourceClass;
  sourceRef: string;
  sourceVersionDigest: Digest;
  contentDigest: Digest;
  semanticKey: Digest;
  scopeCeiling: MemoryCandidateScopeCeilingV1;
  kind: MemoryCandidateKind;
  redactionClass: "minimal";
  observedAt: string;
  statement: string;
  ranking: {
    score: number;
    reasons: string[];
    duplicateCount: number;
    accessCount: number;
    decayTier: "hot" | "warm" | "cold" | null;
  };
  compilerVersion: typeof MEMORY_CANDIDATE_COMPILER_VERSION;
  lifecycle: {
    status: "pending" | "evaluated" | "dismissed";
    disposition: MemoryCandidateDisposition | null;
    revision: number;
    updatedAt: string;
  };
}

export interface DailyCandidateSourcePolicyV1 {
  session: string;
  scopeCeiling: MemoryCandidateScopeCeilingV1;
}

export interface MemoryCandidatePolicyV1 {
  schema: typeof MEMORY_CANDIDATE_POLICY_SCHEMA;
  mode: "disabled" | "shadow" | "materialize";
  forwardOnlySince: string;
  maxCandidatesPerRun: number;
  maxContextBytes: number;
  dailySessions: DailyCandidateSourcePolicyV1[];
  domainSources: boolean;
  kgSources: boolean;
  sourceQuotas: Record<MemoryCandidateSourceClass, number>;
}

export interface MemoryCandidateReportV1 {
  schema: typeof MEMORY_CANDIDATE_REPORT_SCHEMA;
  workspaceId: string;
  mode: MemoryCandidatePolicyV1["mode"];
  snapshotAt: string;
  compilerVersion: typeof MEMORY_CANDIDATE_COMPILER_VERSION;
  considered: number;
  eligible: number;
  selected: number;
  selectedBytes: number;
  sourceCounts: Record<string, number>;
  rejectionCounts: Record<string, number>;
  reportDigest: Digest;
  candidates: MemoryCandidateV1[];
}

const WORKSPACE_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;
const DOMAIN_RE = /^[a-z0-9][a-z0-9-]{0,99}$/;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SECRET_RE = /(?:api[-_ ]?key|authorization|bearer|password|passwd|private[-_ ]?key|secret|token)\s*[:=]\s*\S+/i;
const DEFAULT_QUOTAS: Record<MemoryCandidateSourceClass, number> = {
  "daily-decision": 12,
  "daily-learning": 12,
  "retrieval-card": 12,
  "domain-decision": 12,
  "domain-proposal": 8,
  "kg-assertion": 16,
};

type CandidateDraft = Omit<MemoryCandidateV1, "candidateId" | "semanticKey" | "ranking" | "lifecycle"> & {
  baseScore: number;
  reasons: string[];
  accessCount?: number;
  decayTier?: "hot" | "warm" | "cold" | null;
};

function assertInside(root: string, target: string, label: string): void {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  const prefix = resolvedRoot.endsWith(sep) ? resolvedRoot : `${resolvedRoot}${sep}`;
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(prefix)) throw new Error(`${label} escapes allowed root`);
}

function normalizeText(value: unknown, max = 2_000): string {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text || text.length > max) return "";
  return text;
}

function semanticText(value: string): string {
  return value.toLocaleLowerCase("und").replace(/[\p{P}\p{S}]+/gu, " ").replace(/\s+/g, " ").trim();
}

function safeIso(value: unknown): string | null {
  const text = String(value || "");
  return Number.isFinite(Date.parse(text)) ? new Date(text).toISOString() : null;
}

function dateIso(date: string): string {
  return `${date}T12:00:00.000Z`;
}

function inForwardWindow(observedAt: string, policy: MemoryCandidatePolicyV1, snapshotAt: string): boolean {
  const observedDate = observedAt.slice(0, 10);
  return observedDate >= policy.forwardOnlySince.slice(0, 10) && Date.parse(observedAt) <= Date.parse(snapshotAt);
}

function readStableText(path: string): { content: string; digest: Digest } | null {
  const before = statSync(path);
  const content = readFileSync(path, "utf8");
  const after = statSync(path);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) return null;
  return { content, digest: sha256Digest(content) };
}

function sourceRef(workspace: string, path: string, fragment: string): string {
  const rel = relative(resolve(workspace), resolve(path)).split(sep).join("/");
  if (!rel || rel.startsWith("../")) throw new Error("candidate source escapes workspace");
  return `${rel}#${fragment}`;
}

function draft(options: {
  workspaceId: string;
  sourceClass: MemoryCandidateSourceClass;
  sourceRef: string;
  sourceVersionDigest: Digest;
  scopeCeiling: MemoryCandidateScopeCeilingV1;
  kind: MemoryCandidateKind;
  observedAt: string;
  statement: string;
  baseScore: number;
  reasons: string[];
  accessCount?: number;
  decayTier?: "hot" | "warm" | "cold" | null;
}): CandidateDraft | null {
  const statement = normalizeText(options.statement);
  if (!statement || SECRET_RE.test(statement)) return null;
  const contentDigest = sha256Digest(statement);
  return {
    schema: MEMORY_CANDIDATE_SCHEMA,
    workspaceId: options.workspaceId,
    sourceClass: options.sourceClass,
    sourceRef: options.sourceRef,
    sourceVersionDigest: options.sourceVersionDigest,
    contentDigest,
    scopeCeiling: options.scopeCeiling,
    kind: options.kind,
    redactionClass: "minimal",
    observedAt: options.observedAt,
    statement,
    baseScore: options.baseScore,
    reasons: options.reasons,
    accessCount: options.accessCount,
    decayTier: options.decayTier,
    compilerVersion: MEMORY_CANDIDATE_COMPILER_VERSION,
  };
}

function parseDailyNote(options: {
  workspace: string;
  workspaceId: string;
  path: string;
  policy: MemoryCandidatePolicyV1;
  sourcePolicy: DailyCandidateSourcePolicyV1;
  snapshotAt: string;
  rejectionCounts: Record<string, number>;
}): CandidateDraft[] {
  const stable = readStableText(options.path);
  if (!stable) {
    options.rejectionCounts.changed_during_read = (options.rejectionCounts.changed_during_read || 0) + 1;
    return [];
  }
  const date = basename(options.path, ".md");
  if (!DATE_RE.test(date)) return [];
  const observedAt = dateIso(date);
  if (!inForwardWindow(observedAt, options.policy, options.snapshotAt)) return [];
  let section = "";
  const ordinals: Record<string, number> = {};
  const out: CandidateDraft[] = [];
  for (const line of stable.content.split(/\r?\n/)) {
    const heading = line.match(/^##\s+(.+)$/);
    if (heading) section = heading[1].trim().toLocaleLowerCase("und");
    if (!/^[-*]\s+\S/.test(line) || !["decisions", "learnings"].includes(section)) continue;
    const sourceClass: MemoryCandidateSourceClass = section === "decisions" ? "daily-decision" : "daily-learning";
    const kind: MemoryCandidateKind = section === "decisions" ? "decision" : "learning";
    ordinals[section] = (ordinals[section] || 0) + 1;
    const entry = draft({
      workspaceId: options.workspaceId,
      sourceClass,
      sourceRef: sourceRef(options.workspace, options.path, `${section}:${ordinals[section]}`),
      sourceVersionDigest: stable.digest,
      scopeCeiling: options.sourcePolicy.scopeCeiling,
      kind,
      observedAt,
      statement: line.replace(/^[-*]\s+/, ""),
      baseScore: section === "decisions" ? 70 : 55,
      reasons: [section === "decisions" ? "structured_decision" : "structured_learning"],
    });
    if (entry) out.push(entry);
    else options.rejectionCounts.invalid_or_sensitive = (options.rejectionCounts.invalid_or_sensitive || 0) + 1;
  }
  return out;
}

function parseRetrievalCards(options: {
  workspace: string;
  workspaceId: string;
  root: string;
  policy: MemoryCandidatePolicyV1;
  sourcePolicy: DailyCandidateSourcePolicyV1;
  snapshotAt: string;
  rejectionCounts: Record<string, number>;
}): CandidateDraft[] {
  if (!existsSync(options.root)) return [];
  const out: CandidateDraft[] = [];
  for (const name of readdirSync(options.root).filter((entry) => entry.endsWith(".md")).sort()) {
    const date = name.slice(0, 10);
    if (!DATE_RE.test(date)) continue;
    const observedAt = dateIso(date);
    if (!inForwardWindow(observedAt, options.policy, options.snapshotAt)) continue;
    const path = join(options.root, name);
    const stable = readStableText(path);
    if (!stable) {
      options.rejectionCounts.changed_during_read = (options.rejectionCounts.changed_during_read || 0) + 1;
      continue;
    }
    const summary = stable.content.split(/^## Summary\s*$/m)[1]?.trim() || "";
    const entry = draft({
      workspaceId: options.workspaceId,
      sourceClass: "retrieval-card",
      sourceRef: sourceRef(options.workspace, path, "summary"),
      sourceVersionDigest: stable.digest,
      scopeCeiling: options.sourcePolicy.scopeCeiling,
      kind: "decision",
      observedAt,
      statement: summary,
      baseScore: 85,
      reasons: ["explicit_retrieval_card"],
    });
    if (entry) out.push(entry);
    else options.rejectionCounts.invalid_or_sensitive = (options.rejectionCounts.invalid_or_sensitive || 0) + 1;
  }
  return out;
}

function domainNames(workspace: string): string[] {
  const registryPath = join(workspace, "memory", "domains", "registry.json");
  if (!existsSync(registryPath)) return [];
  try {
    const registry = JSON.parse(readFileSync(registryPath, "utf8"));
    return Object.keys(registry?.domains || {}).filter((name) => DOMAIN_RE.test(name)).sort();
  } catch {
    return [];
  }
}

function parseDomainDecisions(options: {
  workspace: string;
  workspaceId: string;
  domain: string;
  policy: MemoryCandidatePolicyV1;
  snapshotAt: string;
  rejectionCounts: Record<string, number>;
}): CandidateDraft[] {
  const path = join(options.workspace, "memory", "domains", options.domain, "decisions.md");
  if (!existsSync(path)) return [];
  const stable = readStableText(path);
  if (!stable) {
    options.rejectionCounts.changed_during_read = (options.rejectionCounts.changed_during_read || 0) + 1;
    return [];
  }
  const out: CandidateDraft[] = [];
  let ordinal = 0;
  for (const line of stable.content.split(/\r?\n/)) {
    if (!line.trim().startsWith("|")) continue;
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    if (cells.length < 2 || !DATE_RE.test(cells[0])) continue;
    const observedAt = dateIso(cells[0]);
    if (!inForwardWindow(observedAt, options.policy, options.snapshotAt)) continue;
    ordinal += 1;
    const entry = draft({
      workspaceId: options.workspaceId,
      sourceClass: "domain-decision",
      sourceRef: sourceRef(options.workspace, path, `row:${cells[0]}:${ordinal}`),
      sourceVersionDigest: stable.digest,
      scopeCeiling: { level: "domain", subject: options.domain },
      kind: "decision",
      observedAt,
      statement: [cells[1], cells[2]].filter(Boolean).join(" — "),
      baseScore: 72,
      reasons: ["domain_decision"],
    });
    if (entry) out.push(entry);
    else options.rejectionCounts.invalid_or_sensitive = (options.rejectionCounts.invalid_or_sensitive || 0) + 1;
  }
  return out;
}

function parseDomainProposals(options: {
  workspace: string;
  workspaceId: string;
  domain: string;
  policy: MemoryCandidatePolicyV1;
  snapshotAt: string;
  rejectionCounts: Record<string, number>;
}): CandidateDraft[] {
  const path = join(options.workspace, "memory", "domains", options.domain, "changelog.md");
  if (!existsSync(path)) return [];
  const stable = readStableText(path);
  if (!stable) {
    options.rejectionCounts.changed_during_read = (options.rejectionCounts.changed_during_read || 0) + 1;
    return [];
  }
  let currentDate = "";
  let ordinal = 0;
  const out: CandidateDraft[] = [];
  for (const line of stable.content.split(/\r?\n/)) {
    const heading = line.match(/^##\s+(\d{4}-\d{2}-\d{2})(?:\s|$)/);
    if (heading) currentDate = heading[1];
    if (!currentDate || !/\bPROPOSAL\b/i.test(line) || !/^[-*]\s+/.test(line)) continue;
    const observedAt = dateIso(currentDate);
    if (!inForwardWindow(observedAt, options.policy, options.snapshotAt)) continue;
    ordinal += 1;
    const entry = draft({
      workspaceId: options.workspaceId,
      sourceClass: "domain-proposal",
      sourceRef: sourceRef(options.workspace, path, `proposal:${currentDate}:${ordinal}`),
      sourceVersionDigest: stable.digest,
      scopeCeiling: { level: "domain", subject: options.domain },
      kind: "proposal",
      observedAt,
      statement: line.replace(/^[-*]\s+/, "").replace(/^\[?PROPOSAL\]?\s*:?\s*/i, ""),
      baseScore: 68,
      reasons: ["explicit_domain_proposal"],
    });
    if (entry) out.push(entry);
    else options.rejectionCounts.invalid_or_sensitive = (options.rejectionCounts.invalid_or_sensitive || 0) + 1;
  }
  return out;
}

function parseKgAssertions(options: {
  workspace: string;
  workspaceId: string;
  policy: MemoryCandidatePolicyV1;
  snapshotAt: string;
  rejectionCounts: Record<string, number>;
}): CandidateDraft[] {
  const root = join(options.workspace, "life", "v3", "assertions");
  if (!existsSync(root)) return [];
  const accessState = readKgV3AccessState(options.workspace, options.workspaceId);
  const out: CandidateDraft[] = [];
  for (const name of readdirSync(root).filter((entry) => entry.endsWith(".json")).sort()) {
    const path = join(root, name);
    const stable = readStableText(path);
    if (!stable) {
      options.rejectionCounts.changed_during_read = (options.rejectionCounts.changed_during_read || 0) + 1;
      continue;
    }
    let assertion: KgAssertionV3;
    try { assertion = JSON.parse(stable.content); } catch {
      options.rejectionCounts.invalid_json = (options.rejectionCounts.invalid_json || 0) + 1;
      continue;
    }
    if (assertion.workspaceId !== options.workspaceId || assertion.lifecycle?.status !== "active") continue;
    if (!["decision", "preference", "constraint"].includes(assertion.kind)) continue;
    const observedAt = safeIso(assertion.lifecycle?.changedAt) || safeIso(assertion.createdAt);
    if (!observedAt || !inForwardWindow(observedAt, options.policy, options.snapshotAt)) continue;
    const value = assertion.object?.type === "string" ? assertion.object.value : "";
    const access = accessState.assertions[assertion.id];
    const accessCount = Number(access?.accessCount || 0);
    const decayTier = kgV3DecayTier(assertion, accessState, new Date(options.snapshotAt));
    const accessBoost = Math.min(12, Math.floor(Math.log2(accessCount + 1) * 4));
    const base = assertion.kind === "preference" ? 78 : assertion.kind === "constraint" ? 74 : 70;
    const entry = draft({
      workspaceId: options.workspaceId,
      sourceClass: "kg-assertion",
      sourceRef: sourceRef(options.workspace, path, assertion.id),
      sourceVersionDigest: stable.digest,
      scopeCeiling: { level: "workspace", subject: options.workspaceId },
      kind: assertion.kind as "decision" | "preference" | "constraint",
      observedAt,
      statement: String(value || ""),
      baseScore: base + accessBoost,
      reasons: ["active_kg_assertion", ...(accessBoost ? ["recent_access"] : []), `decay_${decayTier}`],
      accessCount,
      decayTier,
    });
    if (entry) out.push(entry);
    else options.rejectionCounts.invalid_or_sensitive = (options.rejectionCounts.invalid_or_sensitive || 0) + 1;
  }
  return out;
}

function finalizeDrafts(drafts: CandidateDraft[], snapshotAt: string): MemoryCandidateV1[] {
  const semanticCounts = new Map<string, number>();
  for (const entry of drafts) {
    const semantic = semanticText(entry.statement);
    semanticCounts.set(semantic, (semanticCounts.get(semantic) || 0) + 1);
  }
  return drafts.map((entry) => {
    const semantic = semanticText(entry.statement);
    const duplicateCount = semanticCounts.get(semantic) || 1;
    const semanticKey = sha256Digest(semantic);
    const recencyDays = Math.max(0, Math.floor((Date.parse(snapshotAt) - Date.parse(entry.observedAt)) / 86_400_000));
    const recencyBoost = Math.max(0, 10 - recencyDays * 2);
    const repetitionBoost = duplicateCount > 1 ? Math.min(12, duplicateCount * 3) : 0;
    const score = Math.max(0, Math.min(100, entry.baseScore + recencyBoost + repetitionBoost));
    const identity = {
      workspaceId: entry.workspaceId,
      sourceClass: entry.sourceClass,
      sourceRef: entry.sourceRef,
      contentDigest: entry.contentDigest,
    };
    const candidateId = sha256Digest(canonicalizeJcs(identity));
    const { baseScore: _baseScore, reasons, accessCount = 0, decayTier = null, ...base } = entry;
    return {
      ...base,
      candidateId,
      semanticKey,
      ranking: {
        score,
        reasons: [...new Set([...reasons, ...(recencyBoost ? ["recent"] : []), ...(repetitionBoost ? ["repeated_evidence"] : [])])].sort(),
        duplicateCount,
        accessCount,
        decayTier,
      },
      lifecycle: { status: "pending", disposition: null, revision: 1, updatedAt: snapshotAt },
    };
  });
}

function validatePolicy(value: MemoryCandidatePolicyV1, workspaceId: string): MemoryCandidatePolicyV1 {
  if (!WORKSPACE_RE.test(workspaceId)) throw new Error("invalid candidate compiler workspace ID");
  if (!value || value.schema !== MEMORY_CANDIDATE_POLICY_SCHEMA) throw new Error("invalid candidate compiler policy schema");
  if (!["disabled", "shadow", "materialize"].includes(value.mode)) throw new Error("invalid candidate compiler mode");
  if (!safeIso(value.forwardOnlySince)) throw new Error("candidate compiler forwardOnlySince is invalid");
  if (!Number.isInteger(value.maxCandidatesPerRun) || value.maxCandidatesPerRun < 1 || value.maxCandidatesPerRun > 200) throw new Error("candidate compiler maxCandidatesPerRun is invalid");
  if (!Number.isInteger(value.maxContextBytes) || value.maxContextBytes < 1_024 || value.maxContextBytes > 262_144) throw new Error("candidate compiler maxContextBytes is invalid");
  if (!Array.isArray(value.dailySessions)) throw new Error("candidate compiler dailySessions is invalid");
  const sessions = new Set<string>();
  for (const entry of value.dailySessions) {
    if (!SESSION_RE.test(entry.session) || sessions.has(entry.session)) throw new Error("candidate compiler daily session is invalid or duplicated");
    sessions.add(entry.session);
    if (!["domain", "workspace"].includes(entry.scopeCeiling?.level)) throw new Error("candidate compiler scope ceiling is invalid");
    if (entry.scopeCeiling.level === "workspace" && entry.scopeCeiling.subject !== workspaceId) throw new Error("candidate compiler workspace scope broadening is forbidden");
    if (entry.scopeCeiling.level === "domain" && !DOMAIN_RE.test(entry.scopeCeiling.subject)) throw new Error("candidate compiler domain scope is invalid");
  }
  for (const sourceClass of Object.keys(DEFAULT_QUOTAS) as MemoryCandidateSourceClass[]) {
    const quota = value.sourceQuotas?.[sourceClass];
    if (!Number.isInteger(quota) || quota < 0 || quota > 100) throw new Error(`candidate compiler quota is invalid: ${sourceClass}`);
  }
  return value;
}

export function candidatePolicyFromConfig(config: Record<string, any>, workspaceId: string): MemoryCandidatePolicyV1 {
  const raw = config?.oll?.candidateCompiler;
  const disabled: MemoryCandidatePolicyV1 = {
    schema: MEMORY_CANDIDATE_POLICY_SCHEMA,
    mode: "disabled",
    forwardOnlySince: "9999-12-31T00:00:00.000Z",
    maxCandidatesPerRun: 50,
    maxContextBytes: 65_536,
    dailySessions: [],
    domainSources: false,
    kgSources: false,
    sourceQuotas: { ...DEFAULT_QUOTAS },
  };
  if (!raw) return disabled;
  const policy: MemoryCandidatePolicyV1 = {
    schema: MEMORY_CANDIDATE_POLICY_SCHEMA,
    mode: raw.mode,
    forwardOnlySince: raw.forwardOnlySince,
    maxCandidatesPerRun: raw.maxCandidatesPerRun,
    maxContextBytes: raw.maxContextBytes,
    dailySessions: raw.dailySessions || [],
    domainSources: raw.domainSources === true,
    kgSources: raw.kgSources === true,
    sourceQuotas: { ...DEFAULT_QUOTAS, ...(raw.sourceQuotas || {}) },
  };
  return validatePolicy(policy, workspaceId);
}

export function compileMemoryCandidates(options: {
  workspace: string;
  workspaceId: string;
  snapshotAt: string;
  policy: MemoryCandidatePolicyV1;
}): MemoryCandidateReportV1 {
  const workspace = resolve(options.workspace);
  assertInside(workspace, workspace, "workspace");
  const policy = validatePolicy(options.policy, options.workspaceId);
  if (!safeIso(options.snapshotAt)) throw new Error("candidate compiler snapshotAt is invalid");
  const rejectionCounts: Record<string, number> = {};
  const drafts: CandidateDraft[] = [];
  if (policy.mode !== "disabled") {
    const agentRoot = join(workspace, "memory", `agent-${options.workspaceId}`);
    assertInside(workspace, agentRoot, "daily note root");
    for (const sourcePolicy of policy.dailySessions) {
      const sessionRoot = join(agentRoot, sourcePolicy.session);
      assertInside(agentRoot, sessionRoot, "daily note session");
      if (!existsSync(sessionRoot)) {
        rejectionCounts.missing_session = (rejectionCounts.missing_session || 0) + 1;
        continue;
      }
      for (const name of readdirSync(sessionRoot).filter((entry) => DATE_RE.test(entry.replace(/\.md$/, "")) && entry.endsWith(".md")).sort()) {
        drafts.push(...parseDailyNote({
          workspace, workspaceId: options.workspaceId, path: join(sessionRoot, name), policy,
          sourcePolicy, snapshotAt: options.snapshotAt, rejectionCounts,
        }));
      }
      drafts.push(...parseRetrievalCards({
        workspace, workspaceId: options.workspaceId, root: join(sessionRoot, "retrieval"), policy,
        sourcePolicy, snapshotAt: options.snapshotAt, rejectionCounts,
      }));
    }
    if (policy.domainSources) {
      for (const domain of domainNames(workspace)) {
        drafts.push(...parseDomainDecisions({ workspace, workspaceId: options.workspaceId, domain, policy, snapshotAt: options.snapshotAt, rejectionCounts }));
        drafts.push(...parseDomainProposals({ workspace, workspaceId: options.workspaceId, domain, policy, snapshotAt: options.snapshotAt, rejectionCounts }));
      }
    }
    if (policy.kgSources) drafts.push(...parseKgAssertions({ workspace, workspaceId: options.workspaceId, policy, snapshotAt: options.snapshotAt, rejectionCounts }));
  }
  const candidates = finalizeDrafts(drafts, options.snapshotAt);
  const sourceCounts: Record<string, number> = {};
  for (const candidate of candidates) sourceCounts[candidate.sourceClass] = (sourceCounts[candidate.sourceClass] || 0) + 1;
  const eligible = candidates.filter((candidate) => candidate.ranking.score >= 55);
  const bySource = new Map<MemoryCandidateSourceClass, number>();
  const selected: MemoryCandidateV1[] = [];
  let selectedBytes = 0;
  for (const candidate of [...eligible].sort((a, b) => (
    b.ranking.score - a.ranking.score
      || b.observedAt.localeCompare(a.observedAt)
      || a.candidateId.localeCompare(b.candidateId)
  ))) {
    if (selected.length >= policy.maxCandidatesPerRun) break;
    const used = bySource.get(candidate.sourceClass) || 0;
    if (used >= policy.sourceQuotas[candidate.sourceClass]) {
      rejectionCounts.source_quota = (rejectionCounts.source_quota || 0) + 1;
      continue;
    }
    const bytes = Buffer.byteLength(canonicalizeJcs(candidate), "utf8");
    if (selectedBytes + bytes > policy.maxContextBytes) {
      rejectionCounts.byte_budget = (rejectionCounts.byte_budget || 0) + 1;
      continue;
    }
    selected.push(candidate);
    selectedBytes += bytes;
    bySource.set(candidate.sourceClass, used + 1);
  }
  const reportBase = {
    schema: MEMORY_CANDIDATE_REPORT_SCHEMA,
    workspaceId: options.workspaceId,
    mode: policy.mode,
    snapshotAt: options.snapshotAt,
    compilerVersion: MEMORY_CANDIDATE_COMPILER_VERSION,
    considered: candidates.length,
    eligible: eligible.length,
    selected: selected.length,
    selectedBytes,
    sourceCounts,
    rejectionCounts,
    candidates: selected,
  } as const;
  return { ...reportBase, reportDigest: sha256Digest(canonicalizeJcs(reportBase)) };
}

export function selectMemoryCandidateContext(options: {
  candidates: MemoryCandidateV1[];
  policy: MemoryCandidatePolicyV1;
}): MemoryCandidateV1[] {
  const bySource = new Map<MemoryCandidateSourceClass, number>();
  const selected: MemoryCandidateV1[] = [];
  let selectedBytes = 0;
  for (const candidate of [...options.candidates].filter((entry) => entry.lifecycle.status === "pending").sort((a, b) => (
    b.ranking.score - a.ranking.score
      || b.observedAt.localeCompare(a.observedAt)
      || a.candidateId.localeCompare(b.candidateId)
  ))) {
    if (selected.length >= options.policy.maxCandidatesPerRun) break;
    const used = bySource.get(candidate.sourceClass) || 0;
    if (used >= options.policy.sourceQuotas[candidate.sourceClass]) continue;
    const bytes = Buffer.byteLength(canonicalizeJcs(candidate), "utf8");
    if (selectedBytes + bytes > options.policy.maxContextBytes) continue;
    selected.push(candidate);
    selectedBytes += bytes;
    bySource.set(candidate.sourceClass, used + 1);
  }
  return selected;
}

function candidatePaths(workspace: string, candidateId: Digest): { candidate: string; operation: string } {
  if (!DIGEST_RE.test(candidateId)) throw new Error("invalid memory candidate ID");
  const root = join(resolve(workspace), "memory-state", "oll");
  return {
    candidate: join(root, "candidates", `${candidateId.slice(7)}.json`),
    operation: join(root, "candidate-operations", `${candidateId.slice(7)}.json`),
  };
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withCandidateLock<T>(workspace: string, fn: () => T): T {
  const lock = join(resolve(workspace), "memory-state", "oll", ".candidate-store.lock");
  mkdirSync(join(resolve(workspace), "memory-state", "oll"), { recursive: true });
  const started = Date.now();
  for (;;) {
    try { mkdirSync(lock); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let stale = false;
      try { stale = Date.now() - statSync(lock).mtimeMs > 30_000; } catch { stale = false; }
      if (stale) { rmSync(lock, { recursive: true, force: true }); continue; }
      if (Date.now() - started > 5_000) throw new Error("memory candidate store lock timeout");
      sleepSync(20);
    }
  }
  try { return fn(); }
  finally { rmSync(lock, { recursive: true, force: true }); }
}

export function materializeMemoryCandidates(options: {
  workspace: string;
  workspaceId: string;
  report: MemoryCandidateReportV1;
  now?: string;
}): { created: number; deduplicated: number; candidates: MemoryCandidateV1[] } {
  if (options.report.workspaceId !== options.workspaceId) throw new Error("candidate report workspace mismatch");
  if (options.report.mode !== "materialize") return { created: 0, deduplicated: 0, candidates: options.report.candidates };
  const now = options.now || options.report.snapshotAt;
  return withCandidateLock(options.workspace, () => {
    let created = 0;
    let deduplicated = 0;
    const stored: MemoryCandidateV1[] = [];
    for (const candidate of options.report.candidates) {
      if (candidate.workspaceId !== options.workspaceId || candidate.schema !== MEMORY_CANDIDATE_SCHEMA) throw new Error("invalid candidate report entry");
      const paths = candidatePaths(options.workspace, candidate.candidateId);
      mkdirSync(join(resolve(options.workspace), "memory-state", "oll", "candidate-operations"), { recursive: true });
      const operation = {
        schema: "oll.memory-candidate-operation.v1",
        operationId: sha256Digest(canonicalizeJcs({ candidateId: candidate.candidateId, contentDigest: candidate.contentDigest })),
        workspaceId: options.workspaceId,
        candidateId: candidate.candidateId,
        contentDigest: candidate.contentDigest,
        status: "intent_recorded",
        updatedAt: now,
      };
      if (!existsSync(paths.operation)) atomicWriteJson(paths.operation, operation);
      if (existsSync(paths.candidate)) {
        const existing = JSON.parse(readFileSync(paths.candidate, "utf8")) as MemoryCandidateV1;
        if (existing.candidateId !== candidate.candidateId || existing.contentDigest !== candidate.contentDigest || existing.workspaceId !== options.workspaceId) {
          throw new Error(`memory candidate conflict: ${candidate.candidateId}`);
        }
        stored.push(existing);
        deduplicated += 1;
      } else {
        mkdirSync(join(resolve(options.workspace), "memory-state", "oll", "candidates"), { recursive: true });
        atomicWriteJson(paths.candidate, candidate);
        stored.push(candidate);
        created += 1;
      }
      atomicWriteJson(paths.operation, { ...operation, status: "committed", updatedAt: now });
    }
    return { created, deduplicated, candidates: stored };
  });
}

export function listPendingMemoryCandidates(options: { workspace: string; workspaceId: string }): MemoryCandidateV1[] {
  const root = join(resolve(options.workspace), "memory-state", "oll", "candidates");
  if (!existsSync(root)) return [];
  return readdirSync(root).filter((name) => /^[0-9a-f]{64}\.json$/.test(name)).sort().map((name) => {
    const candidate = JSON.parse(readFileSync(join(root, name), "utf8")) as MemoryCandidateV1;
    if (candidate.schema !== MEMORY_CANDIDATE_SCHEMA || candidate.workspaceId !== options.workspaceId || `${candidate.candidateId.slice(7)}.json` !== name) {
      throw new Error(`invalid memory candidate projection: ${name}`);
    }
    return candidate;
  }).filter((candidate) => candidate.lifecycle.status === "pending");
}

export function transitionMemoryCandidate(options: {
  workspace: string;
  workspaceId: string;
  candidateId: Digest;
  expectedRevision: number;
  disposition: MemoryCandidateDisposition;
  now?: string;
}): MemoryCandidateV1 {
  const now = options.now || new Date().toISOString();
  return withCandidateLock(options.workspace, () => {
    const path = candidatePaths(options.workspace, options.candidateId).candidate;
    if (!existsSync(path)) throw new Error(`memory candidate not found: ${options.candidateId}`);
    const current = JSON.parse(readFileSync(path, "utf8")) as MemoryCandidateV1;
    if (
      current.workspaceId === options.workspaceId
      && current.lifecycle.revision === options.expectedRevision + 1
      && current.lifecycle.disposition === options.disposition
    ) return current;
    if (current.workspaceId !== options.workspaceId || current.lifecycle.status !== "pending" || current.lifecycle.revision !== options.expectedRevision) {
      throw new Error(`memory candidate revision conflict: ${options.candidateId}`);
    }
    const status = options.disposition === "ignored" ? "dismissed" : options.disposition === "consumed" ? "evaluated" : "pending";
    const next: MemoryCandidateV1 = {
      ...current,
      lifecycle: {
        status,
        disposition: options.disposition,
        revision: current.lifecycle.revision + 1,
        updatedAt: now,
      },
    };
    atomicWriteJson(path, next);
    return next;
  });
}
