export type MemoryObservationPluginLlmPolicy = {
  allowModelOverride?: boolean;
  allowedModels?: unknown;
};

export type MemoryObservationInferenceSelection = {
  provider: string;
  model: string;
};

export function hasExactInferenceModelAuthorization(
  policy: MemoryObservationPluginLlmPolicy | null | undefined,
  expectedModel: string,
): boolean {
  const allowed = policy?.allowedModels;
  return policy?.allowModelOverride === true
    && /^[a-z0-9._-]+\/[A-Za-z0-9._:-]+$/.test(expectedModel)
    && Array.isArray(allowed)
    && allowed.length > 0
    && allowed.every((model) => typeof model === "string"
      && /^[a-z0-9._-]+\/[A-Za-z0-9._:-]+$/.test(model))
    && new Set(allowed).size === allowed.length
    && allowed.includes(expectedModel);
}

export function resolvedInferenceModelRef(selection: MemoryObservationInferenceSelection): string {
  return `${selection.provider}/${selection.model}`;
}

export function assertResolvedInferenceModel(
  expectedModel: string,
  selection: MemoryObservationInferenceSelection,
): void {
  const resolvedModel = resolvedInferenceModelRef(selection);
  if (resolvedModel !== expectedModel) {
    throw new Error(`episodic evaluator resolved unexpected model ${resolvedModel}`);
  }
}
