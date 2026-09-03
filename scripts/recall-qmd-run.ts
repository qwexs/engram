#!/usr/bin/env bun
import { parseArgs } from "node:util";
import {
  RecallAuthorityError,
  compileRecallAuthorityManifest,
  loadRecallCaptureFrame,
} from "../src/qmd/recall-evaluator-authority.ts";
import { loadRecallEvalDataset } from "../src/qmd/recall-evaluator-baseline.ts";
import { RecallQmdRunnerError, runRecallQmdRetrieval } from "../src/qmd/recall-evaluator-runner.ts";
import { resolveQmdContext } from "../src/qmd/context.ts";

const usage = `Usage: bun scripts/recall-qmd-run.ts \\
  --workspace <absolute-path> \\
  --workspace-id <id> \\
  --runtime-session-key <agent:...> \\
  --capture-frame <sealed-frame.json> \\
  --dataset <sealed-dataset.json> \\
  --compiled-at <RFC3339> \\
  --run-id <uuid> \\
  --started-at <RFC3339>`;

function required(value: string | undefined): string {
  if (!value) throw new Error("missing required argument");
  return value;
}

async function main(): Promise<void> {
  try {
    const { values } = parseArgs({
      args: process.argv.slice(2),
      strict: true,
      options: {
        workspace: { type: "string" },
        "workspace-id": { type: "string" },
        "runtime-session-key": { type: "string" },
        "capture-frame": { type: "string" },
        dataset: { type: "string" },
        "compiled-at": { type: "string" },
        "run-id": { type: "string" },
        "started-at": { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
    if (values.help) {
      process.stdout.write(`${usage}\n`);
      return;
    }
    const workspace = required(values.workspace);
    const authorityManifest = compileRecallAuthorityManifest({
      workspace,
      workspaceId: required(values["workspace-id"]),
      runtimeSessionKey: required(values["runtime-session-key"]),
      captureFrame: loadRecallCaptureFrame(required(values["capture-frame"])),
      compiledAt: required(values["compiled-at"]),
    });
    const result = await runRecallQmdRetrieval({
      context: resolveQmdContext({ value: workspace, source: "explicit" }),
      dataset: loadRecallEvalDataset(required(values.dataset)),
      authorityManifest,
      runId: required(values["run-id"]),
      startedAt: required(values["started-at"]),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    const code = error instanceof RecallQmdRunnerError || error instanceof RecallAuthorityError ? error.code : "INVALID_INPUT";
    process.stderr.write(`recall-qmd-run: ${code}\n`);
    process.exitCode = 1;
  }
}

await main();
