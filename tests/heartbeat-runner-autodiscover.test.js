// Test for the `autoDiscoverCollections` feature in heartbeat-runner.js.
// Verifies the pure parser that consumes `qmd collection list --format cli`
// output. Spawn-based behavior of discoverQmdCollections is exercised
// indirectly by ensuring the parser it delegates to is correct.

import { describe, test, expect, beforeAll } from "bun:test";

let exports;

beforeAll(async () => {
  // Import heartbeat-runner as a module. Because import.meta.main is false
  // inside this test, the runner skips main() and exposes its helpers on
  // globalThis.__engramHeartbeatRunnerExports.
  const mod = await import("../scripts/heartbeat-runner.js");
  // mod is the namespace object; helpers live on globalThis per the runner.
  exports = globalThis.__engramHeartbeatRunnerExports;
  if (!exports) {
    throw new Error("heartbeat-runner.js did not expose test helpers; check !import.meta.main gate");
  }
});

describe("parseQmdCollectionList", () => {
  test("extracts collection names from cli format output", () => {
    const stdout = [
      "Collection",
      "  sample-life (qmd://sample-life/)",
      "  sample-workspace (qmd://sample-workspace/)",
      "  openclaw-memory-agent-sample-main (qmd://openclaw-memory-agent-sample-main/)",
    ].join("\n");
    expect(exports.parseQmdCollectionList(stdout)).toEqual([
      "sample-life",
      "sample-workspace",
      "openclaw-memory-agent-sample-main",
    ]);
  });

  test("returns empty array for empty input", () => {
    expect(exports.parseQmdCollectionList("")).toEqual([]);
  });

  test("tolerates extra leading whitespace and blank lines", () => {
    const stdout = "   \n    name1 (qmd://path1/)\n\n    name2 (qmd://path2/)\n";
    expect(exports.parseQmdCollectionList(stdout)).toEqual(["name1", "name2"]);
  });

  test("ignores lines without the qmd:// annotation", () => {
    const stdout = [
      "Some header line",
      "  sample-life (qmd://sample-life/)",
      "  trailing comment without parens",
      "  another (qmd://another/)",
    ].join("\n");
    expect(exports.parseQmdCollectionList(stdout)).toEqual([
      "sample-life",
      "another",
    ]);
  });

  test("supports dashes, dots, and underscores in collection names", () => {
    const stdout =
      "  sample-life (qmd://sample-life/)\n" +
      "  openclaw-memory-agent-sample-telegram-group--12345-topic-30 (qmd://.../)\n" +
      "  my.collection_v2 (qmd://my.collection_v2/)\n";
    const result = exports.parseQmdCollectionList(stdout);
    expect(result).toContain("sample-life");
    expect(result).toContain("openclaw-memory-agent-sample-telegram-group--12345-topic-30");
    expect(result).toContain("my.collection_v2");
  });
});
