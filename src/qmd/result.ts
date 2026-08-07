import { dependencyError, qmdOperationError, timeoutError } from "../cli/errors.ts";
import type { QmdRunResult } from "./types.ts";

export function qmdRunDetails(result: QmdRunResult): Record<string, unknown> {
  return {
    operationRecord: result.operationRecord,
    exitCode: result.exitCode,
    signal: result.signal,
    stderrBytes: Buffer.byteLength(result.stderr),
  };
}

export function requireSuccessfulQmdRun(result: QmdRunResult): void {
  if (result.timedOut) {
    throw timeoutError(`QMD ${result.operationRecord.operation} timed out.`, qmdRunDetails(result));
  }
  if (result.spawnError) {
    throw dependencyError("QMD executable is unavailable.", {
      ...qmdRunDetails(result),
      cause: result.spawnError.message,
    });
  }
  if (!result.ok) {
    throw qmdOperationError(`QMD ${result.operationRecord.operation} failed.`, qmdRunDetails(result));
  }
}
