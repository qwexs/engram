import { mkdirSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";

const DEFAULT_STALE_MS = 60_000;
const DEFAULT_WAIT_MS = 10_000;

export class DailyNoteLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DailyNoteLockError";
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function dailyNoteLockPath(notePath: string): string {
  return `${notePath}.engram-write-lock`;
}

export function withDailyNoteLock<T>(
  notePath: string,
  operation: () => T,
  options: { staleMs?: number; waitMs?: number } = {},
): T {
  const lockPath = dailyNoteLockPath(notePath);
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
  mkdirSync(dirname(notePath), { recursive: true });
  const started = Date.now();
  while (true) {
    try { mkdirSync(lockPath, { mode: 0o700 }); break; }
    catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
      let stale = false;
      try { stale = Date.now() - statSync(lockPath).mtimeMs > staleMs; } catch { stale = false; }
      if (stale) { rmSync(lockPath, { recursive: true, force: true }); continue; }
      if (Date.now() - started >= waitMs) throw new DailyNoteLockError(`daily-note writer lock timed out: ${notePath}`);
      sleepSync(20);
    }
  }
  try { return operation(); }
  finally { rmSync(lockPath, { recursive: true, force: true }); }
}
