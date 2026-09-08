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
// The validator is an archive reader, irrespective of authority-marker state.
// Reject write capabilities themselves, not only one historical call spelling.
const validatorPath = join(repository, "scripts/validate.js");
if (!existsSync(validatorPath)) violations.push("read-only validator missing: scripts/validate.js");
else {
  const source = readFileSync(validatorPath, "utf8");
  const capabilities = /\b(?:writeFile(?:Sync)?|appendFile(?:Sync)?|createWriteStream|mkdir(?:Sync)?|rename(?:Sync)?|unlink(?:Sync)?|rm(?:Sync)?|truncate(?:Sync)?|copyFile(?:Sync)?|openSync)\b/g;
  for (const token of new Set(source.match(capabilities) ?? [])) violations.push(`validator write capability: ${token}`);
  if (/Bun\s*\.\s*write\s*\(/.test(source)) violations.push("validator write capability: Bun.write");
  if (/legacyKgMutationState/.test(source)) violations.push("validator mutation authority fallback remains reachable");
}
const heartbeatPath = join(repository, "scripts/heartbeat-runner.js");
if (existsSync(heartbeatPath)) {
  const source = readFileSync(heartbeatPath, "utf8");
  if (/["'`]--fix["'`]/.test(source)) violations.push("heartbeat automatic validator fix argument remains reachable");
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
