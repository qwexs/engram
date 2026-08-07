#!/usr/bin/env bun

/**
 * Install the lightweight `engram` launcher without publishing a package.
 *
 * The launcher deliberately has a narrow ownership marker and an exact
 * expected body.  That lets install stay idempotent while uninstall refuses
 * to remove a file it did not create.
 */

import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const MIN_BUN_MINOR = 3;
const SKILL_ROOT = realpathSync(resolve(import.meta.dir, ".."));
const CLI_ENTRYPOINT = join(SKILL_ROOT, "bin", "engram");

function usage() {
  return `Usage: bun scripts/install-cli.js [options]

Install a local \`engram\` launcher for this checkout.

Options:
  --bin-dir <path>  Destination directory (default: $BUN_INSTALL/bin or ~/.bun/bin)
  --dry-run         Print the action without changing files
  --uninstall       Remove only the exact launcher created by this script
  -h, --help        Show help
`;
}

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  const options = { dryRun: false, uninstall: false, binDir: null, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--uninstall") options.uninstall = true;
    else if (arg === "--bin-dir") {
      const value = argv[++index];
      if (!value || value.startsWith("-")) fail("--bin-dir requires a path.");
      options.binDir = value;
    } else if (arg === "-h" || arg === "--help") options.help = true;
    else fail(`Unknown option: ${arg}`);
  }
  return options;
}

function assertBunRuntime() {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(Bun.version);
  if (!match) fail(`Could not parse Bun runtime version: ${Bun.version}`);
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major !== 1 || minor < MIN_BUN_MINOR) {
    fail(`Engram CLI requires Bun >=1.3.0 <2 (found ${Bun.version}).`);
  }
}

function defaultBinDir() {
  return join(process.env.BUN_INSTALL || join(homedir(), ".bun"), "bin");
}

function shellQuote(value) {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function launcherName() {
  return process.platform === "win32" ? "engram.cmd" : "engram";
}

function launcherContent() {
  if (process.platform === "win32") {
    return [
      "@echo off",
      "REM Engram CLI launcher — managed by scripts/install-cli.js; do not edit.",
      `\"${process.execPath}\" \"${CLI_ENTRYPOINT}\" %*`,
      "",
    ].join("\r\n");
  }
  return [
    "#!/usr/bin/env sh",
    "# Engram CLI launcher — managed by scripts/install-cli.js; do not edit.",
    `exec ${shellQuote(process.execPath)} ${shellQuote(CLI_ENTRYPOINT)} \"$@\"`,
    "",
  ].join("\n");
}

function ownedLauncher(path, expected) {
  try {
    return lstatSync(path).isFile() && readFileSync(path, "utf8") === expected;
  } catch {
    return false;
  }
}

function removeOwnedLauncher(path, expected) {
  if (!ownedLauncher(path, expected)) {
    fail(`Refusing to remove foreign launcher: ${path}`);
  }
  unlinkSync(path);
}

function postCheck(path) {
  const result = Bun.spawnSync([path, "--version"], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    const detail = new TextDecoder().decode(result.stderr).trim();
    fail(`Post-check failed: engram --version${detail ? `: ${detail}` : ""}`);
  }
  const version = new TextDecoder().decode(result.stdout).trim();
  if (!version) fail("Post-check failed: engram --version returned no version.");
  console.log(`Post-check: engram --version → ${version}`);
}

export function installCli(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(usage());
    return;
  }
  assertBunRuntime();

  const binDir = resolve(options.binDir || defaultBinDir());
  const path = join(binDir, launcherName());
  const expected = launcherContent();

  if (options.uninstall) {
    if (!existsSync(path)) {
      console.log(`Engram CLI launcher is not installed: ${path}`);
      return;
    }
    if (!ownedLauncher(path, expected)) {
      fail(`Refusing to remove foreign launcher: ${path}`);
    }
    if (options.dryRun) {
      console.log(`Would remove managed launcher: ${path}`);
      return;
    }
    removeOwnedLauncher(path, expected);
    console.log(`Removed managed launcher: ${path}`);
    return;
  }

  if (existsSync(path)) {
    if (!ownedLauncher(path, expected)) {
      fail(`Refusing to overwrite foreign launcher: ${path}`);
    }
    if (options.dryRun) {
      console.log(`Would verify existing managed launcher: ${path}`);
      return;
    }
    postCheck(path);
    console.log(`Engram CLI launcher already installed: ${path}`);
    return;
  }

  if (options.dryRun) {
    console.log(`Would install managed launcher: ${path}`);
    console.log(`Launcher target: ${CLI_ENTRYPOINT}`);
    return;
  }

  mkdirSync(binDir, { recursive: true });
  let created = false;
  try {
    const descriptor = openSync(path, "wx", 0o755);
    try {
      writeSync(descriptor, expected);
    } finally {
      closeSync(descriptor);
    }
    chmodSync(path, 0o755);
    created = true;
  } catch (error) {
    if (ownedLauncher(path, expected)) {
      postCheck(path);
      console.log(`Engram CLI launcher already installed: ${path}`);
      return;
    }
    throw error;
  }

  try {
    postCheck(path);
  } catch (error) {
    // Only clean up an exact launcher we just wrote.  A replacement by another
    // process is foreign and must be left untouched.
    if (created && ownedLauncher(path, expected)) unlinkSync(path);
    throw error;
  }
  console.log(`Installed Engram CLI launcher: ${path}`);
}

if (import.meta.main) {
  try {
    installCli();
  } catch (error) {
    console.error(`install-cli: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
