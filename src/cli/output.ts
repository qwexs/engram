import type { CliError } from "./errors.ts";

export type JsonSuccess = {
  schema: "engram.cli.result.v1";
  ok: true;
  command: string;
  meta: {
    elapsedMs: number;
    workspace: string;
  };
  data: Record<string, unknown>;
};

export type JsonFailure = {
  schema: "engram.cli.error.v1";
  ok: false;
  error: {
    code: CliError["code"];
    message: string;
    details?: Record<string, unknown>;
  };
};

export type Writer = (chunk: string) => void;

export function writeJsonSuccess(
  write: Writer,
  command: string,
  meta: JsonSuccess["meta"],
  data: Record<string, unknown>,
): void {
  const envelope: JsonSuccess = { schema: "engram.cli.result.v1", ok: true, command, meta, data };
  write(`${JSON.stringify(envelope)}\n`);
}

export function writeJsonError(write: Writer, error: CliError, verbose: boolean): void {
  const envelope: JsonFailure = {
    schema: "engram.cli.error.v1",
    ok: false,
    error: {
      code: error.code,
      message: error.message,
      ...(verbose && error.details !== undefined ? { details: error.details } : {}),
    },
  };
  write(`${JSON.stringify(envelope)}\n`);
}
