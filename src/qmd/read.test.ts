import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CliError, EXIT_CODES } from "../cli/errors.ts";
import { executeQmdRead } from "./read.ts";
import type { QmdContext } from "./types.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const fixture = join(root, "tests", "fixtures", "fake-qmd.js");
const tempRoots: string[] = [];

function harness(named = false): QmdContext {
  const workspace = mkdtempSync(join(tmpdir(), "engram-read-"));
  tempRoots.push(workspace);
  return {
    workspace,
    workspaceSource: "explicit",
    topology: named ? "shared" : "isolated",
    selector: named ? { kind: "named", name: "team" } : { kind: "local" },
    physicalIndex: { path: join(workspace, "index.sqlite"), key: "key", exists: false },
    command: { executable: process.execPath, prefixArgs: [fixture] },
    policy: { ownedCollections: ["life"], readableCollections: ["life", "child"] },
    warnings: [],
  };
}

async function expectCode(promise: Promise<unknown>, code: number): Promise<void> {
  try {
    await promise;
    throw new Error("expected failure");
  } catch (error) {
    expect(error).toBeInstanceOf(CliError);
    expect(error).toMatchObject({ exitCode: code });
  }
}

afterEach(() => {
  while (tempRoots.length) rmSync(tempRoots.pop()!, { recursive: true, force: true });
});

describe("executeQmdRead", () => {
  test("authorizes multi-collection reads and emits real QMD -n syntax", async () => {
    const context = harness(true);
    const log = join(context.workspace, "argv.log");
    const result = await executeQmdRead(context, {
      operation: "query", query: "term", collections: ["life", "child"], limit: 10,
    }, { env: { FAKE_QMD_LOG: log } });
    expect(result.data).toMatchObject({
      schema: "engram.qmd.query.v1",
      query: "term",
      collections: ["life", "child"],
      limit: 10,
      results: [{ file: "qmd://life/example.md", score: 0.9 }],
      operationRecord: { operation: "query", policyDecision: { code: "ALLOW_COLLECTION_READ" } },
    });
    expect(JSON.parse(readFileSync(log, "utf8"))).toEqual([
      "--index", "team", "query", "term", "--format", "json",
      "-c", "life", "-c", "child", "-n", "10",
    ]);
  });

  test("denies an unreadable collection before spawn", async () => {
    const context = harness();
    const log = join(context.workspace, "argv.log");
    await expectCode(executeQmdRead(context, {
      operation: "search", query: "term", collections: ["private"],
    }, { env: { FAKE_QMD_LOG: log } }), EXIT_CODES.POLICY_DENIED);
    expect(existsSync(log)).toBe(false);
  });

  test.each([
    [{ FAKE_QMD_MODE: "non-zero" }, EXIT_CODES.QMD_OPERATION_FAILED],
    [{ FAKE_QMD_READ_MODE: "malformed" }, EXIT_CODES.QMD_OPERATION_FAILED],
    [{ FAKE_QMD_READ_MODE: "object" }, EXIT_CODES.QMD_OPERATION_FAILED],
  ] as const)("maps runner failure %#", async (env, exitCode) => {
    await expectCode(executeQmdRead(harness(), {
      operation: "vsearch", query: "term", collections: ["life"],
    }, { env: { ...env } }), exitCode);
  });

  test("maps timeout", async () => {
    await expectCode(executeQmdRead(harness(), {
      operation: "search", query: "term", collections: ["life"], timeoutMs: 20,
    }, { env: { FAKE_QMD_MODE: "timeout" } }), EXIT_CODES.TIMEOUT_CANCELLED);
  });

  test("maps an unavailable QMD executable as a dependency error", async () => {
    const context = harness();
    context.command.executable = join(context.workspace, "missing-qmd");
    await expectCode(executeQmdRead(context, {
      operation: "query", query: "term", collections: ["life"],
    }), EXIT_CODES.DEPENDENCY_ERROR);
  });
});
