import { contextError } from "../cli/errors.ts";
import { isAbsolute } from "node:path";
import type {
  QmdContext,
  QmdEffectiveScope,
  QmdInvocation,
  QmdInvocationRequest,
  QmdOperation,
  RedactedQmdInvocation,
} from "./types.ts";

export const DEFAULT_QMD_TIMEOUT_MS = 30_000;
export const MAX_QMD_READ_LIMIT = 100;

const STRUCTURED_OPERATIONS = new Set<QmdOperation>([
  "capabilities",
  "search",
  "query",
  "vsearch",
  "embed",
]);

const COLLECTION_SCOPED_OPERATIONS = new Set<QmdOperation>([
  "search",
  "query",
  "vsearch",
  "embed",
]);

const SENSITIVE_NAME = "(?:api[-_]?key|token|secret|password|authorization|credential)";
const SENSITIVE_OPTION = new RegExp(`^--?[\\w-]*${SENSITIVE_NAME}[\\w-]*$`, "i");
const SENSITIVE_ASSIGNMENT = new RegExp(`^(--?[\\w-]*${SENSITIVE_NAME}[\\w-]*)=(.*)$`, "i");
const MAX_LOGGED_QUERY_CHARS = 120;

export function requestsStructuredOutput(operation: QmdOperation): boolean {
  return STRUCTURED_OPERATIONS.has(operation);
}

function normalizedTimeout(timeoutMs: number | undefined): number {
  const value = timeoutMs ?? DEFAULT_QMD_TIMEOUT_MS;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw contextError("QMD timeout must be a positive safe integer.", { timeoutMs: value });
  }
  return value;
}

function normalizedCollections(values: string[], operation: QmdOperation): string[] {
  if (!Array.isArray(values) || values.some((value) => typeof value !== "string" || value.trim() === "")) {
    throw contextError(`QMD ${operation} collections must be non-empty strings.`, { operation });
  }
  const collections = [...new Set(values.map((value) => value.trim()))];
  if (collections.length === 0) {
    throw contextError(`QMD ${operation} requires at least one collection.`, { operation });
  }
  return collections;
}

function normalizedReadLimit(limit: number | undefined): number | undefined {
  if (limit === undefined) return undefined;
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_QMD_READ_LIMIT) {
    throw contextError(`QMD read limit must be an integer from 1 to ${MAX_QMD_READ_LIMIT}.`, { limit });
  }
  return limit;
}

function collectionArgs(collections: string[]): string[] {
  return collections.flatMap((collection) => ["-c", collection]);
}

function effectiveScope(operation: QmdOperation): QmdEffectiveScope {
  return COLLECTION_SCOPED_OPERATIONS.has(operation) ? "collections" : "index";
}

export function buildQmdInvocation(
  context: QmdContext,
  request: QmdInvocationRequest,
): QmdInvocation {
  const { operation } = request;
  const argv = [...context.command.prefixArgs];
  if (context.selector.kind === "named") argv.push("--index", context.selector.name);
  if (operation === "collection-add") argv.push("collection", "add");
  else argv.push(operation);

  let collections: string[] = [];
  let readLimit: number | undefined;
  if (operation === "search" || operation === "query" || operation === "vsearch") {
    if (typeof request.query !== "string" || request.query.trim() === "") {
      throw contextError(`QMD ${operation} requires a non-empty query.`, { operation });
    }
    collections = normalizedCollections(request.collections, operation);
    argv.push(request.query);
    readLimit = normalizedReadLimit(request.limit);
  } else if (operation === "embed") {
    collections = normalizedCollections(request.collections ?? context.policy.ownedCollections, operation);
  } else if (operation === "collection-add") {
    if (typeof request.collection !== "string" || request.collection.trim() === "" || /[\\/]/.test(request.collection)) {
      throw contextError("QMD collection-add requires a non-path collection name.");
    }
    if (typeof request.path !== "string" || !isAbsolute(request.path)) {
      throw contextError("QMD collection-add path must be absolute.");
    }
    if (typeof request.mask !== "string" || request.mask.trim() === "") {
      throw contextError("QMD collection-add mask must be non-empty.");
    }
    collections = [request.collection.trim()];
    argv.push(request.path, "--name", collections[0]!, "--mask", request.mask.trim());
  }

  if (requestsStructuredOutput(operation)) argv.push("--format", "json");
  if (collections.length > 0 && operation !== "collection-add") argv.push(...collectionArgs(collections));
  if (readLimit !== undefined) argv.push("-n", String(readLimit));

  return {
    executable: context.command.executable,
    argv,
    cwd: context.workspace,
    operation,
    effectiveScope: operation === "collection-add" ? "collections" : effectiveScope(operation),
    indexKey: context.physicalIndex.key,
    collections,
    timeoutMs: normalizedTimeout(request.timeoutMs),
  };
}

function redactArgv(invocation: QmdInvocation): string[] {
  const redacted: string[] = [];
  let redactNext = false;
  const structuredFormatIndex = invocation.argv.lastIndexOf("--format");
  const queryIndex = ["search", "query", "vsearch"].includes(invocation.operation)
    ? structuredFormatIndex - 1
    : -1;

  for (let index = 0; index < invocation.argv.length; index += 1) {
    const value = invocation.argv[index]!;
    if (redactNext) {
      redacted.push("[REDACTED]");
      redactNext = false;
      continue;
    }
    const assignment = value.match(SENSITIVE_ASSIGNMENT);
    if (assignment) {
      redacted.push(`${assignment[1]}=[REDACTED]`);
      continue;
    }
    if (SENSITIVE_OPTION.test(value)) {
      redacted.push(value);
      redactNext = true;
      continue;
    }
    if (index === queryIndex && value.length > MAX_LOGGED_QUERY_CHARS) {
      redacted.push(`[REDACTED QUERY: ${value.length} chars]`);
      continue;
    }
    redacted.push(value);
  }
  return redacted;
}

export function redactQmdInvocation(invocation: QmdInvocation): RedactedQmdInvocation {
  return { ...invocation, argv: redactArgv(invocation) };
}
