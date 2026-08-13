import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  reconcileWorkspaceMemory,
  ReconciliationCommandResult,
  ReconciliationRuntime,
} from "../src/oll/reconciliation";

const roots: string[] = [];

class FakeRuntime implements ReconciliationRuntime {
  readonly commands: string[][] = [];
  constructor(private readonly results: ReconciliationCommandResult[]) {}
  async run(command: string[]): Promise<ReconciliationCommandResult> {
    this.commands.push(command);
    return this.results.shift()!;
  }
}

function setup(): string {
  const root = mkdtempSync(join(tmpdir(), "engram-reconcile-"));
  roots.push(root);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "engram.json"), "{}\n");
  return root;
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("PR 5 reusable deterministic reconciliation", () => {
  test("is permanently retired after KG v3 fleet cutover", async () => {
    const workspace = setup();
    const runtime = new FakeRuntime([]);
    const result = await reconcileWorkspaceMemory({ workspace, scriptsDir: "/canonical/scripts", runtime, dryRun: true });
    expect(result).toMatchObject({ status: "ok", skipped: "legacy-v2-reconciliation-retired" });
    expect(runtime.commands).toHaveLength(0);
  });
});
