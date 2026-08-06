import type { ParsedInvocation } from "./args.ts";
import { usageError } from "./errors.ts";

export const VERSION = "3.5.0";

const GLOBAL_OPTIONS_HELP = `Global options:
  --workspace <path>    Workspace root (default: current directory)
  --json                Emit exactly one JSON envelope to stdout
  --timeout-ms <n>      Command timeout in milliseconds
  --verbose             Include diagnostic details in JSON errors
  -h, --help            Show help
  -V, --version         Show version`;

export const ROOT_HELP = `Usage: engram [global options] <command> [args]

Commands:
  qmd                 QMD operations (coming in a later release)

${GLOBAL_OPTIONS_HELP}
`;

export const QMD_HELP = `Usage: engram [global options] qmd <command> [args]

QMD commands are not available in this build.

${GLOBAL_OPTIONS_HELP}
`;

export type RoutedSuccess =
  | { kind: "help"; command: "help" | "qmd.help"; text: string }
  | { kind: "version"; command: "version"; version: string };

export function route(invocation: ParsedInvocation): RoutedSuccess {
  const { command, options } = invocation;

  if (options.version) return { kind: "version", command: "version", version: VERSION };
  if (options.help || command === undefined) {
    return command === "qmd"
      ? { kind: "help", command: "qmd.help", text: QMD_HELP }
      : { kind: "help", command: "help", text: ROOT_HELP };
  }

  if (command === "qmd") {
    throw usageError("QMD commands are not available in this build.", {
      commandArgs: invocation.commandArgs,
    });
  }

  throw usageError(`Unknown command: ${command}`, { command });
}
