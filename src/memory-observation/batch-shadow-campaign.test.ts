import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BATCH_CAMPAIGN_CONFIG_SCHEMA,
  BATCH_CAMPAIGN_CONFIG_SCHEMA_V2,
  BatchShadowCampaignError,
  runBatchShadowCampaign,
  snapshotBatchShadowCampaign,
  type BatchShadowCampaignConfigV1,
  type BatchShadowCampaignConfigV2,
} from "./batch-shadow-campaign.ts";
import { BATCH_CONFIG_SCHEMA, type BatchSourceFrameEntryV1 } from "./batch-compiler.ts";
import {
  BATCH_EVALUATOR_AUTHORITY,
  BATCH_OBSERVATION_SCHEMA,
  deriveBatchObservationId,
} from "./batch-observation.ts";
import { BATCH_SHADOW_OUTPUT_SCHEMA } from "./batch-shadow-runner.ts";
import { deriveSourceDigest, sha256, type JsonValue, type ObservationScope } from "./ledger.ts";

const scope: ObservationScope = {
  workspaceId: "main",
  runtimeSessionKey: "agent:main:telegram:direct:100000001",
  scopeClass: "self",
  scopeId: "telegram:100000001",
};
const policyDigest = sha256("policy-v1");

function source(index: number): BatchSourceFrameEntryV1 {
  const traceId = sha256(`campaign-trace-${index}`);
  const sourceTurnId = `channel-user:v1:${index.toString(16).padStart(64, "0")}`;
  const sourceCompletedAt = `2026-08-31T20:0${index}:00.000Z`;
  const payload = { source: { role: "user", text: `request-${index}` }, outcome: { role: "assistant", text: `outcome-${index}` } };
  const evidenceIdentity = { schema: "engram.memory-evidence-envelope.v1" as const, traceId, scope, payload };
  return {
    envelope: {
      schema: "engram.memory-observation-job.v1",
      traceId,
      sourceTurnId,
      scope,
      sourceCompletedAt,
      sourceDigest: deriveSourceDigest(sourceTurnId, scope, sourceCompletedAt),
      evidenceDigest: sha256(evidenceIdentity as unknown as JsonValue),
      policyVersion: "memory-observation-authority-v1",
      policyDigest,
      evidenceRefs: [{ kind: "source-turn", ref: sourceTurnId, digest: sha256(`ref-${index}`) }],
      authority: { id: "openclaw-runtime", version: "runtime-v1", digest: sha256("runtime-v1") },
      admittedAt: sourceCompletedAt,
    },
    evidence: { ...evidenceIdentity, createdAt: sourceCompletedAt, expiresAt: "2099-09-03T20:00:00.000Z" },
  };
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function batchObservation(entry: BatchSourceFrameEntryV1): Record<string, unknown> {
  const bundleId = sha256("campaign-bundle");
  const groupId = "campaign-group";
  const assertionIndex = 0;
  const observationClass = "episodic.event" as const;
  const evaluationPolicyDigest = sha256("campaign-evaluation-policy");
  const observationId = deriveBatchObservationId({ bundleId, groupId, assertionIndex, observationClass, evaluationPolicyDigest });
  const sourceRef = {
    traceId: entry.envelope.traceId,
    sourceTurnId: entry.envelope.sourceTurnId,
    sourceDigest: entry.envelope.sourceDigest,
    evidenceDigest: entry.envelope.evidenceDigest,
    sourceCompletedAt: entry.envelope.sourceCompletedAt,
  };
  const base = {
    schema: BATCH_OBSERVATION_SCHEMA,
    observationId,
    bundleId,
    groupId,
    assertionIndex,
    scope,
    sourceRefs: [sourceRef],
    producer: BATCH_EVALUATOR_AUTHORITY,
    observationClass,
    targetConsumer: "daily-note",
    payload: { section: "events", text: "Campaign batch observation.", actorRef: "assistant", outcomeStatus: "completed" },
    citations: [{ traceId: entry.envelope.traceId, evidenceRef: entry.envelope.evidenceRefs[0] }],
    sourceCompletedAt: entry.envelope.sourceCompletedAt,
    confidence: 0.9,
    reasonCodes: ["explicit_completion"],
    evaluationPolicyDigest,
    completedAt: "2026-08-31T20:10:00.000Z",
  };
  return { ...base, observationDigest: sha256(base as unknown as JsonValue) };
}

function fixture(): { root: string; store: string; config: BatchShadowCampaignConfigV1; sources: BatchSourceFrameEntryV1[] } {
  const root = mkdtempSync(join(tmpdir(), "engram-campaign-ledger-"));
  const store = mkdtempSync(join(tmpdir(), "engram-campaign-store-"));
  for (const path of ["envelopes", "evidence", "queues/evaluator", "observations/typed", "observations/batch"]) {
    mkdirSync(join(root, path), { recursive: true });
  }
  const sources = [source(1), source(2)];
  for (const [index, entry] of sources.entries()) {
    const name = `${entry.envelope.traceId.slice(7)}.json`;
    writeJson(join(root, "envelopes", name), entry.envelope);
    writeJson(join(root, "evidence", name), entry.evidence);
    const write = index === 0;
    writeJson(join(root, "queues/evaluator", name), {
      schema: "engram.memory-observation-ledger-queue.v1",
      traceId: entry.envelope.traceId,
      queueClass: "evaluator",
      status: "terminal",
      reasonCode: write ? "semantic_write" : "semantic_skip_noise",
    });
    if (write) {
      writeJson(join(root, "observations/typed", name), {
        schema: "engram.memory-observation.v1",
        observationId: sha256(`observation-${index}`),
        traceId: entry.envelope.traceId,
        scope,
      });
    }
  }
  const config: BatchShadowCampaignConfigV1 = {
    schema: BATCH_CAMPAIGN_CONFIG_SCHEMA,
    ledgerRoot: root,
    storeRoot: store,
    modelRunCwd: root,
    partition: { ...scope, producerEpoch: "runtime-v1", policyDigest },
    fromInclusive: "2026-08-31T20:00:00.000Z",
    throughInclusive: "2026-08-31T20:02:00.000Z",
    sealedAt: "2026-08-31T20:10:00.000Z",
    targetTurns: 3,
    compiler: {
      schema: BATCH_CONFIG_SCHEMA,
      inactivityGapMs: 300_000,
      maxTurns: 10,
      maxEvidenceBytes: 100_000,
      maxAgeMs: 3_600_000,
    },
    runner: {
      schema: "engram.memory-batch-shadow-runner-config.v2",
      requestedModel: "openai/gpt-5.6-terra",
      maxTokens: 2_000,
      temperature: 0,
      messageMode: "single-user",
    },
  };
  return { root, store, config, sources };
}

describe("batch shadow campaign", () => {
  test("freezes an exact retained frame and reports an incomplete write-heavy snapshot separately from acceptance", async () => {
    const setup = fixture();
    try {
      const snapshot = snapshotBatchShadowCampaign(setup.config);
      expect(snapshot.compile.sourceCount).toBe(2);
      expect(snapshot.compile.exclusions).toEqual([]);
      expect(snapshot.historical.map((entry) => entry.decision)).toEqual(["write", "skip"]);
      let calls = 0;
      const first = await runBatchShadowCampaign(setup.config, {
        complete: async (request) => {
          calls++;
          expect(request.system).toBe("");
          const prompt = JSON.parse(request.prompt);
          const traceIds = prompt.task.sources.map((entry: any) => entry.sourceRef.traceId);
          return {
            resolvedModel: "openai/gpt-5.6-terra",
            usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 0 },
            costUsd: 0.00125,
            output: JSON.stringify({
              schema: BATCH_SHADOW_OUTPUT_SCHEMA,
              groups: [{ groupId: "case-1", decision: "skip", sourceRefs: traceIds, reason: "noise" }],
            }),
          };
        },
      });
      expect(first.manifest.target).toEqual({ requiredTurns: 3, observedTurns: 2, complete: false });
      expect(first.manifest.historical).toMatchObject({ write: 1, skip: 1, defer: 0, failed: 0 });
      expect(first.manifest.shadow).toMatchObject({
        calls: 1,
        validatedCalls: 1,
        failedCalls: 0,
        coveredTurns: 2,
        usageReadback: "measured",
        inputTokens: 100,
        outputTokens: 20,
        monetaryCost: { provenance: "gateway-agent-meta", shadowUsd: 0.00125 },
      });
      expect(first.manifest.diagnostics).toEqual({
        sourceCoverage: "met",
        callReductionPercent: 50,
        callReductionGate: "not_met",
        corpusGate: "not_met",
        adjudicationGate: "pending",
        economicsGate: "pending_baseline_cost",
        acceptanceVerdict: "not_evaluated",
      });
      expect(readFileSync(first.manifestPath, "utf8")).not.toContain("request-1");
      const second = await runBatchShadowCampaign(setup.config, {
        complete: async () => { throw new Error("duplicate campaign must not call the provider"); },
      });
      expect(second.manifest).toEqual(first.manifest);
      expect(calls).toBe(1);
    } finally {
      rmSync(setup.root, { recursive: true, force: true });
      rmSync(setup.store, { recursive: true, force: true });
    }
  });

  test("maps current batch terminal reasons and validates the exact batch observation for writes", () => {
    const setup = fixture();
    try {
      const [first, second] = setup.sources;
      const firstName = `${first.envelope.traceId.slice(7)}.json`;
      const secondName = `${second.envelope.traceId.slice(7)}.json`;
      const observation = batchObservation(first);
      unlinkSync(join(setup.root, "observations/typed", firstName));
      writeJson(join(setup.root, "observations/batch", `${String(observation.observationId).slice(7)}.json`), observation);
      writeJson(join(setup.root, "queues/evaluator", firstName), {
        schema: "engram.memory-observation-ledger-queue.v1",
        traceId: first.envelope.traceId,
        queueClass: "evaluator",
        status: "terminal",
        reasonCode: "semantic_batch_write",
      });
      const setSecondReason = (reasonCode: string) => writeJson(join(setup.root, "queues/evaluator", secondName), {
        schema: "engram.memory-observation-ledger-queue.v1",
        traceId: second.envelope.traceId,
        queueClass: "evaluator",
        status: "terminal",
        reasonCode,
      });

      setSecondReason("semantic_batch_skip");
      expect(snapshotBatchShadowCampaign(setup.config).historical.map((entry) => entry.decision)).toEqual(["write", "skip"]);
      setSecondReason("semantic_batch_grouped_no_assertion");
      expect(snapshotBatchShadowCampaign(setup.config).historical.map((entry) => entry.decision)).toEqual(["write", "skip"]);
      setSecondReason("semantic_batch_defer");
      expect(snapshotBatchShadowCampaign(setup.config).historical.map((entry) => entry.decision)).toEqual(["write", "defer"]);
      setSecondReason("batch_invalid_json");
      expect(snapshotBatchShadowCampaign(setup.config).historical.map((entry) => entry.decision)).toEqual(["write", "failed"]);

      unlinkSync(join(setup.root, "observations/batch", `${String(observation.observationId).slice(7)}.json`));
      expect(() => snapshotBatchShadowCampaign(setup.config)).toThrow(BatchShadowCampaignError);
    } finally {
      rmSync(setup.root, { recursive: true, force: true });
      rmSync(setup.store, { recursive: true, force: true });
    }
  });

  test("fails closed when retained evidence or terminal baseline is missing", () => {
    const setup = fixture();
    try {
      const first = setup.sources[0];
      unlinkSync(join(setup.root, "evidence", `${first.envelope.traceId.slice(7)}.json`));
      expect(() => snapshotBatchShadowCampaign(setup.config)).toThrow(BatchShadowCampaignError);
    } finally {
      rmSync(setup.root, { recursive: true, force: true });
      rmSync(setup.store, { recursive: true, force: true });
    }
  });

  test("binds measured gateway agent transport into the v2 campaign config", () => {
    const setup = fixture();
    try {
      const config: BatchShadowCampaignConfigV2 = {
        ...setup.config,
        schema: BATCH_CAMPAIGN_CONFIG_SCHEMA_V2,
        gatewayAgentId: "managers",
        runner: {
          ...setup.config.runner,
          schema: "engram.memory-batch-shadow-runner-config.v3",
          providerMode: "gateway-agent-meta",
          gatewayAgentId: "managers",
        },
      };
      expect(snapshotBatchShadowCampaign(config).compile.sourceCount).toBe(2);
      expect(() => snapshotBatchShadowCampaign({
        ...config,
        gatewayAgentId: "main",
      })).toThrow(BatchShadowCampaignError);
    } finally {
      rmSync(setup.root, { recursive: true, force: true });
      rmSync(setup.store, { recursive: true, force: true });
    }
  });
});
