import { afterEach, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
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
import {
  OllRolloutError,
  applyOllRollout,
  planOllRollout,
  rollbackOllRollout,
} from "../src/oll/rollout";
import {
  captureAdaptationSignal,
  proposeAdaptationRule,
  transitionAdaptationRule,
} from "../src/oll/adaptation-store";
import ruleContextHook, { RULE_CONTEXT_BOOTSTRAP_NAME } from "../hooks/engram-rule-context-load/handler";

const roots: string[] = [];

function digest(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function write(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

function setup(ids = ["project-alpha"]) {
  const fleetRoot = mkdtempSync(join(tmpdir(), "engram-pr7-fleet-"));
  const stateRoot = mkdtempSync(join(tmpdir(), "engram-pr7-state-"));
  roots.push(fleetRoot, stateRoot);
  const workspaces = ids.map((workspaceId) => {
    const workspacePath = join(fleetRoot, workspaceId);
    write(join(workspacePath, "engram.json"), {
      schemaVersion: 1,
      workspace: { id: workspaceId },
      agent: `agent-${workspaceId}`,
      qmd: { maintenance: { mode: "coordinated" } },
      oll: {
        enabled: true,
        scheduleOwner: "nightly",
        nightly: { enabled: false },
        adaptation: {
          enabled: true,
          mode: "observe-only",
          actorRegistry: "${ENGRAM_STATE_ROOT}/oll/actors.v1.json",
          companyRuleStore: "${ENGRAM_STATE_ROOT}/oll/company-rules",
          maxInjectedRuleBytes: 8192,
        },
      },
    });
    write(join(workspacePath, "memory-state", "oll", "state.json"), {
      schema: "oll-nightly-state.v1",
      schemaVersion: 1,
      workspaceId,
      scheduleOwner: "nightly",
      nightlyEnabled: false,
      legacyHeartbeat: {
        admission: "disabled",
        application: "disabled",
        disabledAt: "2026-08-11T00:00:00.000Z",
      },
      memoryReconciliation: { weeklyWindowStart: null, lastCompletedAt: "2026-08-11T00:40:00.000Z" },
      capture: { lastObservedAt: null },
      evaluation: { lastCompletedAt: null, lastSnapshotAt: null, signalRevisions: {}, lastScore: null, completedCount: 0 },
      migration: {
        id: "legacy-heartbeat-v1",
        sourceDigest: digest(`source:${workspaceId}`),
        mappingVersion: 1,
        backupManifest: "backup.json",
        quarantineManifest: "quarantine.json",
        completedAt: "2026-08-11T00:00:00.000Z",
      },
    });
    return { workspaceId, workspacePath };
  });
  return { fleetRoot, stateRoot, workspaces };
}

function readiness(overrides: Record<string, boolean> = {}) {
  return {
    syntheticSuitePassed: true,
    legacyCutoverVerified: true,
    noLegacyDispatcherOrApplicator: true,
    hookSourceVerified: true,
    schedulerCandidateVerified: true,
    nonPrivilegedCanary: true,
    observeOnlyCanaryPassed: false,
    ...overrides,
  };
}

function scheduler(env: ReturnType<typeof setup>, payload: string, jobId = "nightly-1") {
  const payloadRevision = digest(payload);
  const evidencePath = join(env.stateRoot, "oll-rollouts", "scheduler-releases", `${payloadRevision.slice(7)}.json`);
  write(evidencePath, {
    schema: "oll.scheduler-release-evidence.v1", jobId, payloadRevision, enabled: true,
    schedule: { kind: "cron", expr: "40 0 * * *", tz: "UTC", staggerMs: 0 },
    readBackAt: "2026-08-12T02:30:00.000Z",
  });
  return { jobId, payloadRevision, evidencePath };
}

function activeRule(workspaceId: string, rolloutBatchId: string) {
  const value: any = {
    schema: "oll.adaptation-rule.v1",
    id: randomUUID(),
    workspaceId,
    scope: { level: "workspace", subject: workspaceId },
    rule: "Use the canary report format",
    priority: 0,
    sourceSignals: [randomUUID()],
    risk: "low",
    status: "active",
    expectedImprovement: "Consistent reports",
    costOfInaction: "Manual reformatting",
    rollbackRef: "suspend:canary",
    decision: {
      action: "activate_rule",
      runId: randomUUID(),
      actionId: digest("activate"),
      reason: "canary activation",
      decidedAt: "2026-08-12T02:00:00.000Z",
    },
    activatedAt: "2026-08-12T02:00:00.000Z",
    reviewDueAt: null,
    expiresAt: null,
    rolloutBatchId,
    supersededBy: null,
    revision: 1,
    contentDigest: digest("rule-content"),
  };
  return value;
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("PR 7 rollout and rollback contracts", () => {
  test("dry-run plan is deterministic, sorted, and performs no writes", () => {
    const env = setup(["project-z", "project-a"]);
    const releaseId = randomUUID();
    const plan = planOllRollout({
      stateRoot: env.stateRoot,
      releaseId,
      rolloutBatchId: "pr7-canary-1",
      targetMode: "observe-only",
      workspaces: env.workspaces,
      scheduler: scheduler(env, "payload-v1"),
      readiness: readiness(),
      now: "2026-08-12T03:00:00.000Z",
    });
    expect(plan.workspaces.map((entry) => entry.workspaceId)).toEqual(["project-a", "project-z"]);
    expect(plan.releaseMarkerPath).toContain(releaseId);
    expect(existsSync(plan.releaseMarkerPath)).toBe(false);
    expect(plan.actions.every((entry) => entry.targetMode === "observe-only")).toBe(true);
  });

  test("observe-only canary requires all cutover gates and writes backup plus release evidence", () => {
    const env = setup();
    const base = {
      stateRoot: env.stateRoot,
      releaseId: randomUUID(),
      rolloutBatchId: "pr7-canary-2",
      targetMode: "observe-only" as const,
      workspaces: env.workspaces,
      scheduler: scheduler(env, "payload-v2"),
      readiness: readiness(),
      now: "2026-08-12T03:00:00.000Z",
    };
    expect(() => applyOllRollout({ ...base, acknowledge: false })).toThrow(OllRolloutError);
    expect(() => applyOllRollout({
      ...base,
      readiness: readiness({ noLegacyDispatcherOrApplicator: false }),
      acknowledge: true,
    })).toThrow("readiness gate failed");

    const result = applyOllRollout({ ...base, acknowledge: true });
    const config = JSON.parse(readFileSync(join(env.workspaces[0].workspacePath, "engram.json"), "utf8"));
    const nightlyState = JSON.parse(readFileSync(join(env.workspaces[0].workspacePath, "memory-state", "oll", "state.json"), "utf8"));
    const rolloutState = JSON.parse(readFileSync(join(env.workspaces[0].workspacePath, "memory-state", "oll", "rollout.json"), "utf8"));
    expect(config.oll).toMatchObject({ nightly: { enabled: true }, adaptation: { mode: "observe-only" } });
    expect(nightlyState.nightlyEnabled).toBe(true);
    expect(rolloutState).toMatchObject({ schema: "oll.workspace-rollout-state.v1", status: "observe_only_canary" });
    expect(result.marker).toMatchObject({
      schema: "oll.rollout-release.v1",
      status: "observe_only_canary",
      scheduler: scheduler(env, "payload-v2"),
      upgradedWorkspaceIds: ["project-alpha"],
      activatedRuleIds: [],
    });
    expect(existsSync(result.marker.backupManifestPath)).toBe(true);
    expect(readFileSync(result.marker.backupManifestPath, "utf8")).toContain("engram.json");
  });

  test("active rollout additionally requires passed observe-only evidence", () => {
    const env = setup();
    const options = {
      stateRoot: env.stateRoot,
      releaseId: randomUUID(),
      rolloutBatchId: "pr7-active-1",
      targetMode: "active" as const,
      workspaces: env.workspaces,
      scheduler: scheduler(env, "payload-v3"),
      readiness: readiness(),
      now: "2026-08-12T04:00:00.000Z",
      acknowledge: true,
    };
    expect(() => applyOllRollout(options)).toThrow("observeOnlyCanaryPassed");
    const result = applyOllRollout({
      ...options,
      readiness: readiness({ observeOnlyCanaryPassed: true }),
    });
    const config = JSON.parse(readFileSync(join(env.workspaces[0].workspacePath, "engram.json"), "utf8"));
    const nightlyState = JSON.parse(readFileSync(join(env.workspaces[0].workspacePath, "memory-state", "oll", "state.json"), "utf8"));
    expect(config.oll.adaptation.mode).toBe("active");
    expect(nightlyState.nightlyEnabled).toBe(true);
    expect(result.marker.status).toBe("active");
  });

  test("rollback preserves evidence, suspends batch rules, disables nightly rethink, and keeps reconciliation config", () => {
    const env = setup();
    const releaseId = randomUUID();
    const rolloutBatchId = "pr7-active-rollback";
    const rolloutOptions = {
      stateRoot: env.stateRoot,
      releaseId,
      rolloutBatchId,
      targetMode: "active" as const,
      workspaces: env.workspaces,
      scheduler: scheduler(env, "payload-v4"),
      readiness: readiness({ observeOnlyCanaryPassed: true }),
      now: "2026-08-12T04:00:00.000Z",
      acknowledge: true,
    };
    const applied = applyOllRollout(rolloutOptions);
    const value = activeRule("project-alpha", rolloutBatchId);
    write(join(env.workspaces[0].workspacePath, "memory-state", "oll", "rules", `${value.id}.json`), value);

    const rolledBack = rollbackOllRollout({
      stateRoot: env.stateRoot,
      releaseMarkerPath: applied.releaseMarkerPath,
      acknowledge: true,
      reason: "canary rollback drill",
      now: "2026-08-12T05:00:00.000Z",
    });
    const config = JSON.parse(readFileSync(join(env.workspaces[0].workspacePath, "engram.json"), "utf8"));
    const nightlyState = JSON.parse(readFileSync(join(env.workspaces[0].workspacePath, "memory-state", "oll", "state.json"), "utf8"));
    const rolloutState = JSON.parse(readFileSync(join(env.workspaces[0].workspacePath, "memory-state", "oll", "rollout.json"), "utf8"));
    const suspended = JSON.parse(readFileSync(join(env.workspaces[0].workspacePath, "memory-state", "oll", "rules", `${value.id}.json`), "utf8"));
    expect(config.oll).toMatchObject({
      nightly: { enabled: false },
      adaptation: { mode: "observe-only" },
    });
    expect(config.qmd.maintenance.mode).toBe("coordinated");
    expect(nightlyState).toMatchObject({
      nightlyEnabled: false,
      memoryReconciliation: { lastCompletedAt: "2026-08-11T00:40:00.000Z" },
    });
    expect(rolloutState).toMatchObject({ status: "rolled_back", targetMode: "observe-only", revision: 2 });
    expect(suspended).toMatchObject({ status: "suspended", revision: 2, rolloutBatchId });
    expect(rolledBack).toMatchObject({
      schema: "oll.rollback-report.v1",
      releaseId,
      suspendedRuleIds: [value.id],
      legacyHeartbeatRestored: false,
      deterministicReconciliationRetained: true,
    });
    expect(existsSync(applied.releaseMarkerPath)).toBe(true);
    expect(readdirSync(join(env.stateRoot, "oll-rollouts", "events")).length).toBeGreaterThan(0);
    const replay = rollbackOllRollout({
      stateRoot: env.stateRoot,
      releaseMarkerPath: applied.releaseMarkerPath,
      acknowledge: true,
      reason: "canary rollback drill replay",
      now: "2026-08-12T05:01:00.000Z",
    });
    expect(replay).toMatchObject({ status: "idempotent", rollbackId: rolledBack.rollbackId });
    expect(() => applyOllRollout(rolloutOptions)).toThrow("already been rolled back");
  });

  test("synthetic canary delivers one authorized local rule to the next match and rollback removes it", async () => {
    const env = setup();
    write(join(env.stateRoot, "oll", "actors.v1.json"), {
      schema: "oll.actor-registry.v1",
      revision: 1,
      principals: [{
        principalId: "person:alice",
        transportBindings: [{ channel: "telegram", accountId: "default", actorId: "42" }],
        grants: [{
          grantId: "alice-self",
          workspaceId: "project-alpha",
          scope: "person:self",
          actions: ["signal:create", "rule:auto-activate"],
          maxRisk: "low",
        }],
      }],
    });
    const releaseId = randomUUID();
    const rolloutBatchId = "pr7-synthetic-canary";
    const applied = applyOllRollout({
      stateRoot: env.stateRoot,
      releaseId,
      rolloutBatchId,
      targetMode: "active",
      workspaces: env.workspaces,
      scheduler: scheduler(env, "synthetic-payload", "nightly-synthetic"),
      readiness: readiness({ observeOnlyCanaryPassed: true }),
      now: "2026-08-12T04:00:00.000Z",
      acknowledge: true,
    });
    const workspace = env.workspaces[0].workspacePath;
    const actor = { trusted: true as const, channel: "telegram", accountId: "default", actorId: "42", contextKind: "direct" as const };
    const signal = captureAdaptationSignal({
      workspace,
      stateRoot: env.stateRoot,
      type: "correction",
      scope: { level: "person", subject: "telegram:42" },
      statement: "Use the concise report format",
      expectedBehavior: "Use the concise report format in future replies",
      sourceType: "message",
      sourceRef: "telegram:synthetic/1",
      evidenceContent: "explicit correction",
      actorContext: actor,
      capturedBy: "agent:synthetic-canary",
      explicit: true,
      now: "2026-08-12T04:05:00.000Z",
    }).signal;
    const proposed = proposeAdaptationRule({
      workspace,
      stateRoot: env.stateRoot,
      scope: { level: "person", subject: "telegram:42" },
      rule: "Use the concise report format",
      sourceSignals: [signal.id],
      expectedImprovement: "Consistent concise reports",
      costOfInaction: "Repeated formatting corrections",
      rollbackRef: `suspend:${rolloutBatchId}`,
      runId: randomUUID(),
      actionId: digest("synthetic-action"),
      rolloutBatchId,
      actorContext: actor,
      now: "2026-08-12T04:06:00.000Z",
    }).rule;
    transitionAdaptationRule({
      workspace,
      stateRoot: env.stateRoot,
      ruleId: proposed.id,
      expectedRevision: proposed.revision,
      status: "active",
      actorContext: actor,
      now: "2026-08-12T04:07:00.000Z",
    });
    const event: any = {
      type: "agent",
      action: "bootstrap",
      sessionKey: "agent:project-alpha:telegram-direct-42",
      context: {
        workspaceDir: workspace,
        sessionKey: "agent:project-alpha:telegram-direct-42",
        engramStateRoot: env.stateRoot,
        accountId: "default",
        bootstrapFiles: [{
          name: "AGENTS.md",
          path: join(workspace, "AGENTS.md"),
          content: "baseline agent policy",
          missing: false,
        }],
      },
      messages: [],
    };
    await ruleContextHook(event);
    expect(event.messages).toHaveLength(0);
    const injected = event.context.bootstrapFiles.find((file: any) => file.name === RULE_CONTEXT_BOOTSTRAP_NAME);
    expect(injected?.content).toContain("Use the concise report format");

    rollbackOllRollout({
      stateRoot: env.stateRoot,
      releaseMarkerPath: applied.releaseMarkerPath,
      acknowledge: true,
      reason: "synthetic canary rollback",
      now: "2026-08-12T05:00:00.000Z",
    });
    const afterRollback = {
      ...event,
      context: {
        ...event.context,
        bootstrapFiles: event.context.bootstrapFiles.filter((file: any) => file.name !== RULE_CONTEXT_BOOTSTRAP_NAME),
      },
      messages: [],
    };
    await ruleContextHook(afterRollback);
    expect(afterRollback.messages).toHaveLength(0);
    expect(afterRollback.context.bootstrapFiles.some((file: any) => file.name === RULE_CONTEXT_BOOTSTRAP_NAME)).toBe(false);
    const preservedSignal = JSON.parse(readFileSync(join(workspace, "memory-state", "oll", "signals", `${signal.id}.json`), "utf8"));
    expect(preservedSignal.id).toBe(signal.id);
  });
});
