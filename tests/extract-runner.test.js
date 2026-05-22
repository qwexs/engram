import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { collectDailyCandidates, collectSessionCandidates, collectSessionFiles, extractLastWatermark } from "../scripts/extract-runner.js";

function makeWorkspace() {
  const root = mkdtempSync(join(tmpdir(), "engram-extract-"));
  mkdirSync(join(root, "memory", "agent-main", "main", "sessions"), { recursive: true });
  writeFileSync(join(root, "engram.json"), JSON.stringify({ agent: "agent-main" }));
  return root;
}

describe("extract-runner daily candidates", () => {
  test("reads only after the last extraction watermark", () => {
    const note = `# 2026-05-21\n\n## Events\n- Old event\n<!-- extracted:L4:2026-05-21T00:00:00+03:00 -->\n- New Engram heartbeat event\n`;
    const result = collectDailyCandidates(note);
    expect(result.watermark.watermark).toBe(4);
    expect(result.candidates.map((c) => c.text)).toEqual(["New Engram heartbeat event"]);
  });

  test("tracks the last watermark even when old reports are above it", () => {
    const note = `# 2026-05-21\n\n## Heartbeat Report\n- **Extraction**: ok\n<!-- extracted:L4:old -->\n\n## Decisions\n- Решили оставить heartbeat-runner entrypoint.\n`;
    expect(extractLastWatermark(note).watermark).toBe(4);
    expect(collectDailyCandidates(note).candidates[0].category).toBe("decision");
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
