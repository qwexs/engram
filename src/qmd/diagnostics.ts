import { resolve } from "node:path";
import {
  CliError,
  contextError,
  dependencyError,
  qmdOperationError,
  timeoutError,
} from "../cli/errors.ts";
import { canonicalizePath } from "./context.ts";
import { buildQmdInvocation } from "./invocation.ts";
import { runQmdInvocation, type QmdRunnerOptions } from "./runner.ts";
import type { QmdContext, QmdOperationRecord, QmdRunResult } from "./types.ts";

type CapabilityPayload = {
  schema: "qmd.capabilities.v1";
  version: string;
  embed: {
    multipleCollections: true;
    indexScopedLock: true;
    structuredOutput: true;
  };
};

export type QmdCapabilitiesData = {
  schema: "engram.qmd.capabilities.v1";
  compatible: true;
  qmd: CapabilityPayload;
  operationRecord: QmdOperationRecord;
};

export type QmdStatusData = {
  schema: "engram.qmd.status.v1";
  index: {
    expectedPath: string;
    actualPath: string;
    key: string;
    exists: boolean;
    matches: true;
  };
  operationRecord: QmdOperationRecord;
};

export type QmdDoctorCheck = {
  id: "context" | "ownership" | "physical-index" | "capabilities";
  status: "pass" | "warn" | "fail";
  message: string;
  errorCode?: CliError["code"];
  operationRecord?: QmdOperationRecord;
};

export type QmdDoctorData = {
  schema: "engram.qmd.doctor.v1";
  healthy: boolean;
  strict: boolean;
  context: QmdContext;
  checks: QmdDoctorCheck[];
  warnings: QmdContext["warnings"];
  status?: QmdStatusData;
  capabilities?: QmdCapabilitiesData;
};

export type DiagnosticOptions = {
  timeoutMs?: number;
  runner?: QmdRunnerOptions;
};

function recordDetails(result: QmdRunResult): Record<string, unknown> {
  return {
    operationRecord: result.operationRecord,
    exitCode: result.exitCode,
    signal: result.signal,
    stderrBytes: Buffer.byteLength(result.stderr),
  };
}

function requireSuccessfulRun(result: QmdRunResult): void {
  if (result.timedOut) {
    throw timeoutError(`QMD ${result.operationRecord.operation} timed out.`, recordDetails(result));
  }
  if (result.spawnError) {
    throw dependencyError("QMD executable is unavailable.", {
      ...recordDetails(result),
      cause: result.spawnError.message,
    });
  }
  if (!result.ok) {
    throw qmdOperationError(`QMD ${result.operationRecord.operation} failed.`, recordDetails(result));
  }
}

function capabilityPayload(value: unknown, operationRecord: QmdOperationRecord): CapabilityPayload {
  const details = { operationRecord };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw qmdOperationError("QMD capabilities output is not a JSON object.", details);
  }
  const payload = value as Record<string, unknown>;
  if (payload.schema !== "qmd.capabilities.v1") {
    throw dependencyError("Unsupported QMD capabilities schema.", { ...details, actualSchema: payload.schema });
  }
  if (typeof payload.version !== "string" || payload.version.trim() === "") {
    throw dependencyError("QMD capabilities do not report a version.", details);
  }
  const embed = payload.embed;
  if (!embed || typeof embed !== "object" || Array.isArray(embed)) {
    throw dependencyError("QMD capabilities do not report embed support.", details);
  }
  const flags = embed as Record<string, unknown>;
  const missing = ["multipleCollections", "indexScopedLock", "structuredOutput"]
    .filter((flag) => flags[flag] !== true);
  if (missing.length > 0) {
    throw dependencyError("QMD is missing required embed capabilities.", { ...details, missing });
  }
  return payload as CapabilityPayload;
}

export async function inspectQmdCapabilities(
  context: QmdContext,
  options: DiagnosticOptions = {},
): Promise<QmdCapabilitiesData> {
  const invocation = buildQmdInvocation(context, {
    operation: "capabilities",
    timeoutMs: options.timeoutMs,
  });
  const result = await runQmdInvocation(context, invocation, options.runner);
  requireSuccessfulRun(result);
  if (result.parseError || result.structuredData === undefined) {
    throw qmdOperationError("QMD capabilities returned malformed JSON.", {
      ...recordDetails(result),
      parseError: result.parseError?.message,
    });
  }
  const qmd = capabilityPayload(result.structuredData, result.operationRecord);
  const operationRecord: QmdOperationRecord = {
    ...result.operationRecord,
    qmd: {
      version: qmd.version,
      capabilities: {
        multipleCollections: qmd.embed.multipleCollections,
        indexScopedLock: qmd.embed.indexScopedLock,
        structuredOutput: qmd.embed.structuredOutput,
      },
    },
  };
  return {
    schema: "engram.qmd.capabilities.v1",
    compatible: true,
    qmd,
    operationRecord,
  };
}

function parseStatusIndex(stdout: string): string | undefined {
  const match = stdout.match(/^Index:\s*(.+?)\s*$/m);
  return match?.[1];
}

export async function inspectQmdStatus(
  context: QmdContext,
  options: DiagnosticOptions = {},
): Promise<QmdStatusData> {
  const invocation = buildQmdInvocation(context, {
    operation: "status",
    timeoutMs: options.timeoutMs,
  });
  const result = await runQmdInvocation(context, invocation, options.runner);
  requireSuccessfulRun(result);
  const reported = parseStatusIndex(result.stdout);
  if (!reported) {
    throw qmdOperationError("QMD status did not report an Index path.", {
      operationRecord: result.operationRecord,
    });
  }
  const actualPath = canonicalizePath(resolve(context.workspace, reported));
  if (actualPath !== context.physicalIndex.path) {
    throw contextError("QMD status resolved a different physical index.", {
      expectedPath: context.physicalIndex.path,
      actualPath,
      operationRecord: result.operationRecord,
    });
  }
  return {
    schema: "engram.qmd.status.v1",
    index: {
      expectedPath: context.physicalIndex.path,
      actualPath,
      key: context.physicalIndex.key,
      exists: context.physicalIndex.exists,
      matches: true,
    },
    operationRecord: result.operationRecord,
  };
}

function strictDoctorError(data: QmdDoctorData): CliError {
  const failed = data.checks.find((check) => check.status === "fail");
  const details = { doctor: data };
  if (failed?.errorCode === "DEPENDENCY_UNAVAILABLE") {
    return dependencyError("QMD doctor strict checks failed.", details);
  }
  if (failed?.errorCode === "TIMEOUT_CANCELLED") {
    return timeoutError("QMD doctor strict checks failed.", details);
  }
  if (failed?.errorCode === "QMD_OPERATION_FAILED") {
    return qmdOperationError("QMD doctor strict checks failed.", details);
  }
  return contextError("QMD doctor strict checks failed.", details);
}

export async function inspectQmdDoctor(
  context: QmdContext,
  strict: boolean,
  options: DiagnosticOptions = {},
): Promise<QmdDoctorData> {
  const checks: QmdDoctorCheck[] = [
    {
      id: "context",
      status: context.warnings.length > 0 ? "warn" : "pass",
      message: context.warnings.length > 0
        ? `Context resolved with ${context.warnings.length} warning(s).`
        : "Context resolved without warnings.",
    },
    {
      id: "ownership",
      status: context.policy.ownedCollections.length > 0 ? "pass" : "fail",
      message: `${context.policy.ownedCollections.length} owned collection(s) resolved.`,
    },
  ];

  let status: QmdStatusData | undefined;
  try {
    status = await inspectQmdStatus(context, options);
    checks.push({
      id: "physical-index",
      status: context.physicalIndex.exists ? "pass" : "warn",
      message: context.physicalIndex.exists
        ? `QMD uses the resolved physical index: ${context.physicalIndex.path}`
        : `QMD reports the resolved index path, but the physical index is missing: ${context.physicalIndex.path}`,
      operationRecord: status.operationRecord,
    });
  } catch (error) {
    const cliError = error instanceof CliError
      ? error
      : qmdOperationError("QMD status check failed.", { cause: String(error) });
    checks.push({
      id: "physical-index",
      status: "fail",
      message: cliError.message,
      errorCode: cliError.code,
      ...(cliError.details?.operationRecord
        ? { operationRecord: cliError.details.operationRecord as QmdOperationRecord }
        : {}),
    });
  }

  let capabilities: QmdCapabilitiesData | undefined;
  try {
    capabilities = await inspectQmdCapabilities(context, options);
    checks.push({ id: "capabilities", status: "pass", message: `QMD ${capabilities.qmd.version} is compatible.` });
  } catch (error) {
    const cliError = error instanceof CliError
      ? error
      : qmdOperationError("QMD capabilities check failed.", { cause: String(error) });
    checks.push({
      id: "capabilities",
      status: "fail",
      message: cliError.message,
      errorCode: cliError.code,
      ...(cliError.details?.operationRecord
        ? { operationRecord: cliError.details.operationRecord as QmdOperationRecord }
        : {}),
    });
  }

  const data: QmdDoctorData = {
    schema: "engram.qmd.doctor.v1",
    healthy: checks.every((check) => check.status === "pass") && context.warnings.length === 0,
    strict,
    context,
    checks,
    warnings: context.warnings,
    ...(status ? { status } : {}),
    ...(capabilities ? { capabilities } : {}),
  };
  if (strict && !data.healthy) throw strictDoctorError(data);
  return data;
}
