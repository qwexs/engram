#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const repository = resolve(process.argv.includes("--repository") ? process.argv[process.argv.indexOf("--repository") + 1] : join(import.meta.dir, ".."));
const forbiddenFiles = ["memory-write.js", "memory-access-buffer.js", "flush-access-buffer.js", "memory-repair.js", "audit-superseded.js", "migrate-v2.js", "derive-facts.js", "rebuild-summaries.js"];
const forbiddenSources = [
  ["src/oll/reconciliation.ts", "flush-access-buffer.js"],
  ["src/oll/reconciliation.ts", "rebuild-summaries.js"],
  ["scripts/heartbeat-runner.js", "derive-facts.js"],
  ["scripts/heartbeat-runner.js", "rebuild-summaries.js"],
  ["scripts/heartbeat-runner.js", "writeFileSync(entry.itemsPath"],
] as const;
const forbiddenGuidanceFiles = [
  "assets/templates/MEMORY.md",
  "integrations/openclaw-kg-v3/index.ts",
  "templates/domain/topic-thread/agents.md",
  "templates/spawn-prompts/_shared/agents-section.template.md",
] as const;
const violations: string[] = [];
for (const name of forbiddenFiles) if (existsSync(join(repository, "scripts", name))) violations.push(`executable legacy entrypoint exists: scripts/${name}`);
for (const [path, needle] of forbiddenSources) {
  const target = join(repository, path);
  if (existsSync(target) && readFileSync(target, "utf8").includes(needle)) violations.push(`legacy mutation reachability: ${path} contains ${needle}`);
}
for (const path of forbiddenGuidanceFiles) {
  const target = join(repository, path);
  if (existsSync(target) && readFileSync(target, "utf8").includes("memory-write.js")) {
    violations.push(`legacy writer guidance: ${path} mentions memory-write.js`);
  }
}
const report = { schema: "engram.kg-v3-zero-legacy-writers.v1", repository, status: violations.length ? "failed" : "passed", violations };
console.log(JSON.stringify(report, null, 2));
process.exit(violations.length ? 1 : 0);
