import { test, expect, describe, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import handler from "../handler.js";

let ws: string;
type SpawnCall = { bin: string; args: string[] };
let calls: SpawnCall[] = [];

function installMockSpawn(mode: "ok" | "fail-exit1" | "throw") {
  (globalThis as any).__ENGRAM_TEST_SPAWN_FN__ = (_bin: string, args: any[]) => {
    const arr = Array.isArray(args) ? args : [];
    calls.push({ bin: _bin, args: arr });
    if (mode === "throw") throw new TypeError("spawnSync exploded");
    if (mode === "fail-exit1") {
      return {
        pid: 0,
        output: [null, Buffer.from(""), Buffer.from("error: bad session key")],
        stdout: Buffer.from(""),
        stderr: Buffer.from("error: bad session key"),
        status: 1,
        signal: null,
      };
    }
    return {
      pid: 12345,
      output: [null, Buffer.from(`{"ok":true}\n`), Buffer.from("")],
      stdout: Buffer.from(`{"ok":true}\n`),
      stderr: Buffer.from(""),
      status: 0,
      signal: null,
    };
  };
}
function clearMockSpawn() { delete (globalThis as any).__ENGRAM_TEST_SPAWN_FN__; }

beforeAll(() => {
  ws = mkdtempSync(join(tmpdir(), "engram-topic-domain-load-test-"));
  // Force TZ=UTC so toLocaleDateString("sv-SE", { timeZone: "UTC" }) yields
  // the same value the hook computes on the CI/local machine.
  process.env.ENGRAM_TZ = "UTC";
});
afterAll(() => {
  clearMockSpawn();
  delete process.env.ENGRAM_TZ;
  if (ws && existsSync(ws)) rmSync(ws, { recursive: true, force: true });
});
beforeEach(() => {
  calls.length = 0;
  installMockSpawn("ok");
});

// ---------- Helpers ----------

const ACCT = "205075873";
const CHAT = "100xxxxxxxxxx";         // test fixture: anonymized Telegram group id
const TOPIC = "60";                    // test fixture: topic id
const AGENT_ID = "apriori-tech";

function setupWorkspace(registryDomains: any = {}): {
  testDir: string; today: string; sessionKey: string;
} {
  const testDir = mkdtempSync(join(ws, "case-"));
  mkdirSync(join(testDir, "memory", "domains"), { recursive: true });
  writeFileSync(
    join(testDir, "memory", "domains", "registry.json"),
    JSON.stringify({ domains: registryDomains }, null, 2)
  );
  const today = new Date().toLocaleDateString("sv-SE", { timeZone: "UTC" });
  const sessionKey = `agent:${AGENT_ID}:telegram:group:${CHAT}:topic:${TOPIC}`;
  return { testDir, today, sessionKey };
}

function withDomainFiles(testDir: string, domainName: string, opts: { agents?: string } = {}): void {
  const dir = join(testDir, "memory", "domains", domainName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "decisions.md"), "# decisions\n\n### 2026-06-30 — First\n\n");
  writeFileSync(join(dir, "status.md"), "# status\n\nOK.\n");
  writeFileSync(join(dir, "changelog.md"), "## 2026-06-30\n\nDid the thing.\n");
  if (opts.agents !== undefined) writeFileSync(join(dir, "agents.md"), opts.agents);
}

function withSessionNote(testDir: string, today: string, agentId = AGENT_ID): {
  sessionDir: string; notePath: string;
} {
  // sessionSegment: `telegram-group--{chat}-topic-{topic}`
  const sessionSegment = `telegram-group--${CHAT}-topic-${TOPIC}`;
  const sessionDir = join(testDir, "memory", `agent-${agentId}`, sessionSegment);
  mkdirSync(sessionDir, { recursive: true });
  const notePath = join(sessionDir, `${today}.md`);
  writeFileSync(notePath, `# ${today}\n\n## Events\n\n`);
  return { sessionDir, notePath };
}

function makeEvent(opts: {
  testDir: string; sessionKey: string;
  chatId?: string; topicId?: string;
  // Optional alternate metadata locations (OpenClaw 2026.6.6 shape).
  chatIdInMetadata?: string; topicIdInMetadata?: string;
}): any {
  return {
    type: "message",
    action: "received",
    sessionKey: opts.sessionKey,
    context: {
      workspaceDir: opts.testDir,
      chatId: opts.chatId ?? CHAT,
      topicId: opts.topicId ?? TOPIC,
      agentId: AGENT_ID,
      content: "hello",
    },
  };
}

function makeLegacyEvent(opts: {
  testDir: string; sessionKey: string;
  chatId?: string; topicId?: string;
}): any {
  // OpenClaw 2026.6.6 fallback shape — no top-level chatId/topicId
  // on context; both go via context.metadata instead.
  return {
    type: "message",
    action: "received",
    sessionKey: opts.sessionKey,
    context: {
      workspaceDir: opts.testDir,
      agentId: AGENT_ID,
      metadata: {
        threadId: opts.topicId ?? TOPIC,
        to: opts.chatId ?? CHAT,
      },
      content: "hello",
    },
  };
}

function lastCall() { return calls[calls.length - 1]; }
function lastCallText(): string {
  const c = lastCall();
  return c.args[c.args.indexOf("--text") + 1] as string;
}

// =========================================================================
//                          BOUND TOPIC → INJECTION
// =========================================================================

describe("bound topic → system event injection", () => {
  test("Topic-bound domain triggers injection", async () => {
    const { testDir, today, sessionKey } = setupWorkspace({
      "engram": {
        type: "project",
        topic: { chatId: CHAT, topicId: TOPIC },
        kgEntity: "projects/engram",
      },
    });
    withDomainFiles(testDir, "engram", { agents: "# Project-specific AGENTS\n" });
    withSessionNote(testDir, today);

    await handler(makeEvent({ testDir, sessionKey }));

    expect(calls).toHaveLength(1);
    expect(lastCall().bin).toBe("openclaw");
    expect(lastCall().args).toContain("--mode");
    expect(lastCall().args[lastCall().args.indexOf("--mode") + 1]).toBe("now");
    expect(lastCall().args[lastCall().args.indexOf("--session-key") + 1]).toBe(sessionKey);

    const text = lastCallText();
    expect(text).toContain("Engram Domain Context (auto)");
    expect(text).toContain("topic-thread");   // sessionKind tag
    expect(text).toContain("projects/engram"); // kgEntity
    expect(text).toContain("Project-specific AGENTS");
    expect(text).toContain(`chat \`${CHAT}\`, topic \`${TOPIC}\``);
  });

  test("Daily note is NOT mutated by the hook", async () => {
    const { testDir, today, sessionKey } = setupWorkspace({
      "engram": {
        type: "project",
        topic: { chatId: CHAT, topicId: TOPIC },
      },
    });
    withDomainFiles(testDir, "engram", { agents: "x" });
    const { notePath } = withSessionNote(testDir, today);
    const before = readFileSync(notePath, "utf-8");

    await handler(makeEvent({ testDir, sessionKey }));
    const after = readFileSync(notePath, "utf-8");
    expect(after).toBe(before);
    expect(after).not.toContain("domain-context");
    expect(after).not.toContain("Engram Domain Context");
    expect(after).not.toContain("domain-agents");
  });

  test("Daily note missing → still injects (system event doesn't need it)", async () => {
    const { testDir, sessionKey } = setupWorkspace({
      "engram": {
        type: "project",
        topic: { chatId: CHAT, topicId: TOPIC },
      },
    });
    withDomainFiles(testDir, "engram", { agents: "x" });
    // No withSessionNote call → note does not exist.

    await handler(makeEvent({ testDir, sessionKey }));
    expect(calls).toHaveLength(1);
  });

  test("agents.md missing → fallback body used + warning note", async () => {
    const { testDir, today, sessionKey } = setupWorkspace({
      "engram": {
        type: "project",
        topic: { chatId: CHAT, topicId: TOPIC },
      },
    });
    withDomainFiles(testDir, "engram"); // no agents
    withSessionNote(testDir, today);

    await handler(makeEvent({ testDir, sessionKey }));
    expect(calls).toHaveLength(1);
    const text = lastCallText();
    expect(text).toContain("fallback");
    expect(text).toContain("⚠️");
  });

  test("Idempotency: same hash on daily note → no second injection", async () => {
    const { testDir, today, sessionKey } = setupWorkspace({
      "engram": {
        type: "project",
        topic: { chatId: CHAT, topicId: TOPIC },
      },
    });
    withDomainFiles(testDir, "engram", { agents: "Same" });
    const { notePath } = withSessionNote(testDir, today);

    await handler(makeEvent({ testDir, sessionKey }));
    const text1 = lastCallText();
    const hash = text1.match(/engram-system-event-hash:([a-f0-9]+)/)![1];
    writeFileSync(notePath, `${readFileSync(notePath, "utf-8")}\n<!-- engram-system-event-hash:${hash} -->\n`);

    await handler(makeEvent({ testDir, sessionKey }));
    expect(calls).toHaveLength(1); // No second injection.
  });

  test("Hash mismatch → re-injects", async () => {
    const { testDir, today, sessionKey } = setupWorkspace({
      "engram": {
        type: "project",
        topic: { chatId: CHAT, topicId: TOPIC },
      },
    });
    withDomainFiles(testDir, "engram", { agents: "Same" });
    const { notePath } = withSessionNote(testDir, today);

    await handler(makeEvent({ testDir, sessionKey }));
    // Note carries an unrelated/stale marker — should still inject.
    writeFileSync(notePath, `${readFileSync(notePath, "utf-8")}\n<!-- engram-system-event-hash:deadbeef -->\n`);

    await handler(makeEvent({ testDir, sessionKey }));
    expect(calls).toHaveLength(2); // Both calls injected.
  });

  test("Inert `<!-- domain-context:* -->` cruft → no-op (different marker regex)", async () => {
    // Old v3.3 markers do NOT match the new system-event regex, so they
    // don't poison idempotency.
    const { testDir, today, sessionKey } = setupWorkspace({
      "engram": {
        type: "project",
        topic: { chatId: CHAT, topicId: TOPIC },
      },
    });
    withDomainFiles(testDir, "engram", { agents: "x" });
    const { notePath } = withSessionNote(testDir, today);
    writeFileSync(
      notePath,
      `${readFileSync(notePath, "utf-8")}\n<!-- domain-context:engram:abcdef012345 -->\n<!-- /domain-context -->\n`,
    );

    await handler(makeEvent({ testDir, sessionKey }));
    expect(calls).toHaveLength(1);
  });
});

// =========================================================================
//                          UNBOUND TOPIC = NOOP
// =========================================================================

describe("unbound topic → no injection", () => {
  test("Different topicId → no match", async () => {
    const { testDir, today, sessionKey } = setupWorkspace({
      "engram": {
        type: "project",
        topic: { chatId: CHAT, topicId: "999" }, // wrong topic
      },
    });
    withDomainFiles(testDir, "engram", { agents: "x" });
    withSessionNote(testDir, today);

    await handler(makeEvent({ testDir, sessionKey }));
    expect(calls).toHaveLength(0);
  });

  test("Different chatId → no match", async () => {
    const { testDir, today, sessionKey } = setupWorkspace({
      "engram": {
        type: "project",
        topic: { chatId: "1234567890", topicId: TOPIC }, // wrong chat
      },
    });
    withDomainFiles(testDir, "engram", { agents: "x" });
    withSessionNote(testDir, today);

    await handler(makeEvent({ testDir, sessionKey }));
    expect(calls).toHaveLength(0);
  });

  test("Empty registry → no match", async () => {
    const { testDir, today, sessionKey } = setupWorkspace({});
    withSessionNote(testDir, today);

    await handler(makeEvent({ testDir, sessionKey }));
    expect(calls).toHaveLength(0);
  });

  test("Missing topicId → skip (peer's job, not topic's)", async () => {
    const { testDir, today, sessionKey } = setupWorkspace({});
    withSessionNote(testDir, today);

    await handler(makeEvent({ testDir, sessionKey, topicId: "" }));
    expect(calls).toHaveLength(0);
  });

  test("Missing chatId → skip", async () => {
    const { testDir, today, sessionKey } = setupWorkspace({});
    withSessionNote(testDir, today);

    await handler(makeEvent({ testDir, sessionKey, chatId: "" }));
    expect(calls).toHaveLength(0);
  });

  test("Sign-symmetric chatId: registry+/event- matches", async () => {
    const { testDir, today, sessionKey } = setupWorkspace({
      "engram": {
        type: "project",
        topic: { chatId: CHAT, topicId: TOPIC }, // unsigned
      },
    });
    withDomainFiles(testDir, "engram", { agents: "x" });
    withSessionNote(testDir, today);

    // Pass chatId with leading minus (event shape)
    await handler(makeEvent({ testDir, sessionKey, chatId: `-${CHAT}` }));
    expect(calls).toHaveLength(1);
  });

  test("Sign-symmetric chatId: registry-/event+ matches", async () => {
    const { testDir, today, sessionKey } = setupWorkspace({
      "engram": {
        type: "project",
        topic: { chatId: `-${CHAT}`, topicId: TOPIC }, // signed in registry
      },
    });
    withDomainFiles(testDir, "engram", { agents: "x" });
    withSessionNote(testDir, today);

    await handler(makeEvent({ testDir, sessionKey, chatId: CHAT }));
    expect(calls).toHaveLength(1);
  });
});

// =========================================================================
//                          OpenClaw 2026.6.6 EVENT-SHAPE FALLBACKS
// =========================================================================

describe("OC66 event-shape fallbacks", () => {
  test("context.metadata.threadId / metadata.to resolves topic+chat", async () => {
    const { testDir, today, sessionKey } = setupWorkspace({
      "engram": {
        type: "project",
        topic: { chatId: CHAT, topicId: TOPIC },
      },
    });
    withDomainFiles(testDir, "engram", { agents: "x" });
    withSessionNote(testDir, today);

    await handler(makeLegacyEvent({ testDir, sessionKey }));
    expect(calls).toHaveLength(1);
  });
});

// =========================================================================
//                          EVENT-SURFACE GATING
// =========================================================================

describe("event-surface gating", () => {
  test("Wrong event.type → skip", async () => {
    const { testDir, sessionKey } = setupWorkspace({
      "engram": {
        type: "project",
        topic: { chatId: CHAT, topicId: TOPIC },
      },
    });
    withDomainFiles(testDir, "engram", { agents: "x" });

    await handler({ type: "session", action: "start", sessionKey, context: { workspaceDir: testDir } });
    expect(calls).toHaveLength(0);
  });

  test("Wrong event.action → skip", async () => {
    const { testDir, sessionKey } = setupWorkspace({
      "engram": {
        type: "project",
        topic: { chatId: CHAT, topicId: TOPIC },
      },
    });
    withDomainFiles(testDir, "engram", { agents: "x" });

    await handler({ type: "message", action: "sent", sessionKey, context: { workspaceDir: testDir } });
    expect(calls).toHaveLength(0);
  });

  test("Missing sessionKey → skip", async () => {
    const { testDir } = setupWorkspace({
      "engram": {
        type: "project",
        topic: { chatId: CHAT, topicId: TOPIC },
      },
    });
    withDomainFiles(testDir, "engram", { agents: "x" });

    await handler({ type: "message", action: "received", context: { workspaceDir: testDir } });
    expect(calls).toHaveLength(0);
  });

  test("Missing workspaceDir + no agentId → skip", async () => {
    const { sessionKey } = setupWorkspace({});

    await handler({
      type: "message", action: "received",
      sessionKey,
      context: { /* no workspaceDir, no agentId */ },
    });
    expect(calls).toHaveLength(0);
  });
});

// =========================================================================
//                          FAILURE MODES
// =========================================================================

describe("failure modes", () => {
  test("Corrupt registry.json → skip (no throw)", async () => {
    const { testDir, today, sessionKey } = setupWorkspace();
    writeFileSync(join(testDir, "memory", "domains", "registry.json"), "not-json");
    withSessionNote(testDir, today);

    await handler(makeEvent({ testDir, sessionKey }));
    expect(calls).toHaveLength(0);
  });

  test("Missing registry.json → skip", async () => {
    const { testDir, sessionKey } = setupWorkspace({});
    rmSync(join(testDir, "memory", "domains", "registry.json"));

    await handler(makeEvent({ testDir, sessionKey }));
    expect(calls).toHaveLength(0);
  });

  test("Missing domain folder → still works with fallback", async () => {
    const { testDir, today, sessionKey } = setupWorkspace({
      "ghost-domain": {
        type: "project",
        topic: { chatId: CHAT, topicId: TOPIC },
      },
    });
    // No withDomainFiles → no decisions/status/changelog/agents.
    withSessionNote(testDir, today);

    await handler(makeEvent({ testDir, sessionKey }));
    expect(calls).toHaveLength(1);
    const text = lastCallText();
    // status.md and changelog.md are missing → Russian placeholder.
    expect(text).toContain("_status.md пуст_");
    expect(text).toContain("_changelog.md пуст_");
    // agents.md is missing → fallback + ⚠️ note.
    expect(text).toContain("fallback");
    expect(text).toContain("⚠️");
  });

  test("spawnSync exit≠0 → no throw, no marker written", async () => {
    installMockSpawn("fail-exit1");
    const { testDir, today, sessionKey } = setupWorkspace({
      "engram": {
        type: "project",
        topic: { chatId: CHAT, topicId: TOPIC },
      },
    });
    withDomainFiles(testDir, "engram", { agents: "x" });
    const { notePath } = withSessionNote(testDir, today);

    await handler(makeEvent({ testDir, sessionKey }));
    expect(calls).toHaveLength(1);
    const content = readFileSync(notePath, "utf-8");
    expect(content).not.toContain("engram-system-event-hash");
  });

  test("spawnSync throws → no throw from handler", async () => {
    installMockSpawn("throw");
    const { testDir, today, sessionKey } = setupWorkspace({
      "engram": {
        type: "project",
        topic: { chatId: CHAT, topicId: TOPIC },
      },
    });
    withDomainFiles(testDir, "engram", { agents: "x" });
    withSessionNote(testDir, today);

    let didThrow = false;
    try {
      await handler(makeEvent({ testDir, sessionKey }));
    } catch {
      didThrow = true;
    }
    expect(didThrow).toBe(false);
  });

  test("Empty sessionKey on enqueue → graceful skip", async () => {
    const { testDir, today } = setupWorkspace({
      "engram": {
        type: "project",
        topic: { chatId: CHAT, topicId: TOPIC },
      },
    });
    withDomainFiles(testDir, "engram", { agents: "x" });
    withSessionNote(testDir, today);

    await handler({
      type: "message", action: "received",
      sessionKey: "",
      context: {
        workspaceDir: testDir,
        chatId: CHAT,
        topicId: TOPIC,
        agentId: AGENT_ID,
      },
    });
    // Empty sessionKey → parseAgentIdFromSessionKey returns null → workspaceDir
    // falls back to OPENCLAW_WORKSPACE (not set in test) → skip. No throw.
  });
});

// =========================================================================
//                          UNARCHIVE
// =========================================================================

describe("unarchive-on-message", () => {
  test("Archived topic-bound domain is reactivated", async () => {
    const { testDir, today, sessionKey } = setupWorkspace({
      "engram": {
        type: "project",
        topic: { chatId: CHAT, topicId: TOPIC },
        archived: true,
      },
    });
    withDomainFiles(testDir, "engram", { agents: "x" });
    withSessionNote(testDir, today);

    await handler(makeEvent({ testDir, sessionKey }));
    expect(calls).toHaveLength(1);
    const registry = JSON.parse(readFileSync(join(testDir, "memory", "domains", "registry.json"), "utf-8"));
    expect(registry.domains["engram"].archived).toBeUndefined();
  });
});
