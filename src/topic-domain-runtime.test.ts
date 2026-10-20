import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureTopicDomainRuntime } from "./topic-domain-runtime.ts";
import { sha256 } from "./memory-observation/ledger.ts";
import { readModelTransition } from "./memory-observation/model-transition.ts";

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
  test("non-main topic creation archives a completed model migration and repeat stays readable", async () => {
    const f = fixture();
    const projectionPath = join(f.workspace, "memory-state/memory-observation/projection.json");
    const before = read(projectionPath), old = structuredClone(before);
    old.inference.model = "openai/previous"; old.pluginDigest = sha256("previous-plugin"); old.evaluation.policyDigest = sha256("previous-policy");
    const body = { schema: "engram.memory-model-transition.v1", targetProjectionDigest: sha256(before),
      previousProjection: old, previousQuality: null, approvedBy: "operator", approvedAt: before.approvedAt };
    const transition = { ...body, digest: sha256(body) };
    const transitionPath = join(f.workspace, "memory-state/memory-observation/model-transition.json");
    json(transitionPath, transition);
    const common = { workspace: f.workspace, domain: "project-new", chatId: "-1001", topicId: "2",
      gatewayCall: f.gatewayCall, restartGateway: f.restartGateway, registerCollection: async () => ({ ok: true }),
      markDirty: async (input: any) => ({ schema: "engram.qmd.dirty-mark.v1" as const, status: "marked" as const,
        mode: "coordinated" as const, workspace: input.workspace, collections: input.collections, generation: 1 }) };
    const first = await ensureTopicDomainRuntime(common), after = read(projectionPath);
    expect(first.status).toBe("active");
    expect(after.bindings).toHaveLength(2);
    expect(after.inference).toEqual(before.inference);
    expect(after.evaluation).toEqual(before.evaluation);
    expect(after.captureOwnership).toEqual(before.captureOwnership);
    expect(readModelTransition(f.workspace, after)).toBeNull();
    expect(read(join(f.workspace, "memory-state/memory-observation/model-transition-history", transition.digest.slice(7) + ".json"))).toEqual(transition);
    expect((await ensureTopicDomainRuntime(common)).status).toBe("already-active");
  });

  test("pending model work rejects non-main topic setup before host, QMD or configuration mutations", async () => {
    const f = fixture();
    const projectionPath = join(f.workspace, "memory-state/memory-observation/projection.json");
    const before = read(projectionPath), old = structuredClone(before); old.inference.model = "openai/previous";
    const body = { schema: "engram.memory-model-transition.v1", targetProjectionDigest: sha256(before),
      previousProjection: old, previousQuality: null, approvedBy: "operator", approvedAt: before.approvedAt };
    json(join(f.workspace, "memory-state/memory-observation/model-transition.json"), { ...body, digest: sha256(body) });
    json(join(f.workspace, "memory-state/memory-observation/v1/queues/evaluator/pending.json"), { traceId: sha256("source"), status: "queued" });
    const manifestBefore = readFileSync(f.globalManifestPath, "utf8");
    await expect(ensureTopicDomainRuntime({ workspace: f.workspace, domain: "project-new", chatId: "-1001", topicId: "2",
      gatewayCall: async () => { throw Error("host mutation must not run"); },
      registerCollection: async () => { throw Error("QMD mutation must not run"); },
    })).rejects.toThrow("MODEL_TRANSITION_DRAIN_REQUIRED");
    expect(read(projectionPath)).toEqual(before);
    expect(readFileSync(f.globalManifestPath, "utf8")).toBe(manifestBefore);
    expect(existsSync(join(f.workspace, "memory-state/memory-observation/model-transition.json"))).toBe(true);
  });

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

test("main addition retains family, epoch, scheduler and model lineage; repeat is idempotent", async () => {
  const f = fixture();
  const cfgPath = join(f.workspace, "engram.json"), regPath = join(f.workspace, "memory/domains/registry.json");
  const projPath = join(f.workspace, "memory-state/memory-observation/projection.json");
  const cfg = read(cfgPath); cfg.workspace.id = "main"; cfg.agent = "agent-main"; json(cfgPath, cfg);
  const manifest = read(f.globalManifestPath);
  manifest.registry.workspaces = manifest.registry.workspaces.filter((w: any) => w.id !== "main");
  manifest.registry.collections = manifest.registry.collections.filter((c: any) => c.owner !== "main");
  const owner = manifest.registry.workspaces.find((w: any) => w.id === "project"); owner.id = "main"; owner.kind = "technical"; owner.parents = [];
  for (const col of manifest.registry.collections) if (col.owner === "project") col.owner = "main";
  json(f.globalManifestPath, manifest);
  const before = read(projPath); before.schema = "engram.memory-observation-rollout.v3"; before.workspaceId = "main";
  before.bindings = [{ runtimeSessionKey: "agent:main:*", scopeClass: "self", scopeId: "workspace:main", requireOwner: true, allowedChannels: ["telegram", "openclaw"] }];
  json(before.consumers.dailyNote.qmdBinding.manifestPath, manifest); json(projPath, before);
  const registry = read(regPath); registry.domains["project-new"].pending = true; json(regPath, registry);
  const host: any = { agents: { entries: { main: { workspace: f.workspace } } }, channels: { telegram: { groups: {
    "-1001": { enabled: true, topics: { "2": { enabled: true, agentId: "main" } } },
  } } } };
  const common = { workspace: f.workspace, domain: "project-new", chatId: "-1001", topicId: "2",
    gatewayCall: async () => ({ config: host, hash: "test" }), registerCollection: async () => ({ ok: true }),
    markDirty: async (input: any) => ({ schema: "engram.qmd.dirty-mark.v1" as const, status: "marked" as const, mode: "coordinated" as const, workspace: input.workspace, collections: input.collections, generation: 1 }) };
  const envelope = join(f.workspace, "memory-state/memory-observation/v1/envelopes/test.json");
  const queue = join(f.workspace, "memory-state/memory-observation/v1/queues/evaluator/test.json");
  json(envelope, {traceId:"old",scope:{runtimeSessionKey:"agent:main:telegram:group:-1001:topic:2",scopeClass:"self",scopeId:"workspace:main"}});
  json(queue, {traceId:"old",status:"queued"});
  await expect(ensureTopicDomainRuntime(common)).rejects.toThrow("pending family evaluator work");
  expect(read(projPath)).toEqual(before);
  json(queue, {traceId:"old",status:"terminal"});
  const result = await ensureTopicDomainRuntime(common);
  expect(result.status).toBe("active");
  const after = read(projPath);
  expect(after.schema).toBe("engram.memory-observation-rollout.v6");
  expect(after.bindings).toHaveLength(2); expect(after.bindings).toContainEqual(before.bindings[0]);
  expect(after.evaluation).toEqual(before.evaluation); expect(after.inference).toEqual(before.inference);
  expect(after.captureOwnership).toEqual(before.captureOwnership);
  expect(read(regPath).domains["project-new"].pending).toBeUndefined();
  const global = read(f.globalManifestPath);
  expect(global.registry.workspaces.find((w: any) => w.id === "main").readableCollections).not.toContain("company-memory");
  expect((await ensureTopicDomainRuntime(common)).status).toBe("already-active");
  expect(read(projPath)).toEqual(after);
});
