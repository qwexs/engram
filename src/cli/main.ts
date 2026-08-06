import { parseArgv, requestsJson } from "./args.ts";
import { EXIT_CODES, normalizeError } from "./errors.ts";
import { writeJsonError, writeJsonSuccess, type Writer } from "./output.ts";
import { route } from "./router.ts";

export type RunIo = {
  stdout?: Writer;
  stderr?: Writer;
};

function defaultStdout(chunk: string): void {
  process.stdout.write(chunk);
}

function defaultStderr(chunk: string): void {
  process.stderr.write(chunk);
}

export async function runCli(argv: string[], io: RunIo = {}): Promise<number> {
  const startedAt = performance.now();
  const stdout = io.stdout ?? defaultStdout;
  const stderr = io.stderr ?? defaultStderr;
  let json = requestsJson(argv);
  let verbose = false;

  try {
    const invocation = parseArgv(argv);
    json = invocation.options.json;
    verbose = invocation.options.verbose;
    const result = await route(invocation);

    if (json) {
      writeJsonSuccess(stdout, result.command, {
        elapsedMs: Math.max(0, Math.round(performance.now() - startedAt)),
        workspace: result.kind === "qmd-context"
          ? result.data.workspace
          : result.kind === "qmd-diagnostic"
            ? ("context" in result.data
                ? result.data.context.workspace
                : result.data.operationRecord.workspace)
          : invocation.options.workspace.value,
      }, result.kind === "help"
        ? { kind: result.kind, text: result.text }
        : result.kind === "version"
          ? { kind: result.kind, version: result.version }
          : result.data);
    } else if (result.kind === "help" || result.kind === "qmd-context" || result.kind === "qmd-diagnostic") {
      stdout(result.text);
    } else {
      stdout(`${result.version}\n`);
    }
    return EXIT_CODES.SUCCESS;
  } catch (error) {
    const cliError = normalizeError(error);
    if (json) {
      writeJsonError(stdout, cliError, verbose);
    } else {
      stderr(`engram: ${cliError.message}\n`);
    }
    return cliError.exitCode;
  }
}

export async function main(argv: string[]): Promise<void> {
  process.exitCode = await runCli(argv);
}
