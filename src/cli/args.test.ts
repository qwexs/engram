import { describe, expect, test } from "bun:test";
import { parseArgv } from "./args.ts";

describe("parseArgv", () => {
  test("parses global options around a command", () => {
    const parsed = parseArgv([
      "--workspace=/tmp/workspace",
      "qmd",
      "search",
      "memory",
      "--timeout-ms",
      "2500",
      "--json",
      "--verbose",
    ]);

    expect(parsed).toEqual({
      command: "qmd",
      commandArgs: ["search", "memory"],
      options: {
        workspace: { value: "/tmp/workspace", source: "explicit" },
        timeoutMs: 2500,
        json: true,
        verbose: true,
        help: false,
        version: false,
      },
    });
  });

  test("keeps command-specific flags opaque", () => {
    const parsed = parseArgv(["qmd", "search", "--collection", "life"]);
    expect(parsed.commandArgs).toEqual(["search", "--collection", "life"]);
  });

  test("resolves workspace by explicit option, then environment, then cwd", () => {
    const previous = process.env.ENGRAM_WORKSPACE;
    try {
      process.env.ENGRAM_WORKSPACE = "/env/workspace";
      expect(parseArgv(["qmd"]).options.workspace).toEqual({
        value: "/env/workspace",
        source: "env",
      });
      expect(parseArgv(["--workspace", "/explicit/workspace", "qmd"]).options.workspace).toEqual({
        value: "/explicit/workspace",
        source: "explicit",
      });

      delete process.env.ENGRAM_WORKSPACE;
      expect(parseArgv(["qmd"], {
        cwd: () => "/cwd/workspace",
        env: process.env,
      }).options.workspace).toEqual({ value: "/cwd/workspace", source: "cwd" });
    } finally {
      if (previous === undefined) delete process.env.ENGRAM_WORKSPACE;
      else process.env.ENGRAM_WORKSPACE = previous;
    }
  });

  test("rejects malformed global options", () => {
    expect(() => parseArgv(["--timeout-ms", "0", "qmd"])).toThrow(
      "Option --timeout-ms must be a positive integer.",
    );
    expect(() => parseArgv(["--unknown", "qmd"])).toThrow("Unknown global option: --unknown");
    expect(() => parseArgv(["--json", "--json", "qmd"])).toThrow(
      "Option --json may only be specified once.",
    );
  });
});
