#!/usr/bin/env bun
import { resolve } from "node:path";
import { recoverTerminalBatch, recoverReconciledBatch, recoverReviewedSkip, restoreLegacyDefer } from "../src/memory-observation/batch-terminal-recovery.ts";
import type { Digest } from "../src/memory-observation/ledger.ts";

function args(argv: string[]): Record<string, string | boolean> {
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

const options = args(process.argv);
const workspace = resolve(required(options, "workspace"));
const storeRoot = resolve(required(options, "store-root"));
const common = {
  workspace,
  storeRoot,
  jobId: required(options, "job-id") as Digest,
  authorizedBy: required(options, "authorized-by"),
  authorizedAt: required(options, "authorized-at"),
  reason: required(options, "reason"),
  apply: options.apply === true,
};
const result = options["restore-defer-trace"]
  ? restoreLegacyDefer({ ...common, traceId: required(options, "restore-defer-trace") as Digest })
  : options["review-skip-trace"] ? recoverReviewedSkip({...common,traceId:required(options,"review-skip-trace") as Digest}) : options["reconciled"] === true ? recoverReconciledBatch(common) : recoverTerminalBatch(common);
console.log(JSON.stringify(result, null, 2));
