import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  candidatePolicyFromConfig,
  compileMemoryCandidates,
  listPendingMemoryCandidates,
  materializeMemoryCandidates,
  MEMORY_CANDIDATE_POLICY_SCHEMA,
  transitionMemoryCandidate,
  type MemoryCandidatePolicyV1,
} from "../src/oll/memory-candidates";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function root(): string {
  const value = mkdtempSync(join(tmpdir(), "engram-memory-candidates-"));
  roots.push(value);
  return value;
}

function write(path: string, value: string | object): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function policy(overrides: Partial<MemoryCandidatePolicyV1> = {}): MemoryCandidatePolicyV1 {
  return {
    schema: MEMORY_CANDIDATE_POLICY_SCHEMA,
    mode: "shadow",
    forwardOnlySince: "2026-08-14T00:00:00.000Z",
    maxCandidatesPerRun: 50,
    maxContextBytes: 65_536,
    dailySessions: [{ session: "main", scopeCeiling: { level: "workspace", subject: "main" } }],
    domainSources: false,
    kgSources: false,
    sourceQuotas: {
      "daily-decision": 12,
      "daily-learning": 12,
      "retrieval-card": 12,
      "domain-decision": 12,
      "domain-proposal": 8,
      "kg-assertion": 16,
    },
    ...overrides,
  };
}

describe("OLL memory candidate compiler", () => {
  test("admits only structured daily decisions and learnings and excludes heartbeat/events noise", () => {
    const workspace = root();
    write(join(workspace, "memory", "agent-main", "main", "2026-08-14.md"), `# 2026-08-14

## Events
- ordinary event noise

## Decisions
- Сергей утвердил короткий и проверяемый rollout.

## Learnings
- Повторяющийся сигнал следует накапливать до ночного rethink.

## Heartbeat Report
- **OLL**: score 0
- **Maintenance**: ok
`);
    const report = compileMemoryCandidates({
      workspace, workspaceId: "main", snapshotAt: "2026-08-14T23:00:00.000Z", policy: policy(),
    });
    expect(report.considered).toBe(2);
    expect(report.selected).toBe(2);
    expect(report.candidates.map((entry) => entry.sourceClass).sort()).toEqual(["daily-decision", "daily-learning"]);
    expect(JSON.stringify(report)).not.toContain("ordinary event noise");
    expect(JSON.stringify(report)).not.toContain("Maintenance");
  });

  test("keeps independent evidence occurrences while clustering exact semantics", () => {
    const workspace = root();
    const statement = "Использовать простой достаточный план без лишнего оверхеда.";
    write(join(workspace, "memory", "agent-main", "main", "2026-08-14.md"), `# 2026-08-14\n\n## Decisions\n- ${statement}\n`);
    write(join(workspace, "memory", "agent-main", "main", "retrieval", "2026-08-14-simple-plan.md"), `# Simple plan

- **Type:** retrieval event card
- **Date:** 2026-08-14

## Summary

${statement}
`);
    const report = compileMemoryCandidates({ workspace, workspaceId: "main", snapshotAt: "2026-08-14T23:00:00.000Z", policy: policy() });
    expect(report.selected).toBe(2);
    expect(new Set(report.candidates.map((entry) => entry.candidateId)).size).toBe(2);
    expect(new Set(report.candidates.map((entry) => entry.semanticKey)).size).toBe(1);
    expect(report.candidates.every((entry) => entry.ranking.duplicateCount === 2)).toBe(true);
  });

  test("uses exact domain scope and KG access/decay only as ranking metadata", () => {
    const workspace = root();
    write(join(workspace, "memory", "domains", "registry.json"), { domains: { "project-copy": { type: "topic-thread" } } });
    write(join(workspace, "memory", "domains", "project-copy", "decisions.md"), `# Decisions

| Дата | Решение | Контекст |
|---|---|---|
| 2026-08-14 | Использовать утверждённый tone of voice. | Только для copy-домена. |
`);
    write(join(workspace, "life", "v3", "assertions", "11111111-1111-4111-8111-111111111111.json"), {
      schema: "engram.kg-assertion.v3-mvp",
      id: "11111111-1111-4111-8111-111111111111",
      workspaceId: "main",
      entityId: "projects/engram",
      entityType: "project",
      kind: "preference",
      predicate: "deliveryStyle",
      object: { type: "string", value: "Объяснять результат простым языком." },
      scope: ["engram"],
      lifecycle: { status: "active", replacesId: null, supersededById: null, changedAt: "2026-08-14T10:00:00.000Z" },
      provenance: {
        sourceKind: "user_message", sessionKey: "main", messageId: "1", actorId: "42",
        operationId: `sha256:${"a".repeat(64)}`, observedAt: "2026-08-14T10:00:00.000Z",
      },
      createdAt: "2026-08-14T10:00:00.000Z",
    });
    write(join(workspace, "memory-state", "kg-v3", "access", "state.json"), {
      schema: "engram.kg-v3-access-state.v1",
      workspaceId: "main",
      revision: 1,
      appliedEventIds: [],
      assertions: { "11111111-1111-4111-8111-111111111111": { lastAccessed: "2026-08-14T12:00:00.000Z", accessCount: 8 } },
      updatedAt: "2026-08-14T12:00:00.000Z",
    });
    const report = compileMemoryCandidates({
      workspace,
      workspaceId: "main",
      snapshotAt: "2026-08-14T23:00:00.000Z",
      policy: policy({ dailySessions: [], domainSources: true, kgSources: true }),
    });
    const domain = report.candidates.find((entry) => entry.sourceClass === "domain-decision")!;
    const kg = report.candidates.find((entry) => entry.sourceClass === "kg-assertion")!;
    expect(domain.scopeCeiling).toEqual({ level: "domain", subject: "project-copy" });
    expect(kg.scopeCeiling).toEqual({ level: "workspace", subject: "main" });
    expect(kg.ranking).toMatchObject({ accessCount: 8, decayTier: "hot" });
    expect(kg.ranking.reasons).toContain("recent_access");
  });

  test("fails closed on scope broadening and filters credential-like content", () => {
    const workspace = root();
    write(join(workspace, "memory", "agent-main", "main", "2026-08-14.md"), `# 2026-08-14

## Decisions
- api_key = definitely-not-for-model-context
`);
    const report = compileMemoryCandidates({ workspace, workspaceId: "main", snapshotAt: "2026-08-14T23:00:00.000Z", policy: policy() });
    expect(report.selected).toBe(0);
    expect(report.rejectionCounts.invalid_or_sensitive).toBe(1);
    expect(() => compileMemoryCandidates({
      workspace,
      workspaceId: "main",
      snapshotAt: "2026-08-14T23:00:00.000Z",
      policy: policy({ dailySessions: [{ session: "main", scopeCeiling: { level: "workspace", subject: "company" } }] }),
    })).toThrow("scope broadening");
  });

  test("materialization and candidate dispositions are idempotent and revision guarded", () => {
    const workspace = root();
    write(join(workspace, "memory", "agent-main", "main", "2026-08-14.md"), `# 2026-08-14\n\n## Decisions\n- Собирать кандидаты памяти перед rethink.\n`);
    const compiled = compileMemoryCandidates({
      workspace, workspaceId: "main", snapshotAt: "2026-08-14T23:00:00.000Z", policy: policy({ mode: "materialize" }),
    });
    const first = materializeMemoryCandidates({ workspace, workspaceId: "main", report: compiled });
    const second = materializeMemoryCandidates({ workspace, workspaceId: "main", report: compiled });
    expect(first).toMatchObject({ created: 1, deduplicated: 0 });
    expect(second).toMatchObject({ created: 0, deduplicated: 1 });
    const pending = listPendingMemoryCandidates({ workspace, workspaceId: "main" });
    expect(pending).toHaveLength(1);
    const consumed = transitionMemoryCandidate({
      workspace, workspaceId: "main", candidateId: pending[0].candidateId,
      expectedRevision: 1, disposition: "consumed", now: "2026-08-14T23:01:00.000Z",
    });
    expect(consumed.lifecycle).toMatchObject({ status: "evaluated", disposition: "consumed", revision: 2 });
    expect(listPendingMemoryCandidates({ workspace, workspaceId: "main" })).toEqual([]);
    expect(() => transitionMemoryCandidate({
      workspace, workspaceId: "main", candidateId: pending[0].candidateId,
      expectedRevision: 1, disposition: "ignored",
    })).toThrow("revision conflict");
    const operationPath = join(workspace, "memory-state", "oll", "candidate-operations", `${pending[0].candidateId.slice(7)}.json`);
    expect(JSON.parse(readFileSync(operationPath, "utf8")).status).toBe("committed");
  });

  test("config defaults to disabled and requires an explicit forward boundary", () => {
    expect(candidatePolicyFromConfig({}, "main").mode).toBe("disabled");
    expect(() => candidatePolicyFromConfig({ oll: { candidateCompiler: { mode: "shadow" } } }, "main")).toThrow("forwardOnlySince");
  });
});
