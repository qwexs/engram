import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const installer = join(root, "scripts", "install-cli.js");
const temporaryDirectories: string[] = [];

afterEach(() => {
  while (temporaryDirectories.length) rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
});

function temporaryBinDir() {
  const directory = mkdtempSync(join(tmpdir(), "engram-cli-install-"));
  temporaryDirectories.push(directory);
  return directory;
}

function run(binDir: string, ...args: string[]) {
  return Bun.spawnSync([process.execPath, installer, "--bin-dir", binDir, ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
}

function stdout(result: Bun.Subprocess<"ignore", "pipe", "pipe">) {
  return new TextDecoder().decode(result.stdout);
}

describe("install-cli", () => {
  test("dry run leaves the destination untouched", () => {
    const binDir = temporaryBinDir();
    const result = run(binDir, "--dry-run");

    expect(result.exitCode).toBe(0);
    expect(existsSync(join(binDir, "engram"))).toBe(false);
    expect(stdout(result)).toContain("Would install managed launcher");
  });

  test("refuses to overwrite or uninstall a foreign launcher", () => {
    const binDir = temporaryBinDir();
    const launcher = join(binDir, "engram");
    const foreign = "#!/usr/bin/env sh\necho foreign\n";
    writeFileSync(launcher, foreign, { mode: 0o755 });
    chmodSync(launcher, 0o755);

    expect(run(binDir).exitCode).toBe(1);
    expect(readFileSync(launcher, "utf8")).toBe(foreign);
    expect(run(binDir, "--uninstall").exitCode).toBe(1);
    expect(readFileSync(launcher, "utf8")).toBe(foreign);
  });

  test("installs idempotently and targets this checkout's CLI entrypoint", () => {
    const binDir = temporaryBinDir();
    const launcher = join(binDir, "engram");
    const first = run(binDir);

    expect(first.exitCode).toBe(0);
    const content = readFileSync(launcher, "utf8");
    expect(content).toContain("managed by scripts/install-cli.js");
    expect(content).toContain(join(root, "bin", "engram"));
    expect(stdout(first)).toContain("Post-check: engram --version → 3.5.0");

    const second = run(binDir);
    expect(second.exitCode).toBe(0);
    expect(readFileSync(launcher, "utf8")).toBe(content);
    expect(stdout(second)).toContain("already installed");

    expect(run(binDir, "--uninstall").exitCode).toBe(0);
    expect(existsSync(launcher)).toBe(false);
  });
});
