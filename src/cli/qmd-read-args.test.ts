import { describe, expect, test } from "bun:test";
import { CliError } from "./errors.ts";
import { parseQmdReadArgs } from "./qmd-read-args.ts";

describe("parseQmdReadArgs", () => {
  test("accepts one query, repeated collections, and a bounded limit", () => {
    expect(parseQmdReadArgs(["memory query", "-c", "life", "--collection", "child", "--limit", "10"]))
      .toEqual({ query: "memory query", collections: ["life", "child"], limit: 10 });
  });

  test.each([
    [["term"], "at least one"],
    [["-c", "life"], "exactly one"],
    [["term", "extra", "-c", "life"], "exactly one"],
    [["term", "-c", "life", "--limit", "0"], "1 to 100"],
    [["term", "-c", "life", "--limit", "101"], "1 to 100"],
    [["term", "-c", "life", "--bogus"], "Unknown"],
  ] as const)("rejects invalid argv %#", (argv, message) => {
    expect(() => parseQmdReadArgs([...argv])).toThrow(CliError);
    expect(() => parseQmdReadArgs([...argv])).toThrow(message);
  });
});
