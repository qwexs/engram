#!/usr/bin/env bun

import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
  CONTEXT_DELIVERY_MARKERS,
  inspectRolloutModelInput,
  type ContextDeliveryMarker,
} from "../src/context-delivery/rollout-inspector.ts";

function usage(): never {
  console.error("Usage: bun scripts/context-delivery-audit.ts --rollout <absolute-jsonl> [--expect kg,oll,domain,session] [--forbid kg,oll,domain,session] [--expect-envelope <sha256>] [--expect-policy <sha256>] [--json]");
  process.exit(1);
}

const args = process.argv.slice(2);
let rollout = "";
let expected: ContextDeliveryMarker[] = [];
let forbidden: ContextDeliveryMarker[] = [];
let expectedEnvelope = "";
let expectedPolicy = "";
let json = false;

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === "--rollout") rollout = args[++index] || "";
  else if (arg === "--expect") {
    const value = args[++index] || "";
    expected = [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))] as ContextDeliveryMarker[];
  } else if (arg === "--forbid") {
    const value = args[++index] || "";
    forbidden = [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))] as ContextDeliveryMarker[];
  } else if (arg === "--expect-envelope") expectedEnvelope = args[++index] || "";
  else if (arg === "--expect-policy") expectedPolicy = args[++index] || "";
  else if (arg === "--json") json = true;
  else usage();
}

if (!rollout || !isAbsolute(rollout)) usage();
const rolloutPath = resolve(rollout);
if (!existsSync(rolloutPath)) throw new Error(`rollout not found: ${rolloutPath}`);
const known = new Set(Object.keys(CONTEXT_DELIVERY_MARKERS));
for (const marker of expected) if (!known.has(marker)) throw new Error(`unknown expected marker: ${marker}`);
for (const marker of forbidden) if (!known.has(marker)) throw new Error(`unknown forbidden marker: ${marker}`);
const sha256 = /^sha256:[a-f0-9]{64}$/;
if (expectedEnvelope && !sha256.test(expectedEnvelope)) throw new Error("invalid expected envelope digest");
if (expectedPolicy && !sha256.test(expectedPolicy)) throw new Error("invalid expected policy digest");

const audit = await inspectRolloutModelInput(rolloutPath);
const missing = expected.filter((marker) => audit.sourceMarkers[marker].occurrences !== 1);
const forbiddenPresent = forbidden.filter((marker) => audit.sourceMarkers[marker].occurrences !== 0);
const envelopeExactlyOnce = audit.envelopes.length === 1;
const envelopeMatches = !expectedEnvelope || (envelopeExactlyOnce && audit.envelopes[0]?.envelopeDigest === expectedEnvelope);
const policyMatches = !expectedPolicy || (envelopeExactlyOnce && audit.envelopes[0]?.policyDigest === expectedPolicy);
const envelopeRequired = Boolean(expected.length || expectedEnvelope || expectedPolicy);
const supported = audit.inputFormat === "codex-response-item-v1";
const result = {
  ...audit,
  expected,
  forbidden,
  missing,
  forbiddenPresent,
  envelopeExactlyOnce,
  envelopeMatches,
  policyMatches,
  passed: supported
    && missing.length === 0
    && forbiddenPresent.length === 0
    && (!envelopeRequired || envelopeExactlyOnce)
    && envelopeMatches
    && policyMatches,
};

if (json) console.log(JSON.stringify(result));
else {
  console.log(`Rollout: ${result.rolloutPath}`);
  console.log(`Format: ${result.inputFormat}`);
  console.log(`Input: ${result.inputMessages} messages, ${result.inputBytes} bytes; first assistant line: ${result.firstAssistantLine ?? "absent"}`);
  for (const [name, state] of Object.entries(result.markers)) {
    const canonical = result.sourceMarkers[name as ContextDeliveryMarker];
    console.log(`${name}: legacy=${state.occurrences}; canonical=${canonical.occurrences}`);
  }
  console.log(`Envelope: ${result.envelopes.length === 1 ? "exactly once" : result.envelopes.length}`);
  if (expected.length) console.log(`Expected: ${expected.join(", ")}; missing: ${missing.join(", ") || "none"}`);
  if (forbidden.length) console.log(`Forbidden: ${forbidden.join(", ")}; present: ${forbiddenPresent.join(", ") || "none"}`);
}

if (!supported) process.exitCode = 3;
else if (!result.passed) process.exitCode = 2;
