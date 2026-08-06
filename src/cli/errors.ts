export const EXIT_CODES = {
  SUCCESS: 0,
  INTERNAL_ERROR: 1,
  USAGE_ERROR: 2,
  CONTEXT_ERROR: 3,
  POLICY_DENIED: 4,
  DEPENDENCY_ERROR: 5,
  QMD_OPERATION_FAILED: 6,
  TIMEOUT_CANCELLED: 7,
  DEFERRED_PARTIAL: 8,
} as const;

/** Stable process-status meanings reserved for all CLI commands. */
export const EXIT_CODE_SEMANTICS = {
  0: "success",
  1: "internal error",
  2: "usage error",
  3: "configuration or context error",
  4: "policy denied",
  5: "dependency or QMD unavailable",
  6: "QMD operation failed",
  7: "timeout or cancelled",
  8: "deferred or partial",
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];
export type ErrorCode =
  | "INTERNAL"
  | "USAGE"
  | "CONTEXT"
  | "POLICY_DENIED"
  | "DEPENDENCY_UNAVAILABLE"
  | "QMD_OPERATION_FAILED"
  | "TIMEOUT_CANCELLED"
  | "DEFERRED_PARTIAL";

export class CliError extends Error {
  readonly code: ErrorCode;
  readonly exitCode: ExitCode;
  readonly details?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    exitCode: ExitCode,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.exitCode = exitCode;
    this.details = details;
  }
}

export function usageError(message: string, details?: Record<string, unknown>): CliError {
  return new CliError("USAGE", message, EXIT_CODES.USAGE_ERROR, details);
}

export function normalizeError(error: unknown): CliError {
  if (error instanceof CliError) return error;

  return new CliError(
    "INTERNAL",
    "An unexpected error occurred.",
    EXIT_CODES.INTERNAL_ERROR,
    error instanceof Error ? { cause: error.message } : undefined,
  );
}
