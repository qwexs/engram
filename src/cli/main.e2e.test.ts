import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

async function invoke(args: string[], env: Record<string, string> = {}) {
  const proc = Bun.spawn([process.execPath, "bin/engram", ...args], {
    cwd: root,
    env: {
      ...process.env,
      ENGRAM_WORKSPACE: undefined,
      ENGRAM_QMD: undefined,
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

describe("engram executable", () => {
  test("prints help and version", async () => {
    const help = await invoke(["--help"]);
    expect(help).toEqual(expect.objectContaining({ exitCode: 0, stderr: "" }));
    expect(help.stdout).toContain("Usage: engram");

    const version = await invoke(["--version"]);
    expect(version).toEqual(expect.objectContaining({ exitCode: 0, stderr: "" }));
    expect(version.stdout).toBe("3.6.1\n");
  });

  test("wraps JSON success output in the standard envelope", async () => {
    const result = await invoke(["--json", "--version"]);
    expect(result).toEqual(expect.objectContaining({ exitCode: 0, stderr: "" }));
    expect(JSON.parse(result.stdout)).toEqual({
      schema: "engram.cli.result.v1",
      ok: true,
      command: "version",
      meta: {
        elapsedMs: expect.any(Number),
        workspace: root,
      },
      data: { kind: "version", version: "3.6.1" },
    });
  });

  test("uses one JSON stdout envelope and no stderr for JSON errors", async () => {
    const result = await invoke(["--json", "qmd", "unknown"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toBe("");
    expect(result.stdout.endsWith("\n")).toBe(true);
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(result.stdout)).toEqual({
      schema: "engram.cli.error.v1",
      ok: false,
      error: {
        code: "USAGE",
        message: "Unknown QMD command: unknown",
      },
    });
  });

  test("resolves QMD context without invoking QMD", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "engram-cli-resolve-"));
    try {
      writeFileSync(join(workspace, "engram.json"), JSON.stringify({
        qmd: { collections: ["test-memory"], command: "definitely-not-an-executable" },
      }));
      const result = await invoke(["--json", "--workspace", workspace, "qmd", "resolve"]);
      expect(result).toEqual(expect.objectContaining({ exitCode: 0, stderr: "" }));
      expect(JSON.parse(result.stdout)).toMatchObject({
        schema: "engram.cli.result.v1",
        ok: true,
        command: "qmd.resolve",
        meta: { workspace },
        data: {
          schema: "engram.qmd.context.v1",
          workspace,
          workspaceSource: "explicit",
          selector: { kind: "global" },
          command: { executable: "definitely-not-an-executable", prefixArgs: [] },
          policy: { ownedCollections: ["test-memory"], readableCollections: ["test-memory"] },
        },
      });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("returns a JSON usage envelope even when parsing fails", async () => {
    const result = await invoke(["--json", "--timeout-ms", "0", "qmd"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: { code: "USAGE" },
    });
  });

  test("exposes read-only capabilities, status, and doctor diagnostics", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "engram-cli-diagnostics-"));
    try {
      const fixture = join(root, "tests", "fixtures", "fake-qmd.js");
      mkdirSync(join(workspace, ".qmd"));
      writeFileSync(join(workspace, ".qmd", "index.yml"), "collections: {}\n");
      writeFileSync(join(workspace, ".qmd", "index.sqlite"), "");
      writeFileSync(join(workspace, "engram.json"), JSON.stringify({
        qmd: {
          localIndex: true,
          collections: ["test-memory"],
          command: process.execPath,
          commandArgs: [fixture],
        },
      }));

      const capabilities = await invoke(["--json", "--workspace", workspace, "qmd", "capabilities"]);
      expect(capabilities).toEqual(expect.objectContaining({ exitCode: 0, stderr: "" }));
      expect(JSON.parse(capabilities.stdout)).toMatchObject({
        command: "qmd.capabilities",
        data: { schema: "engram.qmd.capabilities.v1", compatible: true },
      });

      const status = await invoke(
        ["--workspace", workspace, "qmd", "status"],
        { FAKE_QMD_STATUS_INDEX: join(workspace, ".qmd", "index.sqlite") },
      );
      expect(status).toEqual(expect.objectContaining({ exitCode: 0, stderr: "" }));
      expect(status.stdout).toContain("Context match: yes");

      const doctor = await invoke(["--json", "--workspace", workspace, "qmd", "doctor"]);
      expect(doctor.exitCode).toBe(0);
      expect(JSON.parse(doctor.stdout)).toMatchObject({
        command: "qmd.doctor",
        data: { schema: "engram.qmd.doctor.v1", healthy: true, strict: false },
      });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("doctor strict preserves one-envelope JSON errors", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "engram-cli-doctor-strict-"));
    try {
      const fixture = join(root, "tests", "fixtures", "fake-qmd.js");
      writeFileSync(join(workspace, "engram.json"), JSON.stringify({
        qmd: {
          localIndex: true,
          collection: "legacy-memory",
          command: process.execPath,
          commandArgs: [fixture],
        },
      }));
      const result = await invoke(["--json", "--workspace", workspace, "qmd", "doctor", "--strict"]);
      expect(result).toEqual(expect.objectContaining({ exitCode: 3, stderr: "" }));
      expect(result.stdout.trim().split("\n")).toHaveLength(1);
      expect(JSON.parse(result.stdout)).toMatchObject({
        schema: "engram.cli.error.v1",
        ok: false,
        error: { code: "CONTEXT", message: "QMD doctor strict checks failed." },
      });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("runs controlled reads with one JSON envelope and explicit collections", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "engram-cli-read-"));
    try {
      const fixture = join(root, "tests", "fixtures", "fake-qmd.js");
      writeFileSync(join(workspace, "engram.json"), JSON.stringify({
        qmd: {
          collections: ["life", "child"],
          command: process.execPath,
          commandArgs: [fixture],
        },
      }));
      const result = await invoke([
        "--json", "--workspace", workspace, "qmd", "search", "term",
        "-c", "life", "-c", "child", "--limit", "10",
      ]);
      expect(result).toEqual(expect.objectContaining({ exitCode: 0, stderr: "" }));
      expect(result.stdout.trim().split("\n")).toHaveLength(1);
      expect(JSON.parse(result.stdout)).toMatchObject({
        schema: "engram.cli.result.v1",
        ok: true,
        command: "qmd.search",
        meta: { workspace },
        data: {
          schema: "engram.qmd.search.v1",
          query: "term",
          collections: ["life", "child"],
          limit: 10,
          results: [{ file: "qmd://life/example.md", score: 0.9 }],
          operationRecord: { operation: "search", caller: { kind: "operator" } },
        },
      });

      const human = await invoke(["--workspace", workspace, "qmd", "query", "term", "-c", "life"]);
      expect(human).toEqual(expect.objectContaining({ exitCode: 0, stderr: "" }));
      expect(JSON.parse(human.stdout)).toEqual([{ file: "qmd://life/example.md", score: 0.9 }]);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("rejects missing collection and caller controls as usage errors before context resolution", async () => {
    for (const args of [
      ["--json", "qmd", "query", "term"],
      ["--json", "qmd", "query", "term", "-c", "life", "--caller", "heartbeat"],
      ["--json", "qmd", "query", "term", "-c", "life", "--scope", "index"],
    ]) {
      const result = await invoke(args);
      expect(result).toEqual(expect.objectContaining({ exitCode: 2, stderr: "" }));
      expect(result.stdout.trim().split("\n")).toHaveLength(1);
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, error: { code: "USAGE" } });
    }
  });
});
