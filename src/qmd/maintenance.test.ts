import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CliError } from "../cli/errors.ts";
import {
  markQmdDirty,
  qmdMaintenancePaths,
  readQmdMaintenanceState,
  runQmdMaintenance,
  type QmdMaintenanceExecutor,
} from "./maintenance.ts";
import type {
  QmdCallerContext,
  QmdContext,
  QmdInvocation,
  QmdRunResult,
} from "./types.ts";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const fakeQmd = join(repositoryRoot, "tests", "fixtures", "fake-qmd.js");
const tempRoots: string[] = [];

function harness(): { root: string; stateRoot: string; context: QmdContext; caller: QmdCallerContext; log: string } {
  const root = mkdtempSync(join(tmpdir(), "engram-maintenance-"));
  tempRoots.push(root);
  const workspace = join(root, "workspace");
  const bin = join(root, "bin");
  mkdirSync(workspace);
  mkdirSync(bin);
  const executable = join(bin, "fake-qmd");
  copyFileSync(fakeQmd, executable);
  chmodSync(executable, 0o755);
  return {
    root,
    stateRoot: join(root, "state"),
    context: {
      workspace,
      workspaceSource: "explicit",
      topology: "shared",
      selector: { kind: "named", name: "global" },
      physicalIndex: { path: join(root, "global.sqlite"), key: "global-index-key", exists: false },
      command: { executable, prefixArgs: [] },
      policy: {
        ownedCollections: ["main-technical"],
        readableCollections: ["main-technical"],
      },
      warnings: [],
    },
    caller: {
      kind: "coordinator",
      capabilities: ["maintenance"],
      allowedCollections: ["main-technical", "project-alpha", "project-beta"],
    },
    log: join(root, "qmd.log"),
  };
}

function fakeRun(invocation: QmdInvocation, ok = true, structuredData?: unknown): QmdRunResult {
  return {
    schema: "engram.qmd.run.v1",
    ok,
    stdout: structuredData === undefined ? "" : JSON.stringify(structuredData),
    stderr: ok ? "" : "fake failure",
    exitCode: ok ? 0 : 9,
    signal: null,
    timedOut: false,
    ...(structuredData === undefined ? {} : { structuredData }),
    operationRecord: {
      schema: "engram.qmd.operation.v1",
      command: "qmd",
      operation: invocation.operation,
      operationClass: "maintenance",
      workspace: invocation.cwd,
      topology: "shared",
      indexKey: invocation.indexKey,
      effectiveScope: invocation.effectiveScope,
      collections: invocation.collections,
      caller: { kind: "coordinator" },
      policyDecision: {
        schema: "engram.qmd.policy-decision.v1",
        allowed: true,
        code: invocation.operation === "embed" ? "ALLOW_COORDINATED_EMBED" : "ALLOW_INDEX_UPDATE",
        reason: "test",
        caller: { kind: "coordinator" },
        operation: invocation.operation,
        effectiveScope: invocation.effectiveScope,
        collections: invocation.collections,
      },
      invocation,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      elapsedMs: 1,
      exitCode: ok ? 0 : 9,
      signal: null,
      timedOut: false,
    },
  };
}

function embedSuccess(invocation: QmdInvocation): QmdRunResult {
  return fakeRun(invocation, true, {
    schema: "qmd.embed.v1",
    status: "ok",
    pendingBefore: 1,
    pendingAfter: 0,
    skippedReason: null,
  });
}

afterEach(() => {
  while (tempRoots.length > 0) rmSync(tempRoots.pop()!, { recursive: true, force: true });
});

describe("QMD maintenance dirty state", () => {
  test("coalesces concurrent marks into one monotonic generation", async () => {
    const { stateRoot, context } = harness();
    await Promise.all(Array.from({ length: 100 }, (_, index) => markQmdDirty(stateRoot, {
      indexKey: context.physicalIndex.key,
      collections: [index % 2 === 0 ? "project-alpha" : "project-beta"],
      reason: `write-${index}`,
    })));

    const state = readQmdMaintenanceState(stateRoot, context.physicalIndex.key);
    expect(state.generation).toBe(100);
    expect(state.dirty).toMatchObject({ bm25: true, vectors: true });
    expect(state.dirty.collections).toEqual(["project-alpha", "project-beta"]);
    expect(state.dirty.reasons).toHaveLength(32);
  });

  test("rejects vector dirtiness without an explicit collection", async () => {
    const { stateRoot, context } = harness();
    await expect(markQmdDirty(stateRoot, {
      indexKey: context.physicalIndex.key,
      reason: "missing-scope",
    })).rejects.toBeInstanceOf(CliError);
  });
});

describe("runQmdMaintenance", () => {
  test("does not spawn QMD for clean state", async () => {
    const h = harness();
    let calls = 0;
    const execute: QmdMaintenanceExecutor = async (_context, invocation) => {
      calls += 1;
      return fakeRun(invocation);
    };
    const result = await runQmdMaintenance({
      context: h.context,
      caller: h.caller,
      collections: h.caller.allowedCollections,
      stateRoot: h.stateRoot,
      execute,
    });
    expect(result.status).toBe("clean");
    expect(calls).toBe(0);
  });

  test("runs one index-wide update then one scoped incremental embed", async () => {
    const h = harness();
    await markQmdDirty(h.stateRoot, {
      indexKey: h.context.physicalIndex.key,
      collections: ["project-alpha"],
      reason: "daily-note-write",
    });
    const invocations: QmdInvocation[] = [];
    const execute: QmdMaintenanceExecutor = async (_context, invocation) => {
      invocations.push(invocation);
      return invocation.operation === "embed" ? embedSuccess(invocation) : fakeRun(invocation);
    };

    const result = await runQmdMaintenance({
      context: h.context,
      caller: h.caller,
      collections: ["main-technical", "project-alpha", "project-beta"],
      stateRoot: h.stateRoot,
      execute,
    });

    expect(result.status).toBe("ok");
    expect(invocations.map((entry) => entry.operation)).toEqual(["update", "embed"]);
    expect(invocations[0]!.argv).not.toContain("-c");
    expect(invocations[1]!.argv).toEqual([
      "--index", "global", "embed", "--format", "json",
      "-c", "main-technical", "-c", "project-alpha", "-c", "project-beta",
    ]);
    expect(invocations[1]!.argv).not.toContain("-f");
    expect(readQmdMaintenanceState(h.stateRoot, h.context.physicalIndex.key).dirty).toEqual({
      bm25: false,
      vectors: false,
      collections: [],
      reasons: [],
    });
  });

  test("preserves dirty state and skips embed when update fails", async () => {
    const h = harness();
    await markQmdDirty(h.stateRoot, {
      indexKey: h.context.physicalIndex.key,
      collections: ["project-alpha"],
      reason: "write",
    });
    const calls: string[] = [];
    const result = await runQmdMaintenance({
      context: h.context,
      caller: h.caller,
      collections: h.caller.allowedCollections,
      stateRoot: h.stateRoot,
      execute: async (_context, invocation) => {
        calls.push(invocation.operation);
        return fakeRun(invocation, false);
      },
    });
    expect(result.status).toBe("partial");
    expect(calls).toEqual(["update"]);
    expect(readQmdMaintenanceState(h.stateRoot, h.context.physicalIndex.key).dirty)
      .toMatchObject({ bm25: true, vectors: true });
  });

  test("keeps vectors dirty after an incomplete embed", async () => {
    const h = harness();
    await markQmdDirty(h.stateRoot, {
      indexKey: h.context.physicalIndex.key,
      collections: ["project-alpha"],
      reason: "write",
    });
    const result = await runQmdMaintenance({
      context: h.context,
      caller: h.caller,
      collections: h.caller.allowedCollections,
      stateRoot: h.stateRoot,
      execute: async (_context, invocation) => invocation.operation === "update"
        ? fakeRun(invocation)
        : fakeRun(invocation, true, {
            schema: "qmd.embed.v1", status: "ok", pendingAfter: 2, skippedReason: null,
          }),
    });
    expect(result.status).toBe("partial");
    expect(readQmdMaintenanceState(h.stateRoot, h.context.physicalIndex.key).dirty)
      .toMatchObject({ bm25: false, vectors: true });
  });

  test("accepts the normal no-pending-documents embed result as complete", async () => {
    const h = harness();
    await markQmdDirty(h.stateRoot, {
      indexKey: h.context.physicalIndex.key,
      collections: ["project-alpha"],
      reason: "write",
    });
    const result = await runQmdMaintenance({
      context: h.context,
      caller: h.caller,
      collections: h.caller.allowedCollections,
      stateRoot: h.stateRoot,
      execute: async (_context, invocation) => invocation.operation === "update"
        ? fakeRun(invocation)
        : fakeRun(invocation, true, {
            schema: "qmd.embed.v1",
            status: "ok",
            pendingBefore: 0,
            pendingAfter: 0,
            skippedReason: "no-pending-documents",
          }),
    });
    expect(result.status).toBe("ok");
    expect(readQmdMaintenanceState(h.stateRoot, h.context.physicalIndex.key).dirty.vectors).toBe(false);
  });

  test("fails closed when dirty collections are outside the run maintenance scope", async () => {
    const h = harness();
    await markQmdDirty(h.stateRoot, {
      indexKey: h.context.physicalIndex.key,
      collections: ["project-beta"],
      reason: "write",
    });
    let calls = 0;
    const result = await runQmdMaintenance({
      context: h.context,
      caller: h.caller,
      collections: ["main-technical", "project-alpha"],
      stateRoot: h.stateRoot,
      execute: async (_context, invocation) => {
        calls += 1;
        return fakeRun(invocation);
      },
    });
    expect(result.status).toBe("error");
    expect(result.error?.message).toContain("project-beta");
    expect(calls).toBe(0);
    expect(readQmdMaintenanceState(h.stateRoot, h.context.physicalIndex.key).dirty.vectors).toBe(true);
  });

  test("does not lose a mark that arrives during maintenance", async () => {
    const h = harness();
    await markQmdDirty(h.stateRoot, {
      indexKey: h.context.physicalIndex.key,
      collections: ["project-alpha"],
      reason: "first",
    });
    let markedDuringRun = false;
    const result = await runQmdMaintenance({
      context: h.context,
      caller: h.caller,
      collections: h.caller.allowedCollections,
      stateRoot: h.stateRoot,
      execute: async (_context, invocation) => {
        if (invocation.operation === "update" && !markedDuringRun) {
          markedDuringRun = true;
          await markQmdDirty(h.stateRoot, {
            indexKey: h.context.physicalIndex.key,
            collections: ["project-beta"],
            reason: "second",
          });
        }
        return invocation.operation === "embed" ? embedSuccess(invocation) : fakeRun(invocation);
      },
    });
    const state = readQmdMaintenanceState(h.stateRoot, h.context.physicalIndex.key);
    expect(result.status).toBe("ok");
    expect(result.observedGeneration).toBe(1);
    expect(state.generation).toBe(2);
    expect(state.dirty).toMatchObject({ bm25: true, vectors: true });
    expect(state.dirty.collections).toEqual(["project-alpha", "project-beta"]);
  });

  test("defers a second coordinator while the physical-index lease is live", async () => {
    const h = harness();
    await markQmdDirty(h.stateRoot, {
      indexKey: h.context.physicalIndex.key,
      collections: ["project-alpha"],
      reason: "write",
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const execute: QmdMaintenanceExecutor = async (_context, invocation) => {
      if (invocation.operation === "update") {
        entered();
        await gate;
      }
      return invocation.operation === "embed" ? embedSuccess(invocation) : fakeRun(invocation);
    };
    const first = runQmdMaintenance({
      context: h.context, caller: h.caller, collections: h.caller.allowedCollections,
      stateRoot: h.stateRoot, execute,
    });
    await started;
    const second = await runQmdMaintenance({
      context: h.context, caller: h.caller, collections: h.caller.allowedCollections,
      stateRoot: h.stateRoot, execute,
    });
    expect(second.status).toBe("deferred");
    release();
    expect((await first).status).toBe("ok");
  });

  test("recovers an expired coordinator lease", async () => {
    const h = harness();
    await markQmdDirty(h.stateRoot, {
      indexKey: h.context.physicalIndex.key,
      collections: ["project-alpha"],
      reason: "write",
    });
    const paths = qmdMaintenancePaths(h.stateRoot, h.context.physicalIndex.key);
    mkdirSync(paths.lease, { recursive: true });
    writeFileSync(paths.leaseMetadata, JSON.stringify({
      schema: "engram.qmd.maintenance-lease.v1",
      token: "stale",
      indexKey: h.context.physicalIndex.key,
      pid: 1,
      acquiredAt: "2000-01-01T00:00:00.000Z",
      renewedAt: "2000-01-01T00:00:00.000Z",
      expiresAt: "2000-01-01T00:00:01.000Z",
    }));
    const result = await runQmdMaintenance({
      context: h.context,
      caller: h.caller,
      collections: h.caller.allowedCollections,
      stateRoot: h.stateRoot,
      execute: async (_context, invocation) => invocation.operation === "embed"
        ? embedSuccess(invocation)
        : fakeRun(invocation),
    });
    expect(result.status).toBe("ok");
    expect(result.recoveredStaleLease).toBe(true);
  });

  test("rejects unauthorized coordinator collections before spawn", async () => {
    const h = harness();
    let calls = 0;
    await expect(runQmdMaintenance({
      context: h.context,
      caller: h.caller,
      collections: ["foreign"],
      stateRoot: h.stateRoot,
      execute: async (_context, invocation) => {
        calls += 1;
        return fakeRun(invocation);
      },
    })).rejects.toMatchObject({ code: "POLICY_DENIED" });
    expect(calls).toBe(0);
  });

  test("executes the hermetic fake QMD with exact update/embed argv", async () => {
    const h = harness();
    await markQmdDirty(h.stateRoot, {
      indexKey: h.context.physicalIndex.key,
      collections: ["project-alpha"],
      reason: "integration",
    });
    const result = await runQmdMaintenance({
      context: h.context,
      caller: h.caller,
      collections: ["main-technical", "project-alpha"],
      stateRoot: h.stateRoot,
      env: { FAKE_QMD_LOG: h.log },
    });
    expect(result.status).toBe("ok");
    const lines = readFileSync(h.log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(lines).toEqual([
      ["--index", "global", "update"],
      ["--index", "global", "embed", "--format", "json", "-c", "main-technical", "-c", "project-alpha"],
    ]);
    expect(lines.flat()).not.toContain("-f");
  });
});
