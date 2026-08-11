#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { resolveSubagentModel } from "./config.js";
import {
  DurableTrustedNightlyRuntime,
  FileDispatchTransport,
  FileWorkspaceRegistryAdapter,
  NightlyDispatchPendingError,
} from "../src/oll/deployment-runtime";
import { runNightlyCoordinator } from "../src/oll/nightly-coordinator";

const command = process.argv[2];
const { values } = parseArgs({
  args: process.argv.slice(3),
  options: {
    "state-root": { type: "string" },
    "registry-snapshot": { type: "string" },
    "allowed-root": { type: "string", multiple: true },
    "scripts-dir": { type: "string" },
    "reconciliation-completed-externally": { type: "boolean", default: false },
    "runtime-label": { type: "string" },
    accepted: { type: "string" },
    "dispatch-ref-uri": { type: "string" },
    "resolved-model-uri": { type: "string" },
    "error-uri": { type: "string" },
  },
  strict: true,
});

const required = (name: string): string => {
  const value = values[name as keyof typeof values];
  if (typeof value !== "string" || !value) throw new Error(`--${name} is required`);
  return value;
};
const decode = (name: string): string => decodeURIComponent(required(name));

try {
  const stateRoot = resolve(required("state-root"));
  const transport = new FileDispatchTransport(stateRoot);
  if (command === "ack") {
    const result = transport.acknowledge({
      runtimeLabel: required("runtime-label"),
      accepted: required("accepted") === "true",
      dispatchRef: decode("dispatch-ref-uri"),
      resolvedModel: decode("resolved-model-uri"),
      error: typeof values["error-uri"] === "string" ? decodeURIComponent(values["error-uri"]) : null,
    });
    console.log(JSON.stringify({ status: "acknowledged", acknowledgement: result }));
  } else if (command === "run") {
    const allowedRoots = values["allowed-root"];
    if (!Array.isArray(allowedRoots) || allowedRoots.length === 0) throw new Error("at least one --allowed-root is required");
    const runtime = new DurableTrustedNightlyRuntime(transport);
    const report = await runNightlyCoordinator({
      stateRoot,
      registryAdapter: new FileWorkspaceRegistryAdapter(required("registry-snapshot")),
      allowedWorkspaceRoots: allowedRoots.map((root) => resolve(root)),
      runtime,
      scriptsDir: resolve(required("scripts-dir")),
      resolveModel: (workspace, phase) => resolveSubagentModel(workspace, phase),
      reconciliationCompletedExternally: values["reconciliation-completed-externally"] === true,
    });
    console.log(JSON.stringify({ status: "completed", report }));
  } else throw new Error("use run or ack");
} catch (error: any) {
  if (error instanceof NightlyDispatchPendingError) {
    console.log(JSON.stringify({ status: "spawn_required", request: error.request }));
  } else {
    console.error(JSON.stringify({ status: "error", error: String(error?.message || error) }));
    process.exit(1);
  }
}
