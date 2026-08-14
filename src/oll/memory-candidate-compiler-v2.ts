import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { readKgV3AccessState } from "../kg-v3/access";
import { kgV3DecayTier } from "../kg-v3/projection";
import { KG_V3_ASSERTION_SCHEMA, type KgAssertionV3 } from "../kg-v3/types";
import { canonicalizeJcs, sha256Digest, type Digest } from "./handoff-v2";
import {
  CANDIDATE_SUPPORTED_VERSIONS_V1,
  MEMORY_CANDIDATE_CLUSTER_V1_SCHEMA,
  MEMORY_CANDIDATE_REPORT_V2_SCHEMA,
  MEMORY_EVIDENCE_OCCURRENCE_V1_SCHEMA,
  candidateContextBytesV1,
  candidateIdV1,
  candidatePolicyDigestV2,
  candidateReportDigest,
  candidateScopeRegistryDigestV1,
  computeCandidateRankingV1,
  evidenceSetDigestV1,
  intersectCandidateScopes,
  normalizeCandidateStatement,
  occurrenceIdV1,
  semanticKeyV1,
  validateCandidatePolicyV2,
  validateCandidateReportV2,
  validateCandidateScopeRegistryV1,
  type CandidateClusterV1,
  type CandidateReasonCode,
  type CandidateReportV2,
  type CandidateScope,
  type CandidateScopeRegistryV1,
  type CandidateSourceClass,
  type CandidateSourcePolicyV2,
  type EvidenceOccurrenceV1,
} from "./memory-candidate-contracts-v2";

const COMPILER_VERSION = "compiler-v2" as const;
const NORMALIZER_VERSION = "semantic-v1" as const;
const SOURCE_CLASSES: CandidateSourceClass[] = [
  "daily-decision",
  "daily-learning",
  "retrieval-card",
  "domain-decision",
  "domain-proposal",
  "kg-assertion",
];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const RFC3339_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const LOCAL_DATE_TIME_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/;
const PRIVATE_PATH_RE = /(?:^|\s)(?:~\/|\/(?:home|root|opt\/openclaw\/\.openclaw|etc|var\/lib\/private)\/)[^\s]*/i;
const SENSITIVE_PATTERNS: RegExp[] = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/i,
  /\b(?:api[-_ ]?key|password|passwd|private[-_ ]?key|secret|token)\s*[:=]\s*\S+/i,
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b/,
  /\b(?:ghp|github_pat)_[A-Za-z0-9_]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
  /(?:^|\D)\+?\d[\d ()-]{9,}\d(?:\D|$)/,
];

class SourceAdmissionError extends Error {
  constructor(readonly reason: CandidateReasonCode) {
    super(reason);
  }
}

interface StableSource {
  bytes: Buffer;
  text: string;
  digest: Digest;
  relativePath: string;
}

interface OccurrenceDraft {
  sourceClass: CandidateSourceClass;
  evidenceKind: EvidenceOccurrenceV1["evidenceKind"];
  sourceRef: string;
  sourceVersionDigest: Digest;
  statement: string;
  provenanceRootId: Digest | null;
  authoritativeScope: CandidateScope;
  effectiveScope: CandidateScope;
  observedAt: string;
  originalTimestamp: string;
  timezone: string;
  parserVersion: string;
  kgDecay: EvidenceOccurrenceV1["kgDecay"];
}

export interface CompileMemoryCandidateReportV2Options {
  workspace: string;
  workspaceId: string;
  policy: CandidateSourcePolicyV2;
  scopeRegistry: CandidateScopeRegistryV1;
  snapshotAt: string;
  batchId: string;
  executionMode?: "report-only" | "shadow" | "materialize";
}

function inside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep) && !rel.split(sep).includes(".."));
}

function ensureNoSymlinkComponents(root: string, target: string): void {
  const canonicalRoot = realpathSync(root);
  const lexicalRoot = resolve(root);
  const lexicalTarget = resolve(target);
  if (!inside(lexicalRoot, lexicalTarget)) throw new SourceAdmissionError("path_escape");
  const parts = relative(lexicalRoot, lexicalTarget).split(sep).filter(Boolean);
  let cursor = lexicalRoot;
  for (const part of parts) {
    cursor = join(cursor, part);
    const stat = lstatSync(cursor);
    if (stat.isSymbolicLink()) throw new SourceAdmissionError("symlink_rejected");
  }
  const canonicalTarget = realpathSync(lexicalTarget);
  if (!inside(canonicalRoot, canonicalTarget)) throw new SourceAdmissionError("path_escape");
}

function stableRead(root: string, path: string): StableSource {
  try {
    ensureNoSymlinkComponents(root, path);
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      const before = fstatSync(fd);
      if (!before.isFile()) throw new SourceAdmissionError("non_regular_file");
      const bytes = readFileSync(fd);
      const after = fstatSync(fd);
      if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
        throw new SourceAdmissionError("source_unstable");
      }
      ensureNoSymlinkComponents(root, path);
      const published = lstatSync(path);
      if (published.dev !== before.dev || published.ino !== before.ino || published.size !== before.size || published.mtimeMs !== before.mtimeMs) {
        throw new SourceAdmissionError("source_unstable");
      }
      const relativePath = relative(resolve(root), resolve(path)).split(sep).join("/");
      if (!relativePath || relativePath.startsWith("../")) throw new SourceAdmissionError("path_escape");
      return { bytes, text: bytes.toString("utf8"), digest: sha256Digest(bytes), relativePath };
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if (error instanceof SourceAdmissionError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP") throw new SourceAdmissionError("symlink_rejected");
    throw new SourceAdmissionError("source_unstable");
  }
}

function stableNames(root: string, path: string): string[] {
  if (!existsSync(path)) return [];
  ensureNoSymlinkComponents(root, path);
  if (!lstatSync(path).isDirectory()) throw new SourceAdmissionError("non_regular_file");
  return readdirSync(path).sort();
}

function assertRfc3339(value: string, label: string): string {
  if (!RFC3339_RE.test(value) || !Number.isFinite(Date.parse(value))) throw new Error(`${label} must be an RFC3339 instant`);
  const parsed = new Date(value);
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  if (parsed.getUTCFullYear() < 1 || month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) {
    throw new Error(`${label} is invalid`);
  }
  return parsed.toISOString();
}

function localParts(instant: Date, timezone: string): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(formatter.formatToParts(instant).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

function legacyLocalInstant(value: string, policy: CandidateSourcePolicyV2): string {
  if (!policy.legacyTimestampParser) throw new SourceAdmissionError("timestamp_invalid");
  const match = LOCAL_DATE_TIME_RE.exec(value);
  if (!match) throw new SourceAdmissionError("timestamp_invalid");
  const [year, month, day, hour = "00", minute = "00", second = "00"] = match.slice(1);
  const local = `${year}-${month}-${day} ${hour}:${minute}:${second}`;
  const base = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
  if (new Date(base).toISOString().slice(0, 10) !== `${year}-${month}-${day}`) throw new SourceAdmissionError("timestamp_invalid");
  const matches: Date[] = [];
  for (let minutes = -14 * 60; minutes <= 14 * 60; minutes += 15) {
    const candidate = new Date(base - minutes * 60_000);
    if (localParts(candidate, policy.workspaceTimezone) === local) matches.push(candidate);
  }
  const unique = [...new Map(matches.map((entry) => [entry.toISOString(), entry])).values()].sort((a, b) => a.getTime() - b.getTime());
  if (unique.length === 0) throw new SourceAdmissionError("timestamp_invalid");
  if (unique.length > 1 && policy.legacyTimestampParser.daylightSavingAmbiguity === "reject") throw new SourceAdmissionError("timestamp_ambiguous");
  return (policy.legacyTimestampParser.daylightSavingAmbiguity === "later" ? unique.at(-1)! : unique[0]).toISOString();
}

function normalizeTimestamp(original: string, policy: CandidateSourcePolicyV2): string {
  if (RFC3339_RE.test(original)) {
    try {
      return assertRfc3339(original, "source timestamp");
    } catch {
      throw new SourceAdmissionError("timestamp_invalid");
    }
  }
  return legacyLocalInstant(original, policy);
}

function containsSensitiveText(statement: string, policy: CandidateSourcePolicyV2): boolean {
  if (policy.sensitiveTextPolicyVersion !== "privacy-v1") throw new Error("unsupported sensitive text policy version");
  return statement.length > 2_000 || PRIVATE_PATH_RE.test(statement) || SENSITIVE_PATTERNS.some((pattern) => pattern.test(statement));
}

function effectiveScope(registry: CandidateScopeRegistryV1, authority: CandidateScope | undefined, ceiling: CandidateScope): CandidateScope {
  if (!authority) throw new SourceAdmissionError("unsupported_scope");
  const intersection = intersectCandidateScopes(registry, authority, ceiling);
  if (!intersection) throw new SourceAdmissionError("scope_incomparable");
  return intersection;
}

function sourceRef(path: string, fragment: string): string {
  return `${path}#${fragment}`;
}

function makeOccurrence(options: CompileMemoryCandidateReportV2Options, draft: OccurrenceDraft): EvidenceOccurrenceV1 {
  const statement = normalizeCandidateStatement(draft.statement);
  if (!statement) throw new SourceAdmissionError("invalid_schema");
  if (containsSensitiveText(statement, options.policy)) throw new SourceAdmissionError("sensitive_text");
  const observedAt = normalizeTimestamp(draft.originalTimestamp, options.policy);
  const lower = Date.parse(assertRfc3339(options.policy.forwardOnlySince, "forwardOnlySince"));
  const upper = Date.parse(assertRfc3339(options.snapshotAt, "snapshotAt"));
  const observed = Date.parse(observedAt);
  if (observed < lower || observed > upper) throw new SourceAdmissionError("timestamp_out_of_window");
  const base: Omit<EvidenceOccurrenceV1, "occurrenceId"> = {
    schema: MEMORY_EVIDENCE_OCCURRENCE_V1_SCHEMA,
    workspaceId: options.workspaceId,
    sourceClass: draft.sourceClass,
    evidenceKind: draft.evidenceKind,
    sourceRef: draft.sourceRef,
    sourceVersionDigest: draft.sourceVersionDigest,
    contentDigest: sha256Digest(statement),
    provenanceRootId: draft.provenanceRootId || sha256Digest(`oll.memory-provenance-root.v1\0${statement}`),
    semanticKey: semanticKeyV1(statement),
    authoritativeScope: draft.authoritativeScope,
    effectiveScope: draft.effectiveScope,
    observedAt,
    originalTimestamp: draft.originalTimestamp,
    timezone: options.policy.workspaceTimezone,
    parserVersion: draft.parserVersion,
    kgDecay: draft.kgDecay,
    canonicalStatement: statement,
  };
  return { ...base, occurrenceId: occurrenceIdV1(base) };
}

function increment(rejections: Partial<Record<CandidateReasonCode, number>>, reason: CandidateReasonCode): void {
  rejections[reason] = (rejections[reason] || 0) + 1;
}

function admitDraft(options: CompileMemoryCandidateReportV2Options, draft: OccurrenceDraft, occurrences: EvidenceOccurrenceV1[], rejections: Partial<Record<CandidateReasonCode, number>>): void {
  try {
    occurrences.push(makeOccurrence(options, draft));
  } catch (error) {
    if (error instanceof SourceAdmissionError) increment(rejections, error.reason);
    else throw error;
  }
}

function parseDailyFile(options: CompileMemoryCandidateReportV2Options, session: CandidateSourcePolicyV2["daily"][number], source: StableSource, occurrences: EvidenceOccurrenceV1[], rejections: Partial<Record<CandidateReasonCode, number>>): void {
  const authority = options.scopeRegistry.sourceAuthorities.daily[session.session];
  const scope = effectiveScope(options.scopeRegistry, authority, session.scopeCeiling);
  const fileDate = basename(source.relativePath, ".md");
  let section: "decisions" | "learnings" | null = null;
  let explicitTimestamp: string | null = null;
  let ordinal = 0;
  for (const line of source.text.split(/\r?\n/)) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      const normalized = heading[1].toLowerCase();
      section = normalized === "decisions" || normalized === "learnings" ? normalized : null;
      explicitTimestamp = null;
      continue;
    }
    const recordHeading = /^###\s+(\S+)\s+—\s+(decision|learning)\s*$/i.exec(line);
    if (recordHeading) {
      const recordSection = recordHeading[2].toLowerCase() === "decision" ? "decisions" : "learnings";
      if (section !== recordSection) {
        section = null;
        explicitTimestamp = null;
        continue;
      }
      explicitTimestamp = recordHeading[1];
      continue;
    }
    const bullet = /^[-*]\s+(.+)$/.exec(line);
    if (!bullet || !section || !session.sections.includes(section)) continue;
    ordinal += 1;
    admitDraft(options, {
      sourceClass: section === "decisions" ? "daily-decision" : "daily-learning",
      evidenceKind: section === "decisions" ? "decision" : "learning",
      sourceRef: sourceRef(source.relativePath, `${section}:${ordinal}`),
      sourceVersionDigest: source.digest,
      statement: bullet[1],
      provenanceRootId: null,
      authoritativeScope: authority,
      effectiveScope: scope,
      observedAt: "",
      originalTimestamp: explicitTimestamp || fileDate,
      timezone: options.policy.workspaceTimezone,
      parserVersion: "daily-note-v2",
      kgDecay: null,
    }, occurrences, rejections);
  }
}

function parseRetrievalCard(options: CompileMemoryCandidateReportV2Options, session: CandidateSourcePolicyV2["daily"][number], source: StableSource, occurrences: EvidenceOccurrenceV1[], rejections: Partial<Record<CandidateReasonCode, number>>): void {
  if (!session.sections.includes("retrieval-cards")) return;
  if (!/\*\*Type:\*\*\s*retrieval event card/i.test(source.text)) return;
  const date = /\*\*Date:\*\*\s*([^\n]+)/i.exec(source.text)?.[1]?.trim();
  const summary = /(?:^|\n)##\s+Summary\s*\r?\n+([\s\S]+?)(?=\n##\s|$)/i.exec(source.text)?.[1]?.trim();
  if (!date || !summary) {
    increment(rejections, "invalid_schema");
    return;
  }
  const authority = options.scopeRegistry.sourceAuthorities.daily[session.session];
  admitDraft(options, {
    sourceClass: "retrieval-card",
    evidenceKind: "decision",
    sourceRef: sourceRef(source.relativePath, `retrieval-cards:${basename(source.relativePath)}`),
    sourceVersionDigest: source.digest,
    statement: summary,
    provenanceRootId: null,
    authoritativeScope: authority,
    effectiveScope: effectiveScope(options.scopeRegistry, authority, session.scopeCeiling),
    observedAt: "",
    originalTimestamp: date,
    timezone: options.policy.workspaceTimezone,
    parserVersion: "retrieval-card-v1",
    kgDecay: null,
  }, occurrences, rejections);
}

function parseDomainDecisions(options: CompileMemoryCandidateReportV2Options, domain: CandidateSourcePolicyV2["domains"][number], source: StableSource, occurrences: EvidenceOccurrenceV1[], rejections: Partial<Record<CandidateReasonCode, number>>): void {
  if (!domain.formats.includes("canonical-decisions-v1")) return;
  const authority = options.scopeRegistry.sourceAuthorities.domains[domain.domainId];
  const scope = effectiveScope(options.scopeRegistry, authority, domain.scopeCeiling);
  const blocks = source.text.split(/(?=^###\s+)/m).filter((block) => /^###\s+/m.test(block));
  let ordinal = 0;
  for (const block of blocks) {
    const topic = /^###\s+(\d{4}-\d{2}-\d{2})\s+—[^\n]*\n([\s\S]*)$/m.exec(block);
    const rule = /^###\s+[^\n]+\n([\s\S]*)$/m.exec(block);
    const statement = /\*\*Решение\*\*:\s*([^\n]+)/i.exec(topic?.[2] || "")?.[1]?.trim()
      || /\*\*Действие\*\*:\s*([^\n]+)/i.exec(rule?.[1] || "")?.[1]?.trim();
    const timestamp = topic?.[1] || /\*\*Добавлено\*\*:\s*(\d{4}-\d{2}-\d{2})/i.exec(rule?.[1] || "")?.[1];
    if (!statement || !timestamp) continue;
    ordinal += 1;
    admitDraft(options, {
      sourceClass: "domain-decision",
      evidenceKind: "decision",
      sourceRef: sourceRef(source.relativePath, `decisions:${ordinal}`),
      sourceVersionDigest: source.digest,
      statement,
      provenanceRootId: null,
      authoritativeScope: authority,
      effectiveScope: scope,
      observedAt: "",
      originalTimestamp: timestamp,
      timezone: options.policy.workspaceTimezone,
      parserVersion: "canonical-decisions-v1",
      kgDecay: null,
    }, occurrences, rejections);
  }
}

function parseDomainProposals(options: CompileMemoryCandidateReportV2Options, domain: CandidateSourcePolicyV2["domains"][number], source: StableSource, occurrences: EvidenceOccurrenceV1[], rejections: Partial<Record<CandidateReasonCode, number>>): void {
  if (!domain.formats.includes("canonical-proposals-v1")) return;
  const authority = options.scopeRegistry.sourceAuthorities.domains[domain.domainId];
  const scope = effectiveScope(options.scopeRegistry, authority, domain.scopeCeiling);
  const blocks = source.text.split(/(?=^##\s+)/m).filter((block) => /^##\s+/m.test(block));
  let ordinal = 0;
  for (const block of blocks) {
    const heading = /^##\s+(\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2})?)\s+—\s+PROPOSAL\s*$/mi.exec(block);
    const statement = /\*\*Proposal\*\*:\s*([^\n]+)/i.exec(block)?.[1]?.trim();
    if (!heading || !statement) continue;
    ordinal += 1;
    admitDraft(options, {
      sourceClass: "domain-proposal",
      evidenceKind: "proposal",
      sourceRef: sourceRef(source.relativePath, `proposals:${ordinal}`),
      sourceVersionDigest: source.digest,
      statement,
      provenanceRootId: null,
      authoritativeScope: authority,
      effectiveScope: scope,
      observedAt: "",
      originalTimestamp: heading[1],
      timezone: options.policy.workspaceTimezone,
      parserVersion: "canonical-proposals-v1",
      kgDecay: null,
    }, occurrences, rejections);
  }
}

function anchoredNamespaceMatch(entityId: string, prefix: string): boolean {
  const normalized = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  return entityId.startsWith(`${normalized}/`) && entityId.length > normalized.length + 1;
}

function parseKgAssertion(options: CompileMemoryCandidateReportV2Options, source: StableSource, accessState: ReturnType<typeof readKgV3AccessState>, occurrences: EvidenceOccurrenceV1[], rejections: Partial<Record<CandidateReasonCode, number>>): void {
  let assertion: KgAssertionV3;
  try {
    assertion = JSON.parse(source.text) as KgAssertionV3;
  } catch {
    increment(rejections, "invalid_schema");
    return;
  }
  if (assertion.schema !== KG_V3_ASSERTION_SCHEMA || assertion.workspaceId !== options.workspaceId || assertion.lifecycle?.status !== "active") {
    increment(rejections, "source_retracted");
    return;
  }
  const matches = options.policy.kg.flatMap((entry) => {
    if (!anchoredNamespaceMatch(assertion.entityId, entry.entityPrefix) || !entry.kinds.includes(assertion.kind as "decision" | "preference" | "constraint")) return [];
    return assertion.scope.filter((scope) => entry.admittedScopes.includes(scope)).map((scope) => ({ entry, scope }));
  });
  if (matches.length !== 1) {
    increment(rejections, "unsupported_scope");
    return;
  }
  const match = matches[0];
  const authority = options.scopeRegistry.sourceAuthorities.kgScopes[match.scope];
  const mapped = match.entry.scopeMapping[match.scope];
  const scope = effectiveScope(options.scopeRegistry, authority, mapped);
  const statement = assertion.object?.type === "string" ? assertion.object.value : "";
  const access = accessState.assertions[assertion.id];
  const accessCount = Math.min(options.policy.decayPolicy.accessCountCap, access?.accessCount || 0);
  const tier = kgV3DecayTier(assertion, accessState, new Date(options.snapshotAt));
  admitDraft(options, {
    sourceClass: "kg-assertion",
    evidenceKind: assertion.kind as "decision" | "preference" | "constraint",
    sourceRef: `kg:${assertion.entityId}`,
    sourceVersionDigest: source.digest,
    statement,
    provenanceRootId: assertion.provenance?.operationId || null,
    authoritativeScope: authority,
    effectiveScope: scope,
    observedAt: "",
    originalTimestamp: assertion.provenance?.observedAt || assertion.createdAt,
    timezone: options.policy.workspaceTimezone,
    parserVersion: "kg-assertion-v3",
    kgDecay: { tier, accessCount },
  }, occurrences, rejections);
}

function emptySourceCounts(): Record<CandidateSourceClass, number> {
  return Object.fromEntries(SOURCE_CLASSES.map((sourceClass) => [sourceClass, 0])) as Record<CandidateSourceClass, number>;
}

function snapshotKg(options: CompileMemoryCandidateReportV2Options): {
  accessState: ReturnType<typeof readKgV3AccessState>;
  accessStateDigest: Digest;
  assertionRevision: number;
  assertionDigest: Digest;
  assertionSources: StableSource[];
} {
  const accessState = readKgV3AccessState(options.workspace, options.workspaceId);
  const accessStateDigest = sha256Digest(canonicalizeJcs(accessState));
  const registryPath = join(options.workspace, "life", "v3", "registry.json");
  let assertionRevision = 0;
  if (existsSync(registryPath)) {
    const registry = JSON.parse(stableRead(options.workspace, registryPath).text) as { revision?: unknown };
    if (Number.isInteger(registry.revision) && Number(registry.revision) >= 0) assertionRevision = Number(registry.revision);
  }
  const assertionsRoot = join(options.workspace, "life", "v3", "assertions");
  const assertionSources = stableNames(options.workspace, assertionsRoot)
    .filter((name) => name.endsWith(".json"))
    .map((name) => stableRead(options.workspace, join(assertionsRoot, name)));
  const assertionDigest = sha256Digest(canonicalizeJcs(assertionSources.map((source) => ({ path: source.relativePath, digest: source.digest }))));
  return { accessState, accessStateDigest, assertionRevision, assertionDigest, assertionSources };
}

function compileOccurrences(options: CompileMemoryCandidateReportV2Options, kg: ReturnType<typeof snapshotKg>): { occurrences: EvidenceOccurrenceV1[]; rejections: Partial<Record<CandidateReasonCode, number>> } {
  const occurrences: EvidenceOccurrenceV1[] = [];
  const rejections: Partial<Record<CandidateReasonCode, number>> = {};
  for (const daily of options.policy.daily) {
    const sessionRoot = join(options.workspace, "memory", `agent-${options.workspaceId}`, daily.session);
    for (const name of stableNames(options.workspace, sessionRoot)) {
      const path = join(sessionRoot, name);
      try {
        if (name.endsWith(".md") && DATE_RE.test(name.slice(0, -3))) parseDailyFile(options, daily, stableRead(options.workspace, path), occurrences, rejections);
      } catch (error) {
        if (error instanceof SourceAdmissionError) increment(rejections, error.reason);
        else throw error;
      }
    }
    const retrievalRoot = join(sessionRoot, "retrieval");
    for (const name of stableNames(options.workspace, retrievalRoot).filter((entry) => entry.endsWith(".md"))) {
      try {
        parseRetrievalCard(options, daily, stableRead(options.workspace, join(retrievalRoot, name)), occurrences, rejections);
      } catch (error) {
        if (error instanceof SourceAdmissionError) increment(rejections, error.reason);
        else throw error;
      }
    }
  }
  for (const domain of options.policy.domains) {
    const domainRoot = join(options.workspace, "memory", "domains", domain.domainId);
    for (const [name, parser] of [["decisions.md", parseDomainDecisions], ["changelog.md", parseDomainProposals]] as const) {
      const path = join(domainRoot, name);
      if (!existsSync(path)) continue;
      try {
        parser(options, domain, stableRead(options.workspace, path), occurrences, rejections);
      } catch (error) {
        if (error instanceof SourceAdmissionError) increment(rejections, error.reason);
        else throw error;
      }
    }
  }
  for (const source of kg.assertionSources) parseKgAssertion(options, source, kg.accessState, occurrences, rejections);
  occurrences.sort((left, right) => left.observedAt.localeCompare(right.observedAt) || left.occurrenceId.localeCompare(right.occurrenceId));
  return { occurrences, rejections };
}

function candidateClusters(options: CompileMemoryCandidateReportV2Options, occurrences: EvidenceOccurrenceV1[], rejections: Partial<Record<CandidateReasonCode, number>>): CandidateClusterV1[] {
  const groups = new Map<string, EvidenceOccurrenceV1[]>();
  for (const occurrence of occurrences) {
    const key = canonicalizeJcs({ semanticKey: occurrence.semanticKey, effectiveScope: occurrence.effectiveScope });
    const group = groups.get(key) || [];
    group.push(occurrence);
    groups.set(key, group);
  }
  const eligible: CandidateClusterV1[] = [];
  for (const group of groups.values()) {
    const ordered = [...group].sort((left, right) => left.observedAt.localeCompare(right.observedAt) || left.occurrenceId.localeCompare(right.occurrenceId));
    const bounded = ordered.slice(-options.policy.limits.maxOccurrencesPerCluster);
    let scope = bounded[0].effectiveScope;
    for (const occurrence of bounded.slice(1)) {
      const next = intersectCandidateScopes(options.scopeRegistry, scope, occurrence.effectiveScope);
      if (!next) throw new Error("compiler produced incomparable cluster scopes");
      scope = next;
    }
    const canonical = [...bounded].filter((occurrence) => canonicalizeJcs(occurrence.effectiveScope) === canonicalizeJcs(scope))
      .sort((left, right) => right.observedAt.localeCompare(left.observedAt) || left.occurrenceId.localeCompare(right.occurrenceId))[0];
    const rankingEligible = bounded.some((occurrence) => !(
      occurrence.sourceClass === "kg-assertion"
      && occurrence.kgDecay?.tier === "cold"
      && ["decision", "preference"].includes(occurrence.evidenceKind)
    ));
    if (!rankingEligible) {
      increment(rejections, "cold_provenance_only");
      continue;
    }
    const ranking = computeCandidateRankingV1({ occurrences: bounded, policy: options.policy, snapshotAt: options.snapshotAt });
    if (ranking.score < options.policy.rankingPolicy.eligibilityThreshold) {
      increment(rejections, "not_selected");
      continue;
    }
    const candidateId = candidateIdV1({ workspaceId: options.workspaceId, normalizerVersion: NORMALIZER_VERSION, semanticKey: canonical.semanticKey, effectiveScope: scope });
    eligible.push({
      schema: MEMORY_CANDIDATE_CLUSTER_V1_SCHEMA,
      candidateId,
      workspaceId: options.workspaceId,
      normalizerVersion: NORMALIZER_VERSION,
      evaluationEpoch: 1,
      semanticKey: canonical.semanticKey,
      effectiveScope: scope,
      canonicalStatement: canonical.canonicalStatement,
      occurrenceIds: bounded.map((occurrence) => occurrence.occurrenceId),
      distinctProvenanceRootIds: [...new Set(bounded.flatMap((occurrence) => occurrence.provenanceRootId ? [occurrence.provenanceRootId] : []))].sort(),
      evidenceSetDigest: evidenceSetDigestV1(bounded.map((occurrence) => occurrence.occurrenceId)),
      ranking,
      lifecycle: {
        status: "pending",
        revision: 1,
        evaluationEpoch: 1,
        reasonCode: "admitted",
        reservationOwner: null,
        correlationId: sha256Digest(canonicalizeJcs({ batchId: options.batchId, candidateId })),
        updatedAt: options.snapshotAt,
      },
    });
  }
  const sorted = eligible.sort((left, right) => right.ranking.score - left.ranking.score || right.lifecycle.updatedAt.localeCompare(left.lifecycle.updatedAt) || left.candidateId.localeCompare(right.candidateId));
  const selected: CandidateClusterV1[] = [];
  const quotaUse = new Map<CandidateSourceClass, number>();
  for (const candidate of sorted) {
    if (selected.length >= options.policy.limits.maxCandidatesPerRun) {
      increment(rejections, "not_selected");
      continue;
    }
    const cited = candidate.occurrenceIds.map((id) => occurrences.find((occurrence) => occurrence.occurrenceId === id)!).filter(Boolean);
    const canonicalOccurrence = [...cited].filter((occurrence) => canonicalizeJcs(occurrence.effectiveScope) === canonicalizeJcs(candidate.effectiveScope))
      .sort((left, right) => right.observedAt.localeCompare(left.observedAt) || left.occurrenceId.localeCompare(right.occurrenceId))[0];
    const used = quotaUse.get(canonicalOccurrence.sourceClass) || 0;
    if (used >= options.policy.limits.sourceQuotas[canonicalOccurrence.sourceClass]) {
      increment(rejections, "source_quota");
      continue;
    }
    const proposed = [...selected, candidate];
    if (candidateContextBytesV1(proposed) > options.policy.limits.maxContextBytes) {
      increment(rejections, "byte_budget");
      continue;
    }
    selected.push(candidate);
    quotaUse.set(canonicalOccurrence.sourceClass, used + 1);
  }
  return selected;
}

export function compileMemoryCandidateReportV2(options: CompileMemoryCandidateReportV2Options): CandidateReportV2 {
  const workspace = resolve(options.workspace);
  if (!existsSync(workspace) || !lstatSync(workspace).isDirectory()) throw new Error("workspace is not a directory");
  const policy = validateCandidatePolicyV2(options.policy);
  const scopeRegistry = validateCandidateScopeRegistryV1(options.scopeRegistry);
  if (policy.mode === "disabled") throw new Error("disabled candidate policy cannot compile a report");
  const executionMode = options.executionMode || "report-only";
  if (executionMode === "shadow" && policy.mode !== "shadow") throw new Error("shadow execution requires a shadow policy");
  if (executionMode === "materialize" && policy.mode !== "materialize") throw new Error("materialize execution requires a materialize policy");
  if (scopeRegistry.workspaceId !== options.workspaceId) throw new Error("scope registry workspace mismatch");
  if (scopeRegistry.digest !== candidateScopeRegistryDigestV1(scopeRegistry)) throw new Error("scope registry digest mismatch");
  assertRfc3339(options.snapshotAt, "snapshotAt");
  if (!options.batchId || options.batchId.length > 300) throw new Error("batchId is invalid");
  const frozen = { ...options, workspace, policy, scopeRegistry };
  const kg = snapshotKg(frozen);
  const { occurrences, rejections } = compileOccurrences(frozen, kg);
  const candidates = candidateClusters(frozen, occurrences, rejections);
  const sourceCounts = emptySourceCounts();
  for (const occurrence of occurrences) sourceCounts[occurrence.sourceClass] += 1;
  const rejected = Object.values(rejections).reduce((sum, count) => sum + (count || 0), 0);
  const policyDigest = candidatePolicyDigestV2(policy);
  const compilationAttemptId = sha256Digest(canonicalizeJcs({
    schema: "oll.memory-candidate-compilation-attempt.v1",
    batchId: options.batchId,
    workspaceId: options.workspaceId,
    snapshotAt: options.snapshotAt,
    policyDigest,
    scopeRegistryDigest: scopeRegistry.digest,
    kgAssertionDigest: kg.assertionDigest,
    accessStateDigest: kg.accessStateDigest,
  }));
  const reportBase: Omit<CandidateReportV2, "reportDigest"> = {
    schema: MEMORY_CANDIDATE_REPORT_V2_SCHEMA,
    compilationAttemptId,
    batchId: options.batchId,
    workspaceId: options.workspaceId,
    executionMode,
    snapshotAt: new Date(options.snapshotAt).toISOString(),
    policyDigest,
    scopeRegistryRevision: scopeRegistry.revision,
    scopeRegistryDigest: scopeRegistry.digest,
    compilerVersion: COMPILER_VERSION,
    normalizerVersion: NORMALIZER_VERSION,
    parserVersions: [...new Set(occurrences.map((occurrence) => occurrence.parserVersion))].sort(),
    kgAssertionRevision: kg.assertionRevision,
    kgAssertionDigest: kg.assertionDigest,
    accessStateRevision: kg.accessState.revision,
    accessStateDigest: kg.accessStateDigest,
    considered: occurrences.length + rejected,
    eligible: occurrences.length,
    selected: candidates.length,
    rejected,
    selectedBytes: candidateContextBytesV1(candidates),
    projectedModelSpawns: candidates.length ? 1 : 0,
    projectedReviews: candidates.length,
    sourceCounts,
    rejectionCounts: rejections,
    occurrences,
    candidates,
  };
  const report = { ...reportBase, reportDigest: candidateReportDigest(reportBase) };
  return validateCandidateReportV2(report, { policy, scopeRegistry, versions: CANDIDATE_SUPPORTED_VERSIONS_V1 });
}

export function digestFileTree(root: string): Digest {
  const hash = createHash("sha256");
  const walk = (path: string): void => {
    for (const name of readdirSync(path).sort()) {
      const child = join(path, name);
      const stat = lstatSync(child);
      const rel = relative(root, child).split(sep).join("/");
      hash.update(`${stat.mode}:${stat.size}:${stat.mtimeMs}:${rel}\0`);
      if (stat.isDirectory()) walk(child);
      else if (stat.isFile()) hash.update(readFileSync(child));
    }
  };
  walk(root);
  return `sha256:${hash.digest("hex")}`;
}
