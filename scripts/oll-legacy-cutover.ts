#!/usr/bin/env bun

import { resolve } from "node:path";
import {
  migrateFleetLegacyOll,
  migrateWorkspaceLegacyOll,
} from "../src/oll/legacy-migration";

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const options: Record<string, string | boolean> = {};
  for (let index = 2; index < argv.length; index++) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      options[key] = next;
      index++;
    } else {
      options[key] = true;
    }
  }
  return options;
}

const options = parseArgs(process.argv);
if (options.help || options.h) {
  console.log(`oll-legacy-cutover.ts

Dry-run is the default. Apply requires both --apply and --ack-cutover.

One workspace:
  bun skills/engram/scripts/oll-legacy-cutover.ts \\
    --workspace /path --workspace-id main [--apply --ack-cutover]

Fleet from an immutable registry snapshot:
  bun skills/engram/scripts/oll-legacy-cutover.ts \\
    --registry-snapshot /path/registry-snapshot.json \\
    --state-root /var/lib/engram [--apply --ack-cutover]

The command disables legacy heartbeat OLL admission/application, inventories
and quarantines active legacy artifacts, migrates state atomically, writes
backup/rollback manifests, and leaves nightly rethink disabled.
`);
  process.exit(0);
}

const apply = Boolean(options.apply);
if (apply && !options["ack-cutover"]) {
  console.error("--apply requires --ack-cutover");
  process.exit(2);
}

try {
  let result;
  if (typeof options["registry-snapshot"] === "string") {
    if (typeof options["state-root"] !== "string") {
      throw new Error("fleet mode requires --state-root");
    }
    result = migrateFleetLegacyOll({
      registrySnapshotPath: resolve(options["registry-snapshot"]),
      stateRoot: resolve(options["state-root"]),
      now: typeof options.now === "string" ? options.now : undefined,
      apply,
    });
  } else {
    if (typeof options.workspace !== "string") {
      throw new Error("use --workspace or --registry-snapshot");
    }
    result = migrateWorkspaceLegacyOll({
      workspace: resolve(options.workspace),
      workspaceId: typeof options["workspace-id"] === "string" ? options["workspace-id"] : undefined,
      now: typeof options.now === "string" ? options.now : undefined,
      apply,
    });
  }
  console.log(JSON.stringify(result, null, 2));
  if (result.status === "partial" || result.status === "error") process.exit(1);
} catch (error) {
  console.error(JSON.stringify({
    schema: "oll.legacy-cutover-error.v1",
    status: "error",
    error: error instanceof Error ? error.message : String(error),
  }, null, 2));
  process.exit(1);
}
