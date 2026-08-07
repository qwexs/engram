import { describe, expect, test } from "bun:test";
import packageJson from "../../package.json" with { type: "json" };
import { parseArgv } from "./args.ts";
import { CliError, EXIT_CODES, EXIT_CODE_SEMANTICS } from "./errors.ts";
import { route, VERSION } from "./router.ts";

describe("route", () => {
  test("routes root and qmd help without invoking QMD", async () => {
    expect(await route(parseArgv([]))).toMatchObject({ kind: "help" });
    expect(await route(parseArgv(["qmd", "--help"]))).toMatchObject({
      kind: "help",
      text: expect.stringContaining("resolve"),
    });
  });

  test("returns the CLI version", async () => {
    expect(await route(parseArgv(["--version"]))).toEqual({
      kind: "version",
      command: "version",
      version: VERSION,
    });
    expect(VERSION).toBe(packageJson.version);
  });

  test("marks unknown qmd commands as usage errors", async () => {
    try {
      await route(parseArgv(["qmd", "unknown"]));
      throw new Error("expected route to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      expect(error).toMatchObject({ code: "USAGE", exitCode: EXIT_CODES.USAGE_ERROR });
    }
  });

  test("reserves the full stable exit-code table", () => {
    expect(EXIT_CODES).toEqual({
      SUCCESS: 0,
      INTERNAL_ERROR: 1,
      USAGE_ERROR: 2,
      CONTEXT_ERROR: 3,
      POLICY_DENIED: 4,
      DEPENDENCY_ERROR: 5,
      QMD_OPERATION_FAILED: 6,
      TIMEOUT_CANCELLED: 7,
      DEFERRED_PARTIAL: 8,
    });
    expect(EXIT_CODE_SEMANTICS[3]).toBe("configuration or context error");
    expect(EXIT_CODE_SEMANTICS[4]).toBe("policy denied");
    expect(EXIT_CODE_SEMANTICS[8]).toBe("deferred or partial");
  });

  test("marks unknown root commands as usage errors", async () => {
    await expect(route(parseArgv(["unknown"]))).rejects.toThrow("Unknown command: unknown");
  });

  test("does not expose caller, scope, or admin elevation flags", async () => {
    await expect(route(parseArgv(["qmd", "capabilities", "--caller", "heartbeat"])))
      .rejects.toThrow("does not accept command arguments");
    await expect(route(parseArgv(["qmd", "status", "--scope=index"])))
      .rejects.toThrow("does not accept command arguments");
    expect(() => parseArgv(["--admin", "qmd", "doctor"])).toThrow("Unknown global option");
  });
});
