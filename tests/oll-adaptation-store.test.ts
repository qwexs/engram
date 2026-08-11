import { afterEach, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import {
  cpSync,
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
import {
  AdaptationStoreError,
  captureAdaptationSignal,
  decideAdaptationReview,
  expireAdaptationReviews,
  listPendingAdaptationSignals,
  proposeAdaptationRule,
  transitionAdaptationRule,
  transitionAdaptationSignal,
} from "../src/oll/adaptation-store";
import { classifyAdaptationRisk } from "../src/oll/authorization";

const roots: string[] = [];
const NOW = "2026-08-12T01:00:00.000Z";
const ACTOR = { trusted: true as const, channel: "telegram", accountId: "default", actorId: "42", contextKind: "direct" as const };

function digest(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function write(path: string, value: string | Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n");
}

function setup(id = "main") {
  const root = mkdtempSync(join(tmpdir(), `engram-oll-pr3-${id}-`));
  const stateRoot = mkdtempSync(join(tmpdir(), `engram-oll-pr3-state-${id}-`));
  roots.push(root, stateRoot);
  write(join(root, "engram.json"), {
    schemaVersion: 1,
    workspace: { id },
    agent: `agent-${id}`,
    oll: {
      scheduleOwner: "nightly",
      nightly: { enabled: false },
      adaptation: {
        enabled: true,
        mode: "observe-only",
        actorRegistry: "${ENGRAM_STATE_ROOT}/oll/actors.v1.json",
      },
    },
  });
  write(join(root, "memory-state", "oll", "state.json"), { schema: "oll-nightly-state.v1", workspaceId: id, nightlyEnabled: false });
  mkdirSync(join(root, "memory", "domains", "reports"), { recursive: true });
  write(join(stateRoot, "oll", "actors.v1.json"), {
    schema: "oll.actor-registry.v1",
    revision: 1,
    principals: [{
      principalId: "person:alice",
      transportBindings: [{ channel: "telegram", accountId: "default", actorId: "42" }],
      grants: [
        {
          grantId: "alice-self",
          workspaceId: id,
          scope: "person:self",
          actions: ["signal:create", "rule:auto-activate", "rule:review", "rule:approve"],
          maxRisk: "high",
        },
        {
          grantId: "alice-reports",
          workspaceId: id,
          scope: "domain:reports",
          actions: ["signal:create", "rule:auto-activate", "rule:review", "rule:approve"],
          maxRisk: "low",
        },
        {
          grantId: "alice-workspace-review",
          workspaceId: id,
          scope: "workspace",
          actions: ["signal:create", "rule:review", "rule:approve"],
          maxRisk: "high",
        },
        {
          grantId: "alice-company-review",
          workspaceId: "*",
          scope: "company",
          actions: ["rule:review", "rule:approve"],
          maxRisk: "high",
        },
      ],
    }],
  });
  return { workspace: root, stateRoot, id };
}

function correction(env: ReturnType<typeof setup>, overrides: Record<string, any> = {}) {
  return captureAdaptationSignal({
    workspace: env.workspace,
    stateRoot: env.stateRoot,
    type: "correction",
    scope: { level: "person", subject: "telegram:42" },
    statement: "Use the established report format",
    expectedBehavior: "Follow the established report format in future reports",
    sourceType: "message",
    sourceRef: "telegram:chat/100/message/200",
    evidenceContent: "raw correction that must not enter audit",
    actorContext: ACTOR,
    capturedBy: "agent:main",
    explicit: true,
    now: NOW,
    ...overrides,
  });
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("PR 3 trusted adaptation capture", () => {
  test("stores one authorized explicit correction and exposes it to the next preflight", () => {
    const env = setup();
    const first = correction(env);
    const second = correction(env);
    expect(first).toMatchObject({ status: "created", created: true, autoActivationEligible: true });
    expect(first.signal).toMatchObject({
      schema: "oll.adaptation-signal.v1",
      workspaceId: "main",
      type: "correction",
      status: "pending",
      authorizationDecision: { status: "authorized", principalId: "person:alice", grantId: "alice-self" },
      revision: 1,
    });
    expect(second).toMatchObject({ status: "deduplicated", created: false });
    expect(second.signal.id).toBe(first.signal.id);
    expect(listPendingAdaptationSignals(env)).toHaveLength(1);
    expect(readdirSync(join(env.workspace, "memory-state", "oll", "signals"))).toHaveLength(1);
    const auditText = readdirSync(join(env.workspace, "memory-state", "oll", "audit"))
      .map((name) => readFileSync(join(env.workspace, "memory-state", "oll", "audit", name), "utf8"))
      .join("\n");
    expect(auditText).not.toContain("raw correction that must not enter audit");
    expect(first.signal.evidence[0]).not.toHaveProperty("content");
  });

  test("concurrent CLI captures converge to one projection under the store lock", async () => {
    const env = setup();
    const requestPath = join(env.workspace, "capture-request.json");
    write(requestPath, {
      type: "correction",
      scope: { level: "person", subject: "telegram:42" },
      statement: "Use the established report format",
      expectedBehavior: "Follow the established report format in future reports",
      sourceType: "message",
      sourceRef: "telegram:chat/100/message/200",
      evidenceContent: "same immutable evidence",
      trustedActorContext: ACTOR,
      capturedBy: "agent:main",
      explicit: true,
      now: NOW,
    });
    const cli = join(import.meta.dir, "..", "scripts", "oll-adaptation.ts");
    const runs = Array.from({ length: 6 }, () => Bun.spawn([
      "bun", cli, "capture", "--workspace", env.workspace, "--state-root", env.stateRoot, "--request-file", requestPath,
    ], { stdout: "pipe", stderr: "pipe" }));
    const exits = await Promise.all(runs.map((run) => run.exited));
    expect(exits).toEqual([0, 0, 0, 0, 0, 0]);
    expect(readdirSync(join(env.workspace, "memory-state", "oll", "signals"))).toHaveLength(1);
  });

  test("unknown, reconstructed, and ambiguous group actors fail closed to review", () => {
    const env = setup();
    const unknown = correction(env, { sourceRef: "telegram:1", evidenceContent: "unknown", actorContext: { ...ACTOR, actorId: "999" } });
    const reconstructed = correction(env, { sourceRef: "daily:1", evidenceContent: "reconstructed", sourceType: "daily-note" });
    const groupOther = correction(env, {
      sourceRef: "telegram:group/1",
      evidenceContent: "other person",
      actorContext: { ...ACTOR, contextKind: "group" },
      scope: { level: "person", subject: "telegram:99" },
    });
    expect(unknown.signal.status).toBe("review_required");
    expect(reconstructed.signal.authorizationDecision.reason).toContain("reconstructed evidence");
    expect(groupOther.signal.authorizationDecision.reason).toContain("another person's scope");
  });

  test("inferred preference, company scope, and regulated semantics cannot auto-activate", () => {
    const env = setup();
    const inferred = correction(env, { type: "preference", explicit: false, sourceRef: "telegram:2", evidenceContent: "preference" });
    const company = correction(env, { scope: { level: "company", subject: "company" }, sourceRef: "telegram:3", evidenceContent: "company" });
    const regulated = correction(env, {
      statement: "Change legal compliance policy",
      expectedBehavior: "Apply a different legal compliance policy",
      sourceRef: "telegram:4",
      evidenceContent: "legal policy",
    });
    expect(inferred.signal.status).toBe("review_required");
    expect(company).toMatchObject({ autoActivationEligible: false, risk: { risk: "high", reviewRequired: true } });
    expect(regulated).toMatchObject({ autoActivationEligible: false, risk: { risk: "high", reviewRequired: true } });
  });

  test("scope ownership and CAS reject cross-workspace paths and stale revisions", () => {
    const env = setup();
    expect(() => correction(env, { scope: { level: "workspace", subject: "other" } })).toThrow(AdaptationStoreError);
    expect(() => correction(env, { scope: { level: "domain", subject: "missing", domain: "missing" } })).toThrow("domain is not owned");
    const created = correction(env);
    const reviewed = transitionAdaptationSignal({ ...env, signalId: created.signal.id, expectedRevision: 1, status: "reviewed", now: NOW });
    expect(reviewed.revision).toBe(2);
    expect(() => transitionAdaptationSignal({ ...env, signalId: created.signal.id, expectedRevision: 1, status: "rejected", now: NOW })).toThrow("revision mismatch");
  });

  test("foreign projections are detected rather than leaked across workspace stores", () => {
    const first = setup("alpha");
    const second = setup("beta");
    const signal = correction(first, { scope: { level: "person", subject: "telegram:42" } }).signal;
    const target = join(second.workspace, "memory-state", "oll", "signals", `${signal.id}.json`);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(first.workspace, "memory-state", "oll", "signals", `${signal.id}.json`), target);
    expect(() => listPendingAdaptationSignals(second)).toThrow("foreign signal projection");
  });
});

describe("PR 3 managed rule and review lifecycle", () => {
  test("observe-only records an eligible low-risk proposal without activation or review noise", () => {
    const env = setup();
    const signal = correction(env).signal;
    const proposal = proposeAdaptationRule({
      ...env,
      scope: { level: "person", subject: "telegram:42" },
      rule: "Use the established report format",
      sourceSignals: [signal.id],
      expectedImprovement: "Consistent report format",
      costOfInaction: "Repeated manual formatting corrections",
      rollbackRef: "suspend:pending",
      runId: randomUUID(),
      actionId: digest("action-1"),
      actorContext: ACTOR,
      now: NOW,
    });
    expect(proposal).toMatchObject({
      status: "created",
      autoActivationEligible: false,
      mode: "observe-only",
      policyDisposition: "observe_only",
      rule: { status: "proposed", risk: "low" },
      review: null,
    });
    expect(() => transitionAdaptationRule({
      ...env,
      ruleId: proposal.rule.id,
      expectedRevision: 1,
      status: "active",
      actorContext: ACTOR,
      now: NOW,
    })).toThrow("activation is disabled outside active mode");
  });

  test("review approval revalidates the current binding and records exact grant evidence", () => {
    const env = setup();
    const signal = correction(env, {
      statement: "Change legal compliance policy",
      expectedBehavior: "Apply a different legal compliance policy",
      sourceRef: "telegram:review/legal",
      evidenceContent: "legal review evidence",
    }).signal;
    const proposal = proposeAdaptationRule({
      ...env,
      scope: { level: "person", subject: "telegram:42" },
      rule: "Change legal compliance policy",
      sourceSignals: [signal.id],
      expectedImprovement: "Different legal compliance policy",
      costOfInaction: "No change to compliance policy",
      rollbackRef: "suspend:pending",
      runId: randomUUID(),
      actionId: digest("action-review"),
      actorContext: ACTOR,
      now: NOW,
    });
    const approved = decideAdaptationReview({
      ...env,
      reviewId: proposal.review.reviewId,
      expectedRevision: 1,
      decision: "approved",
      reason: "Reviewed and approved for the original local scope",
      actorContext: ACTOR,
      now: "2026-08-12T02:00:00.000Z",
    });
    expect(approved).toMatchObject({
      status: "approved",
      revision: 2,
      decision: { principalId: "person:alice", grantId: "alice-self", registryRevision: 1 },
    });
  });

  test("company proposals and reviews stay in the shared company store and require explicit approval", () => {
    const env = setup();
    const signal = correction(env, {
      scope: { level: "company", subject: "company" },
      statement: "Use one company report format",
      expectedBehavior: "Use the approved format across the company",
      sourceRef: "telegram:company/format",
      evidenceContent: "company-wide request",
    }).signal;
    const proposal = proposeAdaptationRule({
      ...env,
      scope: { level: "company", subject: "company" },
      rule: "Use one company report format",
      sourceSignals: [signal.id],
      expectedImprovement: "Consistent company reports",
      costOfInaction: "Inconsistent report presentation",
      rollbackRef: "suspend:pending",
      runId: randomUUID(),
      actionId: digest("company-rule"),
      actorContext: ACTOR,
      now: NOW,
    });
    const companyRoot = join(env.stateRoot, "oll", "company-rules");
    expect(proposal).toMatchObject({
      store: "company",
      policyDisposition: "review_required",
      autoActivationEligible: false,
      rule: { status: "proposed", risk: "high" },
      review: { status: "pending", requiredGrant: "rule:approve" },
    });
    expect(existsSync(join(companyRoot, "rules", `${proposal.rule.id}.json`))).toBe(true);
    expect(existsSync(join(companyRoot, "reviews", `${proposal.review.reviewId}.json`))).toBe(true);
    expect(existsSync(join(env.workspace, "memory-state", "oll", "rules", `${proposal.rule.id}.json`))).toBe(false);
    const approved = decideAdaptationReview({
      ...env,
      reviewId: proposal.review.reviewId,
      expectedRevision: 1,
      decision: "approved",
      reason: "Explicit company-level approval",
      actorContext: ACTOR,
      now: "2026-08-12T02:00:00.000Z",
    });
    expect(approved).toMatchObject({ status: "approved", decision: { grantId: "alice-company-review" } });
    expect(existsSync(join(env.workspace, "memory-state", "oll", "reviews", `${proposal.review.reviewId}.json`))).toBe(false);
  });

  test("active-mode lifecycle is CAS-guarded and preserves suspended, superseded, and rejected projections", () => {
    const env = setup();
    const configPath = join(env.workspace, "engram.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.oll.adaptation.mode = "active";
    write(configPath, config);
    const firstSignal = correction(env).signal;
    const secondSignal = correction(env, {
      statement: "Use the concise report format",
      expectedBehavior: "Follow the concise report format in future reports",
      sourceRef: "telegram:replacement",
      evidenceContent: "replacement evidence",
    }).signal;
    const proposal = (signal: any, rule: string, action: string) => proposeAdaptationRule({
      ...env,
      scope: { level: "person", subject: "telegram:42" },
      rule,
      sourceSignals: [signal.id],
      expectedImprovement: "Consistent report format",
      costOfInaction: "Repeated manual corrections",
      rollbackRef: "suspend:pending",
      runId: randomUUID(),
      actionId: digest(action),
      actorContext: ACTOR,
      now: NOW,
    });
    const first = proposal(firstSignal, "Use the established report format", "lifecycle-1");
    const replacement = proposal(secondSignal, "Use the concise report format", "lifecycle-2");
    expect(first.autoActivationEligible).toBe(true);
    const active = transitionAdaptationRule({ ...env, ruleId: first.rule.id, expectedRevision: 1, status: "active", actorContext: ACTOR, now: NOW });
    const suspended = transitionAdaptationRule({ ...env, ruleId: first.rule.id, expectedRevision: 2, status: "suspended", now: NOW });
    const reactivated = transitionAdaptationRule({ ...env, ruleId: first.rule.id, expectedRevision: 3, status: "active", actorContext: ACTOR, now: NOW });
    const superseded = transitionAdaptationRule({ ...env, ruleId: first.rule.id, expectedRevision: 4, status: "superseded", supersededBy: replacement.rule.id, now: NOW });
    expect([active.status, suspended.status, reactivated.status, superseded.status]).toEqual(["active", "suspended", "active", "superseded"]);
    expect(superseded.supersededBy).toBe(replacement.rule.id);

    const thirdSignal = correction(env, {
      statement: "Use the detailed report format",
      expectedBehavior: "Follow the detailed report format in future reports",
      sourceRef: "telegram:rejected",
      evidenceContent: "rejected evidence",
    }).signal;
    const rejectedProposal = proposal(thirdSignal, "Use the detailed report format", "lifecycle-3");
    const rejected = transitionAdaptationRule({ ...env, ruleId: rejectedProposal.rule.id, expectedRevision: 1, status: "rejected", now: NOW });
    expect(rejected.status).toBe("rejected");
    expect(readdirSync(join(env.workspace, "memory-state", "oll", "rules"))).toHaveLength(3);
    expect(() => transitionAdaptationRule({ ...env, ruleId: rejected.id, expectedRevision: 2, status: "active", actorContext: ACTOR, now: NOW })).toThrow("rejected -> active");
  });

  test("revoked binding fails apply-time review authorization and pending review expires without auto-approval", () => {
    const env = setup();
    const signal = correction(env, {
      statement: "Change legal compliance policy",
      expectedBehavior: "Apply a different legal compliance policy",
      sourceRef: "telegram:review/revoked",
      evidenceContent: "revoked legal evidence",
    }).signal;
    const proposal = proposeAdaptationRule({
      ...env,
      scope: { level: "person", subject: "telegram:42" },
      rule: "Change legal compliance policy",
      sourceSignals: [signal.id],
      expectedImprovement: "Different legal compliance policy",
      costOfInaction: "No change to compliance policy",
      rollbackRef: "suspend:pending",
      runId: randomUUID(),
      actionId: digest("action-revoked"),
      actorContext: ACTOR,
      now: NOW,
    });
    write(join(env.stateRoot, "oll", "actors.v1.json"), { schema: "oll.actor-registry.v1", revision: 2, principals: [] });
    expect(() => decideAdaptationReview({
      ...env,
      reviewId: proposal.review.reviewId,
      expectedRevision: 1,
      decision: "approved",
      reason: "must fail",
      actorContext: ACTOR,
      now: "2026-08-12T02:00:00.000Z",
    })).toThrow("unknown actor binding");
    const expired = expireAdaptationReviews({ ...env, now: "2026-09-12T02:00:00.000Z" });
    expect(expired).toHaveLength(1);
    expect(expired[0]).toMatchObject({ status: "expired", decision: { result: "expired", principalId: null } });
  });

  test("deterministic risk classifier routes workspace, legal, permission, and external actions to review", () => {
    expect(classifyAdaptationRisk({ scope: { level: "person", subject: "telegram:42" }, statement: "Use this report format" }).risk).toBe("low");
    expect(classifyAdaptationRisk({ scope: { level: "workspace", subject: "main" }, statement: "Use this format" })).toMatchObject({ risk: "medium", reviewRequired: true });
    for (const statement of ["Change legal policy", "Grant permission to publish", "Send an external email", "Измени юридическую политику", "Разреши отправлять сообщения"]) {
      expect(classifyAdaptationRisk({ scope: { level: "person", subject: "telegram:42" }, statement })).toMatchObject({ risk: "high", reviewRequired: true });
    }
  });
});
