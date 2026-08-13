import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const baseline = JSON.parse(readFileSync(
  join(import.meta.dir, "fixtures", "oll-nightly", "baseline-current-runtime.json"),
  "utf8",
));

function source(relative: string): string {
  return readFileSync(join(ROOT, relative), "utf8");
}

describe("OLL nightly pre-cutover baseline", () => {
  test("records that the current nightly coordinator is deterministic only", () => {
    const coordinator = source("scripts/daily-summary-coordinator.js");
    const reconciliation = source("src/oll/reconciliation.ts");
    expect(baseline.nightlyCoordinator).toMatchObject({
      requiresExplicitWorkspacePaths: true,
      flushesAccess: true,
      rebuildsSummaries: true,
      spawnsRethink: false,
    });
    expect(coordinator).toContain("At least one --workspace is required");
    expect(coordinator).toContain("reconcileWorkspaceMemory");
    expect(reconciliation).toContain("reconcileKgV3Access");
    expect(reconciliation).toContain("kg-v3-authority-inactive");
    expect(reconciliation).not.toContain("flush-access-buffer.js");
    expect(reconciliation).not.toContain("rebuild-summaries.js");
    expect(coordinator).not.toContain("sessions_spawn");
  });

  test("records legacy OLL admission and application in heartbeat", () => {
    const runner = source("scripts/heartbeat-runner.js");
    const applicator = source("scripts/process-handoff-core.js");
    for (const phase of baseline.heartbeat.admits) expect(runner).toContain(phase);
    for (const handoff of baseline.heartbeat.appliesLegacyHandoffs) {
      expect(applicator).toContain(`\"${handoff}\"`);
    }
  });

  test("preserves evidence of the pre-PR1 label-based model routing defect", () => {
    const config = source("scripts/config.js");
    const runner = source("scripts/heartbeat-runner.js");
    expect(baseline.modelResolution.semanticLookupKey).toBe("label");
    expect(config).toContain("resolveSubagentModel(workspace, phase)");
    expect(config).toContain("subagents?.[phase]");
    expect(runner).toContain("resolveSubagentModel(workspace, phase)");
    expect(runner).not.toContain("resolveSubagentModel(workspace, label)");
  });

  test("records the legacy free-form handoff boundary", () => {
    const runner = source("scripts/heartbeat-runner.js");
    expect(baseline.handoff).toEqual({
      authoritativeSchema: "legacy-free-form",
      watcherBasedWait: false,
    });
    expect(runner).toContain("HB-RETHINK handoff blocks");
    expect(runner).not.toContain("oll.rethink-handoff.v2");
  });
});
