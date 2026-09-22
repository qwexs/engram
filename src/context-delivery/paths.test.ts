import { describe, expect, test } from "bun:test";
import { isAbsolute, join } from "node:path";
import { isInside, samePath, snapshotUnchanged } from "./paths.ts";

describe("context delivery path helpers", () => {
  test("samePath treats the current platform's equivalent workspace roots as equal", () => {
    expect(samePath("/opt/openclaw/workspace", "/opt/openclaw/workspace")).toBe(true);
    expect(samePath("/opt/openclaw/workspace", "/opt/openclaw/other")).toBe(false);
  });

  test("isInside rejects siblings and parent escapes", () => {
    const root = join("/opt/openclaw", "workspace");
    expect(isInside(root, join(root, "memory", "domains"))).toBe(true);
    expect(isInside(root, root)).toBe(false);
    expect(isInside(root, join(root, "..", "other"))).toBe(false);
  });

  test.skipIf(process.platform !== "win32")("treats Windows drive-letter case and separators as the same path", () => {
    expect(samePath("C:\\Engram\\Workspace", "c:/engram/workspace")).toBe(true);
    expect(isInside("C:\\Engram\\Workspace", "c:\\engram\\workspace\\memory\\domains")).toBe(true);
    expect(isAbsolute("C:\\Engram\\audit.jsonl")).toBe(true);
  });

  test("snapshotUnchanged ignores inode identity on Windows", () => {
    const before = { size: 12, mtimeMs: 100, dev: 1, ino: 1 } as any;
    const after = { size: 12, mtimeMs: 100, dev: 2, ino: 9 } as any;
    expect(snapshotUnchanged(before, after)).toBe(process.platform === "win32");
    expect(snapshotUnchanged(before, { ...after, size: 13 })).toBe(false);
  });
});
