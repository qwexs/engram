import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  markGlobalQmdBackfill,
  runGlobalQmdMaintenance,
  runWorkspaceQmdMaintenance,
} from "./maintenance-adapter.ts";
import type { QmdMaintenanceExecutor } from "./maintenance.ts";

function workspace(mode: "legacy" | "shadow" | "coordinated", index = "sample-global"): string {
  const root = mkdtempSync(join(tmpdir(), "engram-maintenance-adapter-"));
  writeFileSync(join(root, "engram.json"), JSON.stringify({
    agent: "agent-test",
    qmd: {
      collection: "test-memory",
      collections: ["test-memory", "test-domains"],
      index,
      maintenance: { mode },
    },
  }));
  return root;
}

function okResult(invocation: Parameters<QmdMaintenanceExecutor>[1]) {
  return {
    schema: "engram.qmd.run.v1" as const,
    ok: true,
    stdout: invocation.operation === "embed"
      ? JSON.stringify({ schema: "qmd.embed.v1", status: "complete", pendingAfter: 0, errors: 0 })
      : "",
    stderr: "",
    exitCode: 0,
    signal: null,
    timedOut: false,
    operationRecord: {} as never,
  };
}

describe("workspace maintenance adapter", () => {
  test("runs legacy update/embed through typed invocations without shell", async () => {
    const calls: Array<{ operation: string; argv: string[] }> = [];
    const execute: QmdMaintenanceExecutor = async (_context, invocation) => {
      calls.push({ operation: invocation.operation, argv: invocation.argv });
      return okResult(invocation);
    };
    const result = await runWorkspaceQmdMaintenance({ workspace: workspace("legacy"), execute });
    expect(result.status).toBe("ok");
    expect(calls.map((entry) => entry.operation)).toEqual(["update", "embed"]);
    expect(calls[0]!.argv).toEqual(["--index", "sample-global", "update"]);
    expect(calls[1]!.argv).toEqual([
      "--index", "sample-global", "embed", "--format", "json",
      "-c", "test-memory", "-c", "test-domains",
    ]);
    expect(calls.flatMap((entry) => entry.argv)).not.toContain("-f");
  });

  test("supports a no-embed legacy maintenance gate", async () => {
    const calls: string[] = [];
    const execute: QmdMaintenanceExecutor = async (_context, invocation) => {
      calls.push(invocation.operation);
      return okResult(invocation);
    };
    const result = await runWorkspaceQmdMaintenance({
      workspace: workspace("shadow"),
      execute,
      skipEmbed: true,
    });
    expect(result.status).toBe("ok");
    expect(calls).toEqual(["update"]);
  });

  test("delegates coordinated workspace heartbeats without executing QMD", async () => {
    let calls = 0;
    const result = await runWorkspaceQmdMaintenance({
      workspace: workspace("coordinated"),
      execute: async () => {
        calls += 1;
        throw new Error("must not execute");
      },
    });
    expect(result.status).toBe("delegated");
    expect(calls).toBe(0);
  });
});

describe("global maintenance adapter", () => {
  test("requires coordinated mode and the expected named index", async () => {
    await expect(runGlobalQmdMaintenance({
      workspace: workspace("legacy"),
      collections: ["test-memory"],
      expectedIndex: "sample-global",
      stateRoot: mkdtempSync(join(tmpdir(), "engram-maintenance-state-")),
    })).rejects.toThrow("mode=coordinated");

    await expect(runGlobalQmdMaintenance({
      workspace: workspace("coordinated", "other-global"),
      collections: ["test-memory"],
      expectedIndex: "sample-global",
      stateRoot: mkdtempSync(join(tmpdir(), "engram-maintenance-state-")),
    })).rejects.toThrow("expected named QMD index");
  });

  test("a clean coordinated state launches no QMD process", async () => {
    let calls = 0;
    const result = await runGlobalQmdMaintenance({
      workspace: workspace("coordinated"),
      collections: ["test-domains", "test-memory"],
      expectedIndex: "sample-global",
      stateRoot: mkdtempSync(join(tmpdir(), "engram-maintenance-state-")),
      execute: async () => {
        calls += 1;
        throw new Error("clean state must not execute");
      },
    });
    expect(result.status).toBe("clean");
    expect(calls).toBe(0);
  });

  test("marks an explicit initial-backfill batch vector-dirty without executing QMD", async () => {
    const root = workspace("coordinated");
    const stateRoot = mkdtempSync(join(tmpdir(), "engram-maintenance-state-"));
    const state = await markGlobalQmdBackfill({
      workspace: root,
      collections: ["test-memory"],
      expectedIndex: "sample-global",
      stateRoot,
    });
    expect(state.dirty).toMatchObject({ bm25: false, vectors: true, collections: ["test-memory"] });
  });
});
