import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const SCRIPT = join(import.meta.dir, "..", "scripts", "validate.js");
const SKILL_DIR = join(import.meta.dir, "..");
let workspace;

function write(rel, content = "") {
  const path = join(workspace, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "engram-validate-domains-"));
  for (const dir of [
    "memory/agent-test/main",
    "memory/templates/group-knowledge",
    "life/projects",
    "life/areas",
    "life/archives",
  ]) mkdirSync(join(workspace, dir), { recursive: true });

  write("engram.json", JSON.stringify({ agent: "agent-test" }));
  write("MEMORY.md", "# Memory\n");
  write("memory/heartbeat-state.json", JSON.stringify({ activeSessions: [] }));
  write("memory/weekly-synthesis-tracker.json", "{}");
  write("life/README.md", "# Life\n");
  write("life/index.md", "# Index\n");

  const domains = {
    topic: { type: "topic-thread" },
    peer: { type: "peer-direct" },
    group: { type: "group-direct" },
    meta: { type: "meta-domain" },
    worker: { type: "dev-project" },
  };
  write("memory/domains/registry.json", JSON.stringify({ domains }, null, 2));
  for (const name of Object.keys(domains)) {
    for (const file of ["decisions.md", "status.md", "changelog.md"]) {
      write(`memory/domains/${name}/${file}`, `# ${file}\n`);
    }
  }
});

afterEach(() => {
  if (workspace && existsSync(workspace)) rmSync(workspace, { recursive: true, force: true });
});

test("validate requires workflow.md only for spawnable domain types", async () => {
  const proc = Bun.spawn(["bun", SCRIPT], {
    cwd: workspace,
    env: { ...process.env, ENGRAM_WORKSPACE: workspace, ENGRAM_SKILL_DIR: SKILL_DIR },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  const output = `${stdout}\n${stderr}`;

  expect(output).toContain('Domain "worker" has no workflow.md');
  for (const contour of ["topic", "peer", "group", "meta"]) {
    expect(output).not.toContain(`Domain "${contour}" has no workflow.md`);
  }
});
