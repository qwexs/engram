#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  applyOllRollout,
  OllRolloutError,
  planOllRollout,
  rollbackOllRollout,
} from "../src/oll/rollout";

function args(argv: string[]) {
  const result: Record<string, string | boolean> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) result[key] = true;
    else {
      result[key] = next;
      index += 1;
    }
  }
  return result;
}

function request(path: unknown) {
  if (typeof path !== "string" || !path) throw new OllRolloutError("request_required", "--request-file is required");
  return JSON.parse(readFileSync(resolve(path), "utf8"));
}

function usage(): never {
  console.error("Usage: oll-rollout.ts <plan|apply|rollback> --request-file <trusted.json> [--ack-rollout|--ack-rollback]");
  process.exit(2);
}

const command = process.argv[2];
const flags = args(process.argv.slice(3));

try {
  const payload = request(flags["request-file"]);
  if (command === "plan") {
    console.log(JSON.stringify(planOllRollout(payload), null, 2));
  } else if (command === "apply") {
    console.log(JSON.stringify(applyOllRollout({ ...payload, acknowledge: flags["ack-rollout"] === true }), null, 2));
  } else if (command === "rollback") {
    console.log(JSON.stringify(rollbackOllRollout({ ...payload, acknowledge: flags["ack-rollback"] === true }), null, 2));
  } else usage();
} catch (error: any) {
  console.error(JSON.stringify({
    status: "error",
    code: error instanceof OllRolloutError ? error.code : "unexpected_error",
    error: String(error?.message || error),
  }));
  process.exit(1);
}
