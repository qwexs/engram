import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { captureAdaptationSignal } from "../src/oll/adaptation-store";
import { applyRethinkHandoffFile } from "../src/oll/handoff-applicator";
import {
  buildRethinkProposalPrompt,
  canonicalizeJcs,
  computeActionId,
  computeHandoffDigest,
  ExpectedHandoffV2,
  RethinkActionV2,
  RethinkHandoffV2,
  sha256Digest,
} from "../src/oll/handoff-v2";
import { applyLegacyRethinkCompatibilityAction } from "../src/oll/legacy-compatibility";

const roots: string[] = [];
const NOW = "2026-08-12T03:00:00.000Z";
const ACTOR = { trusted: true as const, channel: "telegram", accountId: "default", actorId: "42", contextKind: "direct" as const };

function write(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n");
}

function setup(id = "main") {
  const workspace = mkdtempSync(join(tmpdir(), `engram-oll-pr4-${id}-`));
  const stateRoot = mkdtempSync(join(tmpdir(), `engram-oll-pr4-state-${id}-`));
  roots.push(workspace, stateRoot);
  write(join(workspace, "engram.json"), {
    schemaVersion: 1,
    workspace: { id },
    agent: `agent-${id}`,
    oll: {
      scheduleOwner: "nightly",
      nightly: { enabled: false },
      adaptation: {
        enabled: true,
        mode: "active",
        actorRegistry: "${ENGRAM_STATE_ROOT}/oll/actors.v1.json",
        companyRuleStore: "${ENGRAM_STATE_ROOT}/oll/company-rules",
        maxInjectedRuleBytes: 8192,
      },
    },
  });
  write(join(stateRoot, "oll", "actors.v1.json"), {
    schema: "oll.actor-registry.v1",
    revision: 1,
    principals: [{
      principalId: "person:alice",
      transportBindings: [{ channel: "telegram", accountId: "default", actorId: "42" }],
      grants: [{
        grantId: "alice-self",
        workspaceId: id,
        scope: "person:self",
        actions: ["signal:create", "rule:auto-activate", "rule:review", "rule:approve"],
        maxRisk: "high",
      }],
    }],
  });
  const signal = captureAdaptationSignal({
    workspace,
    stateRoot,
    type: "correction",
    scope: { level: "person", subject: "telegram:42" },
    statement: "Use the standard report format",
    expectedBehavior: "Use the standard report format for future reports",
    sourceType: "message",
    sourceRef: "telegram:message/42",
    evidenceContent: "Use the standard report format",
    actorContext: ACTOR,
    capturedBy: "agent:main",
    explicit: true,
    now: NOW,
  }).signal;
  const runId = randomUUID();
  const evaluationId = randomUUID();
  const expectedPath = join(workspace, "memory-state", "oll", "handoffs", "incoming", `${runId}.json`);
  const expected: ExpectedHandoffV2 = {
    batchId: "nightly-2026-08-12T00:40:00Z",
    workspaceId: id,
    evaluationId,
    runId,
    phase: "hb-rethink",
    attempt: 1,
    policyVersion: 1,
    contextDigest: sha256Digest("context-v1"),
    expectedHandoffPath: expectedPath,
    signalRevisions: { [signal.id]: signal.revision },
  };
  return { workspace, stateRoot, id, signal, expected };
}

function authorizationFrom(signal: any) {
  const auth = signal.authorizationDecision;
  return {
    status: auth.status,
    principalId: auth.principalId,
    grantId: auth.grantId,
    registryRevision: auth.registryRevision,
    registryDigest: auth.registryDigest,
    reason: auth.reason,
  };
}

function makeHandoff(env: ReturnType<typeof setup>, overrides: Record<string, unknown> = {}, actionOverrides: Record<string, unknown> = {}): RethinkHandoffV2 {
  const actionWithoutId = {
    type: "propose_rule" as const,
    payload: {
      ruleId: null,
      rule: "Use the standard report format",
      sourceSignals: [env.signal.id],
      scope: { level: "person" as const, subject: "telegram:42" },
      risk: "low" as const,
      rationale: "Explicit correction with reversible formatting scope",
      expectedImprovement: "Consistent report format",
      costOfInaction: "Repeated formatting corrections",
      rollbackRef: "suspend:generated",
      expectedRuleRevision: null,
      authorizationResult: authorizationFrom(env.signal),
      policyVersion: 1 as const,
      reviewDisposition: "auto_apply" as const,
      ...actionOverrides,
    },
  };
  const action: RethinkActionV2 = {
    ...actionWithoutId,
    actionId: computeActionId(env.expected.evaluationId, 0, actionWithoutId),
  };
  const withoutDigest = {
    schema: "oll.rethink-handoff.v2" as const,
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
    ...overrides,
  };
  return { ...withoutDigest, handoffDigest: computeHandoffDigest(withoutDigest as any) } as RethinkHandoffV2;
}

function installHandoff(env: ReturnType<typeof setup>, handoff = makeHandoff(env)): RethinkHandoffV2 {
  write(env.expected.expectedHandoffPath, handoff);
  return handoff;
}

function nextRun(env: ReturnType<typeof setup>): void {
  const runId = randomUUID();
  env.expected = {
    ...env.expected,
    evaluationId: randomUUID(),
    runId,
    expectedHandoffPath: join(env.workspace, "memory-state", "oll", "handoffs", "incoming", `${runId}.json`),
  };
}

function makeRuleActionHandoff(
  env: ReturnType<typeof setup>,
  type: "activate_rule" | "supersede_rule" | "suspend_rule" | "reject_rule",
  payloadOverrides: Record<string, unknown>,
): RethinkHandoffV2 {
  const actionWithoutId = {
    type,
    payload: {
      ruleId: payloadOverrides.ruleId,
      rule: null,
      sourceSignals: [env.signal.id],
      scope: { level: "person" as const, subject: "telegram:42" },
      risk: "low" as const,
      rationale: `Deterministic ${type} lifecycle action`,
      expectedImprovement: "Consistent report format",
      costOfInaction: "Repeated formatting corrections",
      rollbackRef: "suspend:generated",
      expectedRuleRevision: payloadOverrides.expectedRuleRevision,
      authorizationResult: authorizationFrom(env.signal),
      policyVersion: 1 as const,
      reviewDisposition: "auto_apply" as const,
      ...payloadOverrides,
    },
  };
  const action = { ...actionWithoutId, actionId: computeActionId(env.expected.evaluationId, 0, actionWithoutId) } as RethinkActionV2;
  const withoutDigest = {
    schema: "oll.rethink-handoff.v2" as const,
    batchId: env.expected.batchId,
    workspaceId: env.expected.workspaceId,
    evaluationId: env.expected.evaluationId,
    runId: env.expected.runId,
    phase: "hb-rethink" as const,
    attempt: env.expected.attempt,
    policyVersion: 1 as const,
    contextDigest: env.expected.contextDigest,
    createdAt: NOW,
    actions: [action],
  };
  return { ...withoutDigest, handoffDigest: computeHandoffDigest(withoutDigest) };
}

function apply(env: ReturnType<typeof setup>, faultInjector?: (transition: any) => void) {
  return applyRethinkHandoffFile({
    workspace: env.workspace,
    stateRoot: env.stateRoot,
    expected: env.expected,
    trustedActorContexts: { "person:alice": ACTOR },
    now: NOW,
    faultInjector,
  });
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("PR 4 strict handoff v2", () => {
  test("JCS is stable and the proposal-only prompt freezes policy, context, and exact target", () => {
    const env = setup();
    expect(canonicalizeJcs({ z: 1, a: [true, { y: "я", x: -0 }] })).toBe('{"a":[true,{"x":0,"y":"я"}],"z":1}');
    const prompt = buildRethinkProposalPrompt({ contextSnapshot: { signals: [env.signal.id], immutable: true }, expected: env.expected });
    expect(prompt).toContain("proposal-only");
    expect(prompt).toContain(env.expected.expectedHandoffPath);
    expect(prompt).toContain("propose_rule, activate_rule, supersede_rule, suspend_rule, reject_rule");
    expect(prompt).toContain(env.expected.contextDigest);
    expect(prompt).toContain(env.signal.id);
    expect(prompt).toContain("rethink2");
  });

  for (const field of ["batchId", "workspaceId", "evaluationId", "runId", "policyVersion", "contextDigest"] as const) {
    test(`quarantines a validly digested handoff with wrong ${field}`, () => {
      const env = setup();
      const value: Record<string, unknown> = {
        batchId: "nightly-wrong",
        workspaceId: "other",
        evaluationId: randomUUID(),
        runId: randomUUID(),
        policyVersion: 2,
        contextDigest: sha256Digest("wrong-context"),
      };
      installHandoff(env, makeHandoff(env, { [field]: value[field] }));
      const result = apply(env);
      expect(result.status).toBe("rejected");
      expect(["correlation_mismatch", "schema_invalid"]).toContain(result.errorClass);
      expect(existsSync(join(env.workspace, "memory-state", "oll", "handoffs", "rejected", `${env.expected.runId}.json`))).toBe(true);
      expect(existsSync(env.expected.expectedHandoffPath)).toBe(false);
    });
  }

  test("rejects unknown policy-semantic fields and a forged actionId", () => {
    const env = setup();
    const handoff = makeHandoff(env);
    (handoff.actions[0].payload as any).authorityOverride = true;
    handoff.handoffDigest = computeHandoffDigest(handoff);
    installHandoff(env, handoff);
    expect(apply(env)).toMatchObject({ status: "rejected", errorClass: "schema_invalid" });
  });

  test("recomputes and rejects a forged actionId even when the outer digest is valid", () => {
    const env = setup();
    const handoff = makeHandoff(env);
    handoff.actions[0].actionId = sha256Digest("forged-action");
    handoff.handoffDigest = computeHandoffDigest(handoff);
    installHandoff(env, handoff);
    expect(apply(env)).toMatchObject({ status: "rejected", errorClass: "schema_invalid", reason: "actionId mismatch at ordinal 0" });
  });
});

describe("PR 4 deterministic applicator", () => {
  test("activates one authorized low-risk local rule and terminal replay has no side effect", () => {
    const env = setup();
    installHandoff(env);
    const first = apply(env);
    expect(first).toMatchObject({ status: "terminal", dispositions: [{ disposition: "verified" }] });
    const rulesDir = join(env.workspace, "memory-state", "oll", "rules");
    const ruleNames = readdirSync(rulesDir);
    expect(ruleNames).toHaveLength(1);
    const rule = JSON.parse(readFileSync(join(rulesDir, ruleNames[0]), "utf8"));
    expect(rule).toMatchObject({ status: "active", revision: 2, rolloutBatchId: env.expected.batchId });
    const journalDir = join(env.workspace, "memory-state", "oll", "apply-journal", env.expected.runId, "events");
    const journalCount = readdirSync(journalDir).length;
    const transitions = readdirSync(journalDir).sort().map((name) => JSON.parse(readFileSync(join(journalDir, name), "utf8")).transition);
    expect(transitions).toEqual(["received", "validated", "intent_recorded", "effect_committed", "verified", "terminal"]);
    const second = apply(env);
    expect(second.status).toBe("replayed");
    expect(readdirSync(rulesDir)).toHaveLength(1);
    expect(readdirSync(journalDir)).toHaveLength(journalCount);
    expect(readdirSync(join(env.workspace, "memory-state", "oll", "operations"))).toHaveLength(1);
  });

  for (const transition of ["received", "validated", "intent_recorded", "effect_committed", "verified", "terminal"] as const) {
    test(`recovers after a crash immediately after ${transition} without duplicate effect`, () => {
      const env = setup();
      installHandoff(env);
      let injected = false;
      expect(() => apply(env, (observed) => {
        if (!injected && observed === transition) {
          injected = true;
          throw new Error(`crash-after-${transition}`);
        }
      })).toThrow(`crash-after-${transition}`);
      const recovered = apply(env);
      expect(["terminal", "replayed"]).toContain(recovered.status);
      const rulesDir = join(env.workspace, "memory-state", "oll", "rules");
      expect(readdirSync(rulesDir)).toHaveLength(1);
      const rule = JSON.parse(readFileSync(join(rulesDir, readdirSync(rulesDir)[0]), "utf8"));
      expect(rule).toMatchObject({ status: "active", revision: 2 });
      expect(readdirSync(join(env.workspace, "memory-state", "oll", "operations"))).toHaveLength(1);
    });
  }

  test("routes deterministic high-risk legal content to review and never activates it", () => {
    const env = setup();
    const highSignal = captureAdaptationSignal({
      workspace: env.workspace,
      stateRoot: env.stateRoot,
      type: "correction",
      scope: { level: "person", subject: "telegram:42" },
      statement: "Change legal compliance policy",
      expectedBehavior: "Apply a different legal compliance policy",
      sourceType: "message",
      sourceRef: "telegram:message/legal",
      evidenceContent: "Change legal compliance policy",
      actorContext: ACTOR,
      capturedBy: "agent:main",
      explicit: true,
      now: NOW,
    }).signal;
    env.signal = highSignal;
    env.expected.signalRevisions = { [highSignal.id]: highSignal.revision };
    installHandoff(env, makeHandoff(env, {}, {
      rule: "Change legal compliance policy",
      sourceSignals: [highSignal.id],
      risk: "high",
      expectedImprovement: "Different legal compliance policy",
      costOfInaction: "No legal compliance change",
      authorizationResult: authorizationFrom(highSignal),
    }));
    const result = apply(env);
    expect(result).toMatchObject({ status: "terminal", dispositions: [{ disposition: "review_pending" }] });
    const ruleName = readdirSync(join(env.workspace, "memory-state", "oll", "rules"))[0];
    const rule = JSON.parse(readFileSync(join(env.workspace, "memory-state", "oll", "rules", ruleName), "utf8"));
    expect(rule.status).toBe("proposed");
    expect(readdirSync(join(env.workspace, "memory-state", "oll", "reviews"))).toHaveLength(1);
  });

  test("enforces revision-guarded suspend, reactivate, and supersede actions", () => {
    const env = setup();
    installHandoff(env);
    expect(apply(env).status).toBe("terminal");
    const rulesDir = join(env.workspace, "memory-state", "oll", "rules");
    const originalId = readdirSync(rulesDir)[0].replace(/\.json$/, "");

    nextRun(env);
    installHandoff(env, makeRuleActionHandoff(env, "suspend_rule", { ruleId: originalId, expectedRuleRevision: 2 }));
    expect(apply(env).dispositions[0].disposition).toBe("verified");
    expect(JSON.parse(readFileSync(join(rulesDir, `${originalId}.json`), "utf8"))).toMatchObject({ status: "suspended", revision: 3 });

    nextRun(env);
    installHandoff(env, makeRuleActionHandoff(env, "activate_rule", { ruleId: originalId, expectedRuleRevision: 3 }));
    expect(apply(env).dispositions[0].disposition).toBe("verified");
    expect(JSON.parse(readFileSync(join(rulesDir, `${originalId}.json`), "utf8"))).toMatchObject({ status: "active", revision: 4 });

    nextRun(env);
    installHandoff(env, makeRuleActionHandoff(env, "supersede_rule", {
      ruleId: originalId,
      rule: "Use the concise report format",
      expectedRuleRevision: 4,
    }));
    expect(apply(env).dispositions[0].disposition).toBe("verified");
    const rules = readdirSync(rulesDir).map((name) => JSON.parse(readFileSync(join(rulesDir, name), "utf8")));
    expect(rules).toHaveLength(2);
    expect(rules.find((rule) => rule.id === originalId)).toMatchObject({ status: "superseded", revision: 5 });
    expect(rules.find((rule) => rule.id !== originalId)).toMatchObject({ status: "active", revision: 2 });
  });

  test("re-evaluates revoked actor authority at apply and fails closed to review", () => {
    const env = setup();
    installHandoff(env);
    write(join(env.stateRoot, "oll", "actors.v1.json"), { schema: "oll.actor-registry.v1", revision: 2, principals: [] });
    const result = apply(env);
    expect(result).toMatchObject({ status: "terminal", dispositions: [{ disposition: "review_pending" }] });
    const ruleName = readdirSync(join(env.workspace, "memory-state", "oll", "rules"))[0];
    const rule = JSON.parse(readFileSync(join(env.workspace, "memory-state", "oll", "rules", ruleName), "utf8"));
    expect(rule.status).toBe("proposed");
  });

  test("legacy compatibility admits only versioned observation/tension actions", () => {
    const calls: string[] = [];
    const handlers = {
      promoteObservation: () => calls.push("observation"),
      resolveTension: () => calls.push("tension"),
    };
    applyLegacyRethinkCompatibilityAction(1, { type: "promote_observation", observationId: "obs-1" }, handlers);
    applyLegacyRethinkCompatibilityAction(1, { type: "resolve_tension", tensionId: "ten-1", resolution: "resolved" }, handlers);
    expect(calls).toEqual(["observation", "tension"]);
    expect(() => applyLegacyRethinkCompatibilityAction(1, { type: "experiment" } as any, handlers)).toThrow("outside the observation/tension");
    expect(() => applyLegacyRethinkCompatibilityAction(2, { type: "promote_observation", observationId: "obs-1" }, handlers)).toThrow("unsupported");
  });
});
