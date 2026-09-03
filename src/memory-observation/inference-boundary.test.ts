import { describe, expect, test } from "bun:test";
import {
  assertResolvedInferenceModel,
  hasExactInferenceModelAuthorization,
  resolvedInferenceModelRef,
} from "./inference-boundary.ts";

describe("memory observation inference model boundary", () => {
  test("requires a single exact plugin model override authorization", () => {
    const model = "openai/gpt-5.6-terra";
    expect(hasExactInferenceModelAuthorization({
      allowModelOverride: true,
      allowedModels: [model],
    }, model)).toBe(true);

    for (const policy of [
      undefined,
      { allowModelOverride: false, allowedModels: [model] },
      { allowModelOverride: true, allowedModels: [] },
      { allowModelOverride: true, allowedModels: ["*"] },
      { allowModelOverride: true, allowedModels: [model, "openai/gpt-5.6-sol"] },
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
