#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beginKgCanary, finalizeKgCanary, KgCanaryError, planKgCanary, recordCanaryExplicitReceipt, rollbackKgCanary } from "../src/kg-v3/canary.ts";

const first = process.argv[2];
const command = first && !first.startsWith("--") ? first : "plan";
const args = process.argv.slice(command === "plan" && first?.startsWith("--") ? 2 : 3);
const value = (flag: string) => { const at = args.indexOf(flag); return at >= 0 ? args[at + 1] : undefined; };
const has = (flag: string) => args.includes(flag);
const options = { workspace: resolve(value("--workspace") || process.cwd()), workspaceId: value("--workspace-id") || "", manifestPath: resolve(value("--manifest") || "") };
if (!options.workspaceId || !value("--manifest")) throw new Error("--workspace-id and --manifest are required");

try {
  let output: unknown;
  if (command === "plan") output = planKgCanary(options);
  else if (command === "begin") output = await beginKgCanary({ ...options, acknowledge: has("--ack-canary-begin") });
  else if (command === "finalize") output = await finalizeKgCanary({ ...options, acknowledge: has("--ack-canary-finalize") });
  else if (command === "rollback") output = rollbackKgCanary({ ...options, acknowledge: has("--ack-rollback") });
  else if (command === "record-receipt") output = recordCanaryExplicitReceipt({ ...options, operationId: (value("--operation-id") || "") as `sha256:${string}` });
  else throw new Error("command must be plan, begin, record-receipt, finalize, or rollback");
  console.log(JSON.stringify(output, null, 2));
} catch (error) {
  console.error(JSON.stringify({ status: "error", code: error instanceof KgCanaryError ? error.code : "UNEXPECTED", error: error instanceof Error ? error.message : String(error) }));
  process.exit(1);
}
