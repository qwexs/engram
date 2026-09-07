import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

function processIdentity(pid: number): string | null {
  try {
    process.kill(pid, 0);
    try { return readFileSync("/proc/" + pid + "/stat", "utf8").split(") ").at(-1)!.split(" ")[19]!; }
    catch { return "alive"; }
  } catch (error: any) { return error.code === "EPERM" ? "alive" : null; }
}

/** Non-waiting same-host lease. A live owner is never stolen by elapsed wall time. */
export function acquireProcessLease(path: string): (() => void) | null {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const token = randomUUID();
  try { mkdirSync(path, { mode: 0o700 }); }
  catch (error: any) {
    if (error.code !== "EEXIST") throw error;
    let stale = false;
    try {
      const owner = JSON.parse(readFileSync(join(path, "owner.json"), "utf8"));
      const actual = Number.isInteger(owner.pid) && owner.pid > 0 ? processIdentity(owner.pid) : "alive";
      stale = actual === null || (actual !== "alive" && owner.identity !== actual);
    } catch {
      try { stale = Date.now() - statSync(path).mtimeMs > 60_000; } catch { return null; }
    }
    if (!stale) return null;
    const retired = path + ".retired-" + token;
    try { renameSync(path, retired); } catch { return null; }
    rmSync(retired, { recursive: true, force: true });
    return acquireProcessLease(path);
  }
  writeFileSync(join(path, "owner.json"), JSON.stringify({ pid: process.pid, identity: processIdentity(process.pid), token }), { mode: 0o600 });
  return () => {
    if (existsSync(path) && JSON.parse(readFileSync(join(path, "owner.json"), "utf8")).token === token) rmSync(path, { recursive: true });
  };
}
