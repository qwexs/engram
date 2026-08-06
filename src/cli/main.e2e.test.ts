import { describe, expect, test } from "bun:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

async function invoke(args: string[]) {
  const proc = Bun.spawn([process.execPath, "bin/engram", ...args], {
    cwd: root,
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
    expect(version.stdout).toBe("3.5.0\n");
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
      data: { kind: "version", version: "3.5.0" },
    });
  });

  test("uses one JSON stdout envelope and no stderr for JSON errors", async () => {
    const result = await invoke(["--json", "qmd", "status"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toBe("");
    expect(result.stdout.endsWith("\n")).toBe(true);
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(result.stdout)).toEqual({
      schema: "engram.cli.error.v1",
      ok: false,
      error: {
        code: "USAGE",
        message: "QMD commands are not available in this build.",
      },
    });
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
});
