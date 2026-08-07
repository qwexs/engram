import { usageError } from "./errors.ts";

export type GlobalOptions = {
  workspace: Workspace;
  json: boolean;
  timeoutMs: number | undefined;
  verbose: boolean;
  help: boolean;
  version: boolean;
};

export type Workspace = {
  value: string;
  source: "explicit" | "env" | "cwd";
};

export type ParserRuntime = {
  cwd: () => string;
  env: Record<string, string | undefined>;
};

export type ParsedInvocation = {
  options: GlobalOptions;
  command: string | undefined;
  commandArgs: string[];
};

const DEFAULT_OPTIONS = (runtime: ParserRuntime): GlobalOptions => ({
  workspace: runtime.env.ENGRAM_WORKSPACE
    ? { value: runtime.env.ENGRAM_WORKSPACE, source: "env" }
    : { value: runtime.cwd(), source: "cwd" },
  json: false,
  timeoutMs: undefined,
  verbose: false,
  help: false,
  version: false,
});

function readValue(argv: string[], index: number, option: string): [string, number] {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw usageError(`Option ${option} requires a value.`, { option });
  }
  return [value, index + 1];
}

function setOnce<T extends keyof GlobalOptions>(
  options: GlobalOptions,
  seen: Set<string>,
  key: T,
  option: string,
  value: GlobalOptions[T],
): void {
  if (seen.has(option)) {
    throw usageError(`Option ${option} may only be specified once.`, { option });
  }
  seen.add(option);
  options[key] = value;
}

function parseTimeout(value: string): number {
  if (!/^[1-9]\d*$/.test(value)) {
    throw usageError("Option --timeout-ms must be a positive integer.", { option: "--timeout-ms", value });
  }
  const timeoutMs = Number(value);
  if (!Number.isSafeInteger(timeoutMs)) {
    throw usageError("Option --timeout-ms must be a safe integer.", { option: "--timeout-ms", value });
  }
  return timeoutMs;
}

/** Parse only the shared CLI options. Command-specific arguments remain opaque. */
export function parseArgv(argv: string[], runtime: ParserRuntime = { cwd: () => process.cwd(), env: process.env }): ParsedInvocation {
  const options = DEFAULT_OPTIONS(runtime);
  const seen = new Set<string>();
  let command: string | undefined;
  const commandArgs: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === "--") {
      if (command === undefined) {
        throw usageError("A command is required after --.");
      }
      commandArgs.push(...argv.slice(index + 1));
      break;
    }

    if (token === "--workspace" || token.startsWith("--workspace=")) {
      const [value, nextIndex] = token === "--workspace"
        ? readValue(argv, index, "--workspace")
        : [token.slice("--workspace=".length), index];
      if (value.length === 0) {
        throw usageError("Option --workspace requires a non-empty value.", { option: "--workspace" });
      }
      setOnce(options, seen, "workspace", "--workspace", { value, source: "explicit" });
      index = nextIndex;
      continue;
    }

    if (token === "--timeout-ms" || token.startsWith("--timeout-ms=")) {
      const [value, nextIndex] = token === "--timeout-ms"
        ? readValue(argv, index, "--timeout-ms")
        : [token.slice("--timeout-ms=".length), index];
      setOnce(options, seen, "timeoutMs", "--timeout-ms", parseTimeout(value));
      index = nextIndex;
      continue;
    }

    if (token === "--json") {
      setOnce(options, seen, "json", "--json", true);
      continue;
    }
    if (token === "--verbose") {
      setOnce(options, seen, "verbose", "--verbose", true);
      continue;
    }
    if (token === "--help" || token === "-h") {
      setOnce(options, seen, "help", "--help", true);
      continue;
    }
    if (token === "--version" || token === "-V") {
      setOnce(options, seen, "version", "--version", true);
      continue;
    }

    if (command === undefined) {
      if (token.startsWith("-")) {
        throw usageError(`Unknown global option: ${token}`, { option: token });
      }
      command = token;
      continue;
    }

    commandArgs.push(token);
  }

  if (options.help && options.version) {
    throw usageError("Options --help and --version cannot be used together.");
  }

  return { options, command, commandArgs };
}

/** Best-effort detection lets malformed JSON invocations retain JSON-only output. */
export function requestsJson(argv: string[]): boolean {
  return argv.some((token) => token === "--json");
}
