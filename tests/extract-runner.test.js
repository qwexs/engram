import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectSessionFiles, extractLastWatermark } from "../scripts/extract-runner.js";

function makeWorkspace(config = {}) {
  const root = mkdtempSync(join(tmpdir(), "engram-extract-"));
  mkdirSync(join(root, "memory", "agent-main", "main", "sessions"), { recursive: true });
  writeFileSync(join(root, "engram.json"), JSON.stringify({ agent: "agent-main", ...config }));
  return root;
}

async function runExtract(root, extra = []) {
  const proc = Bun.spawn([
    "bun", join(import.meta.dir, "..", "scripts", "extract-runner.js"),
    "--workspace", root, "--agent-id", "main", "--session", "main",
    "--date", "2026-05-21", ...extra,
  ], { stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  expect(await proc.exited).toBe(0);
  return { stdout, stats: JSON.parse(stdout.match(/^Stats: (.+)$/m)[1]) };
}

describe("retired automatic KG extraction", () => {
  test("orders cursor files from names without trusting transcript headers", () => {
    const root = makeWorkspace();
    try {
      const dir = join(root, "memory", "agent-main", "main", "sessions");
      writeFileSync(join(dir, "2026-05-21-010000-first.md"), "# Session: 2099-12-31 23:59:59 UTC\nuser: body must not control ordering\n");
      writeFileSync(join(dir, "2026-05-21-020000-second.md"), "# Session: 2000-01-01 00:00:00 UTC\n");
      writeFileSync(join(dir, "cron-noise.md"), "# Session: 2026-05-21 03:00:00 UTC\n");
      const files = collectSessionFiles({
        workspace: root,
        agentDir: "agent-main",
        session: "main",
        lastSessionExtracted: "2026-05-21-010000-first.md",
      });
      expect(files.files.map((file) => file.name)).toEqual(["2026-05-21-020000-second.md"]);
      expect(files.files[0]).not.toHaveProperty("content");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("cannot be re-enabled by legacy configuration", async () => {
    const root = makeWorkspace({ kg: { automaticIngress: "legacy" }, extraction: { kgPolicy: "all" } });
    try {
      const notePath = join(root, "memory", "agent-main", "main", "2026-05-21.md");
      writeFileSync(notePath, "# 2026-05-21\n\n## Decisions\n- Store this through a retired automatic path\n");
      const sessionName = "2026-05-21-010000-contained.md";
      writeFileSync(join(root, "memory", "agent-main", "main", "sessions", sessionName), "# Session: 2026-05-21 01:00:00 UTC\nuser: durable assertion\n");

      const { stdout, stats } = await runExtract(root);
      expect(stdout).toContain("automatic KG extraction retired");
      expect(stats).toMatchObject({
        facts_written: 0,
        kg_extract: false,
        automatic_ingress: "retired",
        sessions_processed: 1,
        last_session_file: sessionName,
      });
      expect(existsSync(join(root, "life"))).toBe(false);
      expect(readFileSync(notePath, "utf8")).toMatch(/<!-- extracted:L\d+/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("does not replay a consumed session cursor", async () => {
    const root = makeWorkspace();
    try {
      const notePath = join(root, "memory", "agent-main", "main", "2026-05-21.md");
      writeFileSync(notePath, "# 2026-05-21\n\n## Events\n");
      const sessionName = "2026-05-21-010000-contained.md";
      writeFileSync(join(root, "memory", "agent-main", "main", "sessions", sessionName), "# Session: 2026-05-21 01:00:00 UTC\n");
      writeFileSync(join(root, "memory", "heartbeat-state.json"), JSON.stringify({ lastSessionExtracted: { main: sessionName } }));

      const { stats } = await runExtract(root);
      expect(stats.sessions_processed).toBe(0);
      expect(stats.last_session_file).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("dry run preserves the watermark unless advancement is explicit", async () => {
    const root = makeWorkspace();
    try {
      const notePath = join(root, "memory", "agent-main", "main", "2026-05-21.md");
      writeFileSync(notePath, "# 2026-05-21\n\n## Events\n<!-- extracted:L4:old -->\n- later line\n");
      const { stats } = await runExtract(root, ["--no-write"]);
      expect(stats).toMatchObject({ dry_run: true, watermark_advanced: false, new_watermark: "L4" });
      expect(readFileSync(notePath, "utf8")).toContain("<!-- extracted:L4:old -->");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("never regresses a preexisting watermark", async () => {
    const root = makeWorkspace();
    try {
      const notePath = join(root, "memory", "agent-main", "main", "2026-05-21.md");
      writeFileSync(notePath, "# 2026-05-21\n\n## Events\n<!-- extracted:L35:old -->\n");
      const { stats } = await runExtract(root);
      expect(stats).toMatchObject({ previous_watermark: "L35", new_watermark: "L35" });
      expect(extractLastWatermark(readFileSync(notePath, "utf8")).watermark).toBe(35);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
