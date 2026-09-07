import type { CompiledBatchBundleV1 } from "./batch-compiler.ts";

export function isGroupTopicBundle(bundle: CompiledBatchBundleV1): boolean {
  return bundle.partition.scopeClass !== "self"
    && /^agent:[^:]+:telegram:group:-[1-9][0-9]*:topic:[1-9][0-9]*$/.test(bundle.partition.runtimeSessionKey);
}

/** Identity comes from trusted runtime evidence, never the model's prose. */
export function groupAssertionAttribution(bundle: CompiledBatchBundleV1, actorRef: string,
  citations: { traceId: string; evidenceRef: { kind: string } }[]): string {
  if (!isGroupTopicBundle(bundle)) return "";
  const authors = new Set<string>();
  for (const input of bundle.inputs) {
    const source = (input.evidence as any)?.source;
    if (source?.role !== "user" || source.attribution !== "speaker-only"
      || typeof source.actorId !== "string" || !/^[A-Za-z0-9._:-]{1,64}$/.test(source.actorId)) {
      throw new Error("group source has no trusted sender attribution");
    }
    if (citations.some((citation) => citation.traceId === input.traceId && citation.evidenceRef.kind === "source-turn")) {
      authors.add(source.actorId);
    }
  }
  if (actorRef === "assistant") return `Агент ${bundle.partition.workspaceId}: `;
  if (actorRef !== "user" || authors.size !== 1) throw new Error("group user assertion must cite exactly one sender");
  return `Участник Telegram ${[...authors][0]} (собственное высказывание): `;
}
