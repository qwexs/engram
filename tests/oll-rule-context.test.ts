import { afterEach, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  composeBootstrapContextHash,
  persistRuleContextConflicts,
  preflightRuleActivation,
  resolveRuleContext,
  type RuleContextTargetV1,
} from "../src/oll/rule-context";

const roots: string[] = [];
const NOW = "2026-08-12T03:00:00.000Z";

function digest(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function write(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

function setup(workspaceId = "main") {
  const workspace = mkdtempSync(join(tmpdir(), `engram-pr6-${workspaceId}-`));
  const stateRoot = mkdtempSync(join(tmpdir(), `engram-pr6-state-${workspaceId}-`));
  roots.push(workspace, stateRoot);
  write(join(workspace, "engram.json"), {
    schemaVersion: 1,
    workspace: { id: workspaceId },
    oll: {
      adaptation: {
        enabled: true,
        mode: "active",
        companyRuleStore: "${ENGRAM_STATE_ROOT}/oll/company-rules",
        maxInjectedRuleBytes: 8192,
      },
    },
  });
  return { workspace, stateRoot, workspaceId };
}

function rule(options: {
  workspaceId?: string;
  level: "person" | "domain" | "workspace" | "company";
  subject: string;
  text: string;
  status?: "proposed" | "active" | "suspended" | "superseded";
  revision?: number;
  activatedAt?: string | null;
  expiresAt?: string | null;
  id?: string;
}) {
  const value: any = {
    schema: "oll.adaptation-rule.v1",
    id: options.id || randomUUID(),
    workspaceId: options.workspaceId || "main",
    scope: { level: options.level, subject: options.subject },
    rule: options.text,
    sourceSignals: [randomUUID()],
    risk: options.level === "company" ? "high" : "low",
    status: options.status || "active",
    expectedImprovement: "Expected improvement",
    costOfInaction: "Cost of inaction",
    rollbackRef: "suspend:test",
    decision: {
      action: "activate_rule",
      runId: randomUUID(),
      actionId: digest(`action:${options.text}`),
      reason: "test activation",
      decidedAt: options.activatedAt || "2026-08-12T01:00:00.000Z",
    },
    activatedAt: options.activatedAt === undefined ? "2026-08-12T01:00:00.000Z" : options.activatedAt,
    reviewDueAt: null,
    expiresAt: options.expiresAt || null,
    rolloutBatchId: "pr6-test",
    supersededBy: options.status === "superseded" ? randomUUID() : null,
    revision: options.revision || 1,
    contentDigest: "",
  };
  value.contentDigest = digest(JSON.stringify({
    workspaceId: value.workspaceId,
    scope: value.scope,
    rule: value.rule,
    sourceSignals: [...value.sourceSignals].sort(),
    risk: value.risk,
    expectedImprovement: value.expectedImprovement,
    costOfInaction: value.costOfInaction,
  }));
  return value;
}

function storeLocal(env: ReturnType<typeof setup>, value: any): void {
  write(join(env.workspace, "memory-state", "oll", "rules", `${value.id}.json`), value);
}

function storeCompany(env: ReturnType<typeof setup>, value: any): void {
  write(join(env.stateRoot, "oll", "company-rules", "rules", `${value.id}.json`), value);
}

function target(env: ReturnType<typeof setup>, overrides: Partial<RuleContextTargetV1> = {}): RuleContextTargetV1 {
  return {
    workspaceId: env.workspaceId,
    sessionKind: "peer-direct",
    domainSubjects: [],
    personSubjects: ["person:alice", "telegram:42", "telegram:user:42"],
    multiPerson: false,
    ...overrides,
  };
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("PR 6 deterministic rule resolution", () => {
  test("injects only active rules matching company, workspace, domain, and person scope", () => {
    const env = setup();
    const company = rule({ level: "company", subject: "example-company", text: "Use the company terminology" });
    const workspace = rule({ level: "workspace", subject: "main", text: "Use the main workspace format" });
    const domain = rule({ level: "domain", subject: "reports", text: "Use the reports workflow" });
    const person = rule({ level: "person", subject: "person:alice", text: "Use concise replies" });
    const unrelated = rule({ level: "domain", subject: "design", text: "Use the design workflow" });
    storeCompany(env, company);
    for (const value of [workspace, domain, person, unrelated]) storeLocal(env, value);

    const result = resolveRuleContext({
      workspace: env.workspace,
      stateRoot: env.stateRoot,
      target: target(env, { domainSubjects: ["reports"] }),
      now: NOW,
    });
    expect(result.rules.map((entry) => entry.ruleId)).toEqual([company.id, workspace.id, domain.id, person.id]);
    expect(result.payload).toContain("Use the reports workflow");
    expect(result.payload).not.toContain("design workflow");
    expect(result.provenance.every((entry) => entry.contentDigest.startsWith("sha256:"))).toBe(true);
  });

  test("never injects proposed, suspended, superseded, expired, or foreign workspace rules", () => {
    const env = setup();
    const active = rule({ level: "workspace", subject: "main", text: "Keep this active rule" });
    const excluded = [
      rule({ level: "workspace", subject: "main", text: "Proposed rule", status: "proposed" }),
      rule({ level: "workspace", subject: "main", text: "Suspended rule", status: "suspended" }),
      rule({ level: "workspace", subject: "main", text: "Superseded rule", status: "superseded" }),
      rule({ level: "workspace", subject: "main", text: "Expired rule", expiresAt: "2026-08-11T00:00:00.000Z" }),
      rule({ workspaceId: "other", level: "workspace", subject: "other", text: "Foreign rule" }),
    ];
    for (const value of [active, ...excluded]) storeLocal(env, value);
    const result = resolveRuleContext({ workspace: env.workspace, stateRoot: env.stateRoot, target: target(env), now: NOW });
    expect(result.rules.map((entry) => entry.ruleId)).toEqual([active.id]);
  });

  test("person-private rules never enter a multi-person group or unrelated person session", () => {
    const env = setup();
    const person = rule({ level: "person", subject: "person:alice", text: "Use Alice's preferred format" });
    const workspace = rule({ level: "workspace", subject: "main", text: "Use the shared format" });
    storeLocal(env, person);
    storeLocal(env, workspace);
    const group = resolveRuleContext({
      workspace: env.workspace,
      stateRoot: env.stateRoot,
      target: target(env, { sessionKind: "group-direct", multiPerson: true, personSubjects: [] }),
      now: NOW,
    });
    const bob = resolveRuleContext({
      workspace: env.workspace,
      stateRoot: env.stateRoot,
      target: target(env, { personSubjects: ["person:bob"] }),
      now: NOW,
    });
    expect(group.rules.map((entry) => entry.ruleId)).toEqual([workspace.id]);
    expect(bob.rules.map((entry) => entry.ruleId)).toEqual([workspace.id]);
  });

  test("rule revision and digest change the hash while equal state is idempotent", () => {
    const env = setup();
    const value = rule({ level: "workspace", subject: "main", text: "Use stable formatting" });
    storeLocal(env, value);
    const first = resolveRuleContext({ workspace: env.workspace, stateRoot: env.stateRoot, target: target(env), now: NOW });
    const second = resolveRuleContext({ workspace: env.workspace, stateRoot: env.stateRoot, target: target(env), now: NOW });
    value.revision = 2;
    value.rule = "Use revised stable formatting";
    value.contentDigest = digest(JSON.stringify({
      workspaceId: value.workspaceId,
      scope: value.scope,
      rule: value.rule,
      sourceSignals: [...value.sourceSignals].sort(),
      risk: value.risk,
      expectedImprovement: value.expectedImprovement,
      costOfInaction: value.costOfInaction,
    }));
    storeLocal(env, value);
    const revised = resolveRuleContext({ workspace: env.workspace, stateRoot: env.stateRoot, target: target(env), now: NOW });
    expect(first.contextHash).toBe(second.contextHash);
    expect(first.payload).toBe(second.payload);
    expect(revised.contextHash).not.toBe(first.contextHash);
    expect(composeBootstrapContextHash({ domainContextHash: "domain-a", ruleContextHash: first.contextHash }))
      .not.toBe(composeBootstrapContextHash({ domainContextHash: "domain-a", ruleContextHash: revised.contextHash }));
  });

  test("conflicting rules are blocked and create one idempotent pending review artifact", () => {
    const env = setup();
    const allow = rule({ level: "workspace", subject: "main", text: "Use the concise weekly report format" });
    const deny = rule({ level: "person", subject: "person:alice", text: "Do not use the concise weekly report format" });
    storeLocal(env, allow);
    storeLocal(env, deny);
    const result = resolveRuleContext({ workspace: env.workspace, stateRoot: env.stateRoot, target: target(env), now: NOW });
    expect(result.rules).toHaveLength(0);
    expect(result.conflicts).toHaveLength(1);
    const paths = persistRuleContextConflicts({ workspace: env.workspace, conflicts: result.conflicts, now: NOW });
    const repeated = persistRuleContextConflicts({ workspace: env.workspace, conflicts: result.conflicts, now: NOW });
    expect(repeated).toEqual(paths);
    const record = JSON.parse(readFileSync(paths[0], "utf8"));
    expect(record).toMatchObject({ schema: "oll.rule-context-conflict.v1", status: "pending_review" });
    expect(record.ruleIds.sort()).toEqual([allow.id, deny.id].sort());
  });

  test("an oversized complete context is rejected without truncation", () => {
    const env = setup();
    const value = rule({ level: "workspace", subject: "main", text: `Use ${"x".repeat(400)}` });
    storeLocal(env, value);
    const result = resolveRuleContext({
      workspace: env.workspace,
      stateRoot: env.stateRoot,
      target: target(env),
      maxBytes: 128,
      now: NOW,
    });
    expect(result.status).toBe("overflow");
    expect(result.payload).toBeNull();
    expect(result.requiredBytes).toBeGreaterThan(128);
    expect(result.rules).toHaveLength(0);
  });

  test("prospective activation routes overflow and conflicts to review before status changes", () => {
    const env = setup();
    const existing = rule({ level: "workspace", subject: "main", text: "Use the concise weekly report format" });
    storeLocal(env, existing);
    const oversized = rule({
      level: "workspace",
      subject: "main",
      text: `Use ${"large ".repeat(100)}`,
      status: "proposed",
    });
    const overflow = preflightRuleActivation({
      workspace: env.workspace,
      stateRoot: env.stateRoot,
      workspaceId: env.workspaceId,
      candidateRule: oversized,
      maxBytes: 256,
      now: NOW,
    });
    expect(overflow).toMatchObject({ reviewRequired: true, reason: "context_overflow" });

    const conflicting = rule({
      level: "person",
      subject: "person:alice",
      text: "Do not use the concise weekly report format",
      status: "proposed",
    });
    const conflict = preflightRuleActivation({
      workspace: env.workspace,
      stateRoot: env.stateRoot,
      workspaceId: env.workspaceId,
      candidateRule: conflicting,
      now: NOW,
    });
    expect(conflict).toMatchObject({ reviewRequired: true, reason: "rule_conflict" });
  });
});
