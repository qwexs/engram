import { usageError } from "./errors.ts";
import { MAX_QMD_READ_LIMIT } from "../qmd/invocation.ts";

export type ParsedQmdReadArgs = {
  query: string;
  collections: string[];
  limit?: number;
};

function requiredValue(args: string[], index: number, option: string): string {
  const value = args[index + 1];
  if (value === undefined || value.trim() === "" || value.startsWith("-")) {
    throw usageError(`${option} requires a value.`);
  }
  return value;
}

export function parseQmdReadArgs(args: string[]): ParsedQmdReadArgs {
  const collections: string[] = [];
  let query: string | undefined;
  let limit: number | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "-c" || arg === "--collection") {
      collections.push(requiredValue(args, index, arg));
      index += 1;
      continue;
    }
    if (arg === "--limit") {
      if (limit !== undefined) throw usageError("--limit may be specified only once.");
      const raw = requiredValue(args, index, arg);
      const parsed = Number(raw);
      if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > MAX_QMD_READ_LIMIT) {
        throw usageError(`--limit must be an integer from 1 to ${MAX_QMD_READ_LIMIT}.`, { limit: raw });
      }
      limit = parsed;
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) throw usageError(`Unknown QMD read option: ${arg}`);
    if (arg.trim() === "") throw usageError("QMD query must be non-empty.");
    if (query !== undefined) throw usageError("QMD read commands accept exactly one query.");
    query = arg;
  }

  if (query === undefined) throw usageError("QMD read commands require exactly one non-empty query.");
  if (collections.length === 0) throw usageError("QMD read commands require at least one -c/--collection.");
  return { query, collections, ...(limit === undefined ? {} : { limit }) };
}
