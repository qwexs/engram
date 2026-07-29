import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { collectDailyCandidates, collectSessionCandidates, collectSessionFiles, extractLastWatermark, findSupersedeTarget } from "../scripts/extract-runner.js";

function makeWorkspace() {
  const root = mkdtempSync(join(tmpdir(), "engram-extract-"));
  mkdirSync(join(root, "memory", "agent-main", "main", "sessions"), { recursive: true });
  writeFileSync(join(root, "engram.json"), JSON.stringify({ agent: "agent-main" }));
  return root;
}

describe("extract-runner daily candidates", () => {
  test("finds high-signal bullets above an EOF watermark (daily-note-append layout)", () => {
    // Production layout: agents write Events/Decisions near the top;
    // heartbeat appends Heartbeat Report + extracted marker at EOF.
    // Scanning only after watermark.line permanently missed this content.
    const note = [
      "# 2026-05-21",
      "",
      "## Events",
      "- Chromolab six-month plan approved with content volumes",
      "",
      "## Decisions",
      "- Елена утвердила структуру плана Chromolab на месяцы 1-2",
      "",
      "## Heartbeat Report",
      "- **Extraction**: ok (0 facts, 0 skipped, 0 sessions, L20->L20)",
      "<!-- extracted:L20:2026-05-21T00:00:00+03:00 -->",
      "",
    ].join("\n");
    const result = collectDailyCandidates(note);
    expect(result.watermark.watermark).toBe(20);
    expect(result.scanMode).toBe("full-high-signal");
    expect(result.candidates.map((c) => c.text)).toEqual([
      "Chromolab six-month plan approved with content volumes",
      "Елена утвердила структуру плана Chromolab на месяцы 1-2",
    ]);
    expect(result.candidates.map((c) => c.category)).toEqual(["milestone", "decision"]);
  });

  test("still finds content when watermark sits mid-file (legacy append-after layout)", () => {
    const note = `# 2026-05-21\n\n## Events\n- Old event already known from prior extract run\n<!-- extracted:L4:2026-05-21T00:00:00+03:00 -->\n- New Engram heartbeat event after marker\n`;
    const result = collectDailyCandidates(note);
    expect(result.watermark.watermark).toBe(4);
    // Full high-signal scan: both bullets are candidates; memory-write dedup
    // skips the already-promoted "Old event" on write.
    expect(result.candidates.map((c) => c.text)).toEqual([
      "Old event already known from prior extract run",
      "New Engram heartbeat event after marker",
    ]);
  });

  test("tracks the last watermark and still collects Decisions after it", () => {
    const note = `# 2026-05-21\n\n## Heartbeat Report\n- **Extraction**: ok\n<!-- extracted:L4:old -->\n\n## Decisions\n- Решили оставить heartbeat-runner entrypoint.\n`;
    expect(extractLastWatermark(note).watermark).toBe(4);
    expect(collectDailyCandidates(note).candidates[0].category).toBe("decision");
  });

  test("ignores Heartbeat Report bullets and ## Next operational notes", () => {
    const note = [
      "# 2026-05-21",
      "",
      "## Events",
      "- Durable project milestone about release readiness",
      "",
      "## Next",
      "- Tomorrow call the client about invoice details",
      "",
      "## Heartbeat Report",
      "- **Extraction**: ok (0 facts)",
      "- **Domains**: ok",
      "<!-- extracted:L12:2026-05-21T00:00:00+03:00 -->",
    ].join("\n");
    const result = collectDailyCandidates(note);
    expect(result.candidates.map((c) => c.text)).toEqual([
      "Durable project milestone about release readiness",
    ]);
  });
});

describe("extract-runner session candidates", () => {
  test("extracts high-signal session facts and ignores cron-like filenames", async () => {
    const root = makeWorkspace();
    try {
      const sessionsDir = join(root, "memory", "agent-main", "main", "sessions");
      writeFileSync(join(sessionsDir, "2026-05-21-010000-test.md"), `# Session: 2026-05-21 01:00:00 UTC\n\nuser: Я предпочитаю runner как единственную точку входа для heartbeat.\n`);
      writeFileSync(join(sessionsDir, "cron-a5c987bb-test.md"), `# Session: 2026-05-21 02:00:00 UTC\n\nuser: Я предпочитаю cron шум.\n`);
      const collected = await collectSessionFiles({ workspace: root, agentDir: "agent-main", session: "main", lastSessionExtracted: null });
      expect(collected.files.map((f) => f.name)).toEqual(["2026-05-21-010000-test.md"]);
      const candidates = collectSessionCandidates(collected.files[0]);
      expect(candidates).toHaveLength(1);
      expect(candidates[0].category).toBe("preference");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("ignores assistant status text and tool/log noise", async () => {
    const root = makeWorkspace();
    try {
      const sessionsDir = join(root, "memory", "agent-main", "main", "sessions");
      writeFileSync(join(sessionsDir, "2026-05-21-010000-noise.md"), [
        "# Session: 2026-05-21 01:00:00 UTC",
        "",
        "assistant: Готово. Pass E доведён, full gate зелёный: `bun test tests` → 113 pass / 0 fail.",
        "assistant: [2026-04-05 19:41:16 GMT+3] Exec completed (swift-lo, code 1) :: remote: ! fsk-shop currently has a deploy lock in place.",
        "assistant: Now let me also look at how BerryMoleculeScene passes berrySrcs.",
        "user: Я предпочитаю deterministic heartbeat runner как единственную точку входа.",
        "",
      ].join("\n"));
      const collected = await collectSessionFiles({ workspace: root, agentDir: "agent-main", session: "main", lastSessionExtracted: null });
      const candidates = collectSessionCandidates(collected.files[0]);
      expect(candidates).toHaveLength(1);
      expect(candidates[0].category).toBe("preference");
      expect(candidates[0].text).toContain("deterministic heartbeat runner");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects technical process telemetry from session and daily-note extraction", () => {
    const incident = "The embed process (1508602) already finished — it's gone. Let me check network traffic.";
    const sessionCandidates = collectSessionCandidates({
      name: "2026-07-20-172903-incident.md",
      content: `# Session: 2026-07-20 17:29:03 UTC\n\nassistant: ${incident}\n`,
    });
    expect(sessionCandidates).toHaveLength(0);

    const daily = collectDailyCandidates(`# 2026-07-20\n\n## Events\n- ${incident}\n`);
    expect(daily.candidates).toHaveLength(0);
  });

  test("keeps durable assistant completion milestones but rejects bare completion prose", () => {
    const candidates = collectSessionCandidates({
      name: "2026-07-20-180000-completion.md",
      content: [
        "# Session: 2026-07-20 18:00:00 UTC",
        "",
        "assistant: Production deployment finished successfully for the Engram release.",
        "assistant: The operation finished successfully and is gone.",
        "user: I finished the migration to the new memory schema.",
      ].join("\n"),
    });

    expect(candidates.map((candidate) => candidate.text)).toEqual([
      "Production deployment finished successfully for the Engram release.",
      "I finished the migration to the new memory schema.",
    ]);
    expect(candidates.every((candidate) => candidate.category === "milestone")).toBe(true);
  });
});

describe("extract-runner dry run", () => {
  test("does not advance daily watermark or session cursor unless explicitly requested", async () => {
    const root = makeWorkspace();
    try {
      const notePath = join(root, "memory", "agent-main", "main", "2026-05-21.md");
      writeFileSync(notePath, `# 2026-05-21\n\n## Events\n- Old event\n<!-- extracted:L4:2026-05-21T00:00:00+03:00 -->\n- New Engram heartbeat event\n`);

      const proc = Bun.spawn([
        "bun",
        join(import.meta.dir, "..", "scripts", "extract-runner.js"),
        "--workspace", root,
        "--agent-id", "main",
        "--session", "main",
        "--date", "2026-05-21",
        "--no-write",
      ], { stdout: "pipe", stderr: "pipe" });

      const exitCode = await proc.exited;
      const stdout = await new Response(proc.stdout).text();
      expect(exitCode).toBe(0);
      expect(stdout).toContain('"dry_run":true');
      expect(stdout).toContain('"watermark_advanced":false');
      expect(readFileSync(notePath, "utf8")).toContain("<!-- extracted:L4:2026-05-21T00:00:00+03:00 -->");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// findSupersedeTarget — auto-supersede detection for high-confidence categories
// ---------------------------------------------------------------------------

function seedEntity(root, entity, facts) {
  const entityPath = join(root, "life", entity);
  mkdirSync(entityPath, { recursive: true });
  const data = { entityId: entity, entityType: "project", facts };
  writeFileSync(join(entityPath, "items.json"), JSON.stringify(data, null, 2));
}

function makeFact(overrides) {
  return {
    id: "test-001",
    fact: "default fact text",
    category: "preference",
    status: "active",
    confidence: 0.85,
    ...overrides,
  };
}

describe("findSupersedeTarget", () => {
  test("returns null for non-supersede categories (milestone/context/status)", async () => {
    const root = makeWorkspace();
    try {
      seedEntity(root, "projects/test", [
        makeFact({ id: "test-001", fact: "Deploy completed in production environment", category: "milestone" }),
      ]);
      const result = await findSupersedeTarget(
        { entity: "projects/test", category: "milestone", fact: "Deploy completed in production environment for second time" },
        { workspace: root }
      );
      expect(result).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("returns {id, sim} for high-Jaccard preference replacement", async () => {
    const root = makeWorkspace();
    try {
      seedEntity(root, "projects/test", [
        makeFact({ id: "test-001", category: "preference", fact: "Use cleanup keep for hb-extract subagents to preserve debug history" }),
      ]);
      const result = await findSupersedeTarget(
        { entity: "projects/test", category: "preference", fact: "Use cleanup keep for hb-extract subagents to preserve debug history forever" },
        { workspace: root }
      );
      expect(result).not.toBeNull();
      expect(result.ambiguous).toBeFalsy();
      expect(result.id).toBe("test-001");
      expect(result.sim).toBeGreaterThanOrEqual(0.75);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("returns null when Jaccard below threshold", async () => {
    const root = makeWorkspace();
    try {
      seedEntity(root, "projects/test", [
        makeFact({ id: "test-001", category: "preference", fact: "Prefer dark mode in code editors for late night work sessions" }),
      ]);
      const result = await findSupersedeTarget(
        { entity: "projects/test", category: "preference", fact: "Always write tests before implementation in TDD strict style" },
        { workspace: root }
      );
      expect(result).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("returns null when existing fact is already superseded", async () => {
    const root = makeWorkspace();
    try {
      seedEntity(root, "projects/test", [
        makeFact({ id: "test-001", category: "preference", status: "superseded", fact: "Use cleanup keep for hb-extract subagents to preserve debug history" }),
      ]);
      const result = await findSupersedeTarget(
        { entity: "projects/test", category: "preference", fact: "Use cleanup keep for hb-extract subagents to preserve debug history forever" },
        { workspace: root }
      );
      expect(result).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("marks ambiguous when two candidates within margin", async () => {
    const root = makeWorkspace();
    try {
      seedEntity(root, "projects/test", [
        makeFact({ id: "test-001", category: "preference", fact: "Use cleanup keep for hb-extract subagents to preserve debug history forever" }),
        makeFact({ id: "test-002", category: "preference", fact: "Use cleanup keep for hb-extract subagents to preserve debug history always" }),
      ]);
      const result = await findSupersedeTarget(
        { entity: "projects/test", category: "preference", fact: "Use cleanup keep for hb-extract subagents to preserve debug history completely" },
        { workspace: root }
      );
      expect(result).not.toBeNull();
      expect(result.ambiguous).toBe(true);
      expect(result.candidates.length).toBeGreaterThanOrEqual(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("returns null for missing entity", async () => {
    const root = makeWorkspace();
    try {
      const result = await findSupersedeTarget(
        { entity: "projects/does-not-exist", category: "preference", fact: "Anything at all about preference" },
        { workspace: root }
      );
      expect(result).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("respects custom threshold via opts", async () => {
    const root = makeWorkspace();
    try {
      seedEntity(root, "projects/test", [
        makeFact({ id: "test-001", category: "preference", fact: "Use cleanup keep for hb-extract subagents to preserve debug history" }),
      ]);
      // Default threshold 0.75 → no match (texts differ enough to drop below)
      const strictResult = await findSupersedeTarget(
        { entity: "projects/test", category: "preference", fact: "Use cleanup keep for hb-extract subagents to preserve debug history forever" },
        { workspace: root, threshold: 0.99 }
      );
      expect(strictResult).toBeNull();

      // Loose threshold 0.5 → match
      const looseResult = await findSupersedeTarget(
        { entity: "projects/test", category: "preference", fact: "Use cleanup keep for hb-extract subagents to preserve debug history forever" },
        { workspace: root, threshold: 0.5 }
      );
      expect(looseResult).not.toBeNull();
      expect(looseResult.id).toBe("test-001");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
