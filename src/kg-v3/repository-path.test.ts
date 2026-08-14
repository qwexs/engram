import { describe, expect, test } from "bun:test";
import { posix, win32 } from "node:path";
import { repositoryFromScriptPath } from "./repository-path.ts";

describe("KG v3 repository path resolution", () => {
  test("preserves a POSIX absolute checkout path", () => {
    expect(repositoryFromScriptPath(
      "/opt/openclaw/workspace/skills/engram/scripts/kg-v3-live-ingress.ts",
      posix,
    )).toBe("/opt/openclaw/workspace/skills/engram");
  });

  test("preserves a Windows absolute checkout path", () => {
    expect(repositoryFromScriptPath(
      "C:\\Users\\Sergey\\clawd\\skills\\engram\\scripts\\kg-v3-live-ingress.ts",
      win32,
    )).toBe("C:\\Users\\Sergey\\clawd\\skills\\engram");
  });
});
