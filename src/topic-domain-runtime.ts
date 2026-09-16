import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { auditQmdGlobalRegistry, type QmdGlobalRegistry } from "./qmd/global-registry.ts";
import { resolveQmdContext } from "./qmd/context.ts";
import { markWorkspaceQmdDirty } from "./qmd/maintenance-integration.ts";
import {
  defineCanaryQmdRuntimeResolver,
  resolveCanaryQmdRuntimeBinding,
} from "./memory-observation/qmd-binding-preflight.ts";
import {
  memoryObservationProjectionPath,
  resolveMemoryObservationProjection,
  type MemoryObservationProjectionV1,
} from "./memory-observation/projection.ts";
import {
  assertTopicDomainRegistry,
  assertTopicHostRoutes,
  configuredTopicBindings,
} from "./memory-observation/topic-bindings.ts";
import { defaultOpenClawCommandExecutor } from "./memory-observation/batch-shadow-openclaw-provider.ts";

type Json = Record<string, any>;
type GatewayResult = Json;
const OPENCLAW_CALL_TIMEOUT_MS = 35_000;
const OPENCLAW_RESTART_TIMEOUT_MS = 30_000;
const OPENCLAW_MAX_BUFFER_BYTES = 8 * 1024 * 1024;

export type TopicDomainRuntimeOptions = {
  workspace: string;
  domain: string;
  chatId: string;
  topicId: string;
  registerCollection: (input: { workspace: string; collection: string; path: string; mask: string }) => Promise<{ ok: boolean; stderr?: string; exitCode?: number }>;
  gatewayCall?: (method: string, params: Json) => Promise<GatewayResult>;
  restartGateway?: () => Promise<void>;
  globalManifestPath?: string;
  markDirty?: typeof markWorkspaceQmdDirty;
};

export type TopicDomainRuntimeResult = {
  status: "active" | "already-active";
  workspaceId: string;
  domain: string;
  runtimeSessionKey: string;
  collections: [string, string];
  hostRouteChanged: boolean;
  gatewayRestarted: boolean;
  projectionPath: string;
  qmdManifestPath: string;
  qmdDirty: string;
};

function readJson(path: string): Json {
  return JSON.parse(readFileSync(path, "utf8"));
}

function body(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function atomicWrite(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const next = body(value);
  if (existsSync(path) && readFileSync(path, "utf8") === next) return;
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, next, { mode: 0o600 });
  renameSync(temp, path);
  if (readFileSync(path, "utf8") !== next) throw new Error(`read-back failed: ${path}`);
}

function union(left: string[] = [], right: string[] = []): string[] {
  return [...new Set([...left, ...right])].sort();
}

function sameTopic(left: unknown, right: { chatId: string; topicId: string }): boolean {
  const value = left as { chatId?: unknown; topicId?: unknown } | null;
  return String(value?.chatId) === right.chatId && String(value?.topicId) === right.topicId;
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function runOpenClaw(args: string[], timeout: number): string {
  const result = defaultOpenClawCommandExecutor("openclaw", args, {
    cwd: process.cwd(),
    timeout,
    maxBuffer: OPENCLAW_MAX_BUFFER_BYTES,
  });
  if (result.error || result.status !== 0 || result.signal !== null) {
    const detail = result.error?.message || result.stderr.trim()
      || `exit=${String(result.status)} signal=${String(result.signal)}`;
    throw new Error(`OpenClaw command failed: ${detail.slice(0, 500)}`);
  }
  return result.stdout;
}

function parseGatewayResult(stdout: string, method: string): GatewayResult {
  const start = stdout.indexOf("{");
  if (start < 0) throw new Error(`OpenClaw ${method} returned invalid JSON`);
  const prefix = stdout.slice(0, start).trim();
  if (prefix && !prefix.split(/\r?\n/).every((line) =>
    line.startsWith("[state-migrations]")
    || line.startsWith("- Skipped plugin doctor state migrations because exclusive state ownership is unavailable:"))) {
    throw new Error(`OpenClaw ${method} returned unexpected non-JSON output`);
  }
  try { return JSON.parse(stdout.slice(start)); }
  catch { throw new Error(`OpenClaw ${method} returned invalid JSON`); }
}

function gatewayCli(method: string, params: Json): GatewayResult {
  const stdout = runOpenClaw([
    "gateway", "call", method, "--json", "--params", JSON.stringify(params), "--timeout", "30000",
  ], OPENCLAW_CALL_TIMEOUT_MS);
  return parseGatewayResult(stdout, method);
}

async function defaultGatewayCall(method: string, params: Json): Promise<GatewayResult> {
  return gatewayCli(method, params);
}

async function defaultRestartGateway(): Promise<void> {
  runOpenClaw(["gateway", "restart"], OPENCLAW_RESTART_TIMEOUT_MS);
}

function hostRoute(config: Json, chatId: string, topicId: string): Json | undefined {
  return config?.channels?.telegram?.groups?.[chatId]?.topics?.[topicId];
}

function assertWorkspaceHost(config: Json, workspace: string, workspaceId: string): void {
  const entries = config?.agents?.entries;
  const agent = Array.isArray(entries)
    ? entries.find((entry: Json) => entry?.id === workspaceId)
    : entries?.[workspaceId];
  if (!agent?.workspace || !samePath(agent.workspace, workspace)) {
    throw new Error("OpenClaw agent/workspace binding is missing or changed");
  }
}

async function ensureHostRoute(input: {
  workspace: string;
  workspaceId: string;
  chatId: string;
  topicId: string;
  gatewayCall: (method: string, params: Json) => Promise<GatewayResult>;
  restartGateway: () => Promise<void>;
}): Promise<{ config: Json; changed: boolean; restarted: boolean }> {
  const first = await input.gatewayCall("config.get", {});
  const firstConfig = first.config;
  if (!firstConfig || typeof first.hash !== "string") throw new Error("OpenClaw config.get read-back is incomplete");
  assertWorkspaceHost(firstConfig, input.workspace, input.workspaceId);
  const current = hostRoute(firstConfig, input.chatId, input.topicId);
  if (current?.enabled === true && current?.agentId === input.workspaceId) {
    return { config: firstConfig, changed: false, restarted: false };
  }
  if (current && current.agentId && current.agentId !== input.workspaceId) {
    throw new Error(`Telegram topic route already belongs to agent ${current.agentId}`);
  }
  const patch = {
    channels: { telegram: { groups: { [input.chatId]: { topics: {
      [input.topicId]: { enabled: true, agentId: input.workspaceId },
    } } } } },
  };
  const applied = await input.gatewayCall("config.patch", { baseHash: first.hash, patch });
  if (applied?.ok !== true) throw new Error("OpenClaw config.patch did not confirm success");
  let restarted = false;
  if (applied.restartRequired === true) {
    await input.restartGateway();
    restarted = true;
  }
  let readBack: GatewayResult | null = null;
  let lastError: unknown = null;
  for (let attempt = 0; attempt < (restarted ? 20 : 1); attempt += 1) {
    try {
      readBack = await input.gatewayCall("config.get", {});
      if (readBack?.config) break;
    } catch (error) { lastError = error; }
    if (restarted) await Bun.sleep(500);
  }
  if (!readBack) throw lastError instanceof Error ? lastError : new Error("OpenClaw config.get after restart failed");
  if (!readBack.config) throw new Error("OpenClaw config.get after patch is incomplete");
  assertWorkspaceHost(readBack.config, input.workspace, input.workspaceId);
  const route = hostRoute(readBack.config, input.chatId, input.topicId);
  if (route?.enabled !== true || route?.agentId !== input.workspaceId) {
    throw new Error("OpenClaw topic route read-back failed");
  }
  return { config: readBack.config, changed: true, restarted };
}

function manifestRegistry(manifest: Json): QmdGlobalRegistry {
  const registry = manifest?.registry;
  const audit = auditQmdGlobalRegistry(registry);
  if (!audit.ok) throw new Error(`QMD registry is invalid: ${audit.findings.filter((item) => item.severity === "error").map((item) => item.code).join(",")}`);
  return registry;
}

function locateGlobalManifest(workspace: string, config: Json, workerManifest: Json, explicit?: string): string {
  const configured = explicit || config?.qmd?.globalManifest;
  if (typeof configured === "string" && configured.trim()) {
    const path = resolve(configured);
    if (!existsSync(path)) throw new Error(`QMD global manifest is missing: ${path}`);
    return path;
  }
  const registry = manifestRegistry(workerManifest);
  const main = registry.workspaces.find((entry) => entry.id === "main");
  const candidate = main ? join(main.path, "ops", "qmd-global-migration", "migration.json") : "";
  if (!candidate || !existsSync(candidate)) {
    throw new Error(`QMD global manifest is not configured for ${workspace}`);
  }
  return resolve(candidate);
}

function ancestorsOf(registry: QmdGlobalRegistry, workspaceId: string): Set<string> {
  const byId = new Map(registry.workspaces.map((entry) => [entry.id, entry]));
  const result = new Set<string>();
  const pending = [...(byId.get(workspaceId)?.parents ?? [])];
  while (pending.length) {
    const id = pending.pop()!;
    if (result.has(id)) continue;
    result.add(id);
    pending.push(...(byId.get(id)?.parents ?? []));
  }
  return result;
}

function addCollection(registry: QmdGlobalRegistry, collection: { name: string; path: string; owner: string; mask: string }): void {
  const matches = registry.collections.filter((entry) => entry.name === collection.name || samePath(entry.path, collection.path));
  const equivalent = matches.length === 1
    && matches[0].name === collection.name
    && samePath(matches[0].path, collection.path)
    && matches[0].owner === collection.owner
    && matches[0].mask === collection.mask;
  if (matches.length > 1 || (matches.length === 1 && !equivalent)) {
    throw new Error(`QMD collection collision: ${collection.name}`);
  }
  if (!matches.length) registry.collections.push(collection);
}

function updateMetaDomains(workspacePath: string, collections: string[]): Array<{ path: string; value: Json }> {
  const registryPath = join(workspacePath, "memory", "domains", "registry.json");
  if (!existsSync(registryPath)) return [];
  const registry = readJson(registryPath);
  let changed = false;
  for (const entry of Object.values<Json>(registry.domains ?? {})) {
    if ((entry.type !== "meta-domain" && entry.metaDomain !== true) || entry.archived === true || entry.enabled === false) continue;
    const next = union(entry.qmdCollections ?? [], collections);
    if (JSON.stringify(next) !== JSON.stringify(entry.qmdCollections ?? [])) {
      entry.qmdCollections = next;
      changed = true;
    }
  }
  if (!changed) return [];
  const changes = [{ path: registryPath, value: registry }];
  const configPath = join(workspacePath, "engram.json");
  if (existsSync(configPath)) {
    const config = readJson(configPath);
    for (const [name, entry] of Object.entries<Json>(registry.domains ?? {})) {
      if (config.domains?.[name] && Array.isArray(entry.qmdCollections)) {
        config.domains[name].qmdCollections = entry.qmdCollections;
      }
    }
    changes.push({ path: configPath, value: config });
  }
  return changes;
}

function snapshotName(workerManifestPath: string, manifest: Json): string {
  const digest = createHash("sha256").update(body(manifest)).digest("hex").slice(0, 16);
  return join(dirname(workerManifestPath), `qmd-manifest.${digest}.json`);
}

function activeAlready(projection: MemoryObservationProjectionV1, domain: string, chatId: string, topicId: string): boolean {
  return projection.bindings.some((binding) => binding.topicDomain?.domain === domain
    && binding.topicDomain.chatId === chatId && binding.topicDomain.topicId === topicId);
}

export function hasActiveTopicMemoryWorker(workspace: string): boolean {
  const path = memoryObservationProjectionPath(workspace);
  if (!existsSync(path)) return false;
  try {
    const projection = readJson(path);
    return projection.enabled === true
      && ["engram.memory-observation-rollout.v4", "engram.memory-observation-rollout.v5"].includes(projection.schema);
  } catch { return false; }
}

export async function ensureTopicDomainRuntime(options: TopicDomainRuntimeOptions): Promise<TopicDomainRuntimeResult> {
  const workspace = resolve(options.workspace);
  const configPath = join(workspace, "engram.json");
  const config = readJson(configPath);
  const workspaceId = String(config.workspace?.id || config.agent || "").replace(/^agent-/, "");
  if (!workspaceId || workspaceId === "main") throw new Error("topic-domain runtime requires an existing non-main workspace");
  const topic = { chatId: String(options.chatId), topicId: String(options.topicId) };
  const domainRegistry = readJson(join(workspace, "memory", "domains", "registry.json"));
  const entry = domainRegistry.domains?.[options.domain];
  if (!entry || !sameTopic(entry.topic, topic) || !["topic-thread", "meta-domain"].includes(entry.type)) {
    throw new Error("topic domain registry entry is missing or changed");
  }
  const projection = resolveMemoryObservationProjection({ workspace, workspaceId });
  if (projection.schema !== "engram.memory-observation-rollout.v4") {
    throw new Error(projection.schema === "engram.memory-observation-rollout.v5"
      ? "group-direct workspace does not support Telegram topics"
      : "workspace is not connected to the topic Memory Worker fleet");
  }
  if (projection.bindings.length >= 20 && !activeAlready(projection, options.domain, topic.chatId, topic.topicId)) {
    throw new Error("workspace already has the maximum 20 Memory Worker bindings");
  }
  const qmdBinding = projection.consumers?.dailyNote.qmdBinding;
  if (!qmdBinding || !("resolver" in qmdBinding) || qmdBinding.resolver !== "exact-session-registry") {
    throw new Error("Memory Worker projection has no exact-session QMD resolver");
  }
  const workerManifest = readJson(qmdBinding.manifestPath);
  const globalManifestPath = locateGlobalManifest(workspace, config, workerManifest, options.globalManifestPath);
  const globalManifest = readJson(globalManifestPath);
  const registry = manifestRegistry(globalManifest);
  const owner = registry.workspaces.find((item) => item.id === workspaceId && samePath(item.path, workspace));
  if (!owner) throw new Error("workspace is missing from the QMD global registry");

  const gatewayCall = options.gatewayCall ?? defaultGatewayCall;
  const restartGateway = options.restartGateway ?? defaultRestartGateway;
  const host = await ensureHostRoute({ workspace, workspaceId, ...topic, gatewayCall, restartGateway });

  const lockPath = `${globalManifestPath}.project-provision.lock`;
  const lock = openSync(lockPath, "wx", 0o600);
  try {
    const currentProjection = resolveMemoryObservationProjection({ workspace, workspaceId });
    if (currentProjection.schema !== "engram.memory-observation-rollout.v4") {
      throw new Error("topic Memory Worker projection changed during setup");
    }
    if (currentProjection.bindings.length >= 20 && !activeAlready(currentProjection, options.domain, topic.chatId, topic.topicId)) {
      throw new Error("workspace already has the maximum 20 Memory Worker bindings");
    }
    const currentQmdBinding = currentProjection.consumers?.dailyNote.qmdBinding;
    if (!currentQmdBinding || !("resolver" in currentQmdBinding) || currentQmdBinding.resolver !== "exact-session-registry") {
      throw new Error("Memory Worker exact-session QMD resolver changed during setup");
    }
    const freshGlobalManifest = readJson(globalManifestPath);
    const freshRegistry = manifestRegistry(freshGlobalManifest);
    const freshOwner = freshRegistry.workspaces.find((item) => item.id === workspaceId && samePath(item.path, workspace));
    if (!freshOwner) throw new Error("workspace changed in the QMD global registry");

    const sessionKey = `telegram-group--${topic.chatId.replace(/^-/, "")}-topic-${topic.topicId}`;
    const runtimeSessionKey = `agent:${workspaceId}:telegram:group:${topic.chatId}:topic:${topic.topicId}`;
    const sessionPath = join(workspace, "memory", `agent-${workspaceId}`, sessionKey);
    mkdirSync(sessionPath, { recursive: true });
    const domainCollection = `domain-${options.domain}`;
    const memoryCollection = `topic-memory-${options.domain}`;
    const collections: [string, string] = [domainCollection, memoryCollection];
    const domainPath = join(workspace, "memory", "domains", options.domain);
    addCollection(freshRegistry, { name: domainCollection, path: domainPath, owner: workspaceId, mask: "**/*.md" });
    addCollection(freshRegistry, { name: memoryCollection, path: sessionPath, owner: workspaceId, mask: "*.md" });
    freshOwner.readableCollections = union(freshOwner.readableCollections, collections);
    const ancestors = ancestorsOf(freshRegistry, workspaceId);
    for (const item of freshRegistry.workspaces) {
      if (ancestors.has(item.id)) item.readableCollections = union(item.readableCollections, collections);
    }
    const audit = auditQmdGlobalRegistry(freshRegistry);
    if (!audit.ok) throw new Error(`QMD registry update is invalid: ${audit.findings.filter((item) => item.severity === "error").map((item) => item.code).join(",")}`);

    for (const item of [
      { collection: domainCollection, path: domainPath, mask: "**/*.md" },
      { collection: memoryCollection, path: sessionPath, mask: "*.md" },
    ]) {
      const result = await options.registerCollection({ workspace, ...item });
      if (!result.ok) throw new Error(`QMD collection registration failed (${item.collection}): ${result.stderr?.trim() || result.exitCode || "unknown error"}`);
    }

    const nextConfig = structuredClone(config);
    nextConfig.qmd.collections = union(nextConfig.qmd.collections ?? [], collections);
    if (!nextConfig.qmd.globalManifest) nextConfig.qmd.globalManifest = globalManifestPath;
    const localMetaChanges = updateMetaDomains(workspace, collections);
    const localConfigChange = localMetaChanges.find((change) => change.path === configPath);
    if (localConfigChange?.value?.domains) nextConfig.domains = localConfigChange.value.domains;
    const upperMetaChanges = [...ancestors]
      .map((id) => freshRegistry.workspaces.find((item) => item.id === id))
      .filter(Boolean)
      .flatMap((item) => updateMetaDomains(item!.path, collections));

    const nextWorkerManifest = structuredClone(freshGlobalManifest);
    const nextWorkerManifestPath = snapshotName(currentQmdBinding.manifestPath, nextWorkerManifest);
    atomicWrite(globalManifestPath, freshGlobalManifest);
    atomicWrite(configPath, nextConfig);
    for (const change of [...localMetaChanges.filter((item) => item.path !== configPath), ...upperMetaChanges]) atomicWrite(change.path, change.value);
    atomicWrite(nextWorkerManifestPath, nextWorkerManifest);

    const context = resolveQmdContext({ value: workspace, source: "explicit" });
    const nextResolver = defineCanaryQmdRuntimeResolver({
      workspace,
      workspaceId,
      manifestPath: nextWorkerManifestPath,
      context,
    });
    const newBinding = configuredTopicBindings(host.config, workspace, workspaceId, [options.domain])[0]!;
    const existing = currentProjection.bindings.filter((binding) => binding.runtimeSessionKey !== runtimeSessionKey);
    const nextProjection: MemoryObservationProjectionV1 = {
      ...currentProjection,
      schema: "engram.memory-observation-rollout.v4",
      bindings: [...existing, newBinding].sort((left, right) => left.runtimeSessionKey.localeCompare(right.runtimeSessionKey)),
      consumers: {
        ...currentProjection.consumers!,
        dailyNote: { ...currentProjection.consumers!.dailyNote, qmdBinding: nextResolver },
      },
    };
    const wasActive = activeAlready(currentProjection, options.domain, topic.chatId, topic.topicId)
      && JSON.stringify(currentQmdBinding) === JSON.stringify(nextResolver);
    atomicWrite(memoryObservationProjectionPath(workspace), nextProjection);

    const readBack = resolveMemoryObservationProjection({ workspace, workspaceId, expectedPluginDigest: currentProjection.pluginDigest });
    assertTopicDomainRegistry(workspace, workspaceId, readBack.bindings);
    assertTopicHostRoutes(host.config, workspace, workspaceId, readBack.bindings);
    for (const binding of readBack.bindings) {
      resolveCanaryQmdRuntimeBinding({
        workspace,
        runtimeSessionKey: binding.runtimeSessionKey,
        timezone: readBack.consumers!.dailyNote.timezone,
        destinationAt: readBack.consumers!.dailyNote.applyAfter,
        resolver: nextResolver,
        context,
      });
    }
    const dirty = await (options.markDirty ?? markWorkspaceQmdDirty)({
      workspace,
      collections,
      reason: `topic-domain:${options.domain}:configured`,
    });
    if (dirty.status !== "marked") throw new Error(`QMD dirty mark failed: ${dirty.error || dirty.status}`);
    return {
      status: wasActive && !host.changed ? "already-active" : "active",
      workspaceId,
      domain: options.domain,
      runtimeSessionKey,
      collections,
      hostRouteChanged: host.changed,
      gatewayRestarted: host.restarted,
      projectionPath: memoryObservationProjectionPath(workspace),
      qmdManifestPath: nextWorkerManifestPath,
      qmdDirty: dirty.status,
    };
  } finally {
    closeSync(lock);
    unlinkSync(lockPath);
  }
}
