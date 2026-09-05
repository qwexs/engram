import { describe, expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { validateObserverReceiptProducerRegistryV1 } from "../src/oll/observer-receipt-bridge-v1.ts";

const REPO = join(import.meta.dir, "..");
const CONTRACT_ROOT = join(REPO, "contracts", "memory-observation", "v1");
const FIXTURE_ROOT = join(import.meta.dir, "fixtures", "memory-observation");
const SCHEMA_PATH = join(REPO, "schemas", "memory-observation-contracts-v1.schema.json");

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"));
}

const schema = readJson(SCHEMA_PATH);
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
ajv.addSchema(schema);

function validator(definition: string) {
  return ajv.compile({ $ref: `${schema.$id}#/$defs/${definition}` });
}

const validateBundle = ajv.getSchema(schema.$id)!;
const validateObservation = validator("observation");
const validateApplyReceipt = validator("applyReceipt");
const validateAdmissionGapReceipt = validator("admissionGapReceipt");

const registry = readJson(join(CONTRACT_ROOT, "producer-registry.json"));
const classRegistry = readJson(join(CONTRACT_ROOT, "class-registry.json"));
const authorityPolicy = readJson(join(CONTRACT_ROOT, "authority-policy.json"));
const dailyTemplate = readJson(join(CONTRACT_ROOT, "consumer-daily-note.json"));
const kgTemplate = readJson(join(CONTRACT_ROOT, "consumer-kg-v3.json"));
const kgDiagnosticTemplate = readJson(join(CONTRACT_ROOT, "consumer-kg-v3-diagnostic.json"));
const ollTemplate = readJson(join(CONTRACT_ROOT, "consumer-oll.json"));
const ollReceiptRegistry = readJson(join(CONTRACT_ROOT, "oll-receipt-producer-registry.json"));
const qmdTemplate = readJson(join(CONTRACT_ROOT, "consumer-qmd.json"));
const recallTemplate = readJson(join(CONTRACT_ROOT, "consumer-recall-telemetry.json"));

type Admission = { admitted: true; effect: "shadow" | "apply" } | { admitted: false; reason: string };
type Authority = { authorized: true } | { authorized: false; reason: string };

const SUPPORTED_AUTHORITY_POLICY_VERSION = "memory-observation-authority-v1";
const SUPPORTED_CONSUMER_POLICY_VERSION = "v1";
const OBSERVATION_AUTHORITY_INPUTS = ["observation-job", "ttl-evidence-store", "producer-registry"];

function exact(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(exact).join(",")}]`;
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${exact(row[key])}`).join(",")}}`;
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function deriveTraceId(workspaceId: string, runtimeSessionKey: string, sourceTurnId: string): string {
  return digest(`engram.memory-trace.v1\0${workspaceId}\0${runtimeSessionKey}\0${sourceTurnId}`);
}

function deriveSourceDigest(sourceTurnId: string, scope: unknown, sourceCompletedAt: string): string {
  return digest(exact({ sourceTurnId, scope, sourceCompletedAt }));
}

function deriveObservationId(traceId: string, producerId: string, observationClass: string): string {
  return digest(`engram.memory-observation.v1\0${traceId}\0${producerId}\0${observationClass}`);
}

function deriveOperationId(consumer: string, observationId: string, destinationEntryId: string): string {
  return digest(`engram.memory-apply.v1\0${consumer}\0${observationId}\0${destinationEntryId}`);
}

function deriveEventId(traceId: string, stage: string, stageRefDigest: string): string {
  return digest(`engram.memory-trace-event.v1\0${traceId}\0${stage}\0${stageRefDigest}`);
}

function authorizeObservation(
  observation: any,
  policy: any = authorityPolicy,
  trustedInputs: readonly string[] = OBSERVATION_AUTHORITY_INPUTS,
): Authority {
  if (policy.schema !== "engram.memory-authority-policy.v1"
    || policy.policyVersion !== SUPPORTED_AUTHORITY_POLICY_VERSION) {
    return { authorized: false, reason: "unknown_authority_policy_version" };
  }
  const rule = policy.rules.find((entry: any) =>
    entry.artifactSchema === observation.schema && entry.stage === "advisory-evaluation",
  );
  if (!rule) return { authorized: false, reason: "authority_rule_missing" };

  const registeredProducer = registry.producers.find((entry: any) =>
    entry.id === observation.producer.id
      && entry.version === observation.producer.version
      && entry.digest === observation.producer.digest,
  );
  if (!registeredProducer) return { authorized: false, reason: "unknown_producer" };
  if (!registeredProducer.artifactSchemas.includes(observation.schema)
    || !registeredProducer.observationClasses.includes(observation.observationClass)
    || !rule.allowedProducerIds.includes(registeredProducer.id)
    || !rule.allowedAuthorityClasses.includes(registeredProducer.authorityClass)) {
    return { authorized: false, reason: "producer_authority_denied" };
  }
  if (rule.requiredTrustedInputs.some((input: string) => !trustedInputs.includes(input))) {
    return { authorized: false, reason: "authority_trusted_input_missing" };
  }
  return { authorized: true };
}

function admitObservation(
  observation: any,
  policy: any,
  options: { authorityPolicy?: any; trustedInputs?: readonly string[] } = {},
): Admission {
  if (policy.schema !== "engram.memory-consumer-policy.v1"
    || policy.policyVersion !== SUPPORTED_CONSUMER_POLICY_VERSION) {
    return { admitted: false, reason: "unknown_consumer_policy_version" };
  }
  if (policy.mode === "disabled") return { admitted: false, reason: "policy_disabled" };
  if (!validateObservation(observation)) return { admitted: false, reason: "schema_invalid" };
  if (!policy.inputSchemas.includes(observation.schema)) return { admitted: false, reason: "input_schema_denied" };
  if (policy.workspaceId !== observation.scope.workspaceId) return { admitted: false, reason: "workspace_denied" };

  const authority = authorizeObservation(
    observation,
    options.authorityPolicy,
    options.trustedInputs ?? OBSERVATION_AUTHORITY_INPUTS,
  );
  if (!authority.authorized) return { admitted: false, reason: authority.reason };

  const registeredClass = classRegistry.classes.find((entry: any) => entry.id === observation.observationClass);
  if (!registeredClass) return { admitted: false, reason: "unknown_class" };
  if (registeredClass.targetConsumer !== observation.targetConsumer) {
    return { admitted: false, reason: "target_consumer_mismatch" };
  }
  if (!policy.allowedProducers.some((entry: any) => exact(entry) === exact(observation.producer))) {
    return { admitted: false, reason: "producer_not_allowed" };
  }
  if (!policy.allowedObservationClasses.includes(observation.observationClass)) {
    return { admitted: false, reason: "class_not_allowed" };
  }
  if (policy.requiredProvenanceFields.some((field: string) =>
    !Object.prototype.hasOwnProperty.call(observation, field))) {
    return { admitted: false, reason: "required_provenance_missing" };
  }
  if (!policy.exactScopeAllowlist.some((entry: any) => exact(entry) === exact(observation.scope))) {
    return { admitted: false, reason: "scope_not_allowed" };
  }
  if (policy.consumer !== observation.targetConsumer) {
    return { admitted: false, reason: "consumer_mismatch" };
  }
  return { admitted: true, effect: policy.mode === "shadow" ? "shadow" : "apply" };
}

describe("Memory Observation Layer PR0 schema bundle", () => {
  test("accepts all positive fixtures", () => {
    for (const name of readdirSync(join(FIXTURE_ROOT, "valid")).sort()) {
      const value = readJson(join(FIXTURE_ROOT, "valid", name));
      expect(validateBundle(value), `${name}: ${ajv.errorsText(validateBundle.errors)}`).toBe(true);
    }
  });

  test("rejects all labeled negative fixtures", () => {
    for (const name of readdirSync(join(FIXTURE_ROOT, "invalid")).sort()) {
      const value = readJson(join(FIXTURE_ROOT, "invalid", name));
      expect(validateBundle(value), `${name} unexpectedly validated`).toBe(false);
    }
  });

  test("binds episodic class to section and trace stage to reference kind", () => {
    const observation = readJson(join(FIXTURE_ROOT, "valid", "observation.json"));
    expect(validateBundle({
      ...observation,
      payload: { ...observation.payload, section: "decisions" },
    })).toBe(false);

    const trace = readJson(join(FIXTURE_ROOT, "valid", "trace-outcome.json"));
    expect(validateBundle({
      ...trace,
      stageRef: { ...trace.stageRef, kind: "source-turn" },
    })).toBe(false);
  });

  test("keeps source producer and class provenance in the 180-day apply receipt", () => {
    const observation = readJson(join(FIXTURE_ROOT, "valid", "observation.json"));
    const receipt = readJson(join(FIXTURE_ROOT, "valid", "apply-receipt.json"));
    expect(validateApplyReceipt(receipt)).toBe(true);
    expect(receipt.sourceProvenance).toEqual({
      sourceTurnId: observation.sourceTurnId,
      producer: observation.producer,
      observationClass: observation.observationClass,
      evidenceRefs: observation.evidenceRefs,
      observationDigest: observation.observationDigest,
    });
    const { sourceProvenance: _removed, ...withoutSourceProvenance } = receipt;
    expect(validateApplyReceipt(withoutSourceProvenance)).toBe(false);
  });

  test("keeps admission gap receipts content-free with closed terminal reasons", () => {
    const fixture = readJson(join(FIXTURE_ROOT, "valid", "admission-gap-receipt.json"));
    const reasonCodes = [
      "restart_before_completion",
      "expired_before_completion",
      "identity_ambiguous",
      "identity_conflict",
      "scope_revoked",
      "run_failed",
      "delivery_failed",
      "evidence_missing",
      "evidence_invalid",
    ];
    for (const reasonCode of reasonCodes) {
      expect(validateAdmissionGapReceipt({ ...fixture, reasonCode }), reasonCode).toBe(true);
    }
    expect(validateAdmissionGapReceipt({ ...fixture, reasonCode: "unknown" })).toBe(false);
    for (const field of ["content", "payload", "evidence"]) {
      expect(validateAdmissionGapReceipt({ ...fixture, [field]: "forbidden" }), field).toBe(false);
    }
  });

  test("validates registries and every default-deny consumer policy", () => {
    const paths = [
      "producer-registry.json",
      "class-registry.json",
      "authority-policy.json",
      "oll-receipt-producer-registry.json",
      ...readdirSync(CONTRACT_ROOT).filter((name) => name.startsWith("consumer-") && name.endsWith(".json")),
    ];
    for (const name of paths) {
      const value = readJson(join(CONTRACT_ROOT, name));
      expect(validateBundle(value), `${name}: ${ajv.errorsText(validateBundle.errors)}`).toBe(true);
    }
  });
});

describe("Memory Observation Layer PR0 closed registries", () => {
  test("publishes exactly five non-authoritative observation classes", () => {
    const ids = classRegistry.classes.map((entry: any) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.sort()).toEqual([
      "diagnostic.durable-intent-gap",
      "diagnostic.recall-failure",
      "episodic.decision",
      "episodic.event",
      "procedural.candidate-evidence",
    ]);
    expect(classRegistry.classes.every((entry: any) => entry.canonicalWriteAuthority === false)).toBe(true);
  });

  test("gives the observer no canonical, rule, or index mutation capability", () => {
    const observer = registry.producers.find((entry: any) => entry.id === "post-turn-observer");
    expect(observer.capabilities).toEqual({
      mayReadRawEvidence: true,
      mayMutateCanonicalMemory: false,
      mayMaterializeRules: false,
      mayWriteDerivedIndex: false,
    });
  });

  test("publishes a digest-verified default-deny OLL receipt producer registry", () => {
    expect(validateObserverReceiptProducerRegistryV1(ollReceiptRegistry)).toEqual(ollReceiptRegistry);
    expect(ollReceiptRegistry.entries).toHaveLength(1);
    expect(ollReceiptRegistry.entries[0]).toMatchObject({
      producer: { id: "batch-post-turn-observer", version: "v1" },
      allowedObservationClasses: ["episodic.decision"],
      exactScopeAllowlist: [],
      allowedEvaluationPolicyDigests: [],
      rolloutState: "report-only",
    });
  });

  test("has one explicit authority rule per stage and denies by default", () => {
    const stages = authorityPolicy.rules.map((entry: any) => entry.stage);
    expect(new Set(stages).size).toBe(stages.length);
    expect(authorityPolicy.defaultDecision).toBe("deny");
    expect(authorityPolicy.replayReauthorizationRequired).toBe(true);
  });

  test("reserves retrieval and utilization schemas without activating a producer or consumer", () => {
    const traceWriter = registry.producers.find((entry: any) => entry.id === "memory-trace-writer");
    expect(traceWriter.artifactSchemas).toEqual(["engram.memory-trace-event.v1"]);
    expect(authorityPolicy.rules.some((entry: any) => [
      "engram.memory-retrieval-receipt.v1",
      "engram.memory-utilization-receipt.v1",
    ].includes(entry.artifactSchema))).toBe(false);
    expect(recallTemplate.inputSchemas).not.toContain("engram.memory-retrieval-receipt.v1");
    expect(recallTemplate.inputSchemas).not.toContain("engram.memory-utilization-receipt.v1");
  });

  test("executes authority and fails closed on an unknown version or missing trusted input", () => {
    const observation = readJson(join(FIXTURE_ROOT, "valid", "observation.json"));
    expect(authorizeObservation(observation)).toEqual({ authorized: true });
    expect(authorizeObservation(observation, {
      ...authorityPolicy,
      policyVersion: "memory-observation-authority-v2",
    })).toEqual({ authorized: false, reason: "unknown_authority_policy_version" });
    expect(authorizeObservation(observation, authorityPolicy, ["observation-job", "producer-registry"]))
      .toEqual({ authorized: false, reason: "authority_trusted_input_missing" });
  });

  test("ships every consumer disabled with an empty exact-scope allowlist", () => {
    for (const policy of [dailyTemplate, kgTemplate, kgDiagnosticTemplate, ollTemplate, qmdTemplate, recallTemplate]) {
      expect(policy.mode).toBe("disabled");
      expect(policy.exactScopeAllowlist).toEqual([]);
      expect(policy.rawEvidenceAllowed).toBe(false);
      expect(policy.applyTimeRecheck).toBe(true);
    }
  });
});

describe("Memory Observation Layer PR0 admission", () => {
  const observation = readJson(join(FIXTURE_ROOT, "valid", "observation.json"));
  const canaryDaily = {
    ...dailyTemplate,
    workspaceId: observation.scope.workspaceId,
    mode: "canary",
    exactScopeAllowlist: [observation.scope],
  };

  test("admits a registry-pinned episodic observation only to the exact daily partition", () => {
    expect(admitObservation(observation, canaryDaily)).toEqual({ admitted: true, effect: "apply" });
  });

  test("fails closed on unknown producer, changed producer digest, and adjacent scope", () => {
    expect(admitObservation({
      ...observation,
      producer: { ...observation.producer, id: "unknown-observer" },
    }, canaryDaily)).toEqual({ admitted: false, reason: "unknown_producer" });
    expect(admitObservation({
      ...observation,
      producer: { ...observation.producer, digest: `sha256:${"0".repeat(64)}` },
    }, canaryDaily)).toEqual({ admitted: false, reason: "unknown_producer" });
    expect(admitObservation({
      ...observation,
      scope: { ...observation.scope, runtimeSessionKey: "agent:fixture-main:telegram:direct:100000002" },
    }, canaryDaily)).toEqual({ admitted: false, reason: "scope_not_allowed" });
  });

  test("fails closed on unknown consumer policy versions and unmet provenance policy", () => {
    expect(admitObservation(observation, {
      ...canaryDaily,
      policyVersion: "v2",
    })).toEqual({ admitted: false, reason: "unknown_consumer_policy_version" });
    expect(admitObservation(observation, {
      ...canaryDaily,
      requiredProvenanceFields: [...canaryDaily.requiredProvenanceFields, "reviewTicket"],
    })).toEqual({ admitted: false, reason: "required_provenance_missing" });
  });

  test("does not let a typed observation satisfy KG v3 explicit-intent admission", () => {
    const enabledKg = {
      ...kgTemplate,
      workspaceId: observation.scope.workspaceId,
      mode: "canary",
      exactScopeAllowlist: [observation.scope],
    };
    expect(admitObservation(observation, enabledKg)).toEqual({ admitted: false, reason: "input_schema_denied" });
  });

  test("keeps durable-intent-gap diagnostic separate from KG canonical authority", () => {
    const diagnostic = {
      ...observation,
      observationClass: "diagnostic.durable-intent-gap",
      targetConsumer: "kg-v3-diagnostic",
      payload: { intentKind: "decision", summary: "Fixture may contain an explicit durable decision." },
    };
    expect(validateObservation(diagnostic)).toBe(true);
    const enabledDiagnostic = {
      ...kgDiagnosticTemplate,
      workspaceId: observation.scope.workspaceId,
      mode: "canary",
      exactScopeAllowlist: [observation.scope],
    };
    expect(admitObservation(diagnostic, enabledDiagnostic)).toEqual({ admitted: true, effect: "apply" });
    expect(enabledDiagnostic.sideEffectClass).toBe("none");
    expect(enabledDiagnostic.soleMutator).toBeNull();
  });

  test("keeps OLL inert while declaring only the batch decision receipt bridge", () => {
    const procedural = {
      ...observation,
      observationClass: "procedural.candidate-evidence",
      targetConsumer: "oll",
      payload: { statement: "Verify provenance before compilation.", evidenceKind: "constraint" },
    };
    expect(validateObservation(procedural)).toBe(true);
    expect(admitObservation(procedural, ollTemplate)).toEqual({ admitted: false, reason: "policy_disabled" });
    expect(ollTemplate.allowedProducers).toEqual([ollReceiptRegistry.entries[0].producer]);
    expect(ollTemplate.allowedObservationClasses).toEqual(["episodic.decision"]);
    expect(ollTemplate.exactScopeAllowlist).toEqual([]);
  });

  test("allows QMD only canonical references or typed index handoffs and never raw observation evidence", () => {
    expect(qmdTemplate.inputSchemas).toEqual(["engram.canonical-record-ref.v1", "engram.memory-index-handoff.v1"]);
    expect(qmdTemplate.allowedCanonicalSourceSchemas).toEqual([
      "engram.daily-note-entry.v1",
      "engram.kg-assertion.v3-mvp",
      "engram.domain-document.v1",
    ]);
    expect(qmdTemplate.rawEvidenceAllowed).toBe(false);
    expect(qmdTemplate.allowedObservationClasses).toEqual([]);
  });
});

describe("Memory Observation Layer PR0 closed derivations", () => {
  test("matches stable SHA-256 control vectors for every published identity formula", () => {
    const sourceTurnId = `channel-user:v1:${"a".repeat(64)}`;
    const scope = {
      workspaceId: "fixture-main",
      runtimeSessionKey: "agent:fixture-main:telegram:direct:100000001",
      scopeClass: "self",
      scopeId: "telegram:100000001",
    };
    const sourceCompletedAt = "2026-08-24T18:00:00.000Z";
    const traceId = deriveTraceId(scope.workspaceId, scope.runtimeSessionKey, sourceTurnId);
    expect(traceId).toBe("sha256:865a666a87e0d471544f290fed6ce3726d6d65028eddc063e1b1aea39e7114da");
    expect(deriveSourceDigest(sourceTurnId, scope, sourceCompletedAt))
      .toBe("sha256:d739bbc840b67c3e6bd44cb39e336b4826bba8d15140353f9c9408344713cc6d");

    const observationId = deriveObservationId(traceId, "post-turn-observer", "episodic.event");
    expect(observationId).toBe("sha256:e4d9a0744857c47e199e09f5bb6f0bcc808abc2450cd699c67a173e5996dd785");
    expect(deriveOperationId("daily-note", observationId, `sha256:${"d".repeat(64)}`))
      .toBe("sha256:4358db92bbf01c949a152d32757df646a2ac8250ad7c919b5c23d8326cc4d431");
    expect(deriveEventId(traceId, "canonical_applied", `sha256:${"e".repeat(64)}`))
      .toBe("sha256:5bbb9b3e5caffaacf05724e99d38bc5901164a13c425336fd336f69664abd876");
  });
});
