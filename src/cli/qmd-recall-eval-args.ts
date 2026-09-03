import { usageError } from "./errors.ts";

export function parseQmdRecallEvalArgs(args: string[]): { corpusPath: string } {
  let corpusPath: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--corpus") {
      corpusPath = args[index + 1];
      if (!corpusPath || corpusPath.startsWith("-")) throw usageError("--corpus requires a value.");
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) throw usageError(`Unknown QMD recall-eval option: ${arg}`);
    if (corpusPath !== undefined) throw usageError("QMD recall-eval accepts exactly one corpus path.");
    corpusPath = arg;
  }
  if (corpusPath === undefined) throw usageError("QMD recall-eval requires a corpus path.");
  return { corpusPath };
}
