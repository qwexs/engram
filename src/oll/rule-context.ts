import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";
import { atomicWriteJson } from "./legacy-migration";

type JsonObject = Record<string, any>;
type ScopeLevel = "company" | "workspace" | "domain" | "person";

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SCOPE_ORDER: Record<ScopeLevel, number> = {
  company: 0,
  workspace: 1,
  domain: 2,
  person: 3,
};

export type RuleContextSessionKindV1 =
  | "main"
  | "peer-direct"
  | "group-direct"
  | "topic-thread";

export interface RuleContextTargetV1 {
  workspaceId: string;
  sessionKind: RuleContextSessionKindV1;
  domainSubjects: readonly string[];
  personSubjects: readonly string[];
  multiPerson: boolean;
}

export interface ResolvedRuleContextEntryV1 {
  ruleId: string;
  workspaceId: string;
  scope: { level: ScopeLevel; subject: string };
  revision: number;
  contentDigest: `sha256:${string}`;
  activatedAt: string;
  rule: string;
}

export interface RuleContextConflictV1 {
  conflictId: `sha256:${string}`;
  workspaceId: string;
  targetDigest: `sha256:${string}`;
  ruleIds: readonly [string, string];
  scopeLevels: readonly [ScopeLevel, ScopeLevel];
  directiveKey: string;
}

export interface RuleContextResolutionV1 {
  schema: "oll.rule-context-resolution.v1";
  status: "empty" | "resolved" | "conflict" | "overflow";
  target: RuleContextTargetV1;
  contextHash: `sha256:${string}`;
  rules: ResolvedRuleContextEntryV1[];
  provenance: Array<Pick<ResolvedRuleContextEntryV1, "ruleId" | "scope" | "revision" | "contentDigest">>;
  conflicts: RuleContextConflictV1[];
  payload: string | null;
  requiredBytes: number;
  maxBytes: number;
}

export interface RuleActivationPreflightV1 {
  schema: "oll.rule-activation-preflight.v1";
  reviewRequired: boolean;
  reason: "ok" | "context_overflow" | "rule_conflict";
  resolution: RuleContextResolutionV1;
}

function digest(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(object[key])}`).join(",")}}`;
}

function assertInside(root: string, path: string): void {
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  if (path !== root && !path.startsWith(prefix)) throw new Error(`rule context path escapes state root: ${path}`);
}

function readJson(path: string): JsonObject {
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must contain an object`);
  return value;
}

function readRules(path: string): JsonObject[] {
  if (!existsSync(path)) return [];
  return readdirSync(path)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .flatMap((name) => {
      try {
        const value = readJson(join(path, name));
        return value.schema === "oll.adaptation-rule.v1" ? [value] : [];
      } catch {
        return [];
      }
    });
}

function companyRulesRoot(config: JsonObject, stateRoot: string): string {
  const root = resolve(stateRoot);
  const setting = String(config?.oll?.adaptation?.companyRuleStore || "${ENGRAM_STATE_ROOT}/oll/company-rules");
  const path = resolve(setting.replaceAll("${ENGRAM_STATE_ROOT}", root));
  assertInside(root, path);
  return path;
}

function validRule(value: JsonObject): value is JsonObject & {
  id: string;
  workspaceId: string;
  scope: { level: ScopeLevel; subject: string };
  status: string;
  revision: number;
  contentDigest: `sha256:${string}`;
  rule: string;
} {
  return value.schema === "oll.adaptation-rule.v1"
    && UUID_RE.test(String(value.id || ""))
    && typeof value.workspaceId === "string"
    && value.scope && ["company", "workspace", "domain", "person"].includes(value.scope.level)
    && typeof value.scope.subject === "string" && value.scope.subject.length > 0
    && Number.isInteger(value.revision) && value.revision >= 1
    && DIGEST_RE.test(String(value.contentDigest || ""))
    && typeof value.rule === "string" && value.rule.trim().length > 0;
}

function matchesTarget(rule: JsonObject, target: RuleContextTargetV1): boolean {
  if (rule.scope.level === "company") return true;
  if (rule.workspaceId !== target.workspaceId) return false;
  if (rule.scope.level === "workspace") return rule.scope.subject === target.workspaceId;
  if (rule.scope.level === "domain") return target.domainSubjects.includes(rule.scope.subject);
  return !target.multiPerson && target.personSubjects.includes(rule.scope.subject);
}

function activeAt(rule: JsonObject, now: string, includeCandidate: boolean): boolean {
  if (rule.status !== "active" && !(includeCandidate && rule.status === "proposed")) return false;
  if (rule.expiresAt && Date.parse(rule.expiresAt) <= Date.parse(now)) return false;
  return true;
}

function toEntry(rule: JsonObject): ResolvedRuleContextEntryV1 {
  return {
    ruleId: rule.id,
    workspaceId: rule.workspaceId,
    scope: { level: rule.scope.level, subject: rule.scope.subject },
    revision: rule.revision,
    contentDigest: rule.contentDigest,
    activatedAt: String(rule.activatedAt || rule.decision?.decidedAt || "1970-01-01T00:00:00.000Z"),
    rule: rule.rule.trim(),
  };
}

function sortEntries(entries: ResolvedRuleContextEntryV1[], source: Map<string, JsonObject>): ResolvedRuleContextEntryV1[] {
  return [...entries].sort((left, right) => {
    const scope = SCOPE_ORDER[left.scope.level] - SCOPE_ORDER[right.scope.level];
    if (scope) return scope;
    const priority = Number(source.get(right.ruleId)?.priority || 0) - Number(source.get(left.ruleId)?.priority || 0);
    if (priority) return priority;
    const activated = left.activatedAt.localeCompare(right.activatedAt);
    if (activated) return activated;
    return left.ruleId.localeCompare(right.ruleId);
  });
}

function directiveIdentity(text: string): { key: string; polarity: 1 | -1 } {
  const normalized = text.toLocaleLowerCase("und").replaceAll("ё", "е");
  const negative = /\b(?:do\s+not|don['’]?t|never|must\s+not|не|нельзя|никогда|запрещ\w*)\b/iu.test(normalized);
  const tokens = normalized
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .filter((token) => !new Set([
      "do", "not", "don", "t", "never", "must", "use", "follow", "keep", "always",
      "не", "нельзя", "никогда", "надо", "нужно", "используй", "использовать", "соблюдай", "всегда",
    ]).has(token));
  return { key: [...tokens].sort().join(" "), polarity: negative ? -1 : 1 };
}

function targetDigest(target: RuleContextTargetV1): `sha256:${string}` {
  return digest(canonicalize({
    workspaceId: target.workspaceId,
    sessionKind: target.sessionKind,
    domainSubjects: [...target.domainSubjects].sort(),
    personSubjects: [...target.personSubjects].sort(),
    multiPerson: target.multiPerson,
  }));
}

function findConflicts(entries: ResolvedRuleContextEntryV1[], target: RuleContextTargetV1): RuleContextConflictV1[] {
  const found: RuleContextConflictV1[] = [];
  const targetHash = targetDigest(target);
  for (let leftIndex = 0; leftIndex < entries.length; leftIndex += 1) {
    const left = entries[leftIndex];
    const leftDirective = directiveIdentity(left.rule);
    if (!leftDirective.key) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < entries.length; rightIndex += 1) {
      const right = entries[rightIndex];
      const rightDirective = directiveIdentity(right.rule);
      if (leftDirective.key !== rightDirective.key || leftDirective.polarity === rightDirective.polarity) continue;
      const ids = [left.ruleId, right.ruleId].sort() as [string, string];
      found.push({
        conflictId: digest(canonicalize({ targetHash, ids, digests: [left.contentDigest, right.contentDigest].sort() })),
        workspaceId: target.workspaceId,
        targetDigest: targetHash,
        ruleIds: ids,
        scopeLevels: ids[0] === left.ruleId
          ? [left.scope.level, right.scope.level]
          : [right.scope.level, left.scope.level],
        directiveKey: leftDirective.key,
      });
    }
  }
  return found.sort((left, right) => left.conflictId.localeCompare(right.conflictId));
}

function identityHash(entries: ResolvedRuleContextEntryV1[]): `sha256:${string}` {
  const identity = entries.map((entry) => ({
    ruleId: entry.ruleId,
    scope: entry.scope,
    revision: entry.revision,
    contentDigest: entry.contentDigest,
  })).sort((left, right) => left.ruleId.localeCompare(right.ruleId));
  return digest(canonicalize(identity));
}

function renderPayload(entries: ResolvedRuleContextEntryV1[], contextHash: string): string {
  const rules = entries.map((entry) => (
    `- ${entry.rule}\n  provenance: ruleId=${entry.ruleId}; scope=${entry.scope.level}:${entry.scope.subject}; revision=${entry.revision}`
  )).join("\n");
  return `<engram-active-rules schema="oll.rule-context.v1" hash="${contextHash}">\n${rules}\n</engram-active-rules>`;
}

export function resolveRuleContext(options: {
  workspace: string;
  stateRoot: string;
  target: RuleContextTargetV1;
  maxBytes?: number;
  candidateRule?: JsonObject | null;
  now?: string;
}): RuleContextResolutionV1 {
  const workspace = resolve(options.workspace);
  const stateRoot = resolve(options.stateRoot);
  const config = readJson(join(workspace, "engram.json"));
  const configuredWorkspaceId = String(config?.workspace?.id || "");
  if (!configuredWorkspaceId || configuredWorkspaceId !== options.target.workspaceId) {
    throw new Error("rule context target workspace does not match engram.json");
  }
  const configuredMax = Number(config?.oll?.adaptation?.maxInjectedRuleBytes || 8192);
  const maxBytes = options.maxBytes ?? configuredMax;
  if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new Error("maxInjectedRuleBytes must be a positive integer");
  const now = options.now || new Date().toISOString();
  if (!Number.isFinite(Date.parse(now))) throw new Error("invalid rule context timestamp");

  const local = readRules(join(workspace, "memory-state", "oll", "rules"));
  const company = readRules(join(companyRulesRoot(config, stateRoot), "rules"));
  const all = [...local, ...company];
  if (options.candidateRule) all.push(options.candidateRule);
  const unique = new Map<string, JsonObject>();
  for (const value of all) {
    if (!validRule(value)) continue;
    const current = unique.get(value.id);
    if (current && current.contentDigest !== value.contentDigest) throw new Error(`ambiguous rule projection: ${value.id}`);
    unique.set(value.id, value);
  }
  const entries = sortEntries([...unique.values()]
    .filter((value) => activeAt(value, now, value === options.candidateRule))
    .filter((value) => matchesTarget(value, options.target))
    .map(toEntry), unique);
  const conflicts = findConflicts(entries, options.target);
  const blocked = new Set(conflicts.flatMap((conflict) => [...conflict.ruleIds]));
  const resolvedEntries = entries.filter((entry) => !blocked.has(entry.ruleId));
  const contextHash = identityHash(resolvedEntries);
  const payload = resolvedEntries.length ? renderPayload(resolvedEntries, contextHash) : null;
  const requiredBytes = payload ? Buffer.byteLength(payload, "utf8") : 0;

  if (requiredBytes > maxBytes) {
    return {
      schema: "oll.rule-context-resolution.v1",
      status: "overflow",
      target: options.target,
      contextHash: identityHash([]),
      rules: [],
      provenance: [],
      conflicts,
      payload: null,
      requiredBytes,
      maxBytes,
    };
  }
  return {
    schema: "oll.rule-context-resolution.v1",
    status: conflicts.length ? "conflict" : resolvedEntries.length ? "resolved" : "empty",
    target: options.target,
    contextHash,
    rules: resolvedEntries,
    provenance: resolvedEntries.map(({ ruleId, scope, revision, contentDigest }) => ({ ruleId, scope, revision, contentDigest })),
    conflicts,
    payload,
    requiredBytes,
    maxBytes,
  };
}

export function composeBootstrapContextHash(options: {
  domainContextHash?: string | null;
  ruleContextHash: string;
}): `sha256:${string}` {
  return digest(canonicalize({
    domainContextHash: options.domainContextHash || null,
    ruleContextHash: options.ruleContextHash,
  }));
}

export function preflightRuleActivation(options: {
  workspace: string;
  stateRoot: string;
  workspaceId: string;
  candidateRule: JsonObject;
  maxBytes?: number;
  now?: string;
}): RuleActivationPreflightV1 {
  const scope = options.candidateRule?.scope || {};
  const level = scope.level as ScopeLevel;
  if (!["company", "workspace", "domain", "person"].includes(level)) {
    throw new Error("candidate rule has an invalid scope");
  }
  const target: RuleContextTargetV1 = {
    workspaceId: options.workspaceId,
    sessionKind: level === "domain" ? "topic-thread" : level === "person" ? "peer-direct" : "main",
    domainSubjects: level === "domain" ? [String(scope.subject)] : [],
    personSubjects: level === "person" ? [String(scope.subject)] : [],
    multiPerson: level === "domain",
  };
  const resolution = resolveRuleContext({
    workspace: options.workspace,
    stateRoot: options.stateRoot,
    target,
    maxBytes: options.maxBytes,
    candidateRule: options.candidateRule,
    now: options.now,
  });
  const candidateConflict = resolution.conflicts.some((conflict) => conflict.ruleIds.includes(options.candidateRule.id));
  return {
    schema: "oll.rule-activation-preflight.v1",
    reviewRequired: resolution.status === "overflow" || candidateConflict,
    reason: resolution.status === "overflow" ? "context_overflow" : candidateConflict ? "rule_conflict" : "ok",
    resolution,
  };
}

export function persistRuleContextConflicts(options: {
  workspace: string;
  conflicts: readonly RuleContextConflictV1[];
  now?: string;
}): string[] {
  const now = options.now || new Date().toISOString();
  const root = join(resolve(options.workspace), "memory-state", "oll", "context-conflicts");
  mkdirSync(root, { recursive: true });
  return options.conflicts.map((conflict) => {
    const path = join(root, `${conflict.conflictId.replace(/^sha256:/, "")}.json`);
    if (!existsSync(path)) {
      atomicWriteJson(path, {
        schema: "oll.rule-context-conflict.v1",
        conflictId: conflict.conflictId,
        workspaceId: conflict.workspaceId,
        targetDigest: conflict.targetDigest,
        ruleIds: conflict.ruleIds,
        scopeLevels: conflict.scopeLevels,
        directiveKey: conflict.directiveKey,
        status: "pending_review",
        detectedAt: now,
        revision: 1,
      });
    }
    return path;
  });
}
