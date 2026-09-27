import { describe, expect, test } from "bun:test";
import {
  assertResolvedInferenceModel,
  hasExactInferenceModelAuthorization,
  resolvedInferenceModelRef,
} from "./inference-boundary.ts";

describe("memory observation inference model boundary", () => {
  test("requires an exact explicit plugin authorization, including during a bounded model overlap", () => {
    const model = "openai/gpt-5.6-terra";
    const next = "openai/gpt-6-luna";
    for (const allowedModels of [[model], [model, next]]) {
      expect(hasExactInferenceModelAuthorization({ allowModelOverride: true, allowedModels }, model)).toBe(true);
    }
    expect(hasExactInferenceModelAuthorization({
      allowModelOverride: true, allowedModels: [model, next],
    }, next)).toBe(true);

    for (const policy of [
      undefined,
      { allowModelOverride: false, allowedModels: [model] },
      { allowModelOverride: true, allowedModels: [] },
      { allowModelOverride: true, allowedModels: ["*"] },
      { allowModelOverride: true, allowedModels: [model, "*"] },
      { allowModelOverride: true, allowedModels: [model, model] },
      { allowModelOverride: true, allowedModels: [model, null] },
      { allowModelOverride: true, allowedModels: [next] },
    ]) expect(hasExactInferenceModelAuthorization(policy, model)).toBe(false);
  });

  test("accepts only the exact provider/model selected by the host", () => {
    const expected = "openai/gpt-5.6-terra";
    const selection = { provider: "openai", model: "gpt-5.6-terra" };
    expect(resolvedInferenceModelRef(selection)).toBe(expected);
    expect(() => assertResolvedInferenceModel(expected, selection)).not.toThrow();
    expect(() => assertResolvedInferenceModel(expected, {
      provider: "openai",
      model: "gpt-5.6-sol",
    })).toThrow("resolved unexpected model openai/gpt-5.6-sol");
  });
});
