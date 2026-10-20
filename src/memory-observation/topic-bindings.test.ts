import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configuredTopicBindings, assertTopicHostRoutes } from "./topic-bindings.ts";
import { resolveMemoryObservationProjection, memoryObservationBinding, memoryObservationCaptureOwner } from "./projection.ts";
import { observerOwnsDailyCapture } from "../../scripts/_lib/observer-daily-ownership.ts";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
function fixture() {
  const workspace = mkdtempSync(join(tmpdir(), "engram-topics-")); roots.push(workspace);
  const domains: any = { general: { type: "meta-domain", topic: { chatId: "-100123", topicId: "1" } },
    smm: { type: "topic-thread", topic: { chatId: "-100123", topicId: "2" } } };
  for (const name of Object.keys(domains)) mkdirSync(join(workspace, "memory/domains", name), { recursive: true });
  const writeRegistry = () => writeFileSync(join(workspace, "memory/domains/registry.json"), JSON.stringify({ domains }));
  writeRegistry(); writeFileSync(join(workspace, "engram.json"), JSON.stringify({ workspace: { id: "project" } }));
  const config: any = { agents: { entries: { project: { workspace } } }, channels: { telegram: { groups: {
    "-100123": { enabled: true, topics: { "1": { enabled: true, agentId: "project" }, "2": { enabled: true, agentId: "project" } } },
  } } } };
  return { workspace, config, domains, writeRegistry };
}

test("exact topic and General bindings require matching host routes and unique domain identity", () => {
  const f = fixture();
  const bindings = configuredTopicBindings(f.config, f.workspace, "project", ["smm", "general"]);
  expect(bindings).toHaveLength(2);
  expect(bindings[0]!.runtimeSessionKey).toBe("agent:project:telegram:group:-100123:topic:1");
  expect(() => configuredTopicBindings(f.config, f.workspace, "project", ["smm", "smm"])).toThrow();
  f.config.channels.telegram.groups["-100123"].topics["2"].agentId = "other";
  expect(() => assertTopicHostRoutes(f.config, f.workspace, "project", bindings)).toThrow();
  f.domains.smm.topic.topicId = "TBD"; f.writeRegistry();
  expect(() => configuredTopicBindings(f.config, f.workspace, "project", ["smm"])).toThrow();
});

test("duplicate registry bindings fail instead of choosing the first domain", () => {
  const f = fixture(); f.domains.duplicate = structuredClone(f.domains.smm); f.writeRegistry();
  expect(() => configuredTopicBindings(f.config, f.workspace, "project", ["smm"])).toThrow("ambiguous");
});

test("v4 transfers only listed topics and revokes ownership after registry drift", () => {
  const f = fixture(); const bindings = configuredTopicBindings(f.config, f.workspace, "project", ["smm", "general"]);
  const at = "2026-09-07T10:00:00.000Z", hash = `sha256:${"a".repeat(64)}`;
  const p: any = { schema: "engram.memory-observation-rollout.v4", workspaceId: "project", enabled: true, mode: "canary", bindings,
    pluginDigest: hash, inference: { provider: "openai", model: "openai/gpt-5.6-terra", evaluateAfter: at },
    evaluation: { mode: "batch-cron", policyDigest: hash, batch: { sourcePolicyDigest: hash, inactivityGapSeconds: 300, maxTurns: 8,
      maxEvidenceBytes: 262144, maxAgeSeconds: 900, maxInferenceCallsPerRun: 1, schedulerId: "group-worker" } },
    limits: { evidenceTtlHours: 72, maxJobs: 1000, maxBytes: 67108864, maxQueueAgeHours: 168, maxAttempts: 2, claimTtlSeconds: 300, maxInferenceCalls: 1 },
    consumers: { dailyNote: { mode: "canary", applyAfter: at, timezone: "UTC", allowedObservationClasses: ["episodic.event", "episodic.decision"], maxAppliesPerWake: 1,
      qmdBinding: { resolver: "exact-session-registry", manifestPath: join(f.workspace, "manifest.json"), workspaceRegistryDigest: hash } } },
    captureOwnership: { owner: "observer", effectiveAfter: at, foregroundDailyNoteCapture: "disabled" }, approvedBy: "operator", approvedAt: at };
  const path = join(f.workspace, "memory-state/memory-observation/projection.json"); mkdirSync(join(f.workspace, "memory-state/memory-observation"), { recursive: true });
  writeFileSync(path, JSON.stringify(p));
  const current = resolveMemoryObservationProjection({ workspace: f.workspace, workspaceId: "project" });
  const now = new Date("2026-09-07T12:00:00.000Z");
  expect(memoryObservationCaptureOwner(current, bindings[0]!.runtimeSessionKey, now)).toBe("observer");
  expect(memoryObservationBinding(current, "agent:project:telegram:group:-100123:topic:3")).toBeNull();
  expect(observerOwnsDailyCapture(f.workspace, "project", "telegram-group--100123-topic-2", now)).toBe(true);
  expect(observerOwnsDailyCapture(f.workspace, "project", "telegram-group--100123-topic-3", now)).toBe(false);
  f.domains.smm.topic.topicId = "9"; f.writeRegistry();
  expect(() => resolveMemoryObservationProjection({ workspace: f.workspace, workspaceId: "project" })).toThrow("registry authorization");
  expect(observerOwnsDailyCapture(f.workspace, "project", "telegram-group--100123-topic-2", now)).toBe(false);
});


test("v6 preserves main family but exact topic authority wins in either order", () => {
  const f = fixture();
  f.config.agents.entries.main = { workspace: f.workspace };
  f.config.channels.telegram.groups["-100123"].topics["2"].agentId = "main";
  const topic = configuredTopicBindings(f.config, f.workspace, "main", ["smm"])[0]!;
  const family: any = { runtimeSessionKey: "agent:main:*", scopeClass: "self", scopeId: "workspace:main", requireOwner: true, allowedChannels: ["telegram", "openclaw"] };
  const at = "2026-09-07T10:00:00.000Z", hash = `sha256:${"a".repeat(64)}`;
  const p: any = { schema: "engram.memory-observation-rollout.v6", workspaceId: "main", enabled: true, mode: "canary", bindings: [family, topic],
    pluginDigest: hash, inference: { provider: "openai", model: "openai/test", evaluateAfter: at },
    evaluation: { mode: "batch-cron", policyDigest: hash, batch: { sourcePolicyDigest: hash, inactivityGapSeconds: 300, maxTurns: 8, maxEvidenceBytes: 262144, maxAgeSeconds: 900, maxInferenceCallsPerRun: 1, schedulerId: "existing-main" } },
    limits: { evidenceTtlHours: 72, maxJobs: 1000, maxBytes: 67108864, maxQueueAgeHours: 168, maxAttempts: 2, claimTtlSeconds: 300, maxInferenceCalls: 1 },
    consumers: { dailyNote: { mode: "canary", applyAfter: at, timezone: "UTC", allowedObservationClasses: ["episodic.event", "episodic.decision"], maxAppliesPerWake: 1, qmdBinding: { resolver: "exact-session-registry", manifestPath: join(f.workspace, "manifest.json"), workspaceRegistryDigest: hash } } },
    captureOwnership: { owner: "observer", effectiveAfter: at, foregroundDailyNoteCapture: "disabled" }, approvedBy: "operator", approvedAt: at };
  const path = join(f.workspace, "memory-state/memory-observation/projection.json"); mkdirSync(join(f.workspace, "memory-state/memory-observation"), { recursive: true });
  const load = (value: any = p) => { writeFileSync(path, JSON.stringify(value)); return resolveMemoryObservationProjection({ workspace: f.workspace, workspaceId: value.workspaceId }); };
  for (const bindings of [[family, topic], [topic, family]]) {
    const active = load({ ...p, bindings });
    expect(memoryObservationBinding(active, topic.runtimeSessionKey)?.scopeId).toBe("domain:main:smm");
    expect(memoryObservationBinding(active, "agent:main:telegram:direct:123")?.scopeId).toBe("workspace:main");
    expect(memoryObservationBinding(active, "agent:other:telegram:direct:123")).toBeNull();
    expect(memoryObservationCaptureOwner(active, topic.runtimeSessionKey, new Date(at))).toBe("observer");
    const changed = structuredClone(f.config); changed.channels.telegram.groups["-100123"].topics["2"].agentId = "other";
    expect(() => assertTopicHostRoutes(changed, f.workspace, "main", [memoryObservationBinding(active, topic.runtimeSessionKey)!])).toThrow();
  }
  for (const value of [ { ...p, bindings: [topic] }, { ...p, bindings: [family] }, { ...p, workspaceId: "other" },
    { ...p, bindings: [{ ...family, requireOwner: false }, topic] }, { ...p, schema: "engram.memory-observation-rollout.v4" } ]) expect(() => load(value)).toThrow();
  f.domains.smm.topic.topicId = "9"; f.writeRegistry();
  expect(() => load()).toThrow("registry authorization");
});
