#!/usr/bin/env bun
/**
 * engram/scripts/build-hook-bundles.ts
 *
 * Rebuild the `handler.js` bundle for every hook whose source is `handler.ts`.
 * OpenClaw imports hooks by `import(handlerPath)` (Node ESM dynamic import) and
 * picks `handler.ts` or `handler.js` from the hook directory in that order. The
 * TypeScript source is for humans; the JS bundle is what the gateway actually
 * loads. The submodule commits the bundle alongside the source so the hook
 * works without a build step on the deployment host.
 *
 * Run before every commit that touches a hook handler. The pre-commit hook in
 * .githooks/pre-commit calls this via `bun run scripts/build-hook-bundles.ts`
 * and rejects the commit if the bundle is out of date.
 *
 * Usage:
 *   bun run scripts/build-hook-bundles.ts                  # every hook
 *   bun run scripts/build-hook-bundles.ts <hook-dir>...    # specific
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const REPO_ROOT = (() => {
  const r = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf-8",
  });
  if (r.status === 0) return r.stdout.trim();
  return process.cwd();
})();
const HOOKS_DIR = join(REPO_ROOT, "hooks");

if (!existsSync(HOOKS_DIR)) {
  console.error(`build-hook-bundles: no hooks/ directory at ${HOOKS_DIR}`);
  process.exit(1);
}

const args = process.argv.slice(2);
const targets: string[] =
  args.length > 0
    ? args.map((a) => resolve(REPO_ROOT, a))
    : readdirSync(HOOKS_DIR)
        .map((name) => join(HOOKS_DIR, name))
        .filter((p) => statSync(p).isDirectory());

let built = 0;
for (const hookDir of targets) {
  if (!existsSync(hookDir)) {
    console.error(`build-hook-bundles: ${hookDir} does not exist`);
    process.exit(1);
  }
  const ts = join(hookDir, "handler.ts");
  const js = join(hookDir, "handler.js");
  if (!existsSync(ts)) continue;

  console.log(`build-hook-bundles: ${ts} -> ${js}`);
  const r = spawnSync(
    "bun",
    ["build", ts, "--target=node", "--format=esm", "--outdir", hookDir],
    { stdio: "inherit" },
  );
  if (r.status !== 0) {
    console.error(`build-hook-bundles: bun build failed for ${ts}`);
    process.exit(r.status ?? 1);
  }
  built += 1;
}

console.log(`build-hook-bundles: ${built} hook(s) built.`);
