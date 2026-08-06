import type { ParsedInvocation } from "./args.ts";
import { usageError } from "./errors.ts";
import { resolveQmdContext } from "../qmd/context.ts";
import type { QmdContextData } from "../qmd/types.ts";

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
  qmd resolve         Resolve workspace QMD context (read-only)

${GLOBAL_OPTIONS_HELP}
`;

export const QMD_HELP = `Usage: engram [global options] qmd <command> [args]

QMD commands:
  resolve             Resolve workspace, index, command, and collection policy

${GLOBAL_OPTIONS_HELP}
`;

export type RoutedSuccess =
  | { kind: "help"; command: "help" | "qmd.help"; text: string }
  | { kind: "version"; command: "version"; version: string }
  | { kind: "qmd-context"; command: "qmd.resolve"; data: QmdContextData; text: string };

function formatQmdContext(data: QmdContextData): string {
  const selector = data.selector.kind === "named"
    ? `named (${data.selector.name})`
    : data.selector.kind;
  const lines = [
    `Workspace: ${data.workspace} (${data.workspaceSource})`,
    `Topology: ${data.topology}`,
    `Selector: ${selector}`,
    `Physical index: ${data.physicalIndex.path}${data.physicalIndex.exists ? "" : " (missing)"}`,
    `Index key: ${data.physicalIndex.key}`,
    `Command: ${[data.command.executable, ...data.command.prefixArgs].join(" ")}`,
    `Owned collections: ${data.policy.ownedCollections.join(", ")}`,
    `Readable collections: ${data.policy.readableCollections.join(", ")}`,
  ];
  for (const warning of data.warnings) lines.push(`Warning [${warning.code}]: ${warning.message}`);
  return `${lines.join("\n")}\n`;
}

export function route(invocation: ParsedInvocation): RoutedSuccess {
  const { command, options } = invocation;

  if (options.version) return { kind: "version", command: "version", version: VERSION };
  if (options.help || command === undefined) {
    return command === "qmd"
      ? { kind: "help", command: "qmd.help", text: QMD_HELP }
      : { kind: "help", command: "help", text: ROOT_HELP };
  }

  if (command === "qmd") {
    const [subcommand, ...args] = invocation.commandArgs;
    if (subcommand === "resolve") {
      if (args.length > 0) {
        throw usageError("engram qmd resolve does not accept command arguments.", { commandArgs: args });
      }
      const context = resolveQmdContext(options.workspace);
      const data: QmdContextData = { schema: "engram.qmd.context.v1", ...context };
      return { kind: "qmd-context", command: "qmd.resolve", data, text: formatQmdContext(data) };
    }
    throw usageError(subcommand === undefined
      ? "A QMD command is required."
      : `Unknown QMD command: ${subcommand}`, { commandArgs: invocation.commandArgs });
  }

  throw usageError(`Unknown command: ${command}`, { command });
}
