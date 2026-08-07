#!/usr/bin/env bun
// Fast, append-only recording of a fact actually used by an agent.
// Expensive counter/summary work is deferred to flush-access-buffer.js.

import { appendFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

function parseArgs(argv) {
  const opts = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      opts[key] = next;
      i++;
    } else opts[key] = true;
  }
  return opts;
}

const opts = parseArgs(process.argv);
if (opts.help || opts.h) {
  console.log(`memory-access-buffer.js

Record a fact that was actually used in an answer without blocking on summary or QMD work.

Usage:
  bun skills/engram/scripts/memory-access-buffer.js --entity people/alice --id alice-001
  bun skills/engram/scripts/memory-access-buffer.js --entity people/alice --fact "Exact fact text"

The nightly coordinator resolves and applies buffered events. Do not record search results or bulk reads.`);
  process.exit(0);
}

const workspace = resolve(opts.workspace || process.env.ENGRAM_WORKSPACE || process.cwd());
const entity = String(opts.entity || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
const id = opts.id ? String(opts.id).trim() : null;
const fact = opts.fact ? String(opts.fact).trim() : null;
if (!entity || entity.split("/").includes("..") || (!id && !fact) || (id && fact)) {
  console.error("❌ Требуются --entity и ровно один из --id/--fact; entity не должен содержать ..");
  process.exit(2);
}
if (fact && fact.length > 12000) {
  console.error("❌ --fact слишком длинный (максимум 12000 символов)");
  process.exit(2);
}

const dir = join(workspace, "workspace", "memory-state");
mkdirSync(dir, { recursive: true });
const entry = {
  schema: "engram.access-event.v1",
  at: new Date().toISOString(),
  entity,
  ...(id ? { id } : { fact }),
  ...(opts.session ? { session: String(opts.session) } : {}),
};
appendFileSync(join(dir, "access-buffer.jsonl"), JSON.stringify(entry) + "\n", "utf8");
console.log(JSON.stringify({ status: "buffered", entity, ...(id ? { id } : { factMatchedLater: true }) }));
