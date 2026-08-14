import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { applyRethinkHandoffFile } from "../src/oll/handoff-applicator";
import { sha256Digest } from "../src/oll/handoff-v2";
import {
  computeActionIdV3,
  computeHandoffDigestV3,
  type ExpectedHandoffV3,
  parseRethinkHandoffV3,
  type RethinkHandoffV3,
} from "../src/oll/handoff-v3";
import {
  materializeMemoryCandidates,
  MEMORY_CANDIDATE_REPORT_SCHEMA,
  MEMORY_CANDIDATE_SCHEMA,
  type MemoryCandidateReportV1,
  type MemoryCandidateV1,
} from "../src/oll/memory-candidates";

const roots: string[] = [];
const NOW = "2026-08-14T22:00:00.000Z";

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function write(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function setup() {
  const workspace = mkdtempSync(join(tmpdir(), "engram-handoff-v3-"));
  const stateRoot = mkdtempSync(join(tmpdir(), "engram-handoff-v3-state-"));
  roots.push(workspace, stateRoot);
  write(join(workspace, "engram.json"), {
    schemaVersion: 1,
    workspace: { id: "main" },
    oll: { adaptation: {
      enabled: true, mode: "observe-only",
      actorRegistry: "${ENGRAM_STATE_ROOT}/oll/actors.v1.json",
      companyRuleStore: "${ENGRAM_STATE_ROOT}/oll/company-rules",
      maxInjectedRuleBytes: 8192,
    } },
  });
  write(join(stateRoot, "oll", "actors.v1.json"), { schema: "oll.actor-registry.v1", revision: 1, principals: [] });
  const statement = "Использовать краткий проверяемый формат отчёта.";
  const candidateId = sha256Digest("candidate-main-1");
  const candidate: MemoryCandidateV1 = {
    schema: MEMORY_CANDIDATE_SCHEMA,
    candidateId,
    workspaceId: "main",
    sourceClass: "daily-decision",
    sourceRef: "memory/agent-main/telegram-direct/2026-08-14.md#decisions:1",
    sourceVersionDigest: sha256Digest("source"),
    contentDigest: sha256Digest(statement),
    semanticKey: sha256Digest(statement.toLowerCase()),
    scopeCeiling: { level: "workspace", subject: "main" },
    kind: "decision",
    redactionClass: "minimal",
    observedAt: NOW,
    statement,
    ranking: { score: 80, reasons: ["structured_decision"], duplicateCount: 1, accessCount: 0, decayTier: null },
    compilerVersion: 1,
    lifecycle: { status: "pending", disposition: null, revision: 1, updatedAt: NOW },
  };
  const reportBase = {
    schema: MEMORY_CANDIDATE_REPORT_SCHEMA,
    workspaceId: "main",
    mode: "materialize" as const,
    snapshotAt: NOW,
    compilerVersion: 1 as const,
    considered: 1, eligible: 1, selected: 1, selectedBytes: 100,
    sourceCounts: { "daily-decision": 1 }, rejectionCounts: {}, candidates: [candidate],
  };
  const report: MemoryCandidateReportV1 = { ...reportBase, reportDigest: sha256Digest(JSON.stringify(reportBase)) };
  materializeMemoryCandidates({ workspace, workspaceId: "main", report, now: NOW });
  const runId = randomUUID();
  const expected: ExpectedHandoffV3 = {
    batchId: "nightly-2026-08-14T00:40:00Z",
    workspaceId: "main",
    evaluationId: randomUUID(),
    runId,
    phase: "hb-rethink",
    attempt: 1,
    policyVersion: 1,
    contextDigest: sha256Digest("context-v2"),
    expectedHandoffPath: join(workspace, "memory-state", "oll", "handoffs", "incoming", `${runId}.json`),
    signalRevisions: {},
    candidateRevisions: { [candidateId]: 1 },
  };
  return { workspace, stateRoot, candidate, expected };
}

function handoff(env: ReturnType<typeof setup>, overrides: Record<string, unknown> = {}): RethinkHandoffV3 {
  const actionWithoutId = {
    type: "propose_rule" as const,
    payload: {
      ruleId: null,
      rule: "Use a concise, verifiable report format.",
      sourceSignals: [],
      sourceCandidates: [env.candidate.candidateId],
      scope: { level: "workspace" as const, subject: "main" },
      risk: "medium" as const,
      rationale: "A structured memory decision is relevant to future behavior.",
      expectedImprovement: "Reports remain concise and verifiable.",
      costOfInaction: "Repeatedly verbose reports.",
      rollbackRef: "suspend:generated",
      expectedRuleRevision: null,
      authorizationResult: {
        status: "review_required" as const,
        principalId: null,
        grantId: null,
        registryRevision: 1,
        registryDigest: sha256Digest("registry"),
        reason: "Memory evidence cannot authorize behavior changes.",
      },
      policyVersion: 1 as const,
      reviewDisposition: "review_required" as const,
      ...overrides,
    },
  };
  const action = { ...actionWithoutId, actionId: computeActionIdV3(env.expected.evaluationId, 0, actionWithoutId) };
  const withoutDigest = {
    schema: "oll.rethink-handoff.v3" as const,
    batchId: env.expected.batchId,
    workspaceId: env.expected.workspaceId,
    evaluationId: env.expected.evaluationId,
    runId: env.expected.runId,
    phase: "hb-rethink" as const,
    attempt: 1,
    policyVersion: 1 as const,
    contextDigest: env.expected.contextDigest,
    createdAt: NOW,
    actions: [action],
    candidateDispositions: [{ candidateId: env.candidate.candidateId, expectedRevision: 1, disposition: "consumed" as const, rationale: "Used in proposal." }],
  };
  return { ...withoutDigest, handoffDigest: computeHandoffDigestV3(withoutDigest) };
}

describe("OLL rethink handoff v3", () => {
  test("materializes candidate-only proposals as mandatory review and consumes the candidate exactly once", () => {
    const env = setup();
    write(env.expected.expectedHandoffPath, handoff(env));
    const result = applyRethinkHandoffFile({ workspace: env.workspace, stateRoot: env.stateRoot, expected: env.expected, now: NOW });
    expect(result.status).toBe("terminal");
    expect(result.dispositions[0].disposition).toBe("review_pending");
    const rulesRoot = join(env.workspace, "memory-state", "oll", "rules");
    const rule = JSON.parse(readFileSync(join(rulesRoot, readdirSync(rulesRoot)[0]), "utf8"));
    expect(rule.status).toBe("proposed");
    expect(rule.sourceSignals).toEqual([]);
    expect(rule.sourceCandidates).toEqual([env.candidate.candidateId]);
    expect(readdirSync(join(env.workspace, "memory-state", "oll", "reviews")).length).toBe(1);
    const stored = JSON.parse(readFileSync(join(env.workspace, "memory-state", "oll", "candidates", `${env.candidate.candidateId.slice(7)}.json`), "utf8"));
    expect(stored.lifecycle).toMatchObject({ status: "evaluated", disposition: "consumed", revision: 2 });
    const replay = applyRethinkHandoffFile({ workspace: env.workspace, stateRoot: env.stateRoot, expected: env.expected, now: NOW });
    expect(replay.status).toBe("replayed");
  });

  test("rejects auto-apply semantics for memory evidence before application", () => {
    const env = setup();
    const invalid = handoff(env, { reviewDisposition: "auto_apply" });
    expect(() => parseRethinkHandoffV3(JSON.stringify(invalid), env.expected, env.expected.expectedHandoffPath)).toThrow("proposal-only and review-required");
  });

  test("replays candidate dispositions after a crash before the terminal journal event", () => {
    const env = setup();
    write(env.expected.expectedHandoffPath, handoff(env));
    expect(() => applyRethinkHandoffFile({
      workspace: env.workspace,
      stateRoot: env.stateRoot,
      expected: env.expected,
      now: NOW,
      faultInjector: (transition) => {
        if (transition === "candidate_dispositions_committed") throw new Error("crash-after-candidate-dispositions");
      },
    })).toThrow("crash-after-candidate-dispositions");
    const recovered = applyRethinkHandoffFile({ workspace: env.workspace, stateRoot: env.stateRoot, expected: env.expected, now: NOW });
    expect(recovered.status).toBe("terminal");
    const stored = JSON.parse(readFileSync(join(env.workspace, "memory-state", "oll", "candidates", `${env.candidate.candidateId.slice(7)}.json`), "utf8"));
    expect(stored.lifecycle).toMatchObject({ status: "evaluated", disposition: "consumed", revision: 2 });
  });

  test("rejects scope broadening even when the outer v3 handoff is valid", () => {
    const env = setup();
    const invalid = handoff(env, { scope: { level: "company", subject: "takeron" } });
    write(env.expected.expectedHandoffPath, invalid);
    const result = applyRethinkHandoffFile({ workspace: env.workspace, stateRoot: env.stateRoot, expected: env.expected, now: NOW });
    expect(result.dispositions[0].disposition).toBe("policy_rejected");
    const stored = JSON.parse(readFileSync(join(env.workspace, "memory-state", "oll", "candidates", `${env.candidate.candidateId.slice(7)}.json`), "utf8"));
    expect(stored.lifecycle).toMatchObject({ status: "pending", disposition: "deferred", revision: 2 });
  });
});
