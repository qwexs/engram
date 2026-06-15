#!/usr/bin/env bun
/**
 * find-openclaw-mjs.js — Resolve the path to the openclaw.mjs script
 * that pairs with the `openclaw.cmd` wrapper on Windows.
 *
 * Extracted from scripts/install-cron.js so the path-candidate logic is
 * unit-testable in isolation (no PATH mocks, no `where` side effects,
 * no top-level CLI side effects when imported by tests).
 *
 * Why this exists: on Windows, Bun.spawn through a .cmd wrapper passes
 * args via cmd.exe, which truncates literal newlines. The
 * `install-cron.js` runner avoids this by invoking `process.execPath
 * <openclaw.mjs>` directly. The trick is finding the .mjs in the first
 * place — there are several npm-global layouts to consider, and
 * `where openclaw.cmd` gives you only the wrapper.
 *
 * Known npm-global layouts for `openclaw.cmd` → sibling `.mjs`:
 *   <prefix>/openclaw.cmd      →  <prefix>/node_modules/openclaw/openclaw.mjs          (bun-style / yarn)
 *   <prefix>/bin/openclaw.cmd  →  <prefix>/lib/node_modules/openclaw/openclaw.mjs       (npm POSIX prefix)
 *   <prefix>/openclaw.cmd      →  <prefix>/node_modules/openclaw/openclaw.mjs          (npm-shim on Windows:
 *                                                                          the shim lives next to the
 *                                                                          module, not one level above it)
 */

import { join } from "node:path";
import { existsSync } from "node:fs";

export function findNodeScriptForCmdDir(cmdDir) {
  const candidates = [
    join(cmdDir, "..", "node_modules", "openclaw", "openclaw.mjs"),
    join(cmdDir, "..", "lib", "node_modules", "openclaw", "openclaw.mjs"),
    join(cmdDir, "node_modules", "openclaw", "openclaw.mjs"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}
