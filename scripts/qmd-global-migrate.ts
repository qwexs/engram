#!/usr/bin/env bun
import {
  applyQmdGlobalMigration,
  planQmdGlobalMigration,
  readQmdGlobalMigrationManifest,
  rollbackQmdGlobalMigration,
} from "../src/qmd/global-migration.ts";

const args = process.argv.slice(2);
const value = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

try {
  const rollback = value("--rollback");
  if (rollback) {
    console.log(JSON.stringify({ status: "rolled-back", backup: rollbackQmdGlobalMigration(rollback) }, null, 2));
    process.exit(0);
  }
  const manifestPath = value("--manifest");
  if (!manifestPath) throw new Error("usage: --manifest <path> [--apply --backup-dir <path> --confirm-index <name>] | --rollback <backup-manifest>");
  const plan = planQmdGlobalMigration(readQmdGlobalMigrationManifest(manifestPath));
  if (!args.includes("--apply")) {
    console.log(JSON.stringify(plan, null, 2));
    process.exit(0);
  }
  const backup = value("--backup-dir");
  const confirmation = value("--confirm-index");
  if (!backup || !confirmation) throw new Error("--apply requires --backup-dir and --confirm-index");
  console.log(JSON.stringify({ status: "applied", backup: applyQmdGlobalMigration(plan, backup, confirmation) }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
