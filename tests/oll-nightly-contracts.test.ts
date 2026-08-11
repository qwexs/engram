import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { OLL_CONTRACT_VERSION, OLL_HANDOFF_SCHEMA, validateNightlyOrchestrationDeclaration } from "../src/oll/contracts";

const FIXTURES = join(import.meta.dir, "fixtures", "oll-nightly");

function readJson(path: string): Record<string, any> {
  return JSON.parse(readFileSync(path, "utf8"));
}

describe("OLL nightly PR 0 contracts", () => {
  test("publishes stable TypeScript contract identities", () => {
    expect(OLL_CONTRACT_VERSION).toBe(1);
    expect(OLL_HANDOFF_SCHEMA).toBe("oll.rethink-handoff.v2");
  });

  test("target workspace fixtures cover all required workspace classes", () => {
    const root = join(FIXTURES, "workspaces");
    const classes = readdirSync(root).sort();
    expect(classes).toEqual(["company", "meta-domain", "personal", "project"]);
    const ids = classes.map((kind) => readJson(join(root, kind, "engram.json")).workspace.id);
    expect(ids.sort()).toEqual(["company", "main", "managers", "project-alpha"]);
    for (const kind of classes) {
      const config = readJson(join(root, kind, "engram.json"));
      expect(config.oll).toMatchObject({
        scheduleOwner: "nightly",
        nightly: { enabled: true, handoffTimeoutSeconds: 900, batchTimeoutSeconds: 21600 },
        adaptation: { mode: "observe-only", maxActionsPerHandoff: 50 },
      });
      expect(config.models.heartbeat.subagents["hb-rethink"]).toBeTruthy();
    }
  });

  test("registry fixture is immutable-order input, not a path scan", () => {
    const registry = readJson(join(FIXTURES, "registry-snapshot.json"));
    expect(registry.schema).toBe("oll.workspace-registry-snapshot.v1");
    expect(registry.entries.map((entry: any) => entry.workspaceId)).toEqual([
      "company",
      "main",
      "managers",
      "project-alpha",
    ]);
    expect(registry.entries.every((entry: any) => entry.registryDigest.startsWith("sha256:"))).toBe(true);
  });

  test("accepts the trusted script declaration", () => {
    const declaration = readJson(join(FIXTURES, "orchestration-declaration.json"));
    expect(validateNightlyOrchestrationDeclaration(declaration)).toEqual({ ok: true, errors: [] });
  });

  test("rejects a scheduler payload without spawn, watcher, or durable resume", () => {
    const invalid = {
      schema: "oll.nightly-orchestration-declaration.v1",
      kind: "script",
      schedulerCount: 2,
      capabilities: ["exec"],
      helpers: [],
      durableState: false,
      resumePolicy: "durable-batch",
      usesIntervalPolling: true,
      maxActiveRethinkRuns: 2,
      handoffTimeoutSeconds: 900,
      batchTimeoutSeconds: 900,
    };
    const result = validateNightlyOrchestrationDeclaration(invalid);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("capabilities must include sessions_spawn");
    expect(result.errors).toContain("helpers must include oll-await-handoff");
    expect(result.errors).toContain("durableState must be true");
    expect(result.errors).toContain("usesIntervalPolling must be false");
    expect(result.errors).toContain("maxActiveRethinkRuns must equal 1");
    expect(result.errors).toContain("schedulerCount must equal 1");
  });
});
