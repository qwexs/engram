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

function missingRequiredEnvironment(stderr: string): string | undefined {
  const match = stderr.match(/\b([A-Z][A-Z0-9_]*(?:API_KEY|TOKEN)) environment variable is required\b/);
  return match?.[1];
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
  const requiredEnvironment = missingRequiredEnvironment(result.stderr);
  if (!result.ok && requiredEnvironment) {
    throw dependencyError(
      `QMD ${result.operationRecord.operation} requires ${requiredEnvironment}, but it is unavailable in this process. Under OpenClaw, run cloud-backed QMD operations through managed Gateway exec; do not copy protected secrets into files or command env.`,
      {
        ...qmdRunDetails(result),
        requiredEnvironment,
        managedEnvironmentRequired: true,
      },
    );
  }
  if (!result.ok) {
    throw qmdOperationError(`QMD ${result.operationRecord.operation} failed.`, qmdRunDetails(result));
  }
}
