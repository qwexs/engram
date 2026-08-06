import type { ParsedInvocation } from "./args.ts";
import { usageError } from "./errors.ts";
import { resolveQmdContext } from "../qmd/context.ts";
import {
  inspectQmdCapabilities,
  inspectQmdDoctor,
  inspectQmdStatus,
  type QmdCapabilitiesData,
  type QmdDoctorData,
  type QmdStatusData,
} from "../qmd/diagnostics.ts";
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
  qmd capabilities    Validate QMD runtime capabilities (read-only)
  qmd status          Verify the physical QMD index (read-only)
  qmd doctor          Run read-only QMD checks

${GLOBAL_OPTIONS_HELP}
`;

export const QMD_HELP = `Usage: engram [global options] qmd <command> [args]

QMD commands:
  resolve             Resolve workspace, index, command, and collection policy
  capabilities        Validate the QMD capability contract
  status              Verify QMD uses the resolved physical index
  doctor [--strict]   Run read-only checks; strict fails on warnings

${GLOBAL_OPTIONS_HELP}
`;

export type RoutedSuccess =
  | { kind: "help"; command: "help" | "qmd.help"; text: string }
  | { kind: "version"; command: "version"; version: string }
  | { kind: "qmd-context"; command: "qmd.resolve"; data: QmdContextData; text: string }
  | {
      kind: "qmd-diagnostic";
      command: "qmd.capabilities" | "qmd.status" | "qmd.doctor";
      data: QmdCapabilitiesData | QmdStatusData | QmdDoctorData;
      text: string;
    };

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

function formatCapabilities(data: QmdCapabilitiesData): string {
  return [
    `QMD version: ${data.qmd.version}`,
    `Capabilities schema: ${data.qmd.schema}`,
    "Embed multiple collections: yes",
    "Index-scoped lock: yes",
    "Structured embed output: yes",
    "",
  ].join("\n");
}

function formatStatus(data: QmdStatusData): string {
  return [
    `Physical index: ${data.index.actualPath}`,
    `Index key: ${data.index.key}`,
    `Exists: ${data.index.exists ? "yes" : "no"}`,
    "Context match: yes",
    "",
  ].join("\n");
}

function formatDoctor(data: QmdDoctorData): string {
  const lines = [`QMD doctor: ${data.healthy ? "healthy" : "issues found"}`];
  for (const check of data.checks) {
    const marker = check.status === "pass" ? "PASS" : check.status === "warn" ? "WARN" : "FAIL";
    lines.push(`[${marker}] ${check.id}: ${check.message}`);
  }
  for (const warning of data.warnings) lines.push(`[WARN] ${warning.code}: ${warning.message}`);
  lines.push("");
  return lines.join("\n");
}

export async function route(invocation: ParsedInvocation): Promise<RoutedSuccess> {
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
    if (subcommand === "capabilities" || subcommand === "status") {
      if (args.length > 0) {
        throw usageError(`engram qmd ${subcommand} does not accept command arguments.`, { commandArgs: args });
      }
      const context = resolveQmdContext(options.workspace);
      if (subcommand === "capabilities") {
        const data = await inspectQmdCapabilities(context, { timeoutMs: options.timeoutMs });
        return {
          kind: "qmd-diagnostic",
          command: "qmd.capabilities",
          data,
          text: formatCapabilities(data),
        };
      }
      const data = await inspectQmdStatus(context, { timeoutMs: options.timeoutMs });
      return { kind: "qmd-diagnostic", command: "qmd.status", data, text: formatStatus(data) };
    }
    if (subcommand === "doctor") {
      if (args.length > 1 || (args.length === 1 && args[0] !== "--strict")) {
        throw usageError("engram qmd doctor accepts only --strict.", { commandArgs: args });
      }
      const context = resolveQmdContext(options.workspace);
      const data = await inspectQmdDoctor(context, args[0] === "--strict", { timeoutMs: options.timeoutMs });
      return { kind: "qmd-diagnostic", command: "qmd.doctor", data, text: formatDoctor(data) };
    }
    throw usageError(subcommand === undefined
      ? "A QMD command is required."
      : `Unknown QMD command: ${subcommand}`, { commandArgs: invocation.commandArgs });
  }

  throw usageError(`Unknown command: ${command}`, { command });
}
