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
  return policy?.allowModelOverride === true
    && Array.isArray(policy.allowedModels)
    && policy.allowedModels.length === 1
    && policy.allowedModels[0] === expectedModel;
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
