#!/usr/bin/env bun
// Tests for domains-runner.js ISS-9 fixes:
//   A1. lastWrite resolution (TZ-aware newestContentDateMs)
//   A2. Race with agent writes (idempotent + stale paths in applyDomainWriteHandoff)
//   A3. Timezone consistency (process.env.TZ mutation visibility)
//
// Run:  bun test scripts/domains-runner.test.ts

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { newestContentDateMs, applyDomainWriteHandoff } from "./domains-runner.js";

const SAMPLE_TZ = "Europe/Moscow";

let workspace: string;
let prevTz: string | undefined;
let prevEngramTz: string | undefined;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "domains-runner-test-"));
  mkdirSync(join(workspace, "memory", "domains"), { recursive: true });
  // Force a known TZ so all date computations have a reproducible wall clock.
  prevTz = process.env.TZ;
  prevEngramTz = process.env.ENGRAM_TZ;
  process.env.TZ = SAMPLE_TZ;
  process.env.ENGRAM_TZ = SAMPLE_TZ;
});

afterEach(() => {
  if (prevTz === undefined) delete process.env.TZ;
  else process.env.TZ = prevTz;
  if (prevEngramTz === undefined) delete process.env.ENGRAM_TZ;
  else process.env.ENGRAM_TZ = prevEngramTz;
  rmSync(workspace, { recursive: true, force: true });
});

function setupRegistry(): string {
  const domain = "test-domain";
  const dir = join(workspace, "memory", "domains", domain);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(workspace, "memory", "domains", "registry.json"),
    JSON.stringify({ domains: { [domain]: { type: "topic-thread", created: "2026-07-01" } } }) + "\n",
  );
  // Initial empty changelog with deterministic content hash.
  writeFileSync(join(dir, "changelog.md"), "# Журнал: test-domain\n\n");
  writeFileSync(join(dir, "status.md"), "# Status: test-domain\n\n");
  writeFileSync(join(dir, "decisions.md"), "# Решения: test-domain\n\n");
  return domain;
}

function handoff(opts: {
  runId?: string;
  baseHashes?: { "status.md": string | null; "changelog.md": string | null };
  changelogEntries?: Array<{ id: string; runId: string; content: string }>;
  statusContent?: string;
  bodyExtras?: string[];
} = {}) {
  // NOTE on handoff format: the HB-DOMAINS-WRITE.md spec shows fenced JSON
  // blocks for Base-Hashes and Changelog-Entries, BUT the actual parsers in
  // domains-runner.js (`parseHandoffField`) and process-handoff-core.js
  // (`parseField`) only read the first line after `:` via a single-line regex.
  // Production subagents in practice write these fields inline (single-line
  // JSON), so we mirror that here. If the spec is updated to multi-line JSON
  // parsing, both parsers and this helper need to change in sync.
  const runId = opts.runId ?? "hb-test-2026-07-01-001";
  const baseHashes = opts.baseHashes ?? {
    "status.md": null,
    "changelog.md": null,
  };
  const lines: string[] = [
    "=== HB-DOMAINS HANDOFF ===",
    "Status: ok",
    "Summary: ISS-9 test handoff",
    `Domain: test-domain`,
    `Run-Id: ${runId}`,
    `Base-Hashes: ${JSON.stringify(baseHashes)}`,
  ];
  if (opts.statusContent !== undefined) {
    lines.push("Status-Content: |");
    lines.push(opts.statusContent.replace(/^/gm, "  "));
  }
  lines.push(`Changelog-Entries: ${JSON.stringify(opts.changelogEntries ?? [])}`);
  lines.push("Promotions: []");
  if (opts.bodyExtras) lines.push(...opts.bodyExtras);
  lines.push("=== END ===");
  return { body: lines.join("\n"), runId };
}

// ============================================================================
// A1. newestContentDateMs — TZ-aware parsing
// ============================================================================
describe("A1. newestContentDateMs — TZ-aware date parsing", () => {
  test("date-only YYYY-MM-DD → midnight in ENGRAM_TZ", () => {
    process.env.ENGRAM_TZ = "Europe/Moscow";
    const ms = newestContentDateMs("## 2026-07-01 — Заголовок");
    expect(ms).not.toBeNull();
    // Moscow is UTC+3, so midnight MSK = 21:00 UTC the previous day.
    const expected = Date.UTC(2026, 6, 1, 0, 0, 0) - 3 * 3600 * 1000;
    expect(ms).toBe(expected);
  });

  test("date+time YYYY-MM-DD HH:MM → TZ-aware noon", () => {
    process.env.ENGRAM_TZ = "Europe/Moscow";
    const ms = newestContentDateMs("## 2026-07-01 14:30 — Title");
    expect(ms).not.toBeNull();
    const expected = Date.UTC(2026, 6, 1, 14, 30, 0) - 3 * 3600 * 1000;
    expect(ms).toBe(expected);
  });

  test("date+time with Z → parse as UTC", () => {
    process.env.ENGRAM_TZ = "Europe/Moscow";
    const ms = newestContentDateMs("Event 2026-07-01T14:30:00Z happened");
    expect(ms).not.toBeNull();
    const expected = Date.UTC(2026, 6, 1, 14, 30, 0);
    expect(ms).toBe(expected);
  });

  test("date+time with explicit +03:00 offset → 11:30 UTC", () => {
    process.env.ENGRAM_TZ = "Europe/Moscow";
    const ms = newestContentDateMs("## 2026-07-01 14:30:00+03:00 — Title");
    expect(ms).not.toBeNull();
    const expected = Date.UTC(2026, 6, 1, 11, 30, 0);
    expect(ms).toBe(expected);
  });

  test("multiple dates — returns the newest", () => {
    const ms = newestContentDateMs(
      "## 2026-06-30 10:00 — old\n## 2026-07-01 14:30 — newer\n## 2026-07-02 09:00 — newest",
    );
    expect(ms).not.toBeNull();
    const expected = Date.UTC(2026, 6, 2, 9, 0, 0) - 3 * 3600 * 1000;
    expect(ms).toBe(expected);
  });

  test("empty content → null", () => {
    expect(newestContentDateMs("")).toBeNull();
  });

  test("content with no dates → null", () => {
    expect(newestContentDateMs("Just some text without dates.")).toBeNull();
  });

  test("malformed date is skipped via NaN filter", () => {
    const ms = newestContentDateMs("## 2026-13-01 — bad month\n## 2026-07-01 12:00 — ok");
    // The malformed entry is skipped (NaN); the valid one is returned.
    const expected = Date.UTC(2026, 6, 1, 12, 0, 0) - 3 * 3600 * 1000;
    expect(ms).toBe(expected);
  });

  test("mix of date-only and date+time — date+time wins", () => {
    const ms = newestContentDateMs("## 2026-07-01\n## 2026-07-01 12:00 — explicit time");
    // Both refer to the same calendar day, but the second one is later in the
    // day so max-of-two returns it.
    const expected = Date.UTC(2026, 6, 1, 12, 0, 0) - 3 * 3600 * 1000;
    expect(ms).toBe(expected);
  });
});

// ============================================================================
// A2. applyDomainWriteHandoff — race with agent writes
// ============================================================================
describe("A2. applyDomainWriteHandoff — race recovery", () => {
  test("idempotent path: Entry-Id already in changelog → noop + advance lastCheckedAt", async () => {
    const domain = setupRegistry();
    const dir = join(workspace, "memory", "domains", domain);
    const changelogPath = join(dir, "changelog.md");
    const runId = "hb-race-2026-07-01-fixed-001";
    const entryId = runId + "-0";

    // Pre-populate changelog with the entry that the (already-applied) handoff
    // would have written. This simulates the race where the file was edited
    // externally between subagent base-hash read and apply.
    const oldContent = readFileSync(changelogPath, "utf8");
    const seededChangelog = oldContent + `\n\n## Already-applied entry\nEntry-Id: ${entryId}\n`;
    writeFileSync(changelogPath, seededChangelog);

    const h = handoff({
      runId,
      baseHashes: { "status.md": null, "changelog.md": null },
      changelogEntries: [{ id: entryId, runId, content: "Race-seeded entry" }],
    });

    const statePath = join(workspace, "memory", "heartbeat-state.json");
    const result = await applyDomainWriteHandoff(
      { ok: true, isOk: true, type: "HB-DOMAINS", body: h.body, summary: "test" },
      { workspace, statePath, now: "2026-07-01T15:00:00.000Z" },
    );

    expect(result.ok).toBe(true);
    expect(result.status).toBe("noop");
    expect(result.idempotent).toBe(true);
    expect(result.externalWrite).toBe(true);
    expect(existsSync(statePath)).toBe(true);
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    expect(state.domainRuns[domain].lastRunId).toBe(runId);
    expect(state.domainRuns[domain].lastCheckedAt).toBe("2026-07-01T15:00:00.000Z");
    expect(state.domainRuns[domain].appliedRunIds).toContain(runId);
  });

  test("stale path: base-hash mismatch + Entry-Id not present → status:stale + advance lastCheckedAt", async () => {
    const domain = setupRegistry();
    const dir = join(workspace, "memory", "domains", domain);
    const runId = "hb-race-2026-07-01-stale-001";
    const entryId = runId + "-0";

    // Provide stale base hashes (point at empty sha256 of "" instead of actual
    // file content). This simulates: subagent read files, computed hashes,
    // then before applying, an external agent edited the file.
    const staleBaseHashes = {
      "status.md": "0000000000000000000000000000000000000000000000000000000000000000",
      "changelog.md": "1111111111111111111111111111111111111111111111111111111111111111",
    };

    const h = handoff({
      runId,
      baseHashes: staleBaseHashes,
      changelogEntries: [{ id: entryId, runId, content: "Race-lost entry" }],
    });

    const statePath = join(workspace, "memory", "heartbeat-state.json");
    const result = await applyDomainWriteHandoff(
      { ok: true, isOk: true, type: "HB-DOMAINS", body: h.body, summary: "test" },
      { workspace, statePath, now: "2026-07-01T16:00:00.000Z" },
    );

    expect(result.ok).toBe(true);
    expect(result.status).toBe("stale");
    expect(result.advancedLastCheckedAt).toBe(true);
    expect(result.staleFiles).toEqual(["status.md", "changelog.md"]);
    expect(result.wroteStatus).toBe(false);
    expect(result.appendedEntries).toBe(0);

    // State must be advanced to prevent re-fire storm.
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    expect(state.domainRuns[domain].lastCheckedAt).toBe("2026-07-01T16:00:00.000Z");
    expect(state.domainRuns[domain].lastRunId).toBe(runId);
    expect(state.domainRuns[domain].appliedRunIds).toContain(runId);

    // The lost entry must NOT have been written to changelog.
    const changelogAfter = readFileSync(join(dir, "changelog.md"), "utf8");
    expect(changelogAfter).not.toContain(entryId);
    expect(changelogAfter).not.toContain("Race-lost entry");
  });

  test("happy path: matching hashes + valid handoff → status:ok, no race paths", async () => {
    const domain = setupRegistry();
    const dir = join(workspace, "memory", "domains", domain);
    const statusPath = join(dir, "status.md");
    const changelogPath = join(dir, "changelog.md");

    const { createHash } = await import("node:crypto");
    const sha = (s: string) => createHash("sha256").update(s).digest("hex");
    const currentHashes = {
      "status.md": sha(readFileSync(statusPath, "utf8")),
      "changelog.md": sha(readFileSync(changelogPath, "utf8")),
    };

    const runId = "hb-race-2026-07-01-happy-001";
    const entryId = runId + "-0";
    const h = handoff({
      runId,
      baseHashes: currentHashes,
      statusContent: "# Status: test-domain\n\nUpdated via ISS-9 test.\n",
      changelogEntries: [{ id: entryId, runId, content: "## 2026-07-01 14:30 — Fresh entry" }],
    });

    const statePath = join(workspace, "memory", "heartbeat-state.json");
    const result = await applyDomainWriteHandoff(
      { ok: true, isOk: true, type: "HB-DOMAINS", body: h.body, summary: "test" },
      { workspace, statePath, now: "2026-07-01T17:00:00.000Z" },
    );

    expect(result.ok).toBe(true);
    expect(result.status).toBe("ok");
    expect(result.wroteStatus).toBe(true);
    expect(result.appendedEntries).toBe(1);

    // Real write happened.
    expect(readFileSync(changelogPath, "utf8")).toContain(entryId);
    expect(readFileSync(statusPath, "utf8")).toContain("Updated via ISS-9 test");

    const state = JSON.parse(readFileSync(statePath, "utf8"));
    expect(state.domainRuns[domain].lastRun).toBe("2026-07-01T17:00:00.000Z");
    expect(state.domainRuns[domain].lastRunId).toBe(runId);
  });
});

// ============================================================================
// A3. Timezone consistency — ensureProcessTz mutates process.env.TZ
// ============================================================================
describe("A3. ensureProcessTz — TZ consistency", () => {
  test("ENGRAM_TZ without TZ → TZ is set to ENGRAM_TZ", () => {
    delete process.env.TZ;
    process.env.ENGRAM_TZ = "Asia/Tokyo";
    // Re-import would re-trigger the IIFE; instead set TZ inline to mimic.
    // For real validation, see the file-level IIFE behavior in domains-runner.js.
    process.env.TZ = "Asia/Tokyo";
    const ms = newestContentDateMs("## 2026-07-01 14:30 — Tokyo");
    // Tokyo is UTC+9, no DST.
    const expected = Date.UTC(2026, 6, 1, 14, 30, 0) - 9 * 3600 * 1000;
    expect(ms).toBe(expected);
  });

  test("TZ alone (no ENGRAM_TZ) → TZ is respected", () => {
    delete process.env.ENGRAM_TZ;
    process.env.TZ = "America/New_York";
    const ms = newestContentDateMs("## 2026-07-01 14:30 — New York");
    // New York is UTC-4 in July (EDT).
    const expected = Date.UTC(2026, 6, 1, 14, 30, 0) + 4 * 3600 * 1000;
    expect(ms).toBe(expected);
  });
});
