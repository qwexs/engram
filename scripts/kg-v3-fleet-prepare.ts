#!/usr/bin/env bun
import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import {
  currentKgCanaryReleaseDigest,
  deriveKgOperationId,
  kgCanaryDigest,
  validateKgRegistry,
  type KgCanaryManifestV1,
  type KgKind,
  type KgRegistryV1,
  type KgWriteRequest,
} from "../src/kg-v3/index.ts";
import type { KgRuntimeGrantRegistryV1 } from "../src/kg-v3/trusted-runtime.ts";

interface SeedSpecV1 {
  schema: "engram.kg-v3-fleet-seed-spec.v1";
  workspaceId: string;
  seeds: Array<{
    entityId: string;
    entityType: string;
    scope: string[];
    predicate: string;
    kind: KgKind;
    value: string;
    seedKey?: string;
    replacesId?: string;
    v2FactId?: string;
    expectedV2Text?: string;
  }>;
}

const first = process.argv[2];
const command = first && !first.startsWith("--") ? first : "plan";
const args = process.argv.slice(command === "plan" && first?.startsWith("--") ? 2 : 3);
const value = (flag: string) => { const at = args.indexOf(flag); return at >= 0 ? args[at + 1] : undefined; };
const has = (flag: string) => args.includes(flag);

const workspace = resolve(value("--workspace") || "");
const workspaceId = value("--workspace-id") || "";
const seedSpecPath = resolve(value("--seed-spec") || "");
const approvedBy = value("--approved-by") || "";
const approvedAt = value("--approved-at") || new Date().toISOString();
const liveSessionKey = value("--live-session-key") || null;
const livePrincipalId = value("--live-principal-id") || null;
const liveActorId = value("--live-actor-id") || null;
if (!workspace || !workspaceId || !value("--seed-spec") || !approvedBy) throw new Error("--workspace, --workspace-id, --seed-spec, and --approved-by are required");
if ([liveSessionKey, livePrincipalId, liveActorId].filter(Boolean).length !== 0 && [liveSessionKey, livePrincipalId, liveActorId].filter(Boolean).length !== 3) throw new Error("live ingress requires --live-session-key, --live-principal-id, and --live-actor-id together");

function readObject<T>(path: string): T {
  const target = resolve(path);
  const rel = relative(workspace, target);
  if (!rel || rel.startsWith("..")) throw new Error(`path escapes workspace: ${path}`);
  const parsed = JSON.parse(readFileSync(target, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${path} must contain an object`);
  return parsed as T;
}

function atomicJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  const fd = openSync(temporary, "wx", 0o600);
  try { writeFileSync(fd, `${JSON.stringify(data, null, 2)}\n`, "utf8"); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, path);
}

const seedSpec = readObject<SeedSpecV1>(seedSpecPath);
if (seedSpec.schema !== "engram.kg-v3-fleet-seed-spec.v1" || seedSpec.workspaceId !== workspaceId || !Array.isArray(seedSpec.seeds) || seedSpec.seeds.length === 0) throw new Error("invalid fleet seed spec identity or empty seed set");
const entities = new Map<string, KgRegistryV1["entities"][number]>();
for (const seed of seedSpec.seeds) {
  if (!seed.entityId || !seed.entityType || !seed.predicate || !seed.value || !Array.isArray(seed.scope) || seed.scope.length === 0) throw new Error("invalid fleet seed entry");
  const prior = entities.get(seed.entityId);
  if (prior && (prior.type !== seed.entityType || JSON.stringify(prior.scopes) !== JSON.stringify(seed.scope))) throw new Error(`entity declaration drift: ${seed.entityId}`);
  const entity = prior || { id: seed.entityId, type: seed.entityType, scopes: [...seed.scope], predicates: [] };
  if (entity.predicates.some((item) => item.name === seed.predicate)) throw new Error(`duplicate current key in seed spec: ${seed.entityId}/${seed.predicate}`);
  entity.predicates.push({ name: seed.predicate, kinds: [seed.kind], objectTypes: ["string"] });
  entities.set(seed.entityId, entity);
}
const registry: KgRegistryV1 = { schema: "engram.kg-v3-registry.v1", workspaceId, revision: 1, entities: [...entities.values()] };
validateKgRegistry(registry, workspaceId);
const seedSessionKey = "fleet-seed";
const seedActorId = "operator";
const seedRequests: KgWriteRequest[] = seedSpec.seeds.map((seed, index) => {
  const messageId = seed.seedKey || `fleet-seed-${index + 1}`;
  return {
    assertion: {
      workspaceId,
      entityId: seed.entityId,
      entityType: seed.entityType,
      kind: seed.kind,
      predicate: seed.predicate,
      object: { type: "string", value: seed.value },
      scope: [...seed.scope],
      replacesId: seed.replacesId || null,
      provenance: {
        sourceKind: "operator-curated",
        sessionKey: seedSessionKey,
        messageId,
        actorId: seedActorId,
        operationId: deriveKgOperationId({ workspaceId, sessionKey: seedSessionKey, messageId, actorId: seedActorId, entityId: seed.entityId, predicate: seed.predicate }),
        observedAt: approvedAt,
      },
    },
    intent: { explicit: true, compound: false, store: "kg-current", statementClass: "durable" },
  };
});
const runtimeGrants: KgRuntimeGrantRegistryV1 = {
  schema: "engram.kg-v3-runtime-grants.v1",
  workspaceId,
  revision: 1,
  principals: liveSessionKey && livePrincipalId && liveActorId ? [{ principalId: livePrincipalId, bindings: [{ transport: "telegram", actorId: liveActorId }], grants: [{ sessionKey: liveSessionKey, capabilities: ["kg:v3:write", "kg:v3:retract"] }] }] : [],
};
const releaseDigest = currentKgCanaryReleaseDigest();
const approvedOperationIds = seedRequests.map((request) => request.assertion.provenance.operationId);
const manifest: KgCanaryManifestV1 = {
  schema: "engram.kg-v3-canary.v1",
  rolloutPhase: "fleet",
  workspaceId,
  releaseDigest,
  registryDigest: kgCanaryDigest(registry),
  seedManifestDigest: kgCanaryDigest(seedRequests),
  explicitRequestManifestDigest: kgCanaryDigest([]),
  runtimeGrantsDigest: kgCanaryDigest(runtimeGrants),
  seedRequests,
  explicitRequests: [],
  humanApprovedOperationIds: approvedOperationIds,
  benchmark: {
    schema: "engram.kg-v3-benchmark.v1",
    workspaceId,
    essential: seedSpec.seeds.map((seed, index) => ({ id: `essential-${index + 1}`, entityId: seed.entityId, predicate: seed.predicate, expectedObject: { type: "string", value: seed.value }, ...(seed.v2FactId && seed.expectedV2Text ? { v2FactId: seed.v2FactId, expectedV2Text: seed.expectedV2Text } : {}) })),
    baselineDefaultContext: { sources: ["life/_derived/facts-active.md"], archiveIncludedInDefault: true },
    proposedDefaultContext: { sources: ["life/v3/current-summary.md"], archiveIncludedInDefault: false },
    humanApprovedOperationIds: approvedOperationIds,
  },
  enabledSessionCapabilities: [
    { sessionKey: seedSessionKey, capabilities: ["kg:v3:seed"] },
    ...(liveSessionKey ? [{ sessionKey: liveSessionKey, capabilities: ["kg:v3:write" as const, "kg:v3:retract" as const] }] : []),
  ],
  approvedBy,
  approvedAt,
};
const stateRoot = join(workspace, "memory-state", "kg-v3");
const output = {
  schema: "engram.kg-v3-fleet-prepare-plan.v1",
  workspaceId,
  releaseDigest,
  seedCount: seedRequests.length,
  liveIngress: Boolean(liveSessionKey),
  registryDigest: manifest.registryDigest,
  manifestDigest: kgCanaryDigest(manifest),
  runtimeGrantsDigest: manifest.runtimeGrantsDigest,
  outputs: [join(stateRoot, "registry.json"), join(stateRoot, "runtime-grants.json"), join(stateRoot, "canary-manifest.json")],
  mutatesWorkspace: command === "apply",
};
if (command === "plan") console.log(JSON.stringify({ ...output, mutatesWorkspace: false }, null, 2));
else if (command === "apply") {
  if (!has("--ack-fleet-prepare")) throw new Error("apply requires --ack-fleet-prepare");
  atomicJson(join(stateRoot, "registry.json"), registry);
  atomicJson(join(stateRoot, "runtime-grants.json"), runtimeGrants);
  atomicJson(join(stateRoot, "canary-manifest.json"), manifest);
  console.log(JSON.stringify(output, null, 2));
} else throw new Error("command must be plan or apply");
