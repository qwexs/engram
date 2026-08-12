import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import type { KgObject } from "./types.ts";
import type { KgV3Reader } from "./reader.ts";

export interface EssentialFactV1 {
  id: string;
  entityId: string;
  predicate: string;
  expectedObject: KgObject;
  v2FactId?: string;
  expectedV2Text?: string;
}

export interface KgBenchmarkContextV1 {
  sources: string[];
  embeddedBodies?: string[];
  archiveIncludedInDefault: boolean;
}

export interface KgBenchmarkManifestV1 {
  schema: "engram.kg-v3-benchmark.v1";
  workspaceId: string;
  essential: EssentialFactV1[];
  baselineDefaultContext: KgBenchmarkContextV1;
  proposedDefaultContext: KgBenchmarkContextV1;
  humanApprovedOperationIds: string[];
}

export interface KgBenchmarkReportV1 {
  schema: "engram.kg-v3-benchmark-report.v1";
  workspaceId: string;
  total: number;
  baselineRecallPercent: number;
  v3RecallPercent: number;
  v3AccuracyPercent: number;
  recallRegressionPoints: number;
  baselineFootprintBytes: number;
  v3FootprintBytes: number;
  footprintReductionPercent: number;
  archiveLeakage: boolean;
  provenanceCompletenessPercent: number;
  humanApprovedPercent: number;
  gates: { accuracy: boolean; recall: boolean; footprint: boolean; uniqueCurrent: boolean; noArchiveLeakage: boolean; provenance: boolean; humanApproval: boolean; passed: boolean };
}

function equal(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validContext(context: unknown): context is KgBenchmarkContextV1 {
  const value = context as KgBenchmarkContextV1;
  return Boolean(value && Array.isArray(value.sources)
    && value.sources.every((source) => typeof source === "string" && source.length > 0)
    && (value.embeddedBodies === undefined || (Array.isArray(value.embeddedBodies) && value.embeddedBodies.every((body) => typeof body === "string")))
    && typeof value.archiveIncludedInDefault === "boolean");
}

function projectionSnapshot(workspace: string, context: KgBenchmarkContextV1): { bodies: string[]; bytes: number } {
  const lexicalRoot = resolve(workspace);
  const realRoot = realpathSync(lexicalRoot);
  const bodies: string[] = [];
  let bytes = 0;
  for (const source of context.sources) {
    const lexicalPath = resolve(lexicalRoot, source);
    const lexicalRelative = relative(lexicalRoot, lexicalPath);
    if (!lexicalRelative || lexicalRelative.startsWith("..")) throw new Error(`benchmark context source escapes workspace: ${source}`);
    if (!existsSync(lexicalPath)) throw new Error(`benchmark context source is missing: ${source}`);
    const realPath = realpathSync(lexicalPath);
    const realRelative = relative(realRoot, realPath);
    if (!realRelative || realRelative.startsWith("..")) throw new Error(`benchmark context source symlink escapes workspace: ${source}`);
    if (!statSync(realPath).isFile()) throw new Error(`benchmark context source is not a file: ${source}`);
    const body = readFileSync(realPath);
    bytes += body.byteLength;
    bodies.push(body.toString("utf8"));
  }
  for (const body of context.embeddedBodies || []) {
    bytes += Buffer.byteLength(body);
    bodies.push(body);
  }
  return { bodies, bytes };
}

export function defaultContextArchiveLeakage(context: KgBenchmarkContextV1): boolean {
  if (!validContext(context) || context.archiveIncludedInDefault !== false || context.sources.length !== 1 || context.sources[0] !== "life/v3/current-summary.md") return true;
  const searchable = [...context.sources, ...(context.embeddedBodies || [])].join("\n").toLowerCase();
  return /items\.json|\blife\/(?!v3\/)|\bv2\b|historical[ -]?(archive|fact)|archive[ -]?fact/.test(searchable);
}

export async function runKgV3Benchmark(options: { workspace: string; workspaceId: string; reader: KgV3Reader; manifest: KgBenchmarkManifestV1 }): Promise<KgBenchmarkReportV1> {
  const manifest = options.manifest;
  if (manifest.schema !== "engram.kg-v3-benchmark.v1" || manifest.workspaceId !== options.workspaceId || !Array.isArray(manifest.essential) || manifest.essential.length === 0 || !validContext(manifest.baselineDefaultContext) || !validContext(manifest.proposedDefaultContext)) throw new Error("invalid KG v3 benchmark manifest");
  if (manifest.proposedDefaultContext.sources.length !== 1 || manifest.proposedDefaultContext.sources[0] !== "life/v3/current-summary.md") throw new Error("KG v3 benchmark proposed source set must be exactly life/v3/current-summary.md");
  const baselineSnapshot = projectionSnapshot(options.workspace, manifest.baselineDefaultContext);
  const proposedSnapshot = projectionSnapshot(options.workspace, manifest.proposedDefaultContext);
  const current = await options.reader.current();
  const keys = current.map((item) => `${item.entityId}\0${item.predicate}`);
  const uniqueCurrent = new Set(keys).size === keys.length;
  if (!uniqueCurrent) throw new Error("KG v3 benchmark detected duplicate current keys");
  let baselineRecall = 0;
  let v3Recall = 0;
  let v3Correct = 0;
  let provenanceComplete = 0;
  let humanApproved = 0;
  for (const essential of manifest.essential) {
    if (essential.v2FactId && essential.expectedV2Text) {
      const historical = options.reader.historicalV2(essential.entityId).find((fact) => fact.id === essential.v2FactId);
      if (historical && historical.fact === essential.expectedV2Text) baselineRecall += 1;
    }
    const assertion = current.find((item) => item.entityId === essential.entityId && item.predicate === essential.predicate);
    if (assertion) {
      v3Recall += 1;
      if (equal(assertion.object, essential.expectedObject)) v3Correct += 1;
      const provenance = assertion.provenance;
      if (provenance?.sourceKind && provenance.sessionKey && provenance.messageId && provenance.actorId && /^sha256:[a-f0-9]{64}$/.test(provenance.operationId) && Number.isFinite(Date.parse(provenance.observedAt))) provenanceComplete += 1;
      if (manifest.humanApprovedOperationIds.includes(provenance.operationId)) humanApproved += 1;
    }
  }
  const total = manifest.essential.length;
  const percent = (value: number) => Number(((value / total) * 100).toFixed(2));
  const baselineRecallPercent = percent(baselineRecall);
  const v3RecallPercent = percent(v3Recall);
  const v3AccuracyPercent = percent(v3Correct);
  const baselineFootprintBytes = baselineSnapshot.bytes;
  const v3FootprintBytes = proposedSnapshot.bytes;
  const footprintReductionPercent = baselineFootprintBytes === 0 ? 0 : Number(((1 - v3FootprintBytes / baselineFootprintBytes) * 100).toFixed(2));
  const recallRegressionPoints = Number((baselineRecallPercent - v3RecallPercent).toFixed(2));
  const archiveLeakage = defaultContextArchiveLeakage({ ...manifest.proposedDefaultContext, embeddedBodies: proposedSnapshot.bodies });
  const provenanceCompletenessPercent = percent(provenanceComplete);
  const humanApprovedPercent = percent(humanApproved);
  const gates = {
    accuracy: v3AccuracyPercent >= 95,
    recall: recallRegressionPoints <= 5,
    footprint: footprintReductionPercent >= 70,
    uniqueCurrent,
    noArchiveLeakage: !archiveLeakage,
    provenance: provenanceCompletenessPercent === 100,
    humanApproval: humanApprovedPercent >= 95,
    passed: false,
  };
  gates.passed = gates.accuracy && gates.recall && gates.footprint && gates.uniqueCurrent && gates.noArchiveLeakage && gates.provenance && gates.humanApproval;
  return { schema: "engram.kg-v3-benchmark-report.v1", workspaceId: options.workspaceId, total, baselineRecallPercent, v3RecallPercent, v3AccuracyPercent, recallRegressionPoints, baselineFootprintBytes, v3FootprintBytes, footprintReductionPercent, archiveLeakage, provenanceCompletenessPercent, humanApprovedPercent, gates };
}
