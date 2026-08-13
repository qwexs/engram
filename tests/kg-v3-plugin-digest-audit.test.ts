import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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
});
