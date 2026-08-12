import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  collectDailyCandidates,
  collectSessionCandidates,
  collectSessionFiles,
  extractLastWatermark,
  findSupersedeTarget,
  resolveDomainForSession,
  shouldExtractToKg,
} from "../scripts/extract-runner.js";

function makeWorkspace(config = {}) {
  const root = mkdtempSync(join(tmpdir(), "engram-extract-"));
  mkdirSync(join(root, "memory", "agent-main", "main", "sessions"), { recursive: true });
  writeFileSync(join(root, "engram.json"), JSON.stringify({
    agent: "agent-main",
    kg: { automaticIngress: "legacy" },
    ...config,
  }));
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
      "- Example Clinic six-month plan approved with content volumes",
      "",
      "## Decisions",
      "- Руководитель утвердил структуру плана Example Clinic на месяцы 1-2",
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
      "Example Clinic six-month plan approved with content volumes",
      "Руководитель утвердил структуру плана Example Clinic на месяцы 1-2",
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

describe("domain-first KG policy", () => {
  const registry = {
    domains: {
      "managers-general": {
        type: "meta-domain",
        metaDomain: true,
        topic: { chatId: "-1000000001", topicId: "1" },
      },
      "managers-clients": {
        type: "topic-thread",
        topic: { chatId: "-1000000001", topicId: "15" },
      },
      "executive-a-general": {
        type: "meta-domain",
        metaDomain: true,
        peer: { chatId: "100000001" },
      },
    },
  };

  test("main and meta-domain (General) allow KG extract", () => {
    const main = resolveDomainForSession(registry, "main");
    expect(main.kind).toBe("main");
    expect(shouldExtractToKg(main).allow).toBe(true);

    const general = resolveDomainForSession(registry, "telegram-group--1000000001-topic-1");
    expect(general.domain).toBe("managers-general");
    expect(general.meta).toBe(true);
    expect(shouldExtractToKg(general).allow).toBe(true);

    const peerMeta = resolveDomainForSession(registry, "telegram-direct-100000001");
    expect(peerMeta.domain).toBe("executive-a-general");
    expect(shouldExtractToKg(peerMeta).allow).toBe(true);
  });

  test("topic-thread sessions skip KG (domain-first)", () => {
    const clients = resolveDomainForSession(registry, "telegram-group--1000000001-topic-15");
    expect(clients.domain).toBe("managers-clients");
    expect(clients.meta).toBe(false);
    const policy = shouldExtractToKg(clients);
    expect(policy.allow).toBe(false);
    expect(policy.reason).toContain("domain-first");
  });

  test("unbound chat sessions skip KG under domain-first", () => {
    const unbound = resolveDomainForSession(registry, "telegram-group--100999-topic-99");
    expect(unbound.kind).toBe("unbound");
    expect(shouldExtractToKg(unbound).allow).toBe(false);
  });

  test("kgPolicy all re-enables topic KG extract", () => {
    const clients = resolveDomainForSession(registry, "telegram-group--1000000001-topic-15");
    expect(shouldExtractToKg(clients, { extraction: { kgPolicy: "all" } }).allow).toBe(true);
  });

  test("kgPolicy main-only blocks meta-domain", () => {
    const general = resolveDomainForSession(registry, "telegram-group--1000000001-topic-1");
    expect(shouldExtractToKg(general, { extraction: { kgPolicy: "main-only" } }).allow).toBe(false);
    expect(shouldExtractToKg({ kind: "main", meta: false }, { extraction: { kgPolicy: "main-only" } }).allow).toBe(true);
  });

  test("topic-thread extract-runner does not write KG facts", async () => {
    const root = makeWorkspace();
    try {
      const session = "telegram-group--1000000001-topic-15";
      const sessionDir = join(root, "memory", "agent-main", session);
      mkdirSync(sessionDir, { recursive: true });
      mkdirSync(join(root, "memory", "domains"), { recursive: true });
      writeFileSync(join(root, "memory", "domains", "registry.json"), JSON.stringify({
        domains: {
          "managers-clients": {
            type: "topic-thread",
            topic: { chatId: "-1000000001", topicId: "15" },
          },
        },
      }));
      const notePath = join(sessionDir, "2026-05-21.md");
      writeFileSync(notePath, [
        "# 2026-05-21",
        "",
        "## Events",
        "- Example Clinic six-month plan approved with content volumes",
        "",
        "## Decisions",
        "- Client approved final commercial proposal structure",
        "",
      ].join("\n"));

      const proc = Bun.spawn([
        "bun",
        join(import.meta.dir, "..", "scripts", "extract-runner.js"),
        "--workspace", root,
        "--agent-id", "main",
        "--session", session,
        "--date", "2026-05-21",
      ], { stdout: "pipe", stderr: "pipe" });
      const exitCode = await proc.exited;
      const stdout = await new Response(proc.stdout).text();
      expect(exitCode).toBe(0);
      expect(stdout).toContain("domain-first skip KG");
      expect(stdout).toContain('"kg_extract":false');
      expect(stdout).toContain('"facts_written":0');
      expect(stdout).toContain('"facts_domain_only":2');
      // No life/ entities created
      expect(existsSync(join(root, "life", "projects"))).toBe(false);
      // Watermark still advanced so extract does not thrash
      expect(readFileSync(notePath, "utf8")).toMatch(/<!-- extracted:L\d+/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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

describe("automatic extraction containment", () => {
  test("suppresses daily/session writes and a consumed session is not replayed", async () => {
    const root = makeWorkspace({ kg: { automaticIngress: "disabled" } });
    try {
      const notePath = join(root, "memory", "agent-main", "main", "2026-05-21.md");
      writeFileSync(notePath, "# 2026-05-21\n\n## Events\n- Completed durable containment rollout milestone\n\n## Decisions\n\n## Learnings\n");
      const sessionName = "2026-05-21-010000-contained.md";
      writeFileSync(join(root, "memory", "agent-main", "main", "sessions", sessionName), [
        "# Session: 2026-05-21 01:00:00 UTC",
        "",
        "user: Я предпочитаю automatic containment without legacy memory writes.",
      ].join("\n"));

      const run = async () => {
        const proc = Bun.spawn([
          "bun", join(import.meta.dir, "..", "scripts", "extract-runner.js"),
          "--workspace", root, "--agent-id", "main", "--session", "main", "--date", "2026-05-21",
        ], { stdout: "pipe", stderr: "pipe" });
        const stdout = await new Response(proc.stdout).text();
        expect(await proc.exited).toBe(0);
        return JSON.parse(stdout.match(/^Stats: (.+)$/m)[1]);
      };

      const first = await run();
      expect(first).toMatchObject({ facts_written: 0, facts_suppressed: 2, daily_candidates: 1, sessions_processed: 1 });
      expect(first.last_session_file).toBe(sessionName);
      expect(existsSync(join(root, "life"))).toBe(false);
      writeFileSync(join(root, "memory", "heartbeat-state.json"), JSON.stringify({
        lastSessionExtracted: { main: sessionName },
      }));

      const second = await run();
      expect(second).toMatchObject({ facts_written: 0, facts_suppressed: 0, daily_candidates: 0, sessions_processed: 0 });
      expect(existsSync(join(root, "life"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("never regresses a preexisting watermark when the rewritten note body is shorter", async () => {
    const root = makeWorkspace({ kg: { automaticIngress: "disabled" } });
    try {
      const notePath = join(root, "memory", "agent-main", "main", "2026-05-21.md");
      writeFileSync(notePath, [
        "# 2026-05-21",
        "",
        "## Events",
        "- Previously consumed durable containment milestone",
        "",
        "## Decisions",
        "",
        "<!-- extracted:L35:2026-05-21T00:00:00+03:00 -->",
        "",
      ].join("\n"));

      const proc = Bun.spawn([
        "bun", join(import.meta.dir, "..", "scripts", "extract-runner.js"),
        "--workspace", root, "--agent-id", "main", "--session", "main", "--date", "2026-05-21",
      ], { stdout: "pipe", stderr: "pipe" });
      const stdout = await new Response(proc.stdout).text();
      expect(await proc.exited).toBe(0);
      const stats = JSON.parse(stdout.match(/^Stats: (.+)$/m)[1]);
      expect(stats).toMatchObject({
        facts_suppressed: 0,
        daily_candidates: 0,
        previous_watermark: "L35",
        new_watermark: "L35",
      });
      expect(readFileSync(notePath, "utf8")).toMatch(/<!-- extracted:L35:/);
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
