import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CliError, EXIT_CODES } from "../cli/errors.ts";
import {
  inspectQmdCapabilities,
  inspectQmdDoctor,
  inspectQmdStatus,
} from "./diagnostics.ts";
import type { QmdContext } from "./types.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const fixture = join(repoRoot, "tests", "fixtures", "fake-qmd.js");
const tempRoots: string[] = [];

function harness(options: { warnings?: QmdContext["warnings"]; indexExists?: boolean } = {}): QmdContext {
  const root = mkdtempSync(join(tmpdir(), "engram-diagnostics-"));
  tempRoots.push(root);
  const indexPath = join(root, ".qmd", "index.sqlite");
  mkdirSync(join(root, ".qmd"));
  return {
    workspace: root,
    workspaceSource: "explicit",
    topology: "isolated",
    selector: { kind: "local" },
    physicalIndex: { path: indexPath, key: "test-index-key", exists: options.indexExists ?? false },
    command: { executable: process.execPath, prefixArgs: [fixture] },
    policy: { ownedCollections: ["self-memory", "life"], readableCollections: ["self-memory", "life"] },
    warnings: options.warnings ?? [],
  };
}

async function expectCliError(promise: Promise<unknown>, code: CliError["code"], exitCode: number): Promise<CliError> {
  try {
    await promise;
    throw new Error("expected CliError");
  } catch (error) {
    expect(error).toBeInstanceOf(CliError);
    expect(error).toMatchObject({ code, exitCode });
    return error as CliError;
  }
}

afterEach(() => {
  while (tempRoots.length > 0) rmSync(tempRoots.pop()!, { recursive: true, force: true });
});

describe("QMD diagnostics", () => {
  test("validates the minimum live capabilities contract", async () => {
    const data = await inspectQmdCapabilities(harness());
    expect(data).toMatchObject({
      schema: "engram.qmd.capabilities.v1",
      compatible: true,
      qmd: {
        schema: "qmd.capabilities.v1",
        version: "2.6.3-fork.2",
        embed: {
          multipleCollections: true,
          indexScopedLock: true,
          structuredOutput: true,
        },
      },
      operationRecord: { operation: "capabilities", operationClass: "diagnostic" },
    });
    expect(data.operationRecord.qmd).toMatchObject({
      version: "2.6.3-fork.2",
      capabilities: { multipleCollections: true, indexScopedLock: true, structuredOutput: true },
    });
  });

  test.each([
    ["malformed", "QMD_OPERATION_FAILED", EXIT_CODES.QMD_OPERATION_FAILED],
    ["schema-mismatch", "DEPENDENCY_UNAVAILABLE", EXIT_CODES.DEPENDENCY_ERROR],
    ["version-missing", "DEPENDENCY_UNAVAILABLE", EXIT_CODES.DEPENDENCY_ERROR],
    ["missing-capability", "DEPENDENCY_UNAVAILABLE", EXIT_CODES.DEPENDENCY_ERROR],
  ] as const)("maps incompatible capabilities mode %s", async (mode, code, exitCode) => {
    await expectCliError(
      inspectQmdCapabilities(harness(), { runner: { env: { FAKE_QMD_CAPABILITIES_MODE: mode } } }),
      code,
      exitCode,
    );
  });

  test("parses and strictly matches the actual status index", async () => {
    const context = harness({ indexExists: true });
    const data = await inspectQmdStatus(context, {
      runner: { env: { FAKE_QMD_STATUS_INDEX: context.physicalIndex.path } },
    });
    expect(data).toMatchObject({
      schema: "engram.qmd.status.v1",
      index: {
        expectedPath: context.physicalIndex.path,
        actualPath: context.physicalIndex.path,
        key: "test-index-key",
        exists: true,
        matches: true,
      },
    });
  });

  test("maps missing or mismatched status index output", async () => {
    const malformed = harness();
    await expectCliError(
      inspectQmdStatus(malformed, { runner: { env: { FAKE_QMD_STATUS_MODE: "malformed" } } }),
      "QMD_OPERATION_FAILED",
      EXIT_CODES.QMD_OPERATION_FAILED,
    );

    const mismatch = harness();
    await expectCliError(
      inspectQmdStatus(mismatch, { runner: { env: { FAKE_QMD_STATUS_INDEX: "/different/index.sqlite" } } }),
      "CONTEXT",
      EXIT_CODES.CONTEXT_ERROR,
    );
  });

  test("maps unavailable, non-zero, and timeout runner results", async () => {
    const unavailable = harness();
    unavailable.command.executable = join(unavailable.workspace, "missing-qmd");
    await expectCliError(
      inspectQmdCapabilities(unavailable),
      "DEPENDENCY_UNAVAILABLE",
      EXIT_CODES.DEPENDENCY_ERROR,
    );

    await expectCliError(
      inspectQmdCapabilities(harness(), { runner: { env: { FAKE_QMD_MODE: "non-zero" } } }),
      "QMD_OPERATION_FAILED",
      EXIT_CODES.QMD_OPERATION_FAILED,
    );

    await expectCliError(
      inspectQmdCapabilities(harness(), {
        timeoutMs: 40,
        runner: { env: { FAKE_QMD_MODE: "timeout", FAKE_QMD_DELAY_MS: "60000" } },
      }),
      "TIMEOUT_CANCELLED",
      EXIT_CODES.TIMEOUT_CANCELLED,
    );
  });

  test("doctor aggregates read-only checks and strict mode fails on warnings", async () => {
    const warning = {
      code: "LEGACY_COLLECTION_NORMALIZED" as const,
      message: "Legacy collection normalized.",
    };
    const context = harness({ warnings: [warning], indexExists: false });
    const data = await inspectQmdDoctor(context, false);
    expect(data).toMatchObject({
      schema: "engram.qmd.doctor.v1",
      healthy: false,
      strict: false,
      warnings: [warning],
      checks: [
        { id: "context", status: "warn" },
        { id: "ownership", status: "pass" },
        { id: "physical-index", status: "warn" },
        { id: "capabilities", status: "pass" },
      ],
    });

    await expectCliError(
      inspectQmdDoctor(context, true),
      "CONTEXT",
      EXIT_CODES.CONTEXT_ERROR,
    );
  });

  test("doctor retains capability failures and strict mode preserves their typed exit", async () => {
    const context = harness({ indexExists: true });
    const options = { runner: { env: { FAKE_QMD_CAPABILITIES_MODE: "missing-capability" } } };
    const data = await inspectQmdDoctor(context, false, options);
    expect(data.healthy).toBe(false);
    expect(data.checks.at(-1)).toMatchObject({
      id: "capabilities",
      status: "fail",
      errorCode: "DEPENDENCY_UNAVAILABLE",
    });
    await expectCliError(
      inspectQmdDoctor(context, true, options),
      "DEPENDENCY_UNAVAILABLE",
      EXIT_CODES.DEPENDENCY_ERROR,
    );
  });

  test("doctor includes the status identity check and fails on an index mismatch", async () => {
    const context = harness({ indexExists: true });
    const options = { runner: { env: { FAKE_QMD_STATUS_INDEX: "/different/index.sqlite" } } };
    const data = await inspectQmdDoctor(context, false, options);
    expect(data.checks.find((check) => check.id === "physical-index")).toMatchObject({
      status: "fail",
      errorCode: "CONTEXT",
    });
    expect(data.status).toBeUndefined();
    await expectCliError(
      inspectQmdDoctor(context, true, options),
      "CONTEXT",
      EXIT_CODES.CONTEXT_ERROR,
    );
  });
});
