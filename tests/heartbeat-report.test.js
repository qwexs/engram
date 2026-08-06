import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "..", "scripts", "heartbeat-report.js");
const DATE = "2026-08-06";
let workspace;
let notePath;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "engram-heartbeat-report-"));
  notePath = join(workspace, "memory", "agent-main", "main", `${DATE}.md`);
  mkdirSync(join(workspace, "memory", "agent-main", "main"), { recursive: true });
  writeFileSync(join(workspace, "engram.json"), JSON.stringify({ agentId: "main" }));
  writeFileSync(notePath, `# ${DATE}\n\n## Events\n\n<!-- extracted:L0:test -->\n`);
});

afterEach(() => {
  if (workspace && existsSync(workspace)) rmSync(workspace, { recursive: true, force: true });
});

async function runReport() {
  const proc = Bun.spawn([
    "bun", SCRIPT,
    "--date", DATE,
    "--session", "main",
    "--extraction", "idle",
    "--synthesis", "idle",
    "--domains", "idle",
    "--oll", "idle",
    "--maintenance", "clean",
  ], {
    cwd: workspace,
    env: { ...process.env, ENGRAM_WORKSPACE: workspace },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  return { stdout, stderr, exitCode: proc.exitCode };
}

describe("heartbeat-report content equality guard", () => {
  test("does not rewrite an unchanged report", async () => {
    const first = await runReport();
    expect(first.exitCode).toBe(0);
    const firstContent = readFileSync(notePath, "utf8");

    const fixed = new Date("2000-01-01T00:00:00.000Z");
    utimesSync(notePath, fixed, fixed);
    const second = await runReport();

    expect(second.exitCode).toBe(0);
    expect(second.stdout).toContain("Unchanged");
    expect(readFileSync(notePath, "utf8")).toBe(firstContent);
    expect(statSync(notePath).mtimeMs).toBe(fixed.getTime());
  });
});
