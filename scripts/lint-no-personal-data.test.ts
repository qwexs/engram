import { test, expect, describe } from "bun:test";
import {
  deploymentIdentifierRegex,
  scanFile,
  scanText,
  runScan,
  workspaceHostRegex,
} from "./lint-no-personal-data.js";

describe("scanFile", () => {
  test("flags a Windows user path", () => {
    const src = String.raw`const x = "C:\Users\Alice\private-agent-a";`;
    const issues = scanFile("hooks/foo/handler.ts", src);
    expect(issues.some((i) => i.pattern === "windows-user-path")).toBe(true);
  });

  test("flags a Unix home path", () => {
    const src = `const x = "/home/alice/corp.example";`;
    const issues = scanFile("hooks/foo/handler.ts", src);
    expect(issues.some((i) => i.pattern === "unix-home-path")).toBe(true);
  });

  test("builds a deployment identifier matcher from env", () => {
    const previous = process.env.ENGRAM_LINT_IDENTIFIERS;
    try {
      process.env.ENGRAM_LINT_IDENTIFIERS = "private-agent-a,Приватный Проект";
      expect(deploymentIdentifierRegex().test("agent:private-agent-a:main")).toBe(true);
      expect(deploymentIdentifierRegex().test("Проект: Приватный Проект")).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.ENGRAM_LINT_IDENTIFIERS;
      else process.env.ENGRAM_LINT_IDENTIFIERS = previous;
    }
  });

  test("flags a Telegram supergroup chat id", () => {
    const src = `chatId = "-1004252667646";`;
    const issues = scanFile("hooks/foo/handler.ts", src);
    expect(issues.some((i) => i.pattern === "telegram-supergroup-chat-id")).toBe(true);
  });

  test("flags an ordinary Telegram user id in an explicit field", () => {
    const src = `telegramUserId = "987654321";`;
    const issues = scanFile("config.json", src);
    expect(issues.some((i) => i.pattern === "telegram-user-id")).toBe(true);
  });

  test("flags an ordinary Telegram user id embedded in a direct-session key", () => {
    const src = `session = "telegram-owner-direct-987654321";`;
    const issues = scanFile("config.json", src);
    expect(issues.some((i) => i.pattern === "telegram-user-id")).toBe(true);
  });

  test("does not flag the documented synthetic Telegram user id fixture", () => {
    const src = `userId = "100000001"; session = "telegram-alice-direct-100000001";`;
    const issues = scanFile("config.json", src);
    expect(issues.some((i) => i.pattern === "telegram-user-id")).toBe(false);
  });

  test("flags a Telegram bot token in OpenClaw form", () => {
    const src = `botToken = "7383699870:AAH_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";`;
    const issues = scanFile("config.json", src);
    expect(issues.some((i) => i.pattern === "telegram-bot-token")).toBe(true);
  });

  test("ENGRAM_LINT_HOSTS configures the private host list", () => {
    // Test the regex builder directly (not via scanFile, which captures
    // its regex at module-load time). Setting the env before importing
    // is awkward in a test runner, so we just exercise the builder.
    // Note: a global regex with `g` flag has stateful `lastIndex`, so we
    // call .test() once per freshly-built regex (or reset lastIndex)
    // to avoid the second call starting mid-string.
    const prev = process.env.ENGRAM_LINT_HOSTS;
    try {
      process.env.ENGRAM_LINT_HOSTS = "foo.example.com";
      expect(workspaceHostRegex().test("https://foo.example.com/x")).toBe(true);
      expect(workspaceHostRegex().test("https://other.org/x")).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.ENGRAM_LINT_HOSTS;
      else process.env.ENGRAM_LINT_HOSTS = prev;
    }
  });

  test("scanText bypasses the allowlist (used by commit-msg hook)", () => {
    // scanText is the pure pattern-matcher; it does not check the source
    // label against ALLOWLIST. This is intentional: the commit-msg hook
    // passes the path to .git/COMMIT_EDITMSG, which is not in the
    // allowlist, and we still want issues to be reported with that path.
    const issues = scanText(
      String.raw`const x = "C:\Users\Alice\x";`,
      "COMMIT_EDITMSG",
    );
    expect(issues.some((i) => i.pattern === "windows-user-path")).toBe(true);
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
    const issues = scanFile(path, "private-agent-a -1001234567890 C:\\\\Users\\\\Alice");
    expect(issues).toEqual([]);
  });

  test("strips allowlist comments so the linter does not match itself", () => {
    // A user file referencing the pattern by name should NOT trigger a
    // deployment-identifier match (the linter's allowlist-comment stripper
    // only fires for lines mentioning the pattern names themselves).
    const src = `// The pattern deployment-identifier is defined elsewhere.\nconst a = 1;\n`;
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
    const src = String.raw`const a = "C:\Users\Alice"; const b = "-1001234567890";`;
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
