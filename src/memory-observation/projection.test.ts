import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  MEMORY_OBSERVATION_PROJECTION_SCHEMA,
  MEMORY_OBSERVATION_PROJECTION_SCHEMA_V2,
  MEMORY_OBSERVATION_PROJECTION_SCHEMA_V3,
  memoryObservationBinding,
  memoryObservationCaptureOwner,
  memoryObservationEvaluationMode,
  memoryObservationProjectionPath,
  resolveMemoryObservationProjection,
  type MemoryObservationProjectionV1,
} from "./projection.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function workspace(): string {
  const value = mkdtempSync(join(tmpdir(), "memory-observation-projection-"));
  roots.push(value);
  return value;
}

function projection(overrides: Partial<MemoryObservationProjectionV1> = {}): MemoryObservationProjectionV1 {
  return {
    schema: MEMORY_OBSERVATION_PROJECTION_SCHEMA,
    workspaceId: "main",
    enabled: true,
    mode: "shadow",
    bindings: [{
      runtimeSessionKey: "agent:main:telegram:direct:100000001",
      scopeClass: "self",
      scopeId: "telegram:100000001",
      requireOwner: true,
      allowedChannels: ["telegram"],
    }],
    pluginDigest: `sha256:${"a".repeat(64)}`,
    inference: {
      provider: "openai",
      model: "openai/gpt-5.6-sol",
      evaluateAfter: "2026-08-24T19:00:00.000Z",
    },
    limits: {
      evidenceTtlHours: 72,
      maxJobs: 1_000,
      maxBytes: 67_108_864,
      maxQueueAgeHours: 168,
      maxAttempts: 2,
      claimTtlSeconds: 300,
      maxInferenceCalls: 0,
    },
    approvedBy: "operator",
    approvedAt: "2026-08-24T19:00:00.000Z",
    ...overrides,
  };
}

function writeProjection(root: string, value: unknown): void {
  const path = memoryObservationProjectionPath(root);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

describe("memory observation rollout projection", () => {
  test("admits only an exact local binding with matching installed plugin bytes", () => {
    const root = workspace();
    const value = projection();
    writeProjection(root, value);
    const current = resolveMemoryObservationProjection({
      workspace: root,
      workspaceId: "main",
      expectedPluginDigest: value.pluginDigest,
    });
    expect(memoryObservationBinding(current, "agent:main:telegram:direct:100000001")?.scopeId).toBe("telegram:100000001");
    expect(memoryObservationBinding(current, "agent:main:telegram:direct:other")).toBeNull();
    expect(() => resolveMemoryObservationProjection({
      workspace: root,
      workspaceId: "main",
      expectedPluginDigest: `sha256:${"b".repeat(64)}`,
    })).toThrow("digest mismatch");

    writeProjection(root, projection({ limits: { ...projection().limits, maxInferenceCalls: 1 } }));
    expect(resolveMemoryObservationProjection({ workspace: root, workspaceId: "main" }).limits.maxInferenceCalls).toBe(1);
  });

  test("fails closed for disabled, wildcard, duplicate, or unbounded-inference projections", () => {
    const root = workspace();
    for (const value of [
      projection({ enabled: false }),
      projection({ bindings: [{ ...projection().bindings[0]!, runtimeSessionKey: "*" }] }),
      projection({ bindings: [projection().bindings[0]!, projection().bindings[0]!] }),
      projection({ limits: { ...projection().limits, maxInferenceCalls: 2 as 1 } }),
      projection({ inference: { ...projection().inference, provider: "minimax" } }),
      projection({ inference: { ...projection().inference, evaluateAfter: "not-an-instant" } }),
    ]) {
      writeProjection(root, value);
      expect(() => resolveMemoryObservationProjection({ workspace: root, workspaceId: "main" })).toThrow("projection is invalid");
    }
  });

  test("admits only an exact event-only daily-note canary", () => {
    const root = workspace();
    const canary = projection({
      mode: "canary",
      consumers: {
        dailyNote: {
          mode: "canary",
          applyAfter: "2026-08-27T00:00:00.000Z",
          timezone: "Europe/Moscow",
          allowedObservationClasses: ["episodic.event"],
          maxAppliesPerWake: 1,
        },
      },
    });
    writeProjection(root, canary);
    expect(resolveMemoryObservationProjection({ workspace: root, workspaceId: "main" }).mode).toBe("canary");

    for (const value of [
      projection({ mode: "canary" }),
      projection({ consumers: canary.consumers }),
      { ...canary, bindings: [canary.bindings[0], { ...canary.bindings[0], runtimeSessionKey: "agent:main:telegram:direct:2" }] },
      { ...canary, consumers: { dailyNote: { ...canary.consumers!.dailyNote, allowedObservationClasses: ["episodic.decision"] } } },
      { ...canary, consumers: { dailyNote: { ...canary.consumers!.dailyNote, maxAppliesPerWake: 2 } } },
    ]) {
      writeProjection(root, value);
      expect(() => resolveMemoryObservationProjection({ workspace: root, workspaceId: "main" })).toThrow("projection is invalid");
    }
  });

  test("admits observer ownership only for an exact event-and-decision canary", () => {
    const root = workspace();
    const effectiveAfter = "2026-08-28T15:00:00.000Z";
    const ownership = projection({
      mode: "canary",
      consumers: {
        dailyNote: {
          mode: "canary",
          applyAfter: effectiveAfter,
          timezone: "Europe/Moscow",
          allowedObservationClasses: ["episodic.event", "episodic.decision"],
          maxAppliesPerWake: 1,
          qmdBinding: { collection: "main-direct-memory" },
        },
      },
      captureOwnership: {
        owner: "observer",
        effectiveAfter,
        foregroundDailyNoteCapture: "disabled",
      },
    });
    writeProjection(root, ownership);
    const active = resolveMemoryObservationProjection({ workspace: root, workspaceId: "main" });
    expect(memoryObservationCaptureOwner(active, ownership.bindings[0]!.runtimeSessionKey, new Date(effectiveAfter))).toBe("observer");
    expect(memoryObservationCaptureOwner(active, "agent:main:telegram:direct:adjacent", new Date(effectiveAfter))).toBe("foreground");
    expect(memoryObservationCaptureOwner(active, ownership.bindings[0]!.runtimeSessionKey, new Date("2026-08-28T14:59:59.999Z"))).toBe("foreground");

    for (const value of [
      { ...ownership, captureOwnership: { ...ownership.captureOwnership!, effectiveAfter: "2026-08-28T15:00:01.000Z" } },
      { ...ownership, captureOwnership: { ...ownership.captureOwnership!, foregroundDailyNoteCapture: "enabled" } },
      { ...ownership, consumers: { dailyNote: { ...ownership.consumers!.dailyNote, allowedObservationClasses: ["episodic.event"] } } },
    ]) {
      writeProjection(root, value);
      expect(() => resolveMemoryObservationProjection({ workspace: root, workspaceId: "main" })).toThrow("projection is invalid");
    }
  });

  test("admits projection v2 batch-cron only with a sealed exact scheduler policy and no immediate wake path", () => {
    const root = workspace();
    const effectiveAfter = "2026-08-31T20:00:00.000Z";
    const batch = projection({
      schema: MEMORY_OBSERVATION_PROJECTION_SCHEMA_V2,
      mode: "canary",
      limits: { ...projection().limits, maxInferenceCalls: 1 },
      evaluation: {
        mode: "batch-cron",
        policyDigest: `sha256:${"b".repeat(64)}`,
        batch: {
          sourcePolicyDigest: `sha256:${"c".repeat(64)}`,
          inactivityGapSeconds: 300,
          maxTurns: 8,
          maxEvidenceBytes: 262_144,
          maxAgeSeconds: 900,
          maxInferenceCallsPerRun: 1,
          schedulerId: "engram-memory-batch-main-direct",
        },
      },
      consumers: {
        dailyNote: {
          mode: "canary",
          applyAfter: effectiveAfter,
          timezone: "Europe/Moscow",
          allowedObservationClasses: ["episodic.event", "episodic.decision"],
          maxAppliesPerWake: 1,
        },
      },
      captureOwnership: {
        owner: "observer",
        effectiveAfter,
        foregroundDailyNoteCapture: "disabled",
      },
    });
    writeProjection(root, batch);
    const active = resolveMemoryObservationProjection({ workspace: root, workspaceId: "main" });
    expect(memoryObservationEvaluationMode(active)).toBe("batch-cron");

    for (const value of [
      { ...batch, limits: { ...batch.limits, maxInferenceCalls: 0 } },
      { ...batch, evaluation: { ...batch.evaluation!, policyDigest: "unknown" } },
      { ...batch, evaluation: { ...batch.evaluation!, batch: { ...batch.evaluation!.batch!, maxTurns: 1 } } },
      { ...batch, evaluation: { ...batch.evaluation!, batch: { ...batch.evaluation!.batch!, maxAgeSeconds: 100 } } },
      { ...batch, evaluation: { ...batch.evaluation!, batch: undefined } },
    ]) {
      writeProjection(root, value);
      expect(() => resolveMemoryObservationProjection({ workspace: root, workspaceId: "main" })).toThrow("projection is invalid");
    }
  });

  test("admits one v3 main-agent family selector while retaining exact resolved session scope", () => {
    const root = workspace();
    const effectiveAfter = "2026-09-02T12:00:00.000Z";
    const family = projection({
      schema: MEMORY_OBSERVATION_PROJECTION_SCHEMA_V3,
      mode: "canary",
      bindings: [{
        runtimeSessionKey: "agent:main:*",
        scopeClass: "self",
        scopeId: "workspace:main",
        requireOwner: true,
        allowedChannels: ["telegram", "openclaw"],
      }],
      limits: { ...projection().limits, maxInferenceCalls: 1 },
      evaluation: {
        mode: "batch-cron",
        policyDigest: `sha256:${"d".repeat(64)}`,
        batch: {
          sourcePolicyDigest: `sha256:${"c".repeat(64)}`,
          inactivityGapSeconds: 300,
          maxTurns: 8,
          maxEvidenceBytes: 262_144,
          maxAgeSeconds: 900,
          maxInferenceCallsPerRun: 1,
          schedulerId: "engram-memory-batch-main",
        },
      },
      consumers: {
        dailyNote: {
          mode: "canary",
          applyAfter: effectiveAfter,
          timezone: "Europe/Moscow",
          allowedObservationClasses: ["episodic.event", "episodic.decision"],
          maxAppliesPerWake: 1,
          qmdBinding: {
            resolver: "exact-session-registry",
            manifestPath: "/workspace/ops/qmd-migration.json",
            workspaceRegistryDigest: `sha256:${"e".repeat(64)}`,
          },
        },
      },
      captureOwnership: {
        owner: "observer",
        effectiveAfter,
        foregroundDailyNoteCapture: "disabled",
      },
    });
    writeProjection(root, family);
    const active = resolveMemoryObservationProjection({ workspace: root, workspaceId: "main" });
    const topicKey = "agent:main:telegram:group:-100123:topic:7";
    expect(memoryObservationBinding(active, topicKey)?.runtimeSessionKey).toBe(topicKey);
    expect(memoryObservationBinding(active, topicKey)?.scopeId).toBe("workspace:main");
    expect(memoryObservationCaptureOwner(active, topicKey, new Date(effectiveAfter))).toBe("observer");
    expect(active.consumers?.dailyNote.qmdBinding).toMatchObject({ resolver: "exact-session-registry" });
    expect(memoryObservationBinding(active, "agent:company:telegram:group:-1")).toBeNull();

    writeProjection(root, { ...family, schema: MEMORY_OBSERVATION_PROJECTION_SCHEMA_V2 });
    expect(() => resolveMemoryObservationProjection({ workspace: root, workspaceId: "main" })).toThrow("projection is invalid");

    writeProjection(root, {
      ...family,
      consumers: {
        dailyNote: {
          ...family.consumers!.dailyNote,
          qmdBinding: { collection: "main-direct-memory" },
        },
      },
    });
    expect(() => resolveMemoryObservationProjection({ workspace: root, workspaceId: "main" })).toThrow("projection is invalid");

    const { qmdBinding: _requiredResolver, ...dailyNoteWithoutResolver } = family.consumers!.dailyNote;
    writeProjection(root, { ...family, consumers: { dailyNote: dailyNoteWithoutResolver } });
    expect(() => resolveMemoryObservationProjection({ workspace: root, workspaceId: "main" })).toThrow("projection is invalid");

    for (const qmdBinding of [
      { resolver: "exact-session-registry", manifestPath: "ops/qmd.json", workspaceRegistryDigest: `sha256:${"e".repeat(64)}` },
      { resolver: "exact-session-registry", manifestPath: "/workspace/ops/qmd.json", workspaceRegistryDigest: "unknown" },
      { resolver: "prefix-guess", manifestPath: "/workspace/ops/qmd.json", workspaceRegistryDigest: `sha256:${"e".repeat(64)}` },
      { resolver: "exact-session-registry", manifestPath: "/workspace/ops/qmd.json", workspaceRegistryDigest: `sha256:${"e".repeat(64)}`, collection: "fallback" },
    ]) {
      writeProjection(root, {
        ...family,
        consumers: { dailyNote: { ...family.consumers!.dailyNote, qmdBinding } },
      });
      expect(() => resolveMemoryObservationProjection({ workspace: root, workspaceId: "main" })).toThrow("projection is invalid");
    }
  });
});
