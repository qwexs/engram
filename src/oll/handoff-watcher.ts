import { existsSync, lstatSync, mkdirSync, watch } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import type { HandoffWaitResultV1 } from "./contracts";

function runIdFromPath(path: string): string {
  return basename(path).replace(/\.json$/, "");
}

function isReady(path: string): boolean {
  if (!existsSync(path)) return false;
  const stat = lstatSync(path);
  return stat.isFile() && !stat.isSymbolicLink();
}

/** Race-safe bounded watcher: pre-check, register, post-check, then fs events. */
export async function awaitHandoffFile(expectedPath: string, timeoutMs = 900_000): Promise<HandoffWaitResultV1> {
  const path = resolve(expectedPath);
  const parent = dirname(path);
  const runId = runIdFromPath(path);
  mkdirSync(parent, { recursive: true });
  const result = (status: HandoffWaitResultV1["status"], errorClass: HandoffWaitResultV1["errorClass"]): HandoffWaitResultV1 => ({
    schema: "oll.handoff-wait-result.v1",
    runId,
    expectedPath: path,
    status,
    observedPath: status === "file" ? path : null,
    observedAt: new Date().toISOString(),
    errorClass,
  });
  if (isReady(path)) return result("file", null);
  return await new Promise<HandoffWaitResultV1>((resolveResult) => {
    let settled = false;
    let watcher: ReturnType<typeof watch> | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (value: HandoffWaitResultV1) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      watcher?.close();
      resolveResult(value);
    };
    watcher = watch(parent, { persistent: false }, () => {
      try { if (isReady(path)) finish(result("file", null)); }
      catch { /* the next event or timeout remains authoritative */ }
    });
    watcher.on("error", () => finish(result("watcher_error", "watcher_error")));
    timer = setTimeout(() => finish(result("timeout", "handoff_timeout")), timeoutMs);
    try { if (isReady(path)) finish(result("file", null)); }
    catch { /* watcher remains active */ }
  });
}
