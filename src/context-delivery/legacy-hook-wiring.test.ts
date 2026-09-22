import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "../..");

function source(relative: string): string {
  return readFileSync(join(root, relative), "utf8");
}

describe("legacy delivery owner cutover wiring", () => {
  test("all four legacy delivery hooks consult the shared policy", () => {
    for (const path of [
      "hooks/engram-kg-context-load/handler.ts",
      "hooks/engram-rule-context-load/handler.ts",
      "hooks/engram-topic-domain-load/handler.ts",
      "hooks/engram-peer-domain-load/handler.ts",
    ]) {
      const value = source(path);
      expect(value).toContain("legacyDeliveryAllowed");
      expect(value.match(/legacyDeliveryAllowed\(/g)).toHaveLength(1);
    }
  });

  test("the shared gate runs before legacy mutation or source resolution", () => {
    const kg = source("hooks/engram-kg-context-load/handler.ts");
    expect(kg.indexOf("legacyDeliveryAllowed(workspace, event)")).toBeLessThan(kg.indexOf("const context = resolveKgDefaultContext"));
    const oll = source("hooks/engram-rule-context-load/handler.ts");
    expect(oll.indexOf("legacyDeliveryAllowed(workspace, event)")).toBeLessThan(oll.indexOf("baseBootstrapFiles ="));
    for (const path of [
      "hooks/engram-topic-domain-load/handler.ts",
      "hooks/engram-peer-domain-load/handler.ts",
    ]) {
      const value = source(path);
      expect(value).toContain("reactivateArchived: false");
      expect(value.indexOf("legacyDeliveryAllowed(preflight.workspaceDir, event)")).toBeLessThan(value.indexOf("? resolveDomainFromEvent(event"));
    }
  });
});
