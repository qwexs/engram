import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const SCRIPT = "scripts/heartbeat-dispatch-check.js";
const fixtures = [];

function workspace() {
  const path = mkdtempSync(join(tmpdir(), "engram-heartbeat-dispatch-"));
  fixtures.push(path);
  return path;
}

function run(path) {
  const proc = Bun.spawnSync(["bun", SCRIPT, "--workspace", path], { stdout: "pipe", stderr: "pipe" });
  return { exitCode: proc.exitCode, output: JSON.parse(new TextDecoder().decode(proc.stdout)) };
}

afterEach(() => {
  for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("heartbeat-dispatch-check", () => {
  test("does not fire when the queue directory is absent", () => {
    const result = run(workspace());
    expect(result.exitCode).toBe(0);
    expect(result.output).toEqual({ fire: false, state: { reason: "queue-missing", queued: 0 } });
  });

  test("fires only for a valid queued request and has no side effects", () => {
    const path = workspace();
    const queue = join(path, "workspace", "ops", "heartbeat-spawns");
    mkdirSync(queue, { recursive: true });
    const request = join(queue, "request.json");
    const source = {
      runId: "hb-domains-2026-08-09-abcdef01",
      phase: "hb-domains-write",
      label: "hb-domains-write",
      model: "example/full-reasoning",
      task: "do work",
      status: "queued",
    };
    writeFileSync(request, JSON.stringify(source, null, 2) + "\n");

    const result = run(path);
    expect(result.exitCode).toBe(0);
    expect(result.output.fire).toBe(true);
    expect(result.output.state.queued).toBe(1);
    expect(result.output.state.queuedRuns[0]).toEqual({
      runId: source.runId,
      phase: source.phase,
      requestFile: "request.json",
    });
    expect(Bun.file(request).text()).resolves.toBe(JSON.stringify(source, null, 2) + "\n");
  });

  test("does not fire for malformed or already claimed requests", () => {
    const path = workspace();
    const queue = join(path, "workspace", "ops", "heartbeat-spawns");
    mkdirSync(queue, { recursive: true });
    writeFileSync(join(queue, "bad.json"), "not json\n");
    writeFileSync(join(queue, "claimed.json"), JSON.stringify({ status: "spawned" }));

    const result = run(path);
    expect(result.exitCode).toBe(0);
    expect(result.output.fire).toBe(false);
    expect(result.output.state).toMatchObject({ queued: 0, malformed: 1 });
  });
});
