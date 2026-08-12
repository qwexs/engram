import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import type { KgAssertionV3, KgObject } from "./types.ts";
import type { KgV3Reader } from "./reader.ts";

export interface EssentialFactV1 {
  id: string;
  entityId: string;
  predicate: string;
  expectedObject: KgObject;
  v2FactId?: string;
  expectedV2Text?: string;
}

export interface KgBenchmarkManifestV1 {
  schema: "engram.kg-v3-benchmark.v1";
  workspaceId: string;
  essential: EssentialFactV1[];
  baselineDefaultContext: { body: string };
  proposedDefaultContext: { sources: string[]; archiveIncludedInDefault: boolean };
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

function projectionBodies(workspace: string, sources: string[]): string[] {
  const root = resolve(workspace);
  return sources.map((source) => {
    const path = resolve(root, source);
    const rel = relative(root, path);
    if (!rel || rel.startsWith("..")) throw new Error(`benchmark context source escapes workspace: ${source}`);
    return readFileSync(path, "utf8");
  });
}

export function defaultContextArchiveLeakage(context: KgBenchmarkManifestV1["proposedDefaultContext"] & { embeddedBodies?: string[] }): boolean {
  if (!context || context.archiveIncludedInDefault !== false || !Array.isArray(context.sources)) return true;
  const searchable = [...context.sources, ...(context.embeddedBodies || [])].join("\n").toLowerCase();
  return /items\.json|\blife\/(?!v3\/)|\bv2\b|historical[ -]?(archive|fact)|archive[ -]?fact/.test(searchable);
}

export async function runKgV3Benchmark(options: { workspace: string; workspaceId: string; reader: KgV3Reader; manifest: KgBenchmarkManifestV1 }): Promise<KgBenchmarkReportV1> {
  const manifest = options.manifest;
  if (manifest.schema !== "engram.kg-v3-benchmark.v1" || manifest.workspaceId !== options.workspaceId || !Array.isArray(manifest.essential) || manifest.essential.length === 0 || typeof manifest.baselineDefaultContext?.body !== "string") throw new Error("invalid KG v3 benchmark manifest");
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
  const proposedBodies = projectionBodies(options.workspace, manifest.proposedDefaultContext.sources);
  const baselineFootprintBytes = Buffer.byteLength(manifest.baselineDefaultContext.body);
  const v3FootprintBytes = Buffer.byteLength(proposedBodies.join("\n"));
  const footprintReductionPercent = baselineFootprintBytes === 0 ? 0 : Number(((1 - v3FootprintBytes / baselineFootprintBytes) * 100).toFixed(2));
  const recallRegressionPoints = Number((baselineRecallPercent - v3RecallPercent).toFixed(2));
  const archiveLeakage = defaultContextArchiveLeakage({ ...manifest.proposedDefaultContext, embeddedBodies: proposedBodies });
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
