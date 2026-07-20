#!/usr/bin/env bun
// Schema repair for an existing KG fact (idempotent, no dedup, no hash registration).
// Use ONLY for correcting schema-level field issues (e.g. `confidence: null` or
// an invalid `abstractionLevel` written before a fix). Do NOT use this to add or
// change factual content — that goes through `memory-write.js`.
//
// Examples:
//   bun skills/engram/scripts/memory-repair.js \
//     --entity projects/engram --id engram-274 --confidence 0.7
//
//   bun skills/engram/scripts/memory-repair.js \
//     --entity projects/engram --id engram-274 --confidence 0.7 --dry-run
//
//   bun skills/engram/scripts/memory-repair.js \
//     --entity projects/engram --id engram-274 --confidence 0.7 --validate --qmd-update

import { join } from "path";
import { resolveQmdCommand } from "./config.js";

const WORKSPACE = process.env.ENGRAM_WORKSPACE || process.cwd() || join(import.meta.dir, "..", "..", "..");
const QMD = resolveQmdCommand(WORKSPACE);

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--") && i + 1 < args.length && !args[i + 1].startsWith("--")) {
      opts[args[i].slice(2)] = args[i + 1];
      i++;
    } else if (args[i].startsWith("--")) {
      opts[args[i].slice(2)] = true;
    }
  }
  return opts;
}

const opts = parseArgs(process.argv);
const dryRun = Boolean(opts["dry-run"] || opts.check);
const entity = opts.entity;
const factId = opts.id;
const newConfidenceRaw = opts.confidence;
const newAbstraction = opts.abstraction;
const VALID_ABSTRACTIONS = new Set(["episode", "pattern", "principle"]);

if (opts.help || opts.h) {
  console.log([
    "memory-repair.js",
    "",
    "Schema repair for an existing KG fact. Corrects schema field values",
    "on a fact that already exists. Does NOT create new facts and does NOT change",
    "the fact text. For new facts use memory-write.js.",
    "",
    "Usage:",
    "  bun skills/engram/scripts/memory-repair.js --entity <path> --id <fact-id>",
    "       [--confidence <0-1>] [--abstraction episode|pattern|principle]",
    "       [--dry-run] [--validate] [--qmd-update]",
    "",
    "Required:",
    "  --entity <path>      Entity path under life/ (e.g. projects/engram)",
    "  --id <fact-id>       Fact id within the entity (e.g. engram-274)",
    "  At least one repair field is required:",
    "  --confidence <0-1>   New confidence value",
    "  --abstraction <v>    New abstractionLevel: episode, pattern, or principle",
    "",
    "Optional:",
    "  --dry-run            Show what would change without writing",
    "  --validate           Run validate.js --agent-id main after repair",
    "  --qmd-update         Run qmd update after repair",
  ].join("\n"));
  process.exit(0);
}

if (!entity || !factId || (newConfidenceRaw === undefined && newAbstraction === undefined)) {
  console.error("❌ Требуются --entity, --id и хотя бы одно из --confidence/--abstraction");
  process.exit(1);
}

let newConfidence;
if (newConfidenceRaw !== undefined) {
  newConfidence = Number(newConfidenceRaw);
  if (!Number.isFinite(newConfidence) || newConfidence < 0 || newConfidence > 1) {
    console.error(`❌ --confidence должен быть числом 0.0-1.0, получено: ${newConfidenceRaw}`);
    process.exit(1);
  }
}
if (newAbstraction !== undefined && !VALID_ABSTRACTIONS.has(newAbstraction)) {
  console.error(`❌ --abstraction должен быть episode, pattern или principle, получено: ${newAbstraction}`);
  process.exit(1);
}

const entityPath = join(WORKSPACE, "life", entity, "items.json");
let payload;
try {
  payload = await Bun.file(entityPath).json();
} catch (e) {
  console.error(`❌ Не удалось прочитать ${entityPath}: ${e.message}`);
  process.exit(1);
}

const facts = Array.isArray(payload.facts) ? payload.facts : null;
if (!facts) {
  console.error(`❌ В ${entityPath} нет массива facts`);
  process.exit(1);
}

const idx = facts.findIndex((f) => f && f.id === factId);
if (idx < 0) {
  console.error(`❌ Факт ${factId} не найден в ${entityPath}`);
  process.exit(1);
}

const before = facts[idx];
const beforeConfidence = before.confidence;
const beforeAbstraction = before.abstractionLevel;
const confidenceChanged = newConfidenceRaw !== undefined && beforeConfidence !== newConfidence;
const abstractionChanged = newAbstraction !== undefined && beforeAbstraction !== newAbstraction;

if (!confidenceChanged && !abstractionChanged) {
  console.log(JSON.stringify({
    status: "noop",
    entity,
    id: factId,
    confidence: beforeConfidence,
    abstractionLevel: beforeAbstraction,
  }));
  process.exit(0);
}

const result = {
  status: dryRun ? "would-repair" : "repaired",
  entity,
  id: factId,
  path: entityPath,
  before: {
    ...(confidenceChanged && { confidence: beforeConfidence }),
    ...(abstractionChanged && { abstractionLevel: beforeAbstraction }),
  },
  after: {
    ...(confidenceChanged && { confidence: newConfidence }),
    ...(abstractionChanged && { abstractionLevel: newAbstraction }),
  },
};

if (dryRun) {
  console.log(JSON.stringify(result));
  process.exit(0);
}

facts[idx] = {
  ...before,
  ...(confidenceChanged && { confidence: newConfidence }),
  ...(abstractionChanged && { abstractionLevel: newAbstraction }),
};
await Bun.write(entityPath, JSON.stringify(payload, null, 2) + "\n");

if (opts.validate) {
  try {
    const proc = Bun.spawn(["bun", join(import.meta.dir, "validate.js")], {
      cwd: WORKSPACE,
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    const err = await new Response(proc.stderr).text();
    await proc.exited;
    result.validate = { status: proc.exitCode, stdoutPreview: out.slice(0, 2000), stderrPreview: err.slice(0, 1000) };
  } catch (e) {
    result.validate = { status: -1, error: e.message };
  }
}

if (opts["qmd-update"]) {
  try {
    const proc = Bun.spawn([QMD, "update"], { cwd: WORKSPACE, stdout: "pipe", stderr: "pipe" });
    await proc.exited;
    result.qmdUpdate = { status: proc.exitCode };
  } catch (e) {
    result.qmdUpdate = { status: -1, error: e.message };
  }
}

console.log(JSON.stringify(result));
