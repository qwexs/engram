import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

function source(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

describe("KG v3 automatic legacy producer retirement", () => {
  test("mechanical extraction has no executable v2 writer branch", () => {
    const body = source("scripts/extract-runner.js");
    expect(body).not.toContain("memory-write.js");
    expect(body).not.toContain("resolveAutomaticIngress");
    expect(body).not.toContain("findSupersedeTarget");
  });

  test("domain and OLL handoffs can only suppress retired promotions", () => {
    const domains = source("scripts/domains-runner.js");
    const handoff = source("scripts/process-handoff-core.js");
    const observations = source("scripts/memory-promote.js");
    expect(domains).not.toContain("memory-write.js");
    expect(domains).not.toContain("runPromotion(");
    expect(handoff).not.toContain("resolveAutomaticIngress");
    expect(observations).not.toContain("memory-write.js");
    expect(observations).not.toContain("Bun.spawn(");
    expect(observations).toContain("promotion is retired");
  });

  test("configuration cannot re-enable automatic KG ingress", () => {
    expect(source("scripts/config.js")).not.toContain("resolveAutomaticIngress");
    expect(source("assets/templates/engram.json")).not.toContain("automaticIngress");
  });

  test("remaining v2 maintenance mutators share the KG v3 authority guard", () => {
    for (const path of [
      "scripts/memory-access-buffer.js",
      "scripts/flush-access-buffer.js",
      "scripts/memory-repair.js",
      "scripts/audit-superseded.js",
      "scripts/validate.js",
      "scripts/migrate-v2.js",
    ]) {
      expect(source(path)).toContain("legacyKgMutationState");
    }
  });

});
