import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { KgV3Core, type KgV3CoreOptions } from "./core.ts";
import type { KgAssertionV3 } from "./types.ts";

export interface HistoricalV2Fact {
  archive: "v2";
  entityId: string;
  id: string;
  fact: string;
  category: string | null;
  status: string | null;
  source: string | null;
}

export class KgV3Reader {
  readonly core: KgV3Core;

  constructor(options: KgV3CoreOptions) {
    this.core = new KgV3Core(options);
  }

  /** Default reader: only active v3 assertions; v2 is never mixed in. */
  current(): KgAssertionV3[] {
    return this.core.current();
  }

  /** Explicit archive-only adapter for the immutable v2 items.json corpus. */
  historicalV2(entityId: string): HistoricalV2Fact[] {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)+$/.test(entityId)) {
      throw new Error("invalid v2 historical entity id");
    }
    const root = resolve(this.core.workspace, "life");
    const path = resolve(root, entityId, "items.json");
    const rel = relative(root, path);
    if (rel.startsWith("..") || rel === "") throw new Error("v2 historical path escapes life root");
    if (!existsSync(path)) return [];
    const value = JSON.parse(readFileSync(path, "utf8")) as { entityId?: string; facts?: unknown[] };
    if (value.entityId && value.entityId !== entityId) throw new Error("v2 historical entity mismatch");
    if (!Array.isArray(value.facts)) throw new Error("v2 historical facts must be an array");
    return value.facts.map((item) => {
      const fact = item as Record<string, unknown>;
      if (typeof fact.id !== "string" || typeof (fact.fact ?? fact.text) !== "string") throw new Error("invalid v2 historical fact");
      return {
        archive: "v2" as const,
        entityId,
        id: fact.id,
        fact: String(fact.fact ?? fact.text),
        category: typeof fact.category === "string" ? fact.category : null,
        status: typeof fact.status === "string" ? fact.status : null,
        source: typeof fact.source === "string" ? fact.source : null,
      };
    });
  }
}
