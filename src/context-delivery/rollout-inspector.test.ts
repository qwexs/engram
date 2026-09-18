import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectRolloutModelInput } from "./rollout-inspector.ts";

const roots: string[] = [];
const ollHash = "a".repeat(64);
const policyHash = "b".repeat(64);

function fixture(records: unknown[]): string {
  const root = mkdtempSync(join(tmpdir(), "engram-context-audit-"));
  roots.push(root);
  const path = join(root, "rollout.jsonl");
  writeFileSync(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
  return path;
}

function message(role: string, text: string) {
  return {
    type: "response_item",
    payload: { type: "message", role, content: [{ type: "input_text", text }] },
  };
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("rollout model-input inspector", () => {
  test("finds source-shaped markers only before the first assistant message", async () => {
    const path = fixture([
      { type: "session_meta", payload: {} },
      message("developer", `<!-- engram-kg-v3-current -->\n<!-- engram-bootstrap-context-hash:sha256:${ollHash} -->\n<!-- engram-session-context:v1 digest=sha256:${ollHash} -->`),
      message("user", "request"),
      message("assistant", "first response"),
      message("user", "<!-- engram-system-event-hash:deadbeef -->"),
    ]);

    const result = await inspectRolloutModelInput(path);

    expect(result.inputFormat).toBe("codex-response-item-v1");
    expect(result.firstAssistantLine).toBe(4);
    expect(result.inputMessages).toBe(2);
    expect(result.markers.kg).toEqual({ present: true, occurrences: 1 });
    expect(result.markers.oll).toEqual({ present: true, occurrences: 1 });
    expect(result.markers.domain).toEqual({ present: false, occurrences: 0 });
    expect(result.markers.session).toEqual({ present: true, occurrences: 1 });
    expect(result.envelopes).toEqual([]);
    expect(result.sourceMarkers.kg.occurrences).toBe(0);
  });

  test("extracts one canonical envelope and exact source artifact digests", async () => {
    const path = fixture([
      message("user", [
        `<!-- engram-context-delivery:v1 envelope=sha256:${ollHash} policy=sha256:${policyHash} -->`,
        `<!-- engram-context-source:oll:v1 digest=sha256:${ollHash} -->`,
        `<!-- engram-context-source:session:v1 digest=sha256:${policyHash} -->`,
        "probe",
      ].join("\n")),
      message("assistant", "ok"),
    ]);

    const result = await inspectRolloutModelInput(path);

    expect(result.envelopes).toEqual([{
      envelopeDigest: `sha256:${ollHash}`,
      policyDigest: `sha256:${policyHash}`,
    }]);
    expect(result.sourceMarkers.oll).toEqual({ occurrences: 1, artifactDigests: [`sha256:${ollHash}`] });
    expect(result.sourceMarkers.session).toEqual({ occurrences: 1, artifactDigests: [`sha256:${policyHash}`] });
    expect(result.sourceMarkers.domain.occurrences).toBe(0);
    expect(result.sourceMarkers.kg.occurrences).toBe(0);
  });

  test("preserves duplicate canonical markers so the gate can reject them", async () => {
    const envelope = `<!-- engram-context-delivery:v1 envelope=sha256:${ollHash} policy=sha256:${policyHash} -->`;
    const source = `<!-- engram-context-source:kg:v3-current digest=sha256:${ollHash} -->`;
    const path = fixture([message("user", `${envelope}\n${envelope}\n${source}\n${source}`)]);

    const result = await inspectRolloutModelInput(path);

    expect(result.envelopes).toHaveLength(2);
    expect(result.sourceMarkers.kg.occurrences).toBe(2);
  });

  test("stops at an assistant tool call before later tool output or user text", async () => {
    const path = fixture([
      message("developer", "ordinary context"),
      { type: "response_item", payload: { type: "function_call", name: "lookup", arguments: "{}" } },
      message("user", "<!-- engram-kg-v3-current -->"),
    ]);

    const result = await inspectRolloutModelInput(path);

    expect(result.firstAssistantLine).toBe(2);
    expect(result.linesRead).toBe(2);
    expect(result.markers.kg.present).toBe(false);
  });

  test("does not count marker-like user text or malformed marker values", async () => {
    const path = fixture([
      message("user", "engram-kg-v3-current <!-- engram-system-event-hash:zzzzzzzz -->"),
      message("developer", "<!-- engram-bootstrap-context-hash:sha256:short -->"),
    ]);

    const result = await inspectRolloutModelInput(path);

    expect(result.markers.kg.present).toBe(false);
    expect(result.markers.oll.present).toBe(false);
    expect(result.markers.domain.present).toBe(false);
    expect(result.markers.session.present).toBe(false);
    expect(result.envelopes).toEqual([]);
    expect(result.sourceMarkers.kg.occurrences).toBe(0);
  });

  test("marks another JSONL protocol unsupported instead of reporting absent delivery", async () => {
    const path = fixture([{ type: "message", message: { role: "user", content: "<!-- engram-kg-v3-current -->" } }]);
    const result = await inspectRolloutModelInput(path);
    expect(result.inputFormat).toBe("unsupported");
    expect(result.inputMessages).toBe(0);
  });

  test("fails on malformed JSONL instead of silently skipping evidence", async () => {
    const root = mkdtempSync(join(tmpdir(), "engram-context-audit-"));
    roots.push(root);
    const path = join(root, "rollout.jsonl");
    writeFileSync(path, "{not-json}\n");
    await expect(inspectRolloutModelInput(path)).rejects.toThrow("invalid rollout JSONL at line 1");
  });
});
