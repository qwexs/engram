import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildQmdInvocation } from "./invocation.ts";
import { CliError, EXIT_CODES } from "../cli/errors.ts";
import { authorizeQmdInvocation } from "./policy.ts";
import { runQmdInvocation, runQmdInvocationSync } from "./runner.ts";
import type { QmdCallerContext, QmdContext, QmdInvocation } from "./types.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const fixture = join(root, "tests", "fixtures", "fake-qmd.js");
const tempRoots: string[] = [];

function harness(): { context: QmdContext; log: string } {
  const temp = mkdtempSync(join(tmpdir(), "engram runner "));
  tempRoots.push(temp);
  const workspace = join(temp, "workspace with spaces");
  mkdirSync(workspace);
  return {
    context: {
      workspace,
      workspaceSource: "explicit",
      topology: "shared",
      selector: { kind: "named", name: "team" },
      physicalIndex: { path: join(temp, "team.sqlite"), key: "test-index-key", exists: false },
      command: { executable: process.execPath, prefixArgs: [fixture] },
      policy: { ownedCollections: ["self-memory", "life"], readableCollections: ["self-memory", "life"] },
      warnings: [],
    },
    log: join(temp, "invocations.log"),
  };
}

function runnerOptions(
  context: QmdContext,
  invocation: QmdInvocation,
  env?: Record<string, string>,
) {
  const caller: QmdCallerContext = invocation.operation === "update" || invocation.operation === "embed"
    ? { kind: "provisioning", capabilities: ["maintenance"], allowedCollections: [] }
    : invocation.operation === "search" || invocation.operation === "query" || invocation.operation === "vsearch"
      ? { kind: "main", capabilities: ["read"], allowedCollections: [...invocation.collections] }
      : { kind: "operator", capabilities: ["diagnostics"], allowedCollections: [] };
  return { env, caller, decision: authorizeQmdInvocation(context, invocation, caller) };
}

afterEach(() => {
  while (tempRoots.length > 0) rmSync(tempRoots.pop()!, { recursive: true, force: true });
});

describe("runQmdInvocation", () => {
  test("uses argv-only spawn with canonical cwd and matching PWD, including paths with spaces", async () => {
    const { context } = harness();
    const invocation = buildQmdInvocation(context, { operation: "status" });
    const result = await runQmdInvocation(context, invocation, runnerOptions(context, invocation, { FAKE_QMD_MODE: "inspect" }));

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      args: ["--index", "team", "status"],
      cwd: context.workspace,
      pwd: context.workspace,
    });
    expect(result.operationRecord).toMatchObject({
      schema: "engram.qmd.operation.v1",
      command: "qmd",
      operation: "status",
      operationClass: "diagnostic",
      workspace: context.workspace,
      topology: "shared",
      indexKey: "test-index-key",
      effectiveScope: "index",
      collections: [],
      caller: { kind: "operator" },
      policyDecision: { allowed: true, code: "ALLOW_OPERATOR_DIAGNOSTIC" },
      exitCode: 0,
      timedOut: false,
    });
  });

  test("drains large stdout and stderr concurrently", async () => {
    const { context } = harness();
    const invocation = buildQmdInvocation(context, { operation: "status" });
    const result = await runQmdInvocation(context, invocation, runnerOptions(context, invocation, {
      FAKE_QMD_MODE: "large-output", FAKE_QMD_OUTPUT_BYTES: "524288",
    }));

    expect(result.ok).toBe(true);
    expect(result.stdout).toHaveLength(524288);
    expect(result.stderr).toHaveLength(524288);
  });

  test("returns a non-zero result without retrying", async () => {
    const { context, log } = harness();
    const invocation = buildQmdInvocation(context, { operation: "update" });
    const result = await runQmdInvocation(context, invocation, runnerOptions(context, invocation, {
      FAKE_QMD_MODE: "non-zero", FAKE_QMD_EXIT_CODE: "12", FAKE_QMD_LOG: log,
    }));

    expect(result).toMatchObject({ ok: false, exitCode: 12, timedOut: false });
    expect(result.stdout).toContain("fake stdout");
    expect(result.stderr).toContain("fake stderr");
    expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(1);
  });

  test("kills a timed-out process and awaits its exit", async () => {
    const { context } = harness();
    const invocation = buildQmdInvocation(context, { operation: "status", timeoutMs: 50 });
    const started = performance.now();
    const result = await runQmdInvocation(context, invocation, runnerOptions(context, invocation, {
      FAKE_QMD_MODE: "timeout", FAKE_QMD_DELAY_MS: "60000",
    }));

    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
    expect(result.operationRecord.completedAt).toEqual(expect.any(String));
    expect(performance.now() - started).toBeLessThan(3_000);
  });

  test("kills the timed-out process group without leaving a child orphan", async () => {
    const { context } = harness();
    const marker = join(dirname(context.workspace), "orphan-marker");
    const invocation = buildQmdInvocation(context, { operation: "status", timeoutMs: 50 });
    const result = await runQmdInvocation(context, invocation, runnerOptions(context, invocation, {
      FAKE_QMD_MODE: "timeout-child", FAKE_QMD_CHILD_MARKER: marker,
    }));

    expect(result.timedOut).toBe(true);
    await Bun.sleep(650);
    expect(existsSync(marker)).toBe(false);
  });

  test("parses valid requested JSON and reports invalid structured output without changing exit semantics", async () => {
    const { context } = harness();
    const invocation = buildQmdInvocation(context, {
      operation: "query",
      query: "term",
      collections: ["life"],
    });
    const valid = await runQmdInvocation(context, invocation, runnerOptions(context, invocation, { FAKE_QMD_MODE: "inspect" }));
    expect(valid.ok).toBe(true);
    expect(valid.structuredData).toMatchObject({ cwd: context.workspace });
    expect(valid.parseError).toBeUndefined();

    const invalid = await runQmdInvocation(context, invocation, runnerOptions(context, invocation, {
      FAKE_QMD_MODE: "large-output", FAKE_QMD_OUTPUT_BYTES: "16",
    }));
    expect(invalid.ok).toBe(true);
    expect(invalid.parseError).toMatchObject({ code: "INVALID_STRUCTURED_OUTPUT" });
    expect(invalid.structuredData).toBeUndefined();
  });

  test("returns a typed spawn error", async () => {
    const { context } = harness();
    context.command.executable = join(context.workspace, "missing executable");
    const invocation = buildQmdInvocation(context, { operation: "status" });
    const result = await runQmdInvocation(context, invocation, runnerOptions(context, invocation));

    expect(result).toMatchObject({
      ok: false,
      exitCode: null,
      timedOut: false,
      spawnError: { code: "SPAWN_FAILED" },
    });
  });

  test("refuses a stale or mismatched allowed decision before spawn", async () => {
    const { context } = harness();
    const invocation = buildQmdInvocation(context, { operation: "query", query: "term", collections: ["life"] });
    const options = runnerOptions(context, invocation);
    const tampered = { ...invocation, collections: ["self-memory"] };
    try {
      await runQmdInvocation(context, tampered, options);
      throw new Error("expected policy denial");
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      expect(error).toMatchObject({ code: "POLICY_DENIED", exitCode: EXIT_CODES.POLICY_DENIED });
    }
  });

  test("re-evaluates policy against current context and omits session data from records", async () => {
    const { context } = harness();
    const invocation = buildQmdInvocation(context, { operation: "query", query: "term", collections: ["life"] });
    const caller: QmdCallerContext = {
      kind: "topic",
      sessionKey: "sensitive-session-key",
      domain: "alpha",
      capabilities: ["read"],
      allowedCollections: ["life"],
    };
    const decision = authorizeQmdInvocation(context, invocation, caller);
    context.policy.readableCollections = ["self-memory"];
    await expect(runQmdInvocation(context, invocation, { caller, decision }))
      .rejects.toMatchObject({ code: "POLICY_DENIED" });

    context.policy.readableCollections = ["self-memory", "life"];
    const result = await runQmdInvocation(context, invocation, {
      caller,
      decision,
      env: { FAKE_QMD_MODE: "inspect" },
    });
    expect(result.operationRecord.caller).toEqual({ kind: "topic" });
    expect(JSON.stringify(result.operationRecord)).not.toContain("sensitive-session-key");
  });
});

describe("runQmdInvocationSync", () => {
  test("preserves the typed policy and argv boundary for legacy synchronous diagnostics", () => {
    const { context } = harness();
    const invocation = buildQmdInvocation(context, { operation: "collection-list" });
    const result = runQmdInvocationSync(context, invocation, runnerOptions(context, invocation, { FAKE_QMD_MODE: "inspect" }));
    expect(result).toMatchObject({ ok: true, exitCode: 0 });
    expect(JSON.parse(result.stdout)).toEqual({
      args: ["--index", "team", "collection", "list"],
      cwd: context.workspace,
      pwd: context.workspace,
    });
    expect(result.operationRecord).toMatchObject({ operation: "collection-list", operationClass: "diagnostic" });
  });
});
