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
  test("preserves flush-before-rebuild ordering and arguments", async () => {
    const workspace = setup();
    const runtime = new FakeRuntime([
      { exitCode: 0, stdout: '{"flushed":2}', stderr: "", timedOut: false },
      { exitCode: 0, stdout: '{"rebuilt":3}', stderr: "", timedOut: false },
    ]);
    const result = await reconcileWorkspaceMemory({ workspace, scriptsDir: "/canonical/scripts", runtime, dryRun: true });
    expect(result).toMatchObject({ status: "ok", accessFlush: { flushed: 2 }, stats: { rebuilt: 3 } });
    expect(runtime.commands).toEqual([
      ["bun", "/canonical/scripts/flush-access-buffer.js", "--workspace", workspace, "--json", "--dry-run"],
      ["bun", "/canonical/scripts/rebuild-summaries.js", "--apply-decay", "--json", "--dry-run"],
    ]);
  });

  test("stops before rebuild when access flush fails or times out", async () => {
    const workspace = setup();
    const runtime = new FakeRuntime([{ exitCode: 1, stdout: "", stderr: "broken", timedOut: false }]);
    await expect(reconcileWorkspaceMemory({ workspace, scriptsDir: "/canonical/scripts", runtime })).resolves.toMatchObject({
      status: "error",
      error: "access flush: broken",
    });
    expect(runtime.commands).toHaveLength(1);
  });
});
