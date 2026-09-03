#!/usr/bin/env bun
import { parseArgs } from "node:util";
import {
  compileRecallAuthorityManifest,
  loadRecallCaptureFrame,
} from "../src/qmd/recall-evaluator-authority.ts";

const usage = `Usage: bun scripts/recall-authority-compile.ts \\
  --workspace <absolute-path> \\
  --workspace-id <id> \\
  --runtime-session-key <agent:...> \\
  --capture-frame <sealed-frame.json> \\
  --compiled-at <RFC3339>`;

function main(): void {
  try {
    const { values } = parseArgs({
      args: process.argv.slice(2),
      strict: true,
      options: {
        workspace: { type: "string" },
        "workspace-id": { type: "string" },
        "runtime-session-key": { type: "string" },
        "capture-frame": { type: "string" },
        "compiled-at": { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
    if (values.help) {
      process.stdout.write(`${usage}\n`);
      return;
    }
    const workspace = values.workspace;
    const workspaceId = values["workspace-id"];
    const runtimeSessionKey = values["runtime-session-key"];
    const captureFramePath = values["capture-frame"];
    const compiledAt = values["compiled-at"];
    if (!workspace || !workspaceId || !runtimeSessionKey || !captureFramePath || !compiledAt) {
      throw new Error(`all arguments are required\n${usage}`);
    }
    const manifest = compileRecallAuthorityManifest({
      workspace,
      workspaceId,
      runtimeSessionKey,
      captureFrame: loadRecallCaptureFrame(captureFramePath),
      compiledAt,
    });
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    process.stderr.write(`recall-authority-compile: ${message}\n`);
    process.exitCode = 1;
  }
}

main();
