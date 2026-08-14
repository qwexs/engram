#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CandidateRolloutError,
  applyCandidateCompilerRolloutV1,
  inspectCandidateCompilerProjectionV1,
  inspectCandidateRollbackBarrierV1,
  planCandidateCompilerRolloutV1,
  rollbackCandidateCompilerV1,
} from "../src/oll/memory-candidate-rollout-v1";

function flags(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) out[key] = true;
    else { out[key] = next; index += 1; }
  }
  return out;
}

function request(value: string | boolean | undefined): any {
  if (typeof value !== "string" || !value) throw new CandidateRolloutError("request_required", "--request-file is required");
  return JSON.parse(readFileSync(resolve(value), "utf8"));
}

const command = process.argv[2];
const values = flags(process.argv.slice(3));

try {
  const payload = request(values["request-file"]);
  const result = command === "plan"
    ? planCandidateCompilerRolloutV1(payload)
    : command === "apply"
      ? applyCandidateCompilerRolloutV1({ ...payload, acknowledge: values["ack-rollout"] === true })
      : command === "barrier"
        ? inspectCandidateRollbackBarrierV1(payload)
        : command === "rollback"
          ? rollbackCandidateCompilerV1({ ...payload, acknowledge: values["ack-rollback"] === true })
          : command === "status"
            ? inspectCandidateCompilerProjectionV1(payload)
            : (() => { throw new CandidateRolloutError("command_invalid", "command must be plan|apply|barrier|rollback|status"); })();
  console.log(JSON.stringify(result, null, 2));
} catch (error: any) {
  console.error(JSON.stringify({
    status: "error",
    code: error instanceof CandidateRolloutError ? error.code : "unexpected_error",
    error: String(error?.message || error),
  }));
  process.exit(1);
}
