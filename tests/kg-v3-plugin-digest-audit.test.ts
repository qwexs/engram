import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const rolloutSource = readFileSync(
  resolve(import.meta.dir, "../scripts/kg-v3-live-ingress.ts"),
  "utf8",
);

describe("KG v3 live plugin digest stability", () => {
  test("builds from the canonical repository cwd", () => {
    expect(rolloutSource).toContain("process.chdir(repository)");
    expect(rolloutSource).toContain(
      'entrypoints: ["./integrations/openclaw-kg-v3/index.ts"]',
    );
    expect(rolloutSource).toContain("process.chdir(previousWorkingDirectory)");
  });

  test("declares every registered memory tool in the plugin contract", () => {
    const root = join(import.meta.dir, "..");
    const manifest = JSON.parse(readFileSync(join(root, "integrations", "openclaw-kg-v3", "openclaw.plugin.json"), "utf8"));
    const source = readFileSync(join(root, "integrations", "openclaw-kg-v3", "index.ts"), "utf8");
    for (const tool of ["engram_memory_save", "engram_memory_retract", "engram_memory_access"]) {
      expect(manifest.contracts.tools).toContain(tool);
      expect(source).toContain(tool);
    }
  });
});
