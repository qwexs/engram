import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { personalBatchBinding, runtimeSourcePolicyDigest } from "../scripts/_lib/memory-observation-rollout-policy.ts";
import { observerOwnsDailyCapture } from "../scripts/_lib/observer-daily-ownership.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const workspace = mkdtempSync(join(tmpdir(), "personal-memory-rollout-")); roots.push(workspace);
  const agentId = "personal-a", sessionKey = `agent:${agentId}:telegram:direct:100000001`;
  const host = { agents: { entries: { [agentId]: { workspace } } }, bindings: [
    { agentId, match: { channel: "telegram", peer: { kind: "direct", id: "100000001" } } },
  ] };
  const binding = personalBatchBinding(host, workspace, agentId, sessionKey);
  const boundary = "2026-09-07T08:00:00.000Z";
  const projection = { schema: "engram.memory-observation-rollout.v2", workspaceId: agentId,
    enabled: true, mode: "canary", bindings: [binding], pluginDigest: `sha256:${"1".repeat(64)}`,
    inference: { provider: "openai", model: "openai/gpt-5.6-terra", evaluateAfter: boundary },
    evaluation: { mode: "batch-cron", policyDigest: `sha256:${"2".repeat(64)}`,
      batch: { sourcePolicyDigest: `sha256:${"3".repeat(64)}`, inactivityGapSeconds: 300,
        maxTurns: 8, maxEvidenceBytes: 262144, maxAgeSeconds: 900, maxInferenceCallsPerRun: 1, schedulerId: "personal-batch" } },
    limits: { evidenceTtlHours: 72, maxJobs: 1000, maxBytes: 67108864, maxQueueAgeHours: 168,
      maxAttempts: 2, claimTtlSeconds: 300, maxInferenceCalls: 1 },
    consumers: { dailyNote: { mode: "canary", applyAfter: boundary, timezone: "UTC",
      allowedObservationClasses: ["episodic.event", "episodic.decision"], maxAppliesPerWake: 1 } },
    captureOwnership: { owner: "observer", effectiveAfter: boundary, foregroundDailyNoteCapture: "disabled" },
    approvedBy: "operator", approvedAt: boundary };
  writeFileSync(join(workspace, "engram.json"), JSON.stringify({ workspace: { id: agentId }, agent: `agent-${agentId}` }));
  const path = join(workspace, "memory-state", "memory-observation", "projection.json");
  mkdirSync(join(workspace, "memory-state", "memory-observation"), { recursive: true });
  writeFileSync(path, JSON.stringify(projection));
  return { workspace, agentId, sessionKey, host, projection, path };
}

test("non-owner personal capture requires an exact unique host DM/workspace binding", () => {
  const f = fixture();
  expect(personalBatchBinding(f.host, f.workspace, f.agentId, f.sessionKey).requireOwner).toBe(false);
  for (const key of [`agent:${f.agentId}:*`, `agent:${f.agentId}:telegram:group:-100`,
    "agent:personal-b:telegram:direct:100000001", `agent:${f.agentId}:telegram:direct:100000002`]) {
    expect(() => personalBatchBinding(f.host, f.workspace, f.agentId, key)).toThrow();
  }
  expect(() => personalBatchBinding({ ...f.host, bindings: [...f.host.bindings, ...f.host.bindings] },
    f.workspace, f.agentId, f.sessionKey)).toThrow("ambiguous");
});

test("ownership is exact, effective-boundary aware, and reverts immediately on disable", () => {
  const f = fixture(); const now = new Date("2026-09-07T09:00:00Z");
  expect(observerOwnsDailyCapture(f.workspace, f.agentId, f.sessionKey, now)).toBe(true);
  expect(observerOwnsDailyCapture(f.workspace, f.agentId, "telegram-direct-100000001", now)).toBe(true);
  expect(observerOwnsDailyCapture(f.workspace, f.agentId, "telegram-direct-100000002", now)).toBe(false);
  expect(observerOwnsDailyCapture(f.workspace, f.agentId, "agent:personal-b:telegram:direct:100000001", now)).toBe(false);
  expect(observerOwnsDailyCapture(f.workspace, f.agentId, f.sessionKey, new Date("2026-09-07T07:00:00Z"))).toBe(false);
  writeFileSync(f.path, JSON.stringify({ ...f.projection, enabled: false }));
  expect(observerOwnsDailyCapture(f.workspace, f.agentId, f.sessionKey, now)).toBe(false);
});

test("legacy extraction/report cannot mutate observer-owned notes; Learnings remains writable", () => {
  const f = fixture();
  // Effective in both CI wall clocks and the live deployment clock.
  f.projection.approvedAt = f.projection.inference.evaluateAfter = f.projection.captureOwnership.effectiveAfter =
    f.projection.consumers.dailyNote.applyAfter = "2020-01-01T00:00:00.000Z";
  writeFileSync(f.path, JSON.stringify(f.projection));
  const session = "telegram-direct-100000001";
  const directory = join(f.workspace, "memory", `agent-${f.agentId}`, session);
  mkdirSync(directory, { recursive: true });
  const today = new Date().toLocaleDateString("sv-SE", { timeZone: "UTC" });
  const note = join(directory, `${today}.md`), original = `# ${today}\n\n## Events\n\n## Decisions\n\n## Learnings\n`;
  writeFileSync(note, original);
  const run = (script: string, args: string[]) => Bun.spawnSync([process.execPath,
    join(import.meta.dir, "..", "scripts", script), ...args], { cwd: f.workspace,
    env: { ...process.env, ENGRAM_WORKSPACE: f.workspace, ENGRAM_TZ: "UTC", TZ: "UTC" } });
  for (const script of ["extract-runner.js", "heartbeat-report.js"]) {
    const result = run(script, ["--session", session]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString()).reason).toBe("observer_owns_capture");
    expect(readFileSync(note, "utf8")).toBe(original);
  }
  for (const section of ["events", "decisions"]) {
    expect(run("daily-note-append.js", ["--session", session, "--section", section, "--text", "duplicate"]).exitCode).toBe(1);
    expect(readFileSync(note, "utf8")).toBe(original);
  }
  // Missing QMD in the fixture may reject the downstream mark, but must not block the retained section writer.
  run("daily-note-append.js", ["--session", session, "--section", "learnings", "--text", "retained learning"]);
  expect(readFileSync(note, "utf8")).toContain("retained learning");
});

test("fresh direct activation derives the unchanged runtime source policy without a shadow envelope", () => {
  const policy = JSON.parse(readFileSync(join(import.meta.dir, "..", "contracts/memory-observation/v1/authority-policy.json"), "utf8"));
  expect(runtimeSourcePolicyDigest(policy)).toBe("sha256:c64569a2a8fb8afd75abf8211e0fd21f3328c0333bcce19013dfee519a14359b");
});
