#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { isAbsolute } from "node:path";
import { preflightOllWorkspace, OllRuntimePreflightError } from "../src/oll/runtime-preflight";

try {
  const { values, positionals } = parseArgs({ args: process.argv.slice(2), strict: true, options: {
    workspace: { type: "string" }, "state-root": { type: "string" }, json: { type: "boolean" }, help: { type: "boolean" },
  } });
  if (values.help) {
    console.log("Usage: oll-runtime-preflight.ts --workspace <absolute-path> --state-root <nightly-state-root> [--json]\nRead-only: resolves managed paths and loads the actor registry; does not check individual grants or run a model.");
  } else {
    if (positionals.length || !values.workspace || !isAbsolute(values.workspace)) throw new Error("--workspace must be an absolute path");
    const result = preflightOllWorkspace(values.workspace!, values["state-root"]!);
    console.log(JSON.stringify({ schema: "oll.runtime-preflight.v1", status: "ok", ...result }, null, 2));
  }
} catch (error) {
  console.error(JSON.stringify({ schema: "oll.runtime-preflight.v1", status: "error", code: error instanceof OllRuntimePreflightError ? error.code : "invalid_input", error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
}
