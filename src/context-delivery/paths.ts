import type { Stats } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

export function samePath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

export function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

export function snapshotUnchanged(before: Stats, after: Stats): boolean {
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) return false;
  if (process.platform === "win32") return true;
  return before.dev === after.dev && before.ino === after.ino;
}
