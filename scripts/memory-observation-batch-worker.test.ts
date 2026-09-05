import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { BATCH_EVALUATOR_AUTHORITY, deriveBatchObservationId } from "../src/memory-observation/batch-observation.ts";
import { sha256, type JsonValue } from "../src/memory-observation/ledger.ts";

const roots: string[] = [];
const repository = resolve(import.meta.dir, "..");

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function sourcePluginDigest(): Promise<`sha256:${string}`> {
  const build = await Bun.build({
    entrypoints: [join(repository, "integrations", "openclaw-memory-observation", "index.ts")],
    target: "node",
    format: "esm",
    external: ["openclaw/plugin-sdk/core"],
    minify: false,
    sourcemap: "none",
    write: false,
  });
  if (!build.success || build.outputs.length !== 1) throw new Error("memory observation plugin build failed");
  return `sha256:${createHash("sha256").update(Buffer.from(await build.outputs[0]!.arrayBuffer())).digest("hex")}`;
}

describe("memory observation batch worker CLI", () => {
  test("treats an absent or disabled projection as an idle rollback state", () => {
    for (const projection of [null, { enabled: false }]) {
      const workspace = mkdtempSync(join(tmpdir(), "memory-batch-worker-disabled-"));
      roots.push(workspace);
      writeFileSync(join(workspace, "engram.json"), JSON.stringify({ workspace: { id: "main" } }));
      if (projection) {
        const path = join(workspace, "memory-state", "memory-observation", "projection.json");
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, JSON.stringify(projection));
      }
      const result = Bun.spawnSync([
        process.execPath,
        join(repository, "scripts", "memory-observation-batch-worker.ts"),
        "--workspace",
        workspace,
      ], { cwd: repository });
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout.toString())).toEqual({
        status: "disabled",
        reason: "projection_inactive",
        workspaceId: "main",
      });
    }
  });

  test("fails closed when projection is not pinned to the exact source plugin bytes", () => {
    const workspace = mkdtempSync(join(tmpdir(), "memory-batch-worker-digest-"));
    roots.push(workspace);
    writeFileSync(join(workspace, "engram.json"), JSON.stringify({ workspace: { id: "fixture-main" } }));
    const projectionPath = join(workspace, "memory-state", "memory-observation", "projection.json");
    mkdirSync(dirname(projectionPath), { recursive: true });
    writeFileSync(projectionPath, JSON.stringify({
      schema: "engram.memory-observation-rollout.v2", workspaceId: "fixture-main", enabled: true, mode: "canary",
      bindings: [{ runtimeSessionKey: "agent:fixture-main:telegram:direct:100000001", scopeClass: "self", scopeId: "telegram:100000001", requireOwner: true, allowedChannels: ["telegram"] }],
      pluginDigest: `sha256:${"0".repeat(64)}`,
      inference: { provider: "openai", model: "openai/gpt-5.6-sol", evaluateAfter: "2026-08-24T00:00:00.000Z" },
      evaluation: { mode: "batch-cron", policyDigest: `sha256:${"1".repeat(64)}`, batch: { sourcePolicyDigest: `sha256:${"2".repeat(64)}`, inactivityGapSeconds: 60, maxTurns: 10, maxEvidenceBytes: 65536, maxAgeSeconds: 600, maxInferenceCallsPerRun: 1, schedulerId: "fixture-batch" } },
      limits: { evidenceTtlHours: 72, maxJobs: 100, maxBytes: 1048576, maxQueueAgeHours: 168, maxAttempts: 2, claimTtlSeconds: 300, maxInferenceCalls: 1 },
      consumers: { dailyNote: { mode: "canary", applyAfter: "2026-08-24T00:00:00.000Z", timezone: "UTC", allowedObservationClasses: ["episodic.event", "episodic.decision"], maxAppliesPerWake: 1 } },
      captureOwnership: { owner: "observer", effectiveAfter: "2026-08-24T00:00:00.000Z", foregroundDailyNoteCapture: "disabled" },
      approvedBy: "operator", approvedAt: "2026-08-24T00:00:00.000Z",
    }));
    const result = Bun.spawnSync([process.execPath, join(repository, "scripts", "memory-observation-batch-worker.ts"), "--workspace", workspace], { cwd: repository });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("plugin digest mismatch");
  });

  test("reconciles a queued daily-note observation from a superseded exact scope", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "memory-batch-worker-reconcile-"));
    roots.push(workspace);
    writeFileSync(join(workspace, "engram.json"), JSON.stringify({ workspace: { id: "main" } }));
    const projectionPath = join(workspace, "memory-state", "memory-observation", "projection.json");
    mkdirSync(dirname(projectionPath), { recursive: true });
    writeFileSync(projectionPath, JSON.stringify({
      schema: "engram.memory-observation-rollout.v3", workspaceId: "main", enabled: true, mode: "canary",
      bindings: [{ runtimeSessionKey: "agent:main:*", scopeClass: "self", scopeId: "workspace:main", requireOwner: true, allowedChannels: ["telegram", "openclaw"] }],
      pluginDigest: await sourcePluginDigest(),
      inference: { provider: "openai", model: "openai/gpt-5.6-terra", evaluateAfter: "2026-09-02T11:28:00.000Z" },
      evaluation: { mode: "batch-cron", policyDigest: sha256("current-batch-policy"), batch: { sourcePolicyDigest: sha256("source-policy"), inactivityGapSeconds: 300, maxTurns: 8, maxEvidenceBytes: 262144, maxAgeSeconds: 900, maxInferenceCallsPerRun: 1, schedulerId: "engram-memory-batch-main" } },
      limits: { evidenceTtlHours: 72, maxJobs: 1000, maxBytes: 67108864, maxQueueAgeHours: 168, maxAttempts: 2, claimTtlSeconds: 300, maxInferenceCalls: 1 },
      consumers: { dailyNote: { mode: "canary", applyAfter: "2026-09-03T19:26:12.000Z", timezone: "Europe/Moscow", allowedObservationClasses: ["episodic.event", "episodic.decision"], maxAppliesPerWake: 1 } },
      captureOwnership: { owner: "observer", effectiveAfter: "2026-09-03T19:26:12.000Z", foregroundDailyNoteCapture: "disabled" },
      approvedBy: "operator", approvedAt: "2026-09-03T19:26:12.000Z",
    }));
    const traceId = sha256("superseded-scope-trace");
    const sourceTurnId = `channel-user:v1:${"d".repeat(64)}`;
    const identity = {
      bundleId: sha256("superseded-scope-bundle"),
      groupId: "group-1",
      assertionIndex: 0,
      observationClass: "episodic.decision" as const,
      evaluationPolicyDigest: sha256("superseded-batch-policy"),
    };
    const observationBase = {
      schema: "engram.memory-batch-observation.v1" as const,
      observationId: deriveBatchObservationId(identity),
      bundleId: identity.bundleId,
      groupId: identity.groupId,
      assertionIndex: identity.assertionIndex,
      scope: { workspaceId: "main", runtimeSessionKey: "agent:main:telegram:direct:100000001", scopeClass: "self" as const, scopeId: "telegram:100000001" },
      sourceRefs: [{ traceId, sourceTurnId, sourceDigest: sha256("source"), evidenceDigest: sha256("evidence"), sourceCompletedAt: "2026-09-02T11:20:00.000Z" }],
      producer: BATCH_EVALUATOR_AUTHORITY,
      observationClass: identity.observationClass,
      targetConsumer: "daily-note" as const,
      payload: { section: "decisions" as const, text: "Superseded scope must terminate.", actorRef: "user" as const, outcomeStatus: "decided" as const },
      citations: [{ traceId, evidenceRef: { kind: "source-turn" as const, ref: sourceTurnId, digest: sha256("citation") } }],
      sourceCompletedAt: "2026-09-02T11:20:00.000Z",
      confidence: 0.99,
      reasonCodes: ["explicit_decision"],
      evaluationPolicyDigest: identity.evaluationPolicyDigest,
      completedAt: "2026-09-02T11:22:35.729Z",
    };
    const observation = { ...observationBase, observationDigest: sha256(observationBase as unknown as JsonValue) };
    const observationPath = join(workspace, "memory-state", "memory-observation", "v1", "observations", "batch", `${observation.observationId.slice(7)}.json`);
    mkdirSync(dirname(observationPath), { recursive: true });
    writeFileSync(observationPath, JSON.stringify(observation));
    const queuePath = join(workspace, "memory-state", "memory-observation", "v1", "consumers", "daily-note", "queue", `${observation.observationId.slice(7)}.json`);
    mkdirSync(dirname(queuePath), { recursive: true });
    writeFileSync(queuePath, JSON.stringify({
      schema: "engram.memory-observation-consumer-queue.v1", consumer: "daily-note", observationId: observation.observationId,
      traceId, status: "queued", attempt: 0, maxAttempts: 3, createdAt: observation.completedAt, updatedAt: observation.completedAt,
      claimedAt: null, claimToken: null, terminalAt: null, reasonCode: null,
    }));

    const result = Bun.spawnSync([process.execPath, join(repository, "scripts", "memory-observation-batch-worker.ts"), "--workspace", workspace], { cwd: repository });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toMatchObject({ evaluation: { status: "idle" }, apply: { status: "idle" } });
    expect(JSON.parse(readFileSync(queuePath, "utf8"))).toMatchObject({
      status: "terminal",
      reasonCode: "policy_superseded_before_apply",
    });
  });
});
