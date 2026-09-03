import { describe, expect, test } from "bun:test";
import { parseQmdRecallEvalArgs } from "./qmd-recall-eval-args.ts";

describe('parseQmdRecallEvalArgs', () => {
  test('accepts a positional corpus path or --corpus', () => {
    expect(parseQmdRecallEvalArgs(['corpus.json'])).toEqual({ corpusPath: 'corpus.json' });
    expect(parseQmdRecallEvalArgs(['--corpus', 'corpus.json'])).toEqual({ corpusPath: 'corpus.json' });
  });
});
