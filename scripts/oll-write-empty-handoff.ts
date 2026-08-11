#!/usr/bin/env bun
import { resolve, join } from "node:path";
import { parseArgs } from "node:util";
import { atomicWriteJson } from "../src/oll/legacy-migration";
import { computeHandoffDigest, type RethinkHandoffV2 } from "../src/oll/handoff-v2";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    target: { type: "string" },
    workspace: { type: "string" },
    "batch-id": { type: "string" },
    "workspace-id": { type: "string" },
    "evaluation-id": { type: "string" },
    "run-id": { type: "string" },
    attempt: { type: "string" },
    "context-digest": { type: "string" },
  },
  strict: true,
});

const required = (name: keyof typeof values): string => {
  const value = values[name];
  if (typeof value !== "string" || !value) throw new Error(`--${name} is required`);
  return value;
};

try {
  const workspace = resolve(required("workspace"));
  const runId = required("run-id");
  const target = resolve(required("target"));
  const expectedTarget = join(workspace, "memory-state", "oll", "handoffs", "incoming", `${runId}.json`);
  if (target !== expectedTarget) throw new Error("empty handoff target is outside the exact incoming path");
  const withoutDigest = {
    schema: "oll.rethink-handoff.v2" as const,
    batchId: required("batch-id"),
    workspaceId: required("workspace-id"),
    evaluationId: required("evaluation-id"),
    runId,
    phase: "hb-rethink" as const,
    attempt: Number(required("attempt")),
    policyVersion: 1 as const,
    contextDigest: required("context-digest") as `sha256:${string}`,
    createdAt: new Date().toISOString(),
    actions: [],
  };
  const handoff: RethinkHandoffV2 = { ...withoutDigest, handoffDigest: computeHandoffDigest(withoutDigest) };
  atomicWriteJson(target, handoff);
  console.log(JSON.stringify({ status: "written", target, handoffDigest: handoff.handoffDigest }));
} catch (error: any) {
  console.error(JSON.stringify({ status: "error", error: String(error?.message || error) }));
  process.exit(1);
}
