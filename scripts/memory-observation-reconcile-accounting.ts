#!/usr/bin/env bun
import { resolve } from "node:path";
import { reconcileBatchAccounting } from "../src/memory-observation/batch-accounting-reconciliation.ts";
import type { Digest } from "../src/memory-observation/ledger.ts";

function parse(argv: string[]): Record<string, string | boolean> {
  const output: Record<string, string | boolean> = {};
  for (let index = 2; index < argv.length; index++) {
    const value = argv[index]!;
    if (!value.startsWith("--")) throw new Error(`unknown positional argument: ${value}`);
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) { output[value.slice(2)] = next; index++; }
    else output[value.slice(2)] = true;
  }
  return output;
}

function required(options: Record<string, string | boolean>, name: string): string {
  const value = options[name];
  if (typeof value !== "string" || !value.trim()) throw new Error(`--${name} is required`);
  return value.trim();
}

const options = parse(process.argv);
const result = reconcileBatchAccounting({
  workspace: resolve(required(options, "workspace")),
  storeRoot: resolve(required(options, "store-root")),
  jobId: required(options, "job-id") as Digest,
  supersedingJobId: typeof options["superseding-job-id"] === "string" ? options["superseding-job-id"] as Digest : undefined,
  authorizedBy: required(options, "authorized-by"),
  authorizedAt: required(options, "authorized-at"),
  reason: required(options, "reason"),
  apply: options.apply === true,
});
console.log(JSON.stringify(result, null, 2));
