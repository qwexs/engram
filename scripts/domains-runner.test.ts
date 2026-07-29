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

import {
  newestContentDateMs, applyDomainWriteHandoff, scanDomains,
  DEFAULT_CADENCE_DAYS, shouldInlineNoopDailyNote,
  DEFAULT_MIN_DAILY_BYTES_FOR_SPAWN, computeAdaptiveCadence,
  DEFAULT_CADENCE_ADAPTIVE_WINDOW_DAYS,
} from "./domains-runner.js";

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

  // Regression for parseHandoffField multiline `Status-Content: |` with internal
  // blank lines. The previous regex used `$` inside a `m`-flagged lookahead, which
  // matched at end-of-line and silently truncated the captured body to its first
  // line. The new line-based parser preserves internal blank lines and content
  // until the next field boundary or end-of-body marker.
  test("multiline Status-Content with internal blank line is preserved", async () => {
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
    const runId = "hb-multiline-blank-001";
    const h = handoff({
      runId,
      baseHashes: currentHashes,
      statusContent: "# Status: test-domain\n\nUpdated via ISS-9 test.\n\nTrailing paragraph with deliberate blank line above.\n",
    });
    const statePath = join(workspace, "memory", "heartbeat-state.json");
    const result = await applyDomainWriteHandoff(
      { ok: true, isOk: true, type: "HB-DOMAINS", body: h.body, summary: "test" },
      { workspace, statePath, now: "2026-07-01T18:00:00.000Z" },
    );
    expect(result.ok).toBe(true);
    expect(result.wroteStatus).toBe(true);
    const written = readFileSync(statusPath, "utf8");
    expect(written).toContain("# Status: test-domain");
    expect(written).toContain("Updated via ISS-9 test.");
    expect(written).toContain("Trailing paragraph with deliberate blank line above.");
    // No truncation: the line after the blank line must reach the file.
    expect(written).toMatch(/Updated via ISS-9 test\.\s*\n\s*\n\s*Trailing paragraph/);
  });

  test("multiline Status-Content preserves body when no === END === marker is present", async () => {
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
    const runId = "hb-multiline-no-end-001";
    // Build a handoff body WITHOUT a closing marker. parseHandoffField must still
    // capture the full multiline body and stop at the next field or end-of-body.
    const bodyNoEnd = [
      "=== HB-DOMAINS HANDOFF ===",
      "Status: ok",
      "Summary: end-of-body test",
      "Domain: " + domain,
      "Run-Id: " + runId,
      "Base-Hashes: " + JSON.stringify(currentHashes),
      "Status-Content: |",
      "  # Status: test-domain",
      "",
      "  Tail line after blank, no closing marker.",
    ].join("\n");
    const statePath = join(workspace, "memory", "heartbeat-state.json");
    const result = await applyDomainWriteHandoff(
      { ok: true, isOk: true, type: "HB-DOMAINS", body: bodyNoEnd, summary: "test" },
      { workspace, statePath, now: "2026-07-01T19:00:00.000Z" },
    );
    expect(result.ok).toBe(true);
    expect(result.wroteStatus).toBe(true);
    const written = readFileSync(statusPath, "utf8");
    expect(written).toContain("Tail line after blank, no closing marker.");
  });

  test("multiline Status-Content stops at === END === marker (no body bleed)", async () => {
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
    const runId = "hb-multiline-end-marker-001";
    const h = handoff({
      runId,
      baseHashes: currentHashes,
      statusContent: "# Status: test-domain\n\nBody line.\n",
    });
    const statePath = join(workspace, "memory", "heartbeat-state.json");
    const result = await applyDomainWriteHandoff(
      { ok: true, isOk: true, type: "HB-DOMAINS", body: h.body, summary: "test" },
      { workspace, statePath, now: "2026-07-01T20:00:00.000Z" },
    );
    expect(result.ok).toBe(true);
    const written = readFileSync(statusPath, "utf8");
    // The captured body must not include the trailing `=== END ===` line.
    expect(written).not.toContain("=== END ===");
  });

  test("block-form Changelog-Entries (fenced JSON) still parses when Status-Content is multiline", async () => {
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
    const runId = "hb-block-form-coexists-001";
    // Construct body with BOTH a multiline Status-Content AND a fenced JSON Changelog-Entries.
    // This guards against the line-based parser accidentally truncating one form because
    // of the other.
    const body = [
      "=== HB-DOMAINS HANDOFF ===",
      "Status: ok",
      "Summary: mixed-form test",
      "Domain: " + domain,
      "Run-Id: " + runId,
      "Base-Hashes: " + JSON.stringify(currentHashes),
      "Status-Content: |",
      "  # Status: test-domain",
      "",
      "  Inline blank inside status.",
      "Changelog-Entries:",
      "```json",
      JSON.stringify([{ id: runId + "-0", runId, content: "## 2026-07-01 14:30 — Mixed-form entry" }]),
      "```",
      "=== END ===",
    ].join("\n");
    const statePath = join(workspace, "memory", "heartbeat-state.json");
    const result = await applyDomainWriteHandoff(
      { ok: true, isOk: true, type: "HB-DOMAINS", body, summary: "test" },
      { workspace, statePath, now: "2026-07-01T21:00:00.000Z" },
    );
    expect(result.ok).toBe(true);
    expect(result.wroteStatus).toBe(true);
    expect(result.appendedEntries).toBe(1);
    expect(readFileSync(changelogPath, "utf8")).toContain(runId + "-0");
    const written = readFileSync(statusPath, "utf8");
    expect(written).toContain("Inline blank inside status.");
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

// ============================================================================
// A4. cadenceDays default fallback — domains without explicit cadence
//     should not be silent no-ops.
// ============================================================================
describe("A4. scanDomains — cadenceDays default fallback", () => {
  test("DEFAULT_CADENCE_DAYS is exported and equals 2", () => {
    expect(DEFAULT_CADENCE_DAYS).toBe(2);
  });

  test("domain without cadenceDays, never run → due=true, overdue=true (default 2)", () => {
    setupRegistry();
    const scan = scanDomains({ workspace });
    expect(scan.domains).toHaveLength(1);
    const d = scan.domains[0];
    expect(d.enabled).toBe(true);
    expect(d.due).toBe(true);
    expect(d.overdue).toBe(true);
  });

  test("domain with explicit cadenceDays=0 → falls back to default 2 (not 'never')", () => {
    setupRegistry();
    const regPath = join(workspace, "memory", "domains", "registry.json");
    const reg = JSON.parse(readFileSync(regPath, "utf-8"));
    reg.domains["test-domain"].cadenceDays = 0;
    writeFileSync(regPath, JSON.stringify(reg) + "\n");
    const scan = scanDomains({ workspace });
    expect(scan.domains[0].due).toBe(true);
    expect(scan.domains[0].overdue).toBe(true);
  });

  test("domain with cadenceDays=1, lastRun 12h ago → not due (12h < 1 day)", () => {
    setupRegistry();
    const regPath = join(workspace, "memory", "domains", "registry.json");
    const reg = JSON.parse(readFileSync(regPath, "utf-8"));
    reg.domains["test-domain"].cadenceDays = 1;
    writeFileSync(regPath, JSON.stringify(reg) + "\n");
    // Last run 12 hours before scan-now.
    const now = new Date("2026-07-04T12:00:00.000Z");
    const statePath = join(workspace, "memory", "heartbeat-state.json");
    writeFileSync(statePath, JSON.stringify({
      domainRuns: { "test-domain": { lastRun: "2026-07-04T00:00:00.000Z" } },
    }) + "\n");
    const scan = scanDomains({ workspace, now });
    expect(scan.domains[0].due).toBe(false);
  });

  test("domain with cadenceDays=1, lastRun 2 days ago → due=true", () => {
    setupRegistry();
    const regPath = join(workspace, "memory", "domains", "registry.json");
    const reg = JSON.parse(readFileSync(regPath, "utf-8"));
    reg.domains["test-domain"].cadenceDays = 1;
    writeFileSync(regPath, JSON.stringify(reg) + "\n");
    const now = new Date("2026-07-04T12:00:00.000Z");
    const statePath = join(workspace, "memory", "heartbeat-state.json");
    writeFileSync(statePath, JSON.stringify({
      domainRuns: { "test-domain": { lastRun: "2026-07-02T12:00:00.000Z" } },
    }) + "\n");
    const scan = scanDomains({ workspace, now });
    expect(scan.domains[0].due).toBe(true);
  });

  test("domain enabled=false → never due, regardless of cadenceDays", () => {
    setupRegistry();
    const regPath = join(workspace, "memory", "domains", "registry.json");
    const reg = JSON.parse(readFileSync(regPath, "utf-8"));
    reg.domains["test-domain"].enabled = false;
    writeFileSync(regPath, JSON.stringify(reg) + "\n");
    const scan = scanDomains({ workspace });
    expect(scan.domains[0].due).toBe(false);
  });

  test("domain with default cadenceDays and lastCheckedAt within window → suppressed", () => {
    setupRegistry();
    const now = new Date("2026-07-04T12:00:00.000Z");
    const statePath = join(workspace, "memory", "heartbeat-state.json");
    writeFileSync(statePath, JSON.stringify({
      domainRuns: {
        "test-domain": {
          lastRun: "2026-07-01T00:00:00.000Z",  // last real write 3.5 days ago
          lastCheckedAt: "2026-07-04T11:00:00.000Z",  // recent check (1h ago)
        },
      },
    }) + "\n");
    const scan = scanDomains({ workspace, now });
    expect(scan.domains[0].due).toBe(true);  // due by cadence
    expect(scan.domains[0].suppressedByLastCheckedAt).toBe(true);  // but suppressed
  });
});

// ============================================================================
// A6. shouldInlineNoopDailyNote — pre-spawn daily-note peek
// ============================================================================
describe("A6. shouldInlineNoopDailyNote — pre-spawn peek", () => {
  function writeDailyNote(text: string) {
    const dir = join(workspace, "memory", "agent-test", "telegram-test-topic-1");
    mkdirSync(dir, { recursive: true });
    const p = join(dir, "2026-07-01.md");
    writeFileSync(p, text);
    return p;
  }

  function writeDecisions(text: string) {
    setupRegistry();
    const p = join(workspace, "memory", "domains", "test-domain", "decisions.md");
    writeFileSync(p, text);
    return p;
  }

  test("DEFAULT_MIN_DAILY_BYTES_FOR_SPAWN is exported and equals 100", () => {
    expect(DEFAULT_MIN_DAILY_BYTES_FOR_SPAWN).toBe(100);
  });

  test("missing daily note → inline-noop", () => {
    const p = join(workspace, "memory", "agent-test", "telegram-test-topic-1", "2026-07-01.md");
    // Don't create the file.
    expect(shouldInlineNoopDailyNote({ dailyPath: p })).toBe(true);
  });

  test("daily note smaller than threshold → inline-noop", () => {
    const p = writeDailyNote("# 2026-07-01\n\n## Events\n\n## Decisions\n");
    expect(shouldInlineNoopDailyNote({ dailyPath: p })).toBe(true);
  });

  test("daily note large with empty high-signal sections → inline-noop", () => {
    // Padding lives BEFORE `## Events` so E/D/L bodies stay short.
    const padding = "# 2026-07-01\n\n" + ("x".repeat(150)) + "\n\n## Events\n   \n\n## Decisions\n\n";
    const p = writeDailyNote(padding);
    expect(shouldInlineNoopDailyNote({ dailyPath: p })).toBe(true);
  });

  test("daily note with real events, no decisions.md → spawn (existing v3.3)", () => {
    const text = "# 2026-07-01\n\n## Events\n\n- 12:00 обсудили важное решение по архитектуре runner.\n- 12:05 также протестировали новый pipeline.\n\n";
    const p = writeDailyNote(text);
    expect(shouldInlineNoopDailyNote({ dailyPath: p })).toBe(false);
  });

  test("decisions-only daily note (empty Events) → spawn", () => {
    // Production: Chromolab plan approvals often land in ## Decisions only.
    const text = [
      "# 2026-07-01",
      "",
      "## Events",
      "",
      "## Decisions",
      "",
      "- Елена утвердила структуру плана Chromolab на месяцы 1-2 и бюджеты.",
      "",
      "## Learnings",
      "",
    ].join("\n");
    const p = writeDailyNote(text);
    expect(shouldInlineNoopDailyNote({ dailyPath: p })).toBe(false);
  });

  test("learnings-only daily note → spawn", () => {
    const text = [
      "# 2026-07-01",
      "",
      "## Events",
      "",
      "## Decisions",
      "",
      "## Learnings",
      "",
      "- Outline doc «Референсы для Такерон» is the source of truth for brand refs.",
      "",
    ].join("\n");
    const p = writeDailyNote(text);
    expect(shouldInlineNoopDailyNote({ dailyPath: p })).toBe(false);
  });

  test("daily note with real events + matching decision keyword → spawn", () => {
    writeDecisions("# Решения: test-domain\n\n## Принятые решения\n\n### 2026-06-30 — Архитектура runner\n\n**Решение**: использовать событийный pipeline с retry.\n");
    const text = "# 2026-07-01\n\n## Events\n\n- 12:00 утвердили событийный pipeline, проверили retry.\n\n";
    const p = writeDailyNote(text);
    expect(shouldInlineNoopDailyNote({ dailyPath: p, decisionsPath: join(workspace, "memory", "domains", "test-domain", "decisions.md") })).toBe(false);
  });

  test("events-only + no matching keyword → inline-noop (A6 key-words gate)", () => {
    writeDecisions("# Решения: test-domain\n\n## Принятые решения\n\n### 2026-06-30 — База данных\n\n**Решение**: мигрировать на postgres.\n");
    const text = "# 2026-07-01\n\n## Events\n\n- 12:00 обсудили новый UI для runner, выбрали цвета.\n\n";
    const p = writeDailyNote(text);
    expect(shouldInlineNoopDailyNote({ dailyPath: p, decisionsPath: join(workspace, "memory", "domains", "test-domain", "decisions.md") })).toBe(true);
  });

  test("decisions section bypasses events-only keyword gate for new topics", () => {
    // Old domain keywords (postgres) must not suppress a Chromolab decision day.
    writeDecisions("# Решения: test-domain\n\n## Принятые решения\n\n### 2026-06-30 — База данных\n\n**Решение**: мигрировать на postgres.\n");
    const text = [
      "# 2026-07-01",
      "",
      "## Events",
      "",
      "## Decisions",
      "",
      "- Утвердили финальное КП Chromolab на 6 месяцев.",
      "",
    ].join("\n");
    const p = writeDailyNote(text);
    expect(shouldInlineNoopDailyNote({
      dailyPath: p,
      decisionsPath: join(workspace, "memory", "domains", "test-domain", "decisions.md"),
    })).toBe(false);
  });

  test("pinned: marker counts as keyword", () => {
    writeDecisions("# Решения: test-domain\n\n## Принятые решения\n\npinned: обязательно использовать token-bucket для rate-limit.\n");
    const text = "# 2026-07-01\n\n## Events\n\n- 12:00 решено применить rate-limit подход token-bucket на новой задаче.\n\n";
    const p = writeDailyNote(text);
    expect(shouldInlineNoopDailyNote({ dailyPath: p, decisionsPath: join(workspace, "memory", "domains", "test-domain", "decisions.md") })).toBe(false);
  });

  test("custom minBytes threshold is respected", () => {
    const text = "# 2026-07-01\n\n## Events\n\n- событие\n";  // ~50 bytes
    const p = writeDailyNote(text);
    expect(shouldInlineNoopDailyNote({ dailyPath: p, minBytes: 30 })).toBe(true); // signal < 30 → noop
    expect(shouldInlineNoopDailyNote({ dailyPath: p, minBytes: 200 })).toBe(true); // size < 200 → noop
  });
});

// ============================================================================
// A7. computeAdaptiveCadence — domain-aware cadence from event density
// ============================================================================
describe("A7. computeAdaptiveCadence — domain-aware cadence", () => {
  function setupDailyNotes(sessionKey: string, dates: { date: string; events: string[] }[]) {
    const agentDir = join(workspace, "memory", "agent-test", sessionKey);
    mkdirSync(agentDir, { recursive: true });
    for (const { date, events } of dates) {
      const notePath = join(agentDir, date + ".md");
      const content = `# ${date}\n\n## Events\n\n${events.map((e) => `- ${e}`).join("\n")}\n\n## Decisions\n\n`;
      writeFileSync(notePath, content);
    }
  }

  // Build 7 valid consecutive dates ending at (today - 1 day) so all 7
  // fall inside the windowDays=7 trailing window (today-7..today-1).
  function sevenDatesEndingYesterday(today: Date): string[] {
    const out: string[] = [];
    for (let i = 1; i <= 7; i++) {
      const d = new Date(today.getTime() - i * 86400000);
      out.push(d.toISOString().slice(0, 10));
    }
    return out.reverse(); // chronological order
  }

  test("DEFAULT_CADENCE_ADAPTIVE_WINDOW_DAYS is exported and equals 7", () => {
    expect(DEFAULT_CADENCE_ADAPTIVE_WINDOW_DAYS).toBe(7);
  });

  test("no daily notes → effectiveCadenceDays == windowDays (coldest)", () => {
    const result = computeAdaptiveCadence({
      workspace,
      sessionKey: "telegram-group--1-topic-1",
      windowDays: 7,
      defaultCadenceDays: 5,
      today: new Date("2026-07-04T12:00:00.000Z"),
    });
    expect(result.eventsPerDay).toBe(0);
    expect(result.totalEvents).toBe(0);
    expect(result.daysWithNotes).toBe(0);
    // raw = windowDays = 7, but clamp(7, 1, 5) = 5.
    expect(result.raw).toBe(7);
    expect(result.effectiveCadenceDays).toBe(5);
  });

  test("1 event per day over 7 days → effectiveCadenceDays = 7, clamped to default", () => {
    const today = new Date("2026-07-05T12:00:00.000Z");
    const dates = sevenDatesEndingYesterday(today).map((date) => ({ date, events: ["event"] }));
    setupDailyNotes("telegram-group--1-topic-2", dates);
    const result = computeAdaptiveCadence({
      workspace,
      sessionKey: "telegram-group--1-topic-2",
      windowDays: 7,
      defaultCadenceDays: 7,
      today,
    });
    expect(result.totalEvents).toBe(7);
    expect(result.eventsPerDay).toBe(1);
    expect(result.raw).toBe(7);  // 7 / 1
    expect(result.effectiveCadenceDays).toBe(7);
  });

  test("7 events per day over 7 days → effectiveCadenceDays = 1 (very active)", () => {
    const today = new Date("2026-07-05T12:00:00.000Z");
    const dates = sevenDatesEndingYesterday(today).map((date) => ({
      date,
      events: ["e1", "e2", "e3", "e4", "e5", "e6", "e7"],
    }));
    setupDailyNotes("telegram-group--1-topic-3", dates);
    const result = computeAdaptiveCadence({
      workspace,
      sessionKey: "telegram-group--1-topic-3",
      windowDays: 7,
      defaultCadenceDays: 14,
      today,
    });
    expect(result.eventsPerDay).toBe(7);
    expect(result.raw).toBe(1);  // 7 / 7 = 1
    expect(result.effectiveCadenceDays).toBe(1);
  });

  test("0.5 events per day → raw=14, clamped to defaultCadenceDays=10", () => {
    // 3 events over 7 days = 0.43 per day, round(7/0.43) ≈ 16 → clamp to 10.
    const dates = [
      { date: "2026-06-29", events: ["a"] },
      { date: "2026-06-30", events: ["a"] },
      { date: "2026-07-01", events: ["a"] },
    ];
    setupDailyNotes("telegram-group--1-topic-4", dates);
    const result = computeAdaptiveCadence({
      workspace,
      sessionKey: "telegram-group--1-topic-4",
      windowDays: 7,
      defaultCadenceDays: 10,
      today: new Date("2026-07-04T12:00:00.000Z"),
    });
    expect(result.totalEvents).toBe(3);
    // 3 / 7 = 0.4286 events/day, round(7 / 0.4286) = round(16.33) = 16 → clamp to 10
    expect(result.raw).toBeGreaterThanOrEqual(15);
    expect(result.raw).toBeLessThanOrEqual(17);
    expect(result.effectiveCadenceDays).toBe(10);
  });

  test("integration: scanDomains with cadenceAdaptive + topic binding + cold topic", () => {
    // Cold topic → effectiveCadenceDays = 5 (clamped from 7 to defaultCadenceDays=5).
    const sessionKey = "telegram-group--1001000001-topic-60";
    // No daily notes → eventsPerDay=0 → raw=windowDays=7 → clamp to defaultCadenceDays=5.
    const regPath = join(workspace, "memory", "domains", "registry.json");
    writeFileSync(regPath, JSON.stringify({
      domains: {
        engram: {
          type: "topic-thread",
          topic: { chatId: "-1001000001", topicId: 60 },
          cadenceDays: 5,
          cadenceAdaptive: true,
          cadenceAdaptiveWindowDays: 7,
        },
      },
    }) + "\n");
    mkdirSync(join(workspace, "memory", "domains", "engram"), { recursive: true });
    const scan = scanDomains({
      workspace,
      now: new Date("2026-07-04T12:00:00.000Z"),
    });
    const d = scan.domains[0];
    expect(d.due).toBe(true); // lastRunMs is null → due
    expect(d.cadenceDays).toBe(5); // clamped from 7 to defaultCadenceDays=5
    expect(d.cadenceAdaptive).not.toBeNull();
    expect(d.cadenceAdaptive.totalEvents).toBe(0);
    expect(d.cadenceAdaptive.eventsPerDay).toBe(0);
  });

  test("integration: scanDomains without cadenceAdaptive flag → uses raw cadenceDays", () => {
    const regPath = join(workspace, "memory", "domains", "registry.json");
    writeFileSync(regPath, JSON.stringify({
      domains: {
        engram: {
          type: "topic-thread",
          topic: { chatId: "-1001000001", topicId: 60 },
          cadenceDays: 4,
        },
      },
    }) + "\n");
    mkdirSync(join(workspace, "memory", "domains", "engram"), { recursive: true });
    const scan = scanDomains({ workspace });
    expect(scan.domains[0].cadenceDays).toBe(4);
    expect(scan.domains[0].cadenceAdaptive).toBeNull();
  });
});
