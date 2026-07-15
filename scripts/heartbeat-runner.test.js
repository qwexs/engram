/**
 * heartbeat-runner.test.js — Tests for hb-domains-write apply gating
 *
 * Covers the regression fixed by ISS-14: previously, the apply phase was
 * gated on --spawn-hb-domains-write, which the cron tick (install-cron.js
 * Step 1) never passes. Handoffs from previous ticks' subagents therefore
 * piled up in workspace/ops/heartbeat-spawns/handoff/ indefinitely until a
 * manual --spawn-hb-domains-write run was issued.
 *
 * The fix is in heartbeat-runner.js:shouldApplyDomainHandoffs(opts) — now
 * always true unless --no-hb-domains-write-apply is explicitly passed.
 *
 * We test the gate directly here (the only behavior that regressed). The
 * downstream behavior (applyDomainWriteHandoff correctness, base-hash
 * verification, file moves) is covered exhaustively by
 * domains-runner.test.ts (A2 cases). Combining both gives full coverage
 * with no subprocess overhead.
 *
 * Test export surface lives in heartbeat-runner.js:
 *   if (!import.meta.main) {
 *     globalThis.__engramHeartbeatRunnerExports = { ..., shouldApplyDomainHandoffs };
 *   }
 */

import {
  test,
  expect,
  describe,
} from "bun:test";

// heartbeat-runner.js attaches its test exports on globalThis when
// imported as a non-entry-point module. This avoids re-running main()'s
// side effects (cron state mutations, qmd discovery, etc.).
import "../scripts/heartbeat-runner.js";
const { shouldApplyDomainHandoffs, planSessionReconciliation } = globalThis.__engramHeartbeatRunnerExports;

describe("ISS-14: shouldApplyDomainHandoffs — drain-queue gate regression", () => {
  test("A1. default (no opts) → apply runs on every cron tick", () => {
    expect(shouldApplyDomainHandoffs({})).toBe(true);
  });

  test("A1. undefined opts → apply runs (defensive default)", () => {
    expect(shouldApplyDomainHandoffs()).toBe(true);
  });

  test("A2. --no-hb-domains-write-apply → apply disabled (opt-out for tests/debug)", () => {
    expect(shouldApplyDomainHandoffs({ "no-hb-domains-write-apply": true })).toBe(false);
  });

  test("A3. --spawn-hb-domains-write present without --no-hb-domains-write-apply → apply runs (was already true pre-fix; covered to guard against re-regression)", () => {
    expect(shouldApplyDomainHandoffs({ "spawn-hb-domains-write": true })).toBe(true);
  });

  test("A3. --spawn-hb-domains-write + --no-hb-domains-write-apply → apply disabled (opt-out wins)", () => {
    expect(shouldApplyDomainHandoffs({
      "spawn-hb-domains-write": true,
      "no-hb-domains-write-apply": true,
    })).toBe(false);
  });

  test("ISS-14 regression scenario: cron tick without --spawn-hb-domains-write (the default), with pending handoff in handoff/ → apply is enabled", () => {
    // This mirrors the exact condition that produced the production bug:
    // install-cron.js Step 1 invokes heartbeat-runner.js without
    // --spawn-hb-domains-write. Before the fix, the gate
    //   (Boolean(opts["spawn-hb-domains-write"]) || opts[HB_DOMAINS_APPLY_FLAG] === true) && ...
    // evaluated to false → applyDomainHandoffs() never ran → e8dcfa78.md
    // sat in handoff/ for 1h 55min (verified 2026-07-05).
    const cronTickOpts = {
      workspace: "/tmp/cron-tick-workspace",
      "all-active-sessions": true,
      "timeout-ms": 300000,
      // intentionally NO "spawn-hb-domains-write" — that's the bug surface.
      // intentionally NO "hb-domains-write-apply" — it had no effect pre-fix either.
    };
    expect(shouldApplyDomainHandoffs(cronTickOpts)).toBe(true);
  });
});

describe("session auto-discovery reconciliation", () => {
  test("adds on-disk sessions to activeSessions even when already tracked in lastDailyNoteCreated", () => {
    const plan = planSessionReconciliation({
      activeSessions: [],
      lastDailyNoteCreated: { "telegram-group--100-topic-7": "2026-07-15" },
    }, ["telegram-group--100-topic-7"]);
    expect(plan.added).toEqual(["telegram-group--100-topic-7"]);
    expect(plan.toTrack).toEqual([]);
    expect(plan.patches.activeSessions).toEqual(["telegram-group--100-topic-7"]);
  });

  test("tracks active on-disk sessions when lastDailyNoteCreated is missing", () => {
    const plan = planSessionReconciliation({
      activeSessions: ["telegram-direct-1"],
      lastDailyNoteCreated: {},
    }, ["telegram-direct-1"]);
    expect(plan.added).toEqual([]);
    expect(plan.toTrack).toEqual(["telegram-direct-1"]);
    expect(plan.patches["lastDailyNoteCreated.telegram-direct-1"]).toBeNull();
  });
});
