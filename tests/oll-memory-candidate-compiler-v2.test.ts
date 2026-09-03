import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sha256Digest } from "../src/oll/handoff-v2";
import { compileMemoryCandidateReportV2, digestFileTree } from "../src/oll/memory-candidate-compiler-v2";
import {
  MEMORY_CANDIDATE_POLICY_V2_SCHEMA,
  MEMORY_CANDIDATE_RANKING_POLICY_V1_SCHEMA,
  MEMORY_CANDIDATE_SCOPE_REGISTRY_V1_SCHEMA,
  candidateScopeRegistryDigestV1,
  validateCandidateReportV2,
  CANDIDATE_SUPPORTED_VERSIONS_V1,
  type CandidateScopeRegistryV1,
  type CandidateSourcePolicyV2,
} from "../src/oll/memory-candidate-contracts-v2";
import {
  OLL_OBSERVER_RECEIPT_REGISTRY_V1_SCHEMA,
  observerReceiptProducerRegistryDigestV1,
  type ObserverReceiptProducerRegistryV1,
  type ObserverReceiptScopeV1,
} from "../src/oll/observer-receipt-bridge-v1.ts";

const NOW = "2026-08-14T12:00:00.000Z";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function write(path: string, content: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content, "utf8");
}

function writeJson(path: string, value: unknown): void {
  write(path, `${JSON.stringify(value, null, 2)}\n`);
}

function policy(): CandidateSourcePolicyV2 {
  return {
    schema: MEMORY_CANDIDATE_POLICY_V2_SCHEMA,
    mode: "shadow",
    forwardOnlySince: "2026-08-14T00:00:00+03:00",
    workspaceTimezone: "Europe/Moscow",
    legacyTimestampParser: { version: "legacy-local-v1", daylightSavingAmbiguity: "reject" },
    daily: [{ session: "main", sections: ["decisions", "learnings", "retrieval-cards"], scopeCeiling: { level: "workspace", subject: "main" } }],
    domains: [{ domainId: "engram", formats: ["canonical-decisions-v1", "canonical-proposals-v1"], scopeCeiling: { level: "domain", subject: "engram" } }],
    kg: [{
      entityPrefix: "projects/",
      kinds: ["decision", "preference", "constraint"],
      admittedScopes: ["project:engram"],
      scopeMapping: { "project:engram": { level: "domain", subject: "engram" } },
    }],
    limits: {
      maxCandidatesPerRun: 20,
      maxContextBytes: 65_536,
      maxOccurrencesPerCluster: 8,
      sourceQuotas: {
        "daily-decision": 8,
        "daily-learning": 8,
        "retrieval-card": 8,
        "domain-decision": 8,
        "domain-proposal": 8,
        "kg-assertion": 8,
      },
    },
    decayPolicy: {
      schema: "oll.memory-candidate-decay-policy.v1",
      hotDays: 7,
      warmDays: 30,
      accessCountCap: 10,
      warmScorePenalty: 12,
      coldKgContribution: "provenance-only",
      trustedAccessEventSchema: "engram.kg-v3-access-event.v1",
    },
    rankingPolicy: {
      schema: MEMORY_CANDIDATE_RANKING_POLICY_V1_SCHEMA,
      eligibilityThreshold: 55,
      baseScores: { decision: 70, learning: 55, preference: 78, constraint: 74, proposal: 68 },
      recencyBoostMax: 10,
      recencyBoostPerDay: 2,
      distinctRootBoostPerRoot: 3,
      distinctRootBoostMax: 12,
    },
    sensitiveTextPolicyVersion: "privacy-v1",
  };
}

function scopeRegistry(): CandidateScopeRegistryV1 {
  const base: Omit<CandidateScopeRegistryV1, "digest"> = {
    schema: MEMORY_CANDIDATE_SCOPE_REGISTRY_V1_SCHEMA,
    workspaceId: "main",
    revision: 1,
    selfToDomain: {},
    domainToWorkspace: { engram: "main" },
    sourceAuthorities: {
      daily: { main: { level: "workspace", subject: "main" } },
      domains: { engram: { level: "domain", subject: "engram" } },
      kgScopes: { "project:engram": { level: "domain", subject: "engram" } },
    },
  };
  return { ...base, digest: candidateScopeRegistryDigestV1(base) };
}

function assertion(options: { id?: string; statement?: string; kind?: "decision" | "preference" | "constraint"; observedAt?: string; operationId?: `sha256:${string}` } = {}) {
  const id = options.id || "11111111-1111-4111-8111-111111111111";
  const observedAt = options.observedAt || "2026-08-14T10:20:00+03:00";
  return {
    schema: "engram.kg-assertion.v3-mvp",
    id,
    workspaceId: "main",
    entityId: "projects/engram-retention",
    entityType: "project",
    kind: options.kind || "constraint",
    predicate: "policy",
    object: { type: "string", value: options.statement || "сохранять проверяемую историю восстановления" },
    scope: ["project:engram"],
    lifecycle: { status: "active", replacesId: null, supersededById: null, changedAt: observedAt },
    provenance: {
      sourceKind: "operator-curated",
      sessionKey: "main",
      messageId: "fixture-1",
      actorId: "actor:fixture",
      operationId: options.operationId || sha256Digest("fixture-operation"),
      observedAt,
    },
    createdAt: observedAt,
  };
}

function workspace(options: { minimal?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "engram-candidate-v2-"));
  roots.push(root);
  const p = policy();
  const registry = scopeRegistry();
  writeJson(join(root, "engram.json"), { workspace: { id: "main" } });
  writeJson(join(root, "life", "v3", "registry.json"), { revision: 7 });
  mkdirSync(join(root, "life", "v3", "assertions"), { recursive: true });
  mkdirSync(join(root, "memory", "agent-main", "main"), { recursive: true });
  mkdirSync(join(root, "memory", "domains", "engram"), { recursive: true });
  if (!options.minimal) {
    write(join(root, "memory", "agent-main", "main", "2026-08-14.md"), [
      "# 2026-08-14",
      "",
      "## Decisions",
      "",
      "### 2026-08-14T10:15:00+03:00 — decision",
      "",
      "- Использовать только подтверждённый источник.",
      "",
      "## Learnings",
      "",
      "### 2026-08-14T10:16:00+03:00 — learning",
      "",
      "- Проверять digest перед восстановлением.",
      "",
    ].join("\n"));
    write(join(root, "memory", "agent-main", "main", "retrieval", "2026-08-14-verified.md"), [
      "# Verified recovery",
      "",
      "- **Type:** retrieval event card",
      "- **Date:** 2026-08-14",
      "- **Source:** `memory/agent-main/main/2026-08-14.md` — Decisions",
      "",
      "## Summary",
      "",
      "Проверять digest перед восстановлением.",
      "",
    ].join("\n"));
    write(join(root, "memory", "domains", "engram", "decisions.md"), [
      "# Правила: Engram",
      "",
      "### Стабильное восстановление",
      "",
      "**Условие**: найден опубликованный compiler report",
      "**Действие**: восстанавливать только из проверенного report",
      "**Добавлено**: 2026-08-14",
      "",
      "### 2026-08-14 — Проверка отчёта",
      "",
      "**Решение**: проверять report digest",
      "**Контекст**: nightly compiler",
      "**Участники**: Сергей",
      "",
    ].join("\n"));
    write(join(root, "memory", "domains", "engram", "changelog.md"), [
      "# Changelog",
      "",
      "## 2026-08-14 14:30 — PROPOSAL",
      "**Proposal**: require report digest verification before recovery",
      "**Reason**: mutable sources must not change a persisted batch",
      "",
    ].join("\n"));
    writeJson(join(root, "life", "v3", "assertions", "11111111-1111-4111-8111-111111111111.json"), assertion());
  }
  return { root, policy: p, registry };
}

function compile(
  root: string,
  p: CandidateSourcePolicyV2,
  registry: CandidateScopeRegistryV1,
  snapshotAt = NOW,
  observerReceiptProducerRegistry?: ObserverReceiptProducerRegistryV1,
  executionMode: "report-only" | "shadow" | "materialize" = "report-only",
) {
  return compileMemoryCandidateReportV2({
    workspace: root,
    workspaceId: "main",
    policy: p,
    scopeRegistry: registry,
    observerReceiptProducerRegistry,
    executionMode,
    snapshotAt,
    batchId: `report-only:${snapshotAt}`,
  });
}

const BATCH_PRODUCER = {
  id: "batch-post-turn-observer",
  version: "v1",
  digest: "sha256:69bf6adb1ebcf5b258102f13871ca7ab29af55df47f0709a489616d76c1d1f74" as const,
};
const DAILY_APPLICATOR = {
  id: "daily-note-applicator",
  version: "v1",
  digest: "sha256:f9e632bc639b5f4240c15f4ac1fffb2ffa1c0b299a380d1432216c9a2c8b7ef5" as const,
};

function bridgeRegistry(
  exactScope: ObserverReceiptScopeV1,
  evaluationPolicyDigest: `sha256:${string}`,
  rolloutState: "report-only" | "shadow" | "materialize" = "report-only",
): ObserverReceiptProducerRegistryV1 {
  const base: Omit<ObserverReceiptProducerRegistryV1, "digest"> = {
    schema: OLL_OBSERVER_RECEIPT_REGISTRY_V1_SCHEMA,
    workspaceId: "main",
    registryVersion: 1,
    canonicalApplicator: DAILY_APPLICATOR,
    entries: [{
      producer: BATCH_PRODUCER,
      observationSchemas: ["engram.memory-batch-observation.v1"],
      allowedObservationClasses: ["episodic.decision"],
      allowedScopeClasses: ["self"],
      exactScopeAllowlist: [exactScope],
      requiredReceiptSchema: "engram.memory-apply-receipt.v1",
      requireCanonicalReadBack: true,
      allowedEvaluationPolicyDigests: [evaluationPolicyDigest],
      rolloutState,
    }],
  };
  return { ...base, digest: observerReceiptProducerRegistryDigestV1(base) };
}

function batchApplyReceipt(input: {
  entryId: `sha256:${string}`;
  relativePath: string;
  statement: string;
  scope: ObserverReceiptScopeV1;
  evaluationPolicyDigest: `sha256:${string}`;
}) {
  const sourceTurnId = `channel-user:v1:${"a".repeat(64)}`;
  const traceId = sha256Digest("batch-source-trace");
  const operationId = sha256Digest("batch-daily-apply-operation");
  const evidenceRef = { kind: "source-turn" as const, ref: sourceTurnId, digest: sha256Digest("source-evidence") };
  return {
    schema: "engram.memory-apply-receipt.v1",
    receiptId: sha256Digest(`engram.memory-apply-receipt.v1\0${operationId}`),
    traceId,
    sourceObservationRef: sha256Digest("batch-observation-id"),
    sourceCompletedAt: "2026-08-14T10:15:00.000Z",
    scope: input.scope,
    producer: DAILY_APPLICATOR,
    sourceProvenance: {
      sourceTurnId,
      producer: BATCH_PRODUCER,
      observationClass: "episodic.decision",
      evidenceRefs: [evidenceRef],
      observationDigest: sha256Digest("batch-observation-digest"),
      batchSourceRefs: [{
        traceId,
        sourceTurnId,
        sourceDigest: sha256Digest("source-digest"),
        evidenceDigest: sha256Digest("evidence-digest"),
        sourceCompletedAt: "2026-08-14T10:15:00.000Z",
      }],
      batchCitations: [{ traceId, evidenceRef }],
      batchEvaluationPolicyDigest: input.evaluationPolicyDigest,
    },
    consumer: "daily-note",
    operationId,
    destinationDate: "2026-08-14",
    destinationRef: `${input.relativePath}#engram-entry:${input.entryId}`,
    destinationEntryId: input.entryId,
    status: "applied",
    canonicalMutation: true,
    readBackDigest: sha256Digest([
      `<!-- engram-entry:${input.entryId} -->`,
      ...input.statement.split("\n").map((line, index) => `${index === 0 ? "- " : "  "}${line}`),
    ].join("\n")),
    policyDigest: sha256Digest("daily-note-canary-policy"),
    completedAt: "2026-08-14T10:16:00.000Z",
  };
}

describe("OLL memory candidate Phase 1 compiler", () => {
  test("parses every canonical source class and emits a verified deterministic report", () => {
    const { root, policy: p, registry } = workspace();
    const first = compile(root, p, registry);
    const second = compile(root, p, registry);
    expect(second).toEqual(first);
    expect(first.reportDigest).toBe("sha256:501db061c6a8f893f959d3e5b87624c500cb19efff4c36302cbabb10c650e334");
    expect(new Set(first.occurrences.map((entry) => entry.sourceClass))).toEqual(new Set([
      "daily-decision", "daily-learning", "retrieval-card", "domain-decision", "domain-proposal", "kg-assertion",
    ]));
    expect(validateCandidateReportV2(first, { policy: p, scopeRegistry: registry, versions: CANDIDATE_SUPPORTED_VERSIONS_V1 })).toEqual(first);
    expect(first.projectedModelSpawns).toBe(1);
    expect(first.projectedReviews).toBe(first.candidates.length);
  });

  test("report-only compilation performs zero filesystem writes", () => {
    const { root, policy: p, registry } = workspace();
    const before = digestFileTree(root);
    compile(root, p, registry);
    expect(digestFileTree(root)).toBe(before);
  });

  test("enforces the exact inclusive RFC3339 forward and snapshot boundaries", () => {
    const { root, policy: p, registry } = workspace({ minimal: true });
    p.forwardOnlySince = "2026-08-14T10:15:00+03:00";
    write(join(root, "memory", "agent-main", "main", "2026-08-14.md"), [
      "## Decisions",
      "### 2026-08-14T10:14:59+03:00 — decision", "- before",
      "### 2026-08-14T10:15:00+03:00 — decision", "- lower",
      "### 2026-08-14T10:16:00+03:00 — decision", "- upper",
      "### 2026-08-14T10:16:01+03:00 — decision", "- after",
    ].join("\n"));
    const report = compile(root, p, registry, "2026-08-14T07:16:00.000Z");
    expect(report.occurrences.map((entry) => entry.canonicalStatement)).toEqual(["lower", "upper"]);
    expect(report.rejectionCounts.timestamp_out_of_window).toBe(2);
  });

  test("parses the production daily-note shape without leaking into later sections", () => {
    const { root, policy: p, registry } = workspace({ minimal: true });
    p.forwardOnlySince = "2026-08-14T00:00:00Z";
    p.workspaceTimezone = "UTC";
    write(join(root, "memory", "agent-main", "main", "2026-08-14.md"), [
      "# 2026-08-14",
      "",
      "## Events",
      "- ordinary event",
      "",
      "## Decisions",
      "- legacy production decision",
      "",
      "## Learnings",
      "- legacy production learning",
      "",
      "## Active Threads",
      "- active thread must not be admitted",
      "",
      "## Next",
      "- next action must not be admitted",
      "",
      "## Heartbeat Report",
      "- heartbeat bullet must not be admitted",
      "",
    ].join("\n"));

    const report = compile(root, p, registry, "2026-08-15T00:00:00.000Z");
    expect(report.occurrences.map((entry) => entry.canonicalStatement).sort()).toEqual([
      "legacy production decision",
      "legacy production learning",
    ].sort());
    expect(report.occurrences.map((entry) => entry.observedAt).sort()).toEqual([
      "2026-08-14T00:00:00.000Z",
      "2026-08-14T00:00:00.000Z",
    ]);

    p.legacyTimestampParser = null;
    const strict = compile(root, p, registry, "2026-08-15T00:00:00.000Z");
    expect(strict.occurrences).toEqual([]);
    expect(strict.rejectionCounts.timestamp_invalid).toBe(2);
  });

  test("default-denies observer-authored decisions and admits a receipt-joined batch decision only through the exact registry", () => {
    const { root, policy: p, registry } = workspace({ minimal: true });
    p.forwardOnlySince = "2026-08-14T00:00:00Z";
    p.workspaceTimezone = "UTC";
    const entryId = `sha256:${"d".repeat(64)}` as const;
    const relativePath = "memory/agent-main/main/2026-08-14.md";
    const statement = "Observer-authored decision becomes an OLL candidate only after the receipt join.\nThe complete canonical entry must read back.";
    const exactScope: ObserverReceiptScopeV1 = {
      workspaceId: "main",
      runtimeSessionKey: "agent:main:telegram:direct:100000001",
      scopeClass: "self",
      scopeId: "telegram:100000001",
    };
    const evaluationPolicyDigest = sha256Digest("memory-batch-shadow-prompt-v8");
    write(join(root, relativePath), [
      "# 2026-08-14",
      "",
      "## Decisions",
      "",
      `<!-- engram-entry:${entryId} -->`,
      ...statement.split("\n").map((line, index) => `${index === 0 ? "- " : "  "}${line}`),
      "",
    ].join("\n"));

    const missingSidecar = compile(root, p, registry, "2026-08-15T00:00:00.000Z");
    expect(missingSidecar.occurrences).toEqual([]);
    expect(missingSidecar.rejectionCounts.invalid_schema).toBe(1);

    const receiptPath = join(root, "memory-state", "memory-observation", "v1", "receipts", "by-entry", `${"d".repeat(64)}.json`);
    const receipt = batchApplyReceipt({ entryId, relativePath, statement, scope: exactScope, evaluationPolicyDigest });
    writeJson(receiptPath, receipt);
    const noRegistry = compile(root, p, registry, "2026-08-15T00:00:00.000Z");
    expect(noRegistry.occurrences).toEqual([]);
    expect(noRegistry.rejectionCounts.unsupported_source).toBe(1);

    const producerRegistry = bridgeRegistry(exactScope, evaluationPolicyDigest);
    const admitted = compile(root, p, registry, "2026-08-15T00:00:00.000Z", producerRegistry);
    expect(admitted.occurrences).toHaveLength(1);
    expect(admitted.occurrences[0]).toMatchObject({
      sourceClass: "daily-decision",
      parserVersion: "daily-note-receipt-v1",
      canonicalStatement: statement.replace("\n", " "),
      provenanceRootId: receipt.sourceProvenance.observationDigest,
      observedAt: receipt.sourceCompletedAt,
    });
    expect(compile(root, p, registry, "2026-08-15T00:00:00.000Z", producerRegistry)).toEqual(admitted);

    writeJson(receiptPath, { ...receipt, readBackDigest: sha256Digest("wrong-read-back") });
    const mismatchedReadBack = compile(root, p, registry, "2026-08-15T00:00:00.000Z", producerRegistry);
    expect(mismatchedReadBack.occurrences).toEqual([]);
    expect(mismatchedReadBack.rejectionCounts.invalid_schema).toBe(1);
  });

  test("keeps report-only batch admission out of materialize and denies scope or evaluator-policy drift", () => {
    const { root, policy: p, registry } = workspace({ minimal: true });
    p.mode = "materialize";
    p.forwardOnlySince = "2026-08-14T00:00:00Z";
    p.workspaceTimezone = "UTC";
    const entryId = `sha256:${"e".repeat(64)}` as const;
    const relativePath = "memory/agent-main/main/2026-08-14.md";
    const statement = "Only an explicitly materialized bridge may feed adaptation.";
    const exactScope: ObserverReceiptScopeV1 = {
      workspaceId: "main",
      runtimeSessionKey: "agent:main:telegram:direct:100000001",
      scopeClass: "self",
      scopeId: "telegram:100000001",
    };
    const evaluationPolicyDigest = sha256Digest("memory-batch-shadow-prompt-v8");
    write(join(root, relativePath), `# 2026-08-14\n\n## Decisions\n\n<!-- engram-entry:${entryId} -->\n- ${statement}\n`);
    const receiptPath = join(root, "memory-state", "memory-observation", "v1", "receipts", "by-entry", `${"e".repeat(64)}.json`);
    const receipt = batchApplyReceipt({ entryId, relativePath, statement, scope: exactScope, evaluationPolicyDigest });
    writeJson(receiptPath, receipt);

    const reportOnly = bridgeRegistry(exactScope, evaluationPolicyDigest, "report-only");
    const gated = compile(root, p, registry, "2026-08-15T00:00:00.000Z", reportOnly, "materialize");
    expect(gated.occurrences).toEqual([]);
    expect(gated.rejectionCounts.unsupported_source).toBe(1);

    const materialize = bridgeRegistry(exactScope, evaluationPolicyDigest, "materialize");
    expect(compile(root, p, registry, "2026-08-15T00:00:00.000Z", materialize, "materialize").occurrences).toHaveLength(1);

    const wrongScope = bridgeRegistry({ ...exactScope, runtimeSessionKey: "agent:main:telegram:direct:999" }, evaluationPolicyDigest, "materialize");
    expect(compile(root, p, registry, "2026-08-15T00:00:00.000Z", wrongScope, "materialize").rejectionCounts.unsupported_source).toBe(1);

    const wrongPolicy = bridgeRegistry(exactScope, sha256Digest("different-evaluator-policy"), "materialize");
    expect(compile(root, p, registry, "2026-08-15T00:00:00.000Z", wrongPolicy, "materialize").rejectionCounts.unsupported_source).toBe(1);
  });

  test("accepts producer-stamped records under their matching canonical section", () => {
    const { root, policy: p, registry } = workspace({ minimal: true });
    p.legacyTimestampParser = null;
    write(join(root, "memory", "agent-main", "main", "2026-08-14.md"), [
      "# 2026-08-14",
      "",
      "## Decisions",
      "",
      "### 2026-08-14T10:15:00.000Z — decision",
      "",
      "- stamped production decision",
      "",
      "## Heartbeat Report",
      "- heartbeat bullet must not be admitted",
      "",
    ].join("\n"));
    const report = compile(root, p, registry);
    expect(report.occurrences.map((entry) => entry.canonicalStatement)).toEqual(["stamped production decision"]);
    expect(report.rejectionCounts.timestamp_invalid).toBeUndefined();
  });

  test("rejects sensitive text and symlink sources without exposing raw content", () => {
    const { root, policy: p, registry } = workspace({ minimal: true });
    const privateValue = "api_key=super-secret-value";
    write(join(root, "memory", "agent-main", "main", "2026-08-14.md"), `## Decisions\n- ${privateValue}\n`);
    const outside = join(root, "outside.md");
    write(outside, "## Decisions\n- escaped\n");
    // Windows requires a privileged symlink entitlement; the sensitive-text
    // rejection below stays covered there, while POSIX CI also covers escapes.
    if (process.platform !== "win32") {
      symlinkSync(outside, join(root, "memory", "agent-main", "main", "2026-08-15.md"));
    }
    const report = compile(root, p, registry, "2026-08-16T00:00:00.000Z");
    expect(report.rejectionCounts.sensitive_text).toBe(1);
    if (process.platform !== "win32") expect(report.rejectionCounts.symlink_rejected).toBe(1);
    expect(JSON.stringify(report)).not.toContain(privateValue);
    expect(JSON.stringify(report)).not.toContain(outside);
  });

  test("rejects non-regular source entries and all privacy-v1 credential classes content-free", () => {
    const samples = [
      "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
      "-----BEGIN PRIVATE KEY----- abcdef",
      "password=hunter-two-value",
      "github_pat_abcdefghijklmnopqrstuvwxyz",
      `private file ${["", "home", "example", ".ssh", "id_ed25519"].join("/")}`,
      "contact private.person@example.invalid",
    ];
    for (const [index, sample] of samples.entries()) {
      const { root, policy: p, registry } = workspace({ minimal: true });
      write(join(root, "memory", "agent-main", "main", "2026-08-14.md"), `## Decisions\n- ${sample}\n`);
      mkdirSync(join(root, "memory", "agent-main", "main", "2026-08-15.md"));
      const report = compile(root, p, registry, "2026-08-16T00:00:00.000Z");
      expect(report.rejectionCounts.sensitive_text, `privacy sample ${index}`).toBe(1);
      expect(report.rejectionCounts.non_regular_file, `non-regular sample ${index}`).toBe(1);
      expect(JSON.stringify(report)).not.toContain(sample);
    }
  });

  test("rejects ambiguous or unversioned legacy local timestamps", () => {
    const { root, policy: p, registry } = workspace({ minimal: true });
    p.workspaceTimezone = "America/New_York";
    p.forwardOnlySince = "2026-10-01T00:00:00Z";
    write(join(root, "memory", "domains", "engram", "changelog.md"), "## 2026-11-01 01:30 — PROPOSAL\n**Proposal**: ambiguous local time\n");
    const ambiguous = compile(root, p, registry, "2026-11-02T00:00:00.000Z");
    expect(ambiguous.rejectionCounts.timestamp_ambiguous).toBe(1);
    p.legacyTimestampParser = null;
    const unversioned = compile(root, p, registry, "2026-11-02T00:00:00.000Z");
    expect(unversioned.rejectionCounts.timestamp_invalid).toBe(1);
  });

  test("trusted source authority may be narrowed by policy but never broadened", () => {
    const { root, policy: p, registry } = workspace({ minimal: true });
    write(join(root, "memory", "agent-main", "main", "2026-08-14.md"), "## Decisions\n- scoped\n");
    const authorityBase: Omit<CandidateScopeRegistryV1, "digest"> = {
      ...registry,
      sourceAuthorities: { ...registry.sourceAuthorities, daily: { main: { level: "domain", subject: "engram" } } },
    };
    const narrowedRegistry = { ...authorityBase, digest: candidateScopeRegistryDigestV1(authorityBase) };
    const report = compile(root, p, narrowedRegistry);
    expect(report.occurrences[0].authoritativeScope).toEqual({ level: "domain", subject: "engram" });
    expect(report.occurrences[0].effectiveScope).toEqual({ level: "domain", subject: "engram" });

    const forgedBase: Omit<CandidateScopeRegistryV1, "digest"> = {
      ...registry,
      sourceAuthorities: { ...registry.sourceAuthorities, daily: {} },
    };
    const forged = { ...forgedBase, digest: candidateScopeRegistryDigestV1(forgedBase) };
    const rejected = compile(root, p, forged);
    expect(rejected.occurrences).toEqual([]);
    expect(rejected.rejectionCounts.unsupported_scope).toBe(1);
  });

  test("cross-layer copies share one provenance root and one cluster slot", () => {
    const { root, policy: p, registry } = workspace({ minimal: true });
    const statement = "Проверять digest перед восстановлением.";
    write(join(root, "memory", "agent-main", "main", "2026-08-14.md"), `## Decisions\n### 2026-08-14T10:15:00+03:00 — decision\n- ${statement}\n`);
    write(join(root, "memory", "agent-main", "main", "retrieval", "2026-08-14-copy.md"), `- **Type:** retrieval event card\n- **Date:** 2026-08-14\n## Summary\n${statement}\n`);
    const report = compile(root, p, registry);
    expect(report.occurrences).toHaveLength(2);
    expect(report.candidates).toHaveLength(1);
    expect(report.candidates[0].occurrenceIds).toHaveLength(2);
    expect(report.candidates[0].distinctProvenanceRootIds).toHaveLength(1);
    expect(report.candidates[0].ranking.distinctRootBoost).toBe(0);
  });

  test("cold KG decisions are provenance-only and compiler reads create no access receipts", () => {
    const { root, policy: p, registry } = workspace({ minimal: true });
    const cold = assertion({ kind: "decision", observedAt: "2026-06-01T10:20:00+03:00" });
    writeJson(join(root, "life", "v3", "assertions", `${cold.id}.json`), cold);
    p.forwardOnlySince = "2026-01-01T00:00:00Z";
    const before = digestFileTree(root);
    const report = compile(root, p, registry);
    expect(report.occurrences).toHaveLength(1);
    expect(report.occurrences[0].kgDecay?.tier).toBe("cold");
    expect(report.candidates).toEqual([]);
    expect(report.rejectionCounts.cold_provenance_only).toBe(1);
    expect(digestFileTree(root)).toBe(before);
  });

  test("CLI emits the same verified report and leaves the workspace byte-identical", () => {
    const { root, policy: p, registry } = workspace();
    const policyPath = join(root, "candidate-policy.json");
    const registryPath = join(root, "candidate-scope-registry.json");
    writeJson(policyPath, p);
    writeJson(registryPath, registry);
    const before = digestFileTree(root);
    const run = Bun.spawnSync([
      process.execPath,
      join(import.meta.dir, "..", "scripts", "oll-memory-candidates.ts"),
      "--workspace", root,
      "--snapshot-at", NOW,
      "--batch-id", `report-only:${NOW}`,
      "--policy-file", policyPath,
      "--scope-registry-file", registryPath,
    ]);
    expect(run.exitCode, run.stderr.toString()).toBe(0);
    const report = JSON.parse(run.stdout.toString());
    expect(report).toEqual(compile(root, p, registry));
    expect(digestFileTree(root)).toBe(before);
  });

  test("CLI error output does not disclose absolute private paths", () => {
    const { root } = workspace({ minimal: true });
    const missing = join(root, "private", "missing-policy.json");
    const run = Bun.spawnSync([
      process.execPath,
      join(import.meta.dir, "..", "scripts", "oll-memory-candidates.ts"),
      "--workspace", root,
      "--policy-file", missing,
    ]);
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr.toString()).not.toContain(root);
    expect(run.stderr.toString()).not.toContain(missing);
  });
});
