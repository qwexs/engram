#!/usr/bin/env bun
import { resolve } from "node:path";
import { KgCanaryError } from "../src/kg-v3/canary.ts";
import { executeKgCanaryReplay, planKgCanaryReplay } from "../src/kg-v3/canary-executor.ts";

const first = process.argv[2];
const command = first && !first.startsWith("--") ? first : "plan";
const args = process.argv.slice(command === "plan" && first?.startsWith("--") ? 2 : 3);
const value = (flag: string) => { const at = args.indexOf(flag); return at >= 0 ? args[at + 1] : undefined; };
const has = (flag: string) => args.includes(flag);
const options = {
  workspace: resolve(value("--workspace") || process.cwd()),
  workspaceId: value("--workspace-id") || "",
  manifestPath: resolve(value("--manifest") || ""),
  runtimeGrantsPath: resolve(value("--runtime-grants") || ""),
};
if (!options.workspaceId || !value("--manifest") || !value("--runtime-grants")) throw new Error("--workspace-id, --manifest, and --runtime-grants are required");

try {
  const output = command === "plan"
    ? planKgCanaryReplay(options)
    : command === "execute"
      ? await executeKgCanaryReplay({ ...options, acknowledge: has("--ack-reviewed-replay") })
      : (() => { throw new Error("command must be plan or execute"); })();
  console.log(JSON.stringify(output, null, 2));
} catch (error) {
  console.error(JSON.stringify({ status: "error", code: error instanceof KgCanaryError ? error.code : "UNEXPECTED", error: error instanceof Error ? error.message : String(error) }));
  process.exit(1);
}
