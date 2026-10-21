#!/usr/bin/env bun
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { auditOllObserverBridge } from "../src/oll/observer-receipt-watchdog.ts";
import { planOllObserverBridge, applyOllObserverBridgePlan } from "../src/oll/observer-receipt-provisioning.ts";

const command = process.argv[2];
const { values } = parseArgs({ args: process.argv.slice(3), options: {
  workspace: { type: "string" }, "plan-file": { type: "string" }, "ack-apply": { type: "boolean" },
}, strict: true });
try {
  if (command === "check") {
    if (!values.workspace) throw Error("--workspace is required");
    const findings = auditOllObserverBridge(resolve(values.workspace));
    console.log(JSON.stringify({ status: findings.some(f => f.level === "error") ? "error" : "ok", findings }));
    process.exitCode = findings.some(f => f.level === "error") ? 1 : 0;
  } else if (command === "plan") {
    if (!values.workspace || !values["plan-file"]) throw Error("--workspace and --plan-file are required");
    const plan = planOllObserverBridge(resolve(values.workspace));
    if (!plan) console.log(JSON.stringify({ status: "skipped", reason: "nightly/compiler disabled or no observer-owned allowlisted decision source" }));
    else {
      writeFileSync(resolve(values["plan-file"]), JSON.stringify(plan, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      console.log(JSON.stringify({ status: "planned", workspaceId: plan.workspaceId, planDigest: plan.planDigest, evidence: plan.evidence }));
    }
  } else if (command === "apply") {
    if (!values["plan-file"] || !values["ack-apply"]) throw Error("--plan-file and --ack-apply are required");
    console.log(JSON.stringify(applyOllObserverBridgePlan(JSON.parse(readFileSync(resolve(values["plan-file"]), "utf8")))));
  } else throw Error("use check, plan or apply");
} catch {
  // Plans and compiler work may contain private paths/evidence: never dump them.
  console.error(JSON.stringify({ status: "error", stage: command, reason: "bridge operation failed; inspect locally with trusted operator tooling" })); process.exitCode = 1;
}
