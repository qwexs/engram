import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureTopicDomainRuntime } from "./topic-domain-runtime.ts";

const DIGEST = `sha256:${"1".repeat(64)}` as const;
let root = "";
const originalCacheHome = process.env.XDG_CACHE_HOME;

function json(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function read(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"));
}

function fixture() {
  root = mkdtempSync(join(tmpdir(), "engram-topic-runtime-"));
  process.env.XDG_CACHE_HOME = join(root, "cache");
  mkdirSync(join(process.env.XDG_CACHE_HOME, "qmd"), { recursive: true });
  writeFileSync(join(process.env.XDG_CACHE_HOME, "qmd/topic-runtime-test.sqlite"), "");
  const main = join(root, "main");
  const company = join(root, "company");
  const workspace = join(root, "project");
  const globalManifestPath = join(main, "ops/qmd-global-migration/migration.json");
  const workerManifestPath = join(workspace, "ops/memory-topic-worker/qmd-manifest.json");
  const oldSession = join(workspace, "memory/agent-project/telegram-group--1001-topic-1");
  const oldDomain = join(workspace, "memory/domains/project-general");
  const newDomain = join(workspace, "memory/domains/project-new");
  for (const path of [
    join(main, "memory/agent-main/main"),
    join(company, "memory/agent-company/main"),
    join(workspace, "memory/agent-project/main"),
    oldSession,
    oldDomain,
    newDomain,
    join(company, "memory/domains/company-general"),
  ]) mkdirSync(path, { recursive: true });
  for (const path of [oldDomain, newDomain, join(company, "memory/domains/company-general")]) {
    writeFileSync(join(path, "README.md"), "# fixture\n");
  }
  const registry = {
    schema: "engram.qmd.global-registry.v1",
    index: { name: "topic-runtime-test" },
    workspaces: [
      { id: "main", path: main, kind: "technical", parents: [], readableCollections: ["main-memory"] },
      { id: "company", path: company, kind: "business", parents: [], readableCollections: ["company-memory"] },
      { id: "project", path: workspace, kind: "business", parents: ["company"], readableCollections: ["project-memory", "domain-project-general", "topic-memory-project-general"] },
    ],
    collections: [
      { name: "main-memory", path: join(main, "memory/agent-main/main"), owner: "main", mask: "**/*.md" },
      { name: "company-memory", path: join(company, "memory/agent-company/main"), owner: "company", mask: "**/*.md" },
      { name: "project-memory", path: join(workspace, "memory/agent-project/main"), owner: "project", mask: "**/*.md" },
      { name: "domain-project-general", path: oldDomain, owner: "project", mask: "**/*.md" },
      { name: "topic-memory-project-general", path: oldSession, owner: "project", mask: "*.md" },
    ],
  };
  const manifest = { schema: "engram.qmd.global-migration.v1", indexPath: join(root, "index.sqlite"), registry, workspaces: [] };
  json(globalManifestPath, manifest);
  json(workerManifestPath, manifest);
  json(join(workspace, "engram.json"), {
    workspace: { id: "project" }, agent: "agent-project",
    qmd: { command: "true", localIndex: false, index: "topic-runtime-test", collection: "project-memory",
      collections: ["project-memory", "domain-project-general", "topic-memory-project-general"],
      globalManifest: globalManifestPath, maintenance: { mode: "coordinated" } },
  });
  json(join(workspace, "memory/domains/registry.json"), { domains: {
    "project-general": { type: "meta-domain", metaDomain: true, topic: { chatId: "-1001", topicId: "1" }, qmdCollections: ["domain-project-general", "topic-memory-project-general"] },
    "project-new": { type: "topic-thread", topic: { chatId: "-1001", topicId: "2" } },
  } });
  json(join(company, "memory/domains/registry.json"), { domains: {
    "company-general": { type: "meta-domain", metaDomain: true, qmdCollections: ["company-memory"] },
  } });
  json(join(company, "engram.json"), { domains: { "company-general": { type: "meta-domain", qmdCollections: ["company-memory"] } } });
  json(join(workspace, "memory-state/memory-observation/projection.json"), {
    schema: "engram.memory-observation-rollout.v4", workspaceId: "project", enabled: true, mode: "canary",
    bindings: [{ runtimeSessionKey: "agent:project:telegram:group:-1001:topic:1", scopeClass: "project",
      scopeId: "domain:project:project-general", requireOwner: false, allowedChannels: ["telegram"],
      topicDomain: { domain: "project-general", chatId: "-1001", topicId: "1" } }],
    pluginDigest: DIGEST,
    inference: { provider: "openai", model: "openai/test", evaluateAfter: "2026-09-01T00:00:00.000Z" },
    limits: { evidenceTtlHours: 72, maxJobs: 1000, maxBytes: 67108864, maxQueueAgeHours: 168, maxAttempts: 2, claimTtlSeconds: 300, maxInferenceCalls: 1 },
    approvedBy: "operator", approvedAt: "2026-09-01T00:00:00.000Z",
    evaluation: { mode: "batch-cron", policyDigest: DIGEST, batch: { sourcePolicyDigest: DIGEST, inactivityGapSeconds: 300,
      maxTurns: 8, maxEvidenceBytes: 262144, maxAgeSeconds: 900, maxInferenceCallsPerRun: 1, schedulerId: "fleet" } },
    consumers: { dailyNote: { mode: "canary", applyAfter: "2026-09-01T00:00:00.000Z", timezone: "Europe/Moscow",
      allowedObservationClasses: ["episodic.event", "episodic.decision"], maxAppliesPerWake: 1,
      qmdBinding: { resolver: "exact-session-registry", manifestPath: workerManifestPath, workspaceRegistryDigest: DIGEST } } },
    captureOwnership: { owner: "observer", effectiveAfter: "2026-09-01T00:00:00.000Z", foregroundDailyNoteCapture: "disabled" },
  });
  const host = { agents: { entries: [{ id: "project", workspace }] }, channels: { telegram: { groups: {
    "-1001": { enabled: true, topics: { "1": { enabled: true, agentId: "project" } } },
  } } } };
  let restartCount = 0;
  const gatewayCall = async (method: string, params: any) => {
    if (method === "config.get") return { hash: "fixture-hash", config: host };
    expect(method).toBe("config.patch");
    expect(params.baseHash).toBe("fixture-hash");
    (host.channels.telegram.groups["-1001"].topics as any)["2"] = params.patch.channels.telegram.groups["-1001"].topics["2"];
    return { ok: true, restartRequired: true, config: host };
  };
  return {
    workspace, company, globalManifestPath, gatewayCall,
    restartGateway: async () => { restartCount += 1; },
    restartCount: () => restartCount,
  };
}

afterEach(() => {
  if (originalCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = originalCacheHome;
  if (root && root.startsWith(tmpdir()) && existsSync(root)) rmSync(root, { recursive: true, force: true });
});

describe("topic-domain runtime", () => {
  test("one call adds the route, exact QMD collections and Memory Worker binding", async () => {
    const f = fixture();
    const result = await ensureTopicDomainRuntime({
      workspace: f.workspace, domain: "project-new", chatId: "-1001", topicId: "2",
      gatewayCall: f.gatewayCall, restartGateway: f.restartGateway,
      registerCollection: async () => ({ ok: true }),
      markDirty: async (input) => ({ schema: "engram.qmd.dirty-mark.v1", status: "marked", mode: "coordinated",
        workspace: input.workspace, collections: input.collections, generation: 1 }),
    });
    expect(result.status).toBe("active");
    expect(result.hostRouteChanged).toBe(true);
    expect(result.gatewayRestarted).toBe(true);
    expect(f.restartCount()).toBe(1);
    expect(result.collections).toEqual(["domain-project-new", "topic-memory-project-new"]);
    const config = read(join(f.workspace, "engram.json"));
    expect(config.qmd.collections).toContain("topic-memory-project-new");
    const global = read(f.globalManifestPath);
    expect(global.registry.collections.find((entry: any) => entry.name === "topic-memory-project-new")?.mask).toBe("*.md");
    expect(global.registry.workspaces.find((entry: any) => entry.id === "company").readableCollections).toContain("topic-memory-project-new");
    const projection = read(join(f.workspace, "memory-state/memory-observation/projection.json"));
    expect(projection.bindings).toHaveLength(2);
    expect(projection.bindings[1].runtimeSessionKey).toBe("agent:project:telegram:group:-1001:topic:2");
    expect(projection.consumers.dailyNote.qmdBinding.manifestPath).toBe(result.qmdManifestPath);
    expect(read(join(f.company, "memory/domains/registry.json")).domains["company-general"].qmdCollections).toContain("topic-memory-project-new");
  });

  test("a repeated call is idempotent and does not restart the gateway", async () => {
    const f = fixture();
    const common = {
      workspace: f.workspace, domain: "project-new", chatId: "-1001", topicId: "2",
      gatewayCall: f.gatewayCall, restartGateway: f.restartGateway,
      registerCollection: async () => ({ ok: true }),
      markDirty: async (input: any) => ({ schema: "engram.qmd.dirty-mark.v1" as const, status: "marked" as const,
        mode: "coordinated" as const, workspace: input.workspace, collections: input.collections, generation: 1 }),
    };
    await ensureTopicDomainRuntime(common);
    const second = await ensureTopicDomainRuntime(common);
    expect(second.status).toBe("already-active");
    expect(f.restartCount()).toBe(1);
    expect(read(join(f.workspace, "memory-state/memory-observation/projection.json")).bindings).toHaveLength(2);
  });
});
