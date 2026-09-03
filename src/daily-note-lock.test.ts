import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("shared daily-note writer lock", () => {
  test("serializes independent processes without losing either canonical append", async () => {
    const root = mkdtempSync(join(tmpdir(), "daily-note-lock-"));
    roots.push(root);
    const notePath = join(root, "2026-08-27.md");
    writeFileSync(notePath, "base\n");
    const modulePath = join(import.meta.dir, "daily-note-lock.ts");
    const program = `
      import { readFileSync, writeFileSync } from "node:fs";
      import { withDailyNoteLock } from ${JSON.stringify(modulePath)};
      const notePath = process.argv[1];
      const token = process.argv[2];
      withDailyNoteLock(notePath, () => {
        const current = readFileSync(notePath, "utf8");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 75);
        writeFileSync(notePath, current + token + "\\n", "utf8");
      });
    `;
    const first = Bun.spawn(["bun", "-e", program, notePath, "first"], { stdout: "pipe", stderr: "pipe" });
    const second = Bun.spawn(["bun", "-e", program, notePath, "second"], { stdout: "pipe", stderr: "pipe" });
    expect(await first.exited).toBe(0);
    expect(await second.exited).toBe(0);
    const content = readFileSync(notePath, "utf8");
    expect(content).toContain("first\n");
    expect(content).toContain("second\n");
  });
});
