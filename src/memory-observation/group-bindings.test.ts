import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { configuredGroupDirectBindings, assertGroupHostRoutes, assertGroupDomainRegistry, validGroupDirectBinding } from "./group-bindings.ts";
import { resolveMemoryObservationProjection, memoryObservationBinding, memoryObservationCaptureOwner } from "./projection.ts";
import { observerOwnsDailyCapture, observerOwnsDomainProjection } from "../../scripts/_lib/observer-daily-ownership.ts";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })));
function fixture() {
  const workspace = mkdtempSync(join(tmpdir(), "engram-group-direct-")); roots.push(workspace);
  mkdirSync(join(workspace, "memory/domains/general"), { recursive: true });
  const domains: any = { general: { type: "group-direct", group: { chatId: "-100123" } } };
  const write = () => writeFileSync(join(workspace, "memory/domains/registry.json"), JSON.stringify({ domains })); write();
  writeFileSync(join(workspace, "engram.json"), JSON.stringify({ workspace: { id: "project" } }));
  const config: any = { agents: { entries: { project: { workspace } } },
    channels: { telegram: { groups: { "-100123": { enabled: true } } } },
    bindings: [{ type: "route", agentId: "project", match: { channel: "telegram", peer: { kind: "group", id: "-100123" } } }] };
  const bindings = configuredGroupDirectBindings(config, workspace, "project", ["general"]);
  return { workspace, domains, write, config, bindings };
}

test("group-direct requires a unique exact registry and explicit host route", () => {
  const f = fixture(), b = f.bindings[0]!;
  expect(b.runtimeSessionKey).toBe("agent:project:telegram:group:-100123");
  expect(validGroupDirectBinding({ ...b, runtimeSessionKey: b.runtimeSessionKey + ":topic:1" })).toBe(false);
  expect(validGroupDirectBinding({ ...b, topicDomain: { domain: "general", chatId: "-100123", topicId: "1" } })).toBe(false);
  expect(validGroupDirectBinding({ ...b, scopeClass: "self" })).toBe(false);
  expect(validGroupDirectBinding({ ...b, groupDomain: { domain: "other", chatId: "-100123" } })).toBe(false);
  f.config.bindings[0].agentId = "other";
  expect(() => assertGroupHostRoutes(f.config, f.workspace, "project", f.bindings)).toThrow();
  f.config.bindings[0].agentId = "project";
  f.config.bindings.push(structuredClone(f.config.bindings[0]));
  expect(() => assertGroupHostRoutes(f.config, f.workspace, "project", f.bindings)).toThrow();
  f.config.bindings.pop(); f.config.channels.telegram.groups["-100123"].topics = { "1": { enabled: true, agentId: "project" } };
  expect(() => assertGroupHostRoutes(f.config, f.workspace, "project", f.bindings)).toThrow();
  f.domains.duplicate = structuredClone(f.domains.general); f.write();
  expect(() => assertGroupDomainRegistry(f.workspace, "project", f.bindings)).toThrow("ambiguous");
});

test("v5 ownership is exact, time-bounded, revocable, and cannot be smuggled into v4", () => {
  const f = fixture(), at = "2026-09-08T12:00:00.000Z", hash = "sha256:" + "a".repeat(64);
  const p: any = { schema: "engram.memory-observation-rollout.v5", workspaceId: "project", enabled: true, mode: "canary", bindings: f.bindings,
    pluginDigest: hash, inference: { provider: "openai", model: "openai/gpt-5.6-terra", evaluateAfter: at },
    evaluation: { mode: "batch-cron", policyDigest: hash, batch: { sourcePolicyDigest: hash, inactivityGapSeconds: 300, maxTurns: 8,
      maxEvidenceBytes: 262144, maxAgeSeconds: 900, maxInferenceCallsPerRun: 1, schedulerId: "same-fleet" } },
    limits: { evidenceTtlHours: 72, maxJobs: 1000, maxBytes: 67108864, maxQueueAgeHours: 168, maxAttempts: 2, claimTtlSeconds: 300, maxInferenceCalls: 1 },
    consumers: { dailyNote: { mode: "canary", applyAfter: at, timezone: "UTC", allowedObservationClasses: ["episodic.event", "episodic.decision"], maxAppliesPerWake: 1,
      qmdBinding: { resolver: "exact-session-registry", manifestPath: join(f.workspace, "manifest.json"), workspaceRegistryDigest: hash } } },
    captureOwnership: { owner: "observer", effectiveAfter: at, foregroundDailyNoteCapture: "disabled" }, approvedBy: "operator", approvedAt: at };
  const path = join(f.workspace, "memory-state/memory-observation/projection.json"); mkdirSync(join(f.workspace, "memory-state/memory-observation"), { recursive: true });
  const write = () => writeFileSync(path, JSON.stringify(p)); write();
  const current = () => resolveMemoryObservationProjection({ workspace: f.workspace, workspaceId: "project" });
  const now = new Date("2026-09-08T13:00:00Z"), key = f.bindings[0]!.runtimeSessionKey;
  expect(memoryObservationCaptureOwner(current(), key, now)).toBe("observer");
  expect(memoryObservationCaptureOwner(current(), key, new Date("2026-09-08T11:00:00Z"))).toBe("foreground");
  for (const other of [key + ":topic:1", key.replace("-100123", "-100124"), key.replace("group:-100123", "direct:123")]) expect(memoryObservationBinding(current(), other)).toBeNull();
  expect(observerOwnsDailyCapture(f.workspace, "project", "telegram-group--100123", now)).toBe(true);
  expect(observerOwnsDomainProjection(f.workspace, "general", now)).toBe(true);
  p.schema = "engram.memory-observation-rollout.v4"; write(); expect(current).toThrow();
  p.schema = "engram.memory-observation-rollout.v5"; p.enabled = false; write(); expect(current).toThrow();
  p.enabled = true; write(); f.domains.general.group.chatId = "-100124"; f.write();
  expect(current).toThrow("registry authorization");
  expect(observerOwnsDailyCapture(f.workspace, "project", "telegram-group--100123", now)).toBe(false);
});
