#!/usr/bin/env bun

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  captureAdaptationSignal,
  decideAdaptationReview,
  expireAdaptationReviews,
  listPendingAdaptationSignals,
  proposeAdaptationRule,
} from "../src/oll/adaptation-store";

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const result: Record<string, string | boolean> = {};
  for (let index = 2; index < argv.length; index++) {
    const value = argv[index];
    if (!value.startsWith("--")) continue;
    const key = value.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      result[key] = next;
      index++;
    } else result[key] = true;
  }
  return result;
}

function request(path: unknown): Record<string, any> {
  if (typeof path !== "string") throw new Error("--request-file is required");
  return JSON.parse(readFileSync(resolve(path), "utf8"));
}

const args = parseArgs(process.argv);
if (args.help || args.h) {
  console.log(`oll-adaptation.ts

Commands:
  capture         --workspace <path> --state-root <path> --request-file <json>
  pending         --workspace <path> --state-root <path>
  propose-rule    --workspace <path> --state-root <path> --request-file <json>
  decide-review   --workspace <path> --state-root <path> --request-file <json>
  expire-reviews  --workspace <path> --state-root <path> [--now <iso>]

Request files are trusted-runtime/operator envelopes. Transport identity is
read only from request.trustedActorContext, never from statement/evidence text.
Capture stores a digest and stable reference, not raw evidence content.
`);
  process.exit(0);
}

const command = process.argv[2];
const workspace = typeof args.workspace === "string" ? resolve(args.workspace) : null;
const stateRoot = typeof args["state-root"] === "string" ? resolve(args["state-root"]) : null;
if (!workspace || !stateRoot) {
  console.error("--workspace and --state-root are required");
  process.exit(2);
}

try {
  let result: unknown;
  if (command === "capture") {
    const input = request(args["request-file"]);
    result = captureAdaptationSignal({
      workspace,
      stateRoot,
      ...input,
      actorContext: input.trustedActorContext || null,
    });
  } else if (command === "pending") {
    result = { schema: "oll.pending-signals.v1", workspace, signals: listPendingAdaptationSignals({ workspace, stateRoot }) };
  } else if (command === "propose-rule") {
    const input = request(args["request-file"]);
    result = proposeAdaptationRule({ workspace, stateRoot, ...input, actorContext: input.trustedActorContext || null });
  } else if (command === "decide-review") {
    const input = request(args["request-file"]);
    result = decideAdaptationReview({ workspace, stateRoot, ...input, actorContext: input.trustedActorContext || null });
  } else if (command === "expire-reviews") {
    result = { schema: "oll.expired-reviews.v1", reviews: expireAdaptationReviews({ workspace, stateRoot, now: typeof args.now === "string" ? args.now : undefined }) };
  } else {
    throw new Error("unknown command; use --help");
  }
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    schema: "oll.adaptation-error.v1",
    status: "error",
    code: (error as any)?.code || "error",
    error: error instanceof Error ? error.message : String(error),
  }, null, 2));
  process.exit(1);
}
