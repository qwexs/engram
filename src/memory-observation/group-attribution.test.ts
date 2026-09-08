import { expect, test } from "bun:test";
import { groupAssertionAttribution } from "./group-attribution.ts";

test("different group participants cannot be collapsed into one user decision", () => {
  const bundle: any = { partition: { workspaceId: "project", scopeClass: "project", runtimeSessionKey: "agent:project:telegram:group:-100123:topic:2" },
    inputs: ["111", "222"].map((actorId, i) => ({ traceId: `trace-${i}`, evidence: { source: { role: "user", actorId, attribution: "speaker-only", text: "Я согласен" } } })) };
  const cite = (i: number) => ({ traceId: `trace-${i}`, evidenceRef: { kind: "source-turn" } });
  expect(groupAssertionAttribution(bundle, "user", [cite(1)])).toContain("222");
  expect(() => groupAssertionAttribution(bundle, "user", [cite(0), cite(1)])).toThrow("exactly one sender");
  expect(groupAssertionAttribution(bundle, "assistant", [cite(0), cite(1)])).toBe("Агент project: ");
  delete bundle.inputs[1].evidence.source.actorId;
  expect(() => groupAssertionAttribution(bundle, "user", [cite(0)])).toThrow("trusted sender");
});

test("existing direct bundle text is unchanged", () => {
  expect(groupAssertionAttribution({ partition: { scopeClass: "self" } } as any, "user", [])).toBe("");
});
test("different group-direct participants cannot be collapsed into one user decision", () => {
  const bundle: any = { partition: { workspaceId: "project", scopeClass: "project", runtimeSessionKey: "agent:project:telegram:group:-100123" },
    inputs: ["111", "222"].map((actorId, i) => ({ traceId: `trace-${i}`, evidence: { source: { role: "user", actorId, attribution: "speaker-only", text: "Я согласен" } } })) };
  const cite = (i: number) => ({ traceId: `trace-${i}`, evidenceRef: { kind: "source-turn" } });
  expect(groupAssertionAttribution(bundle, "user", [cite(1)])).toContain("222");
  expect(() => groupAssertionAttribution(bundle, "user", [cite(0), cite(1)])).toThrow("exactly one sender");
  expect(groupAssertionAttribution(bundle, "assistant", [cite(0), cite(1)])).toBe("Агент project: ");
  delete bundle.inputs[1].evidence.source.actorId;
  expect(() => groupAssertionAttribution(bundle, "user", [cite(0)])).toThrow("trusted sender");
});
