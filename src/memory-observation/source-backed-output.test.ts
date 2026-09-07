import { expect, test } from "bun:test";
import { sourceBackedOutput } from "./source-backed-output.ts";

function fixture(source: string, proposed: string) {
  const citation = { traceId: "source-1", evidenceRef: { kind: "source-turn", ref: "turn-1", digest: "digest" } };
  const bundle: any = { inputs: [{ traceId: "source-1", evidence: { source: { role: "user", text: source } } }] };
  const output: any = { schema: "engram.memory-batch-shadow-output.v1", groups: [{ decision: "write", assertions: [{
    text: proposed, actorRef: "user", outcomeStatus: "corrected", reasonCodes: ["correction"], citations: [citation],
  }] }] };
  return { bundle, output, normalize: () => sourceBackedOutput(output, bundle).groups[0] as any };
}

test("synthetic comparison cannot be turned into the opposite requirement or translated", () => {
  const f = fixture("учебный робот не такой быстрый и точный, как в описании", "The training robot should not be as fast or precise as described.");
  expect(f.normalize().assertions[0]).toMatchObject({ text: "учебный робот не такой быстрый и точный, как в описании", reasonCodes: ["correction", "source_quote"] });
  expect(f.output.groups[0].assertions[0].text).toStartWith("The training robot");
});

test("long sources reject invented text and preserve only literal excerpts", () => {
  const source = "Контекст. ".repeat(100) + "Скорость увеличить, не уменьшить.";
  expect(() => fixture(source, "Скорость уменьшить.").normalize()).toThrow("source_quote_mismatch");
  expect(fixture(source, "Скорость увеличить, не уменьшить.").normalize().assertions[0].reasonCodes).toContain("source_excerpt");
});

test("normalizing several paraphrases of one short utterance creates one quotation", () => {
  const f = fixture("Не меняй имя учебного робота.", "Keep the training robot name.");
  f.output.groups[0].assertions.push({ ...f.output.groups[0].assertions[0], text: "Use the same training robot name." });
  expect(f.normalize().assertions).toHaveLength(1);
});

test("a quoted claim of completion is not verification", () => {
  const f = fixture("Я закончил работу", "Work verified complete");
  f.output.groups[0].assertions[0].outcomeStatus = "completed";
  expect(f.normalize().assertions[0].outcomeStatus).toBe("unknown");
});
