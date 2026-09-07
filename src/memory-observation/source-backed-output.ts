/** Keep one evaluator. Its choice of what matters is advisory; short user
 * wording is copied by code, not paraphrased. No second inference or writer. */
import type { CompiledBatchBundleV1 } from "./batch-compiler.ts";
import type { BatchShadowOutputV1 } from "./batch-shadow-runner.ts";

export function sourceBackedOutput(output: BatchShadowOutputV1, bundle: CompiledBatchBundleV1): BatchShadowOutputV1 {
  const normalized = structuredClone(output);
  for (const group of normalized.groups) {
    if (group.decision !== "write") continue;
    for (const assertion of group.assertions) {
      if (assertion.actorRef !== "user") continue;
      const sources = assertion.citations.filter(citation => citation.evidenceRef.kind === "source-turn")
        .map(citation => bundle.inputs.find(input => input.traceId === citation.traceId))
        .map(input => (input?.evidence as any)?.source?.text)
        .filter((text): text is string => typeof text === "string")
        .map(text => text.replace(/\s+/gu, " ").trim());
      const unique = [...new Set(sources)];
      if (!unique.length) throw new Error("source_quote_missing");
      const proposed = assertion.text.replace(/\s+/gu, " ").trim();
      // Whole short utterances preserve negation/comparisons even if the model
      // selects the opposite requirement. Long sources require a literal span.
      const full = unique.length === 1 && unique[0]!.length <= 700 ? unique[0]! : null;
      if (!full && !unique.some(source => source.includes(proposed))) throw new Error("source_quote_mismatch");
      assertion.text = full ?? proposed;
      assertion.reasonCodes = [...assertion.reasonCodes.filter(code => !["source_quote", "source_excerpt"].includes(code)).slice(0, 7),
        full ? "source_quote" : "source_excerpt"];
      // A quotation proves that a person said something, not completion/approval.
      if (assertion.outcomeStatus === "completed") assertion.outcomeStatus = "unknown";
    }
    const seen = new Set<string>();
    group.assertions = group.assertions.filter(assertion => {
      const key = JSON.stringify([assertion.actorRef, assertion.text, assertion.citations]);
      if (seen.has(key)) return false;
      seen.add(key); return true;
    });
  }
  return normalized;
}
