import { qmdOperationError } from "../cli/errors.ts";
import { buildQmdInvocation } from "./invocation.ts";
import { authorizeQmdInvocation } from "./policy.ts";
import { qmdRunDetails, requireSuccessfulQmdRun } from "./result.ts";
import { runQmdInvocation, type QmdProcessOptions } from "./runner.ts";
import type { QmdCallerContext, QmdContext, QmdOperationRecord } from "./types.ts";

export type QmdReadOperation = "search" | "query" | "vsearch";
export type QmdReadRequest = {
  operation: QmdReadOperation;
  query: string;
  collections: string[];
  limit?: number;
  timeoutMs?: number;
};
export type QmdReadData = {
  schema: `engram.qmd.${QmdReadOperation}.v1`;
  query: string;
  collections: string[];
  limit?: number;
  results: unknown[];
  operationRecord: QmdOperationRecord;
};
export type QmdReadResult = { data: QmdReadData; stdout: string };
export type QmdReadOptions = QmdProcessOptions & { caller?: QmdCallerContext };

export async function executeQmdRead(
  context: QmdContext,
  request: QmdReadRequest,
  runner: QmdReadOptions = {},
): Promise<QmdReadResult> {
  const invocation = buildQmdInvocation(context, { ...request, ...(runner.timeoutMs === undefined ? {} : { timeoutMs: runner.timeoutMs }) });
  const caller: QmdCallerContext = runner.caller ?? {
    kind: "operator",
    allowedCollections: [...context.policy.readableCollections],
    capabilities: ["diagnostics", "read"],
  };
  const decision = authorizeQmdInvocation(context, invocation, caller);
  const result = await runQmdInvocation(context, invocation, { ...runner, caller, decision });
  requireSuccessfulQmdRun(result);
  if (result.parseError || !Array.isArray(result.structuredData)) {
    throw qmdOperationError(`QMD ${request.operation} returned malformed JSON results.`, {
      ...qmdRunDetails(result),
      parseError: result.parseError?.message,
    });
  }
  return {
    stdout: result.stdout,
    data: {
      schema: `engram.qmd.${request.operation}.v1`,
      query: request.query,
      collections: [...invocation.collections],
      ...(request.limit === undefined ? {} : { limit: request.limit }),
      results: result.structuredData,
      operationRecord: result.operationRecord,
    },
  };
}
