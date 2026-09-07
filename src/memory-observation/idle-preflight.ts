import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** A conservative, read-only shortcut, not a second scheduler or policy engine.
 * Even future retries take the full path. Unknown/corrupt state never means idle.
 * Concurrent arrivals are left untouched and picked up on the next cron tick.
 */
export function memoryBatchIsIdle(workspace: string, includeDomains: boolean): boolean {
  const root = join(workspace, "memory-state/memory-observation");
  function records(directory: string): Map<string, Record<string, any>> {
    let names: string[];
    try { names = readdirSync(directory); }
    catch (error: any) { if (error.code === "ENOENT") return new Map(); throw error; }
    return new Map(names.filter(name => name.endsWith(".json")).map(name => {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) throw new Error("unknown record name");
      const value = JSON.parse(readFileSync(join(directory, name), "utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid record");
      return [name, value];
    }));
  }
  const missing = (source: Map<string, unknown>, destination: Map<string, unknown>) =>
    [...source.keys()].some(name => !destination.has(name));
  try {
    const evaluator = records(join(root, "v1/queues/evaluator"));
    const daily = records(join(root, "v1/consumers/daily-note/queue"));
    if ([...evaluator.values()].some(row => row.schema !== "engram.memory-observation-ledger-queue.v1" || row.status !== "terminal")
      || [...daily.values()].some(row => row.schema !== "engram.memory-observation-consumer-queue.v1" || row.status !== "terminal")) return false;

    // Interrupted publication may leave a source without its queue entry.
    if (missing(records(join(root, "v1/envelopes")), evaluator)
      || missing(records(join(root, "v1/observations/batch")), daily)
      || missing(records(join(root, "v1/observations/typed")), daily)) return false;
    const batchRoot = join(root, "batch-live-store/memory-batch-live/v1");
    if (missing(records(join(batchRoot, "jobs")), records(join(batchRoot, "done")))) return false;

    if (includeDomains) {
      const domainRoot = join(workspace, "memory-state/domain-effects/v1");
      const applied = records(join(domainRoot, "receipts"));
      // Keep QMD recovery alive even after the original observation was purged.
      if (missing(records(join(root, "v1/receipts/by-operation")), applied)
        || missing(applied, records(join(domainRoot, "dirty")))) return false;
    }
    // Published QMD dirty generations belong to the maintenance coordinator;
    // it continues independently of this worker's idle shortcut.
    return true;
  } catch { return false; }
}
