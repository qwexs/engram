import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const roots: string[] = [];
const repository = resolve(import.meta.dir, "..");

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

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
});
