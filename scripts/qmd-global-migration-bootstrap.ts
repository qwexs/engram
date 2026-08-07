#!/usr/bin/env bun
import { renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  bootstrapQmdGlobalMigration,
  readQmdMigrationTopology,
} from "../src/qmd/global-migration-bootstrap.ts";

const args = process.argv.slice(2);
const value = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

try {
  const topology = value("--topology");
  const output = value("--output");
  if (!topology || !output) throw new Error("usage: --topology <private-path> --output <private-path>");
  const destination = resolve(output);
  const temp = join(dirname(destination), `.${randomUUID()}.tmp`);
  writeFileSync(temp, `${JSON.stringify(bootstrapQmdGlobalMigration(readQmdMigrationTopology(topology)), null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, destination);
  console.log(JSON.stringify({ status: "created", output: destination }));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
