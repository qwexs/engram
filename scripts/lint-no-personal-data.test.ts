import { test, expect, describe } from "bun:test";
import { scanFile, runScan } from "./lint-no-personal-data.js";

describe("scanFile", () => {
  test("flags a Windows user path", () => {
    const src = String.raw`const x = "C:\Users\Sergey\medved";`;
    const issues = scanFile("hooks/foo/handler.ts", src);
    expect(issues.some((i) => i.pattern === "windows-user-path")).toBe(true);
  });

  test("flags a Unix home path", () => {
    const src = `const x = "/home/spastukhov/apriori.tech";`;
    const issues = scanFile("hooks/foo/handler.ts", src);
    expect(issues.some((i) => i.pattern === "unix-home-path")).toBe(true);
  });

  test("flags a reserved agentId (medved)", () => {
    const src = `expect(get("medved")).toBe("foo");`;
    const issues = scanFile("hooks/foo/tests/x.test.ts", src);
    expect(issues.some((i) => i.pattern === "reserved-agent-id")).toBe(true);
  });

  test("flags a Telegram supergroup chat id", () => {
    const src = `chatId = "-1004252667646";`;
    const issues = scanFile("hooks/foo/handler.ts", src);
    expect(issues.some((i) => i.pattern === "telegram-supergroup-chat-id")).toBe(true);
  });

  test("flags a Telegram bot token in OpenClaw form", () => {
    const src = `botToken = "7383699870:AAH_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";`;
    const issues = scanFile("config.json", src);
    expect(issues.some((i) => i.pattern === "telegram-bot-token")).toBe(true);
  });

  test("does not flag clean fixtures", () => {
    const src = `expect(get("alpha")).toBe("/workspaces/alpha");`;
    const issues = scanFile("hooks/foo/tests/x.test.ts", src);
    expect(issues).toEqual([]);
  });

  test("does not flag the linter's own source", () => {
    // Re-read this very file via fs — runScan/scanFile should short-circuit
    // when the file path matches the allowlist.
    const path = "scripts/lint-no-personal-data.ts";
    const issues = scanFile(path, "medved dobriy apriori-tech -1001234567890 C:\\\\Users\\\\Sergey");
    expect(issues).toEqual([]);
  });

  test("strips allowlist comments so the linter does not match itself", () => {
    // A user file referencing the pattern by name should NOT trigger a
    // reserved-agent-id match (the linter's allowlist-comment stripper
    // only fires for lines mentioning the pattern names themselves).
    const src = `// The pattern reserved-agent-id is defined elsewhere.\nconst a = 1;\n`;
    const issues = scanFile("hooks/foo/x.ts", src);
    expect(issues).toEqual([]);
  });

  test("computes 1-based line and column", () => {
    const src = "\n\n" + String.raw`const x = "C:\Users\Alice\x";` + "\n";
    const issues = scanFile("hooks/foo/handler.ts", src);
    const win = issues.find((i) => i.pattern === "windows-user-path");
    expect(win).toBeTruthy();
    expect(win!.line).toBe(3);
    expect(win!.column).toBeGreaterThanOrEqual(1);
  });

  test("returns multiple issues when multiple patterns match", () => {
    const src = String.raw`const a = "C:\Users\Sergey"; const b = "medved";`;
    const issues = scanFile("hooks/foo/handler.ts", src);
    expect(issues.length).toBeGreaterThanOrEqual(2);
  });
});

describe("runScan with explicit file list", () => {
  test("scans the given files and aggregates issues", () => {
    const result = runScan(["hooks/engram-topic-domain-load/tests/workspace-resolver.test.ts"]);
    // The current test file in the repo is the cleaned-up version with
    // only synthetic ids — so this should pass.
    expect(result.scanned).toBe(1);
    expect(result.issues).toEqual([]);
  });
});
