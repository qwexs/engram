import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import handler, { bootstrapQmdSkipReason } from "./handler.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function bootstrapEvent(workspaceDir: string, sessionKey: string) {
  return {
    type: "agent",
    action: "bootstrap",
    sessionKey,
    context: { workspaceDir, sessionKey },
  };
}

describe("engram-bootstrap-qmd runtime ownership", () => {
  test("classifies current and legacy cron keys plus other ephemeral runtimes", () => {
    expect(bootstrapQmdSkipReason(bootstrapEvent("/tmp/ws", "agent:main:cron:job-id"))).toBe("cron");
    expect(bootstrapQmdSkipReason(bootstrapEvent("/tmp/ws", "agent:main:cron-job-run-run-id"))).toBe("cron");
    expect(bootstrapQmdSkipReason(bootstrapEvent("/tmp/ws", "agent:main:heartbeat"))).toBe("heartbeat");
    expect(bootstrapQmdSkipReason(bootstrapEvent("/tmp/ws", "agent:main:subagent:run-id"))).toBe("ephemeral");
    expect(bootstrapQmdSkipReason(bootstrapEvent("/tmp/ws", "agent:main:main"))).toBeNull();
  });

  test("a cron-driven heartbeat bootstrap performs no direct maintenance", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "engram-bootstrap-qmd-"));
    tempDirs.push(workspace);
    await handler(bootstrapEvent(workspace, "agent:main:cron:heartbeat-job-id"));
  });

  test("an interactive bootstrap also performs no direct maintenance", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "engram-bootstrap-qmd-"));
    tempDirs.push(workspace);
    await handler(bootstrapEvent(workspace, "agent:main:main"));
  });
});
