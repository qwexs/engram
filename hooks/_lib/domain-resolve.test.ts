/**
 * Tests for the shared domain-resolution helper used by both
 * `engram-topic-domain-load` (topic-thread) and `engram-peer-domain-load`
 * (peer-direct + group-direct).
 *
 * Follows the same fixture pattern as `_lib/domain-inject.test.ts`:
 * in-memory temp workspace per test, synthetic `message:received` events,
 * directly invoke `resolveDomainFromEvent(event, opts?)`.
 */
import { test, expect, describe, beforeAll, afterAll, beforeEach } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveDomainFromEvent } from "./domain-resolve.js";

// Shared workspace dir for the suite; each test gets a sub-dir under it.
let ws: string;

beforeAll(() => {
  ws = mkdtempSync(join(tmpdir(), "engram-domain-resolve-test-"));
});
afterAll(() => {
  if (ws && existsSync(ws)) rmSync(ws, { recursive: true, force: true });
});

const CHAT_GROUP = "1001234567890";      // fixture: anonymized Telegram group id (all-digits — required by conversationId regex)
const CHAT_GROUP_NEG = `-${CHAT_GROUP}`;  // fixture: signed form (event shape)
const TOPIC = "60";                       // fixture: topic id
const USER_PEER = "100000001";            // fixture: anonymized user id (DM)

const SESSION_KEY_TELE = `agent:sample-agent:telegram:group:${CHAT_GROUP_NEG}:topic:${TOPIC}`;
const SESSION_KEY_PEER = `agent:sample-agent:telegram:direct:${USER_PEER}`;

function setupWorkspace(registryDomains: any = {}): { testDir: string; } {
  const testDir = mkdtempSync(join(ws, "case-"));
  mkdirSync(join(testDir, "memory", "domains"), { recursive: true });
  writeFileSync(
    join(testDir, "memory", "domains", "registry.json"),
    JSON.stringify({ domains: registryDomains }, null, 2)
  );
  return { testDir };
}

function makeEvent(opts: {
  testDir: string;
  sessionKey?: string;
  chatId?: string | null;
  topicId?: string | null;
  conversationId?: string;
  metadata?: Record<string, any>;
  threadId?: string;
  type?: string;
  action?: string;
}): any {
  const ctx: any = {
    workspaceDir: opts.testDir,
    agentId: "sample-agent",
  };
  if (opts.chatId !== undefined && opts.chatId !== null) ctx.chatId = opts.chatId;
  if (opts.topicId !== undefined && opts.topicId !== null) ctx.topicId = opts.topicId;
  if (opts.conversationId !== undefined) ctx.conversationId = opts.conversationId;
  if (opts.metadata !== undefined) ctx.metadata = opts.metadata;

  return {
    type: opts.type ?? "message",
    action: opts.action ?? "received",
    sessionKey: opts.sessionKey ?? SESSION_KEY_TELE,
    context: ctx,
    ...(opts.threadId !== undefined ? { threadId: opts.threadId } : {}),
  };
}

// =========================================================================
//                          EVENT-SURFACE GATING
// =========================================================================

describe("event-surface gating", () => {
  test("non-message event → null", () => {
    const { testDir } = setupWorkspace();
    const ev = makeEvent({
      testDir,
      type: "session",
      action: "start",
      chatId: CHAT_GROUP,
      topicId: TOPIC,
    });
    expect(resolveDomainFromEvent(ev)).toBeNull();
  });

  test("message:sent (not received) → null", () => {
    const { testDir } = setupWorkspace();
    const ev = makeEvent({
      testDir,
      action: "sent",
      chatId: CHAT_GROUP,
      topicId: TOPIC,
    });
    expect(resolveDomainFromEvent(ev)).toBeNull();
  });
});

// =========================================================================
//                          WORKSPACE RESOLUTION
// =========================================================================

describe("workspace resolution", () => {
  test("event.context.workspaceDir is used when present", () => {
    const { testDir } = setupWorkspace({
      "engram": {
        type: "project",
        topic: { chatId: CHAT_GROUP, topicId: TOPIC },
      },
    });
    const ev = makeEvent({ testDir, chatId: CHAT_GROUP, topicId: TOPIC });
    const r = resolveDomainFromEvent(ev);
    expect(r).not.toBeNull();
    expect(r!.workspaceDir).toBe(testDir);
    expect(r!.agentId).toBe("sample-agent");
  });

  test("missing chatId → null", () => {
    const { testDir } = setupWorkspace();
    // No chat/topic on context, no conversationId, no metadata → can't resolve.
    const ev = makeEvent({ testDir, chatId: null, topicId: null });
    expect(resolveDomainFromEvent(ev)).toBeNull();
  });
});

// =========================================================================
//                          CHAT/TOPIC EXTRACTION FALLBACKS
// =========================================================================

describe("chatId/topicId extraction (3 fallback layers)", () => {
  const REG = {
    "engram": {
      type: "project",
      topic: { chatId: CHAT_GROUP, topicId: TOPIC },
    },
  };

  test("Layer 1: direct context.chatId + context.topicId", () => {
    const { testDir } = setupWorkspace(REG);
    const ev = makeEvent({ testDir, chatId: CHAT_GROUP, topicId: TOPIC });
    const r = resolveDomainFromEvent(ev);
    expect(r).not.toBeNull();
    expect(r!.sessionKind).toBe("topic-thread");
    expect(r!.chatId).toBe(CHAT_GROUP);
    expect(r!.topicId).toBe(TOPIC);
  });

  test("Layer 2: conversationId regex with topic", () => {
    const { testDir } = setupWorkspace(REG);
    const ev = makeEvent({
      testDir,
      chatId: null,
      topicId: null,
      conversationId: `telegram:${CHAT_GROUP_NEG}:topic:${TOPIC}`,
    });
    const r = resolveDomainFromEvent(ev);
    expect(r).not.toBeNull();
    expect(r!.sessionKind).toBe("topic-thread");
    expect(r!.chatId).toBe(CHAT_GROUP_NEG);
    expect(r!.topicId).toBe(TOPIC);
  });

  test("Layer 2: conversationId regex without topic → group-direct", () => {
    const { testDir } = setupWorkspace({
      "co": { type: "project", group: { chatId: CHAT_GROUP_NEG } },
    });
    const ev = makeEvent({
      testDir,
      chatId: null,
      topicId: null,
      conversationId: `telegram:${CHAT_GROUP_NEG}`,
    });
    const r = resolveDomainFromEvent(ev);
    expect(r).not.toBeNull();
    expect(r!.sessionKind).toBe("group-direct");
    expect(r!.topicId).toBeNull();
  });

  test("Layer 3: context.metadata.threadId + metadata.to (OpenClaw 2026.6.6 shape)", () => {
    const { testDir } = setupWorkspace(REG);
    const ev = makeEvent({
      testDir,
      chatId: null,
      topicId: null,
      metadata: { threadId: TOPIC, to: CHAT_GROUP },
    });
    const r = resolveDomainFromEvent(ev);
    expect(r).not.toBeNull();
    expect(r!.sessionKind).toBe("topic-thread");
    expect(r!.topicId).toBe(TOPIC);
    expect(r!.chatId).toBe(CHAT_GROUP);
  });

  test("Layer 3 fallback: metadata.originatingTo resolves chatId only", () => {
    const { testDir } = setupWorkspace({
      "executive-a": { type: "project", peer: { chatId: USER_PEER } },
    });
    // No threadId here — peer-direct resolution must work via metadata alone.
    const r = resolveDomainFromEvent(
      makeEvent({
        testDir,
        sessionKey: SESSION_KEY_PEER,
        chatId: null,
        topicId: null,
        metadata: { originatingTo: USER_PEER },
      }),
    );
    expect(r).not.toBeNull();
    expect(r!.sessionKind).toBe("peer-direct");
    expect(r!.chatId).toBe(USER_PEER);
  });
});

// =========================================================================
//                       BOOTSTRAP SESSION-KEY SHAPES
// =========================================================================

describe("bootstrap session-key normalization", () => {
  const REG = {
    "engram": {
      type: "topic-thread",
      topic: { chatId: CHAT_GROUP_NEG, topicId: TOPIC },
    },
  };

  test("full colon-delimited OpenClaw key resolves the bound topic", () => {
    const { testDir } = setupWorkspace(REG);
    const event = makeEvent({
      testDir,
      type: "agent",
      action: "bootstrap",
      sessionKey: SESSION_KEY_TELE,
    });

    const resolved = resolveDomainFromEvent(event, { kinds: ["topic-thread"] });
    expect(resolved).not.toBeNull();
    expect(resolved!.domainName).toBe("engram");
    expect(resolved!.sessionSegment).toBe(
      `telegram-group--${CHAT_GROUP}-topic-${TOPIC}`,
    );
  });
});

// =========================================================================
//                          SESSION-KIND RESOLUTION
// =========================================================================

describe("sessionKind determination", () => {
  test("topicId present → topic-thread", () => {
    const { testDir } = setupWorkspace({
      "engram": { type: "project", topic: { chatId: CHAT_GROUP, topicId: TOPIC } },
    });
    const r = resolveDomainFromEvent(
      makeEvent({ testDir, chatId: CHAT_GROUP, topicId: TOPIC }),
    );
    expect(r!.sessionKind).toBe("topic-thread");
  });

  test("positive chatId (user id), no topic → peer-direct", () => {
    const { testDir } = setupWorkspace({
      "executive-a": { type: "project", peer: { chatId: USER_PEER } },
    });
    const r = resolveDomainFromEvent(
      makeEvent({
        testDir,
        sessionKey: SESSION_KEY_PEER,
        chatId: USER_PEER,
        topicId: null,
      }),
    );
    expect(r!.sessionKind).toBe("peer-direct");
  });

  test("negative chatId (group), no topic → group-direct", () => {
    const { testDir } = setupWorkspace({
      "co": { type: "project", group: { chatId: CHAT_GROUP_NEG } },
    });
    const r = resolveDomainFromEvent(
      makeEvent({
        testDir,
        chatId: CHAT_GROUP_NEG,
        topicId: null,
      }),
    );
    expect(r!.sessionKind).toBe("group-direct");
  });

  test("kinds filter: ['topic-thread'] rejects peer-direct events", () => {
    const { testDir } = setupWorkspace({
      "executive-a": { type: "project", peer: { chatId: USER_PEER } },
    });
    const r = resolveDomainFromEvent(
      makeEvent({
        testDir,
        sessionKey: SESSION_KEY_PEER,
        chatId: USER_PEER,
        topicId: null,
      }),
      { kinds: ["topic-thread"] },
    );
    expect(r).toBeNull();
  });

  test("kinds filter: ['peer-direct','group-direct'] rejects topic-thread events", () => {
    const { testDir } = setupWorkspace({
      "engram": { type: "project", topic: { chatId: CHAT_GROUP, topicId: TOPIC } },
    });
    const r = resolveDomainFromEvent(
      makeEvent({ testDir, chatId: CHAT_GROUP, topicId: TOPIC }),
      { kinds: ["peer-direct", "group-direct"] },
    );
    expect(r).toBeNull();
  });
});

// =========================================================================
//                          sessionSegment CONVENTIONS
// =========================================================================

describe("sessionSegment conventions", () => {
  test("topic-thread → telegram-group--{absChatId}-topic-{topicId}", () => {
    const { testDir } = setupWorkspace({
      "engram": { type: "project", topic: { chatId: CHAT_GROUP, topicId: TOPIC } },
    });
    const r = resolveDomainFromEvent(
      // Sign in event, unsigned in registry — should still match and produce absChatId.
      makeEvent({ testDir, chatId: CHAT_GROUP_NEG, topicId: TOPIC }),
    );
    expect(r!.sessionSegment).toBe(`telegram-group--${CHAT_GROUP}-topic-${TOPIC}`);
    expect(r!.sessionLocation).toBe(`${CHAT_GROUP}:${TOPIC}`);
  });

  test("peer-direct → telegram-direct--{chatId} (positive)", () => {
    const { testDir } = setupWorkspace({
      "executive-a": { type: "project", peer: { chatId: USER_PEER } },
    });
    const r = resolveDomainFromEvent(
      makeEvent({ testDir, sessionKey: SESSION_KEY_PEER, chatId: USER_PEER, topicId: null }),
    );
    expect(r!.sessionSegment).toBe(`telegram-direct--${USER_PEER}`);
    expect(r!.sessionLocation).toBe(USER_PEER);
  });

  test("group-direct → telegram-group--{absChatId}", () => {
    const { testDir } = setupWorkspace({
      "co": { type: "project", group: { chatId: CHAT_GROUP_NEG } },
    });
    const r = resolveDomainFromEvent(
      makeEvent({ testDir, chatId: CHAT_GROUP_NEG, topicId: null }),
    );
    expect(r!.sessionSegment).toBe(`telegram-group--${CHAT_GROUP}`);
    expect(r!.sessionLocation).toBe(CHAT_GROUP);
  });
});

// =========================================================================
//                          REGISTRY LOOKUP
// =========================================================================

describe("registry lookup", () => {
  test("missing registry.json → null", () => {
    const testDir = mkdtempSync(join(ws, "no-reg-"));
    const r = resolveDomainFromEvent(
      makeEvent({ testDir, chatId: CHAT_GROUP, topicId: TOPIC }),
    );
    expect(r).toBeNull();
    rmSync(testDir, { recursive: true, force: true });
  });

  test("corrupt registry.json → null", () => {
    const testDir = mkdtempSync(join(ws, "corrupt-reg-"));
    mkdirSync(join(testDir, "memory", "domains"), { recursive: true });
    writeFileSync(
      join(testDir, "memory", "domains", "registry.json"),
      "{not valid json",
    );
    const r = resolveDomainFromEvent(
      makeEvent({ testDir, chatId: CHAT_GROUP, topicId: TOPIC }),
    );
    expect(r).toBeNull();
    rmSync(testDir, { recursive: true, force: true });
  });

  test("empty domains object → null", () => {
    const { testDir } = setupWorkspace({});
    const r = resolveDomainFromEvent(
      makeEvent({ testDir, chatId: CHAT_GROUP, topicId: TOPIC }),
    );
    expect(r).toBeNull();
  });

  test("topic binding match (registry signed, event unsigned)", () => {
    const { testDir } = setupWorkspace({
      "engram": { type: "project", topic: { chatId: CHAT_GROUP_NEG, topicId: TOPIC } },
    });
    const r = resolveDomainFromEvent(
      makeEvent({ testDir, chatId: CHAT_GROUP, topicId: TOPIC }),
    );
    expect(r).not.toBeNull();
    expect(r!.domainName).toBe("engram");
    expect(r!.absChatId).toBe(CHAT_GROUP);
  });

  test("peer binding match", () => {
    const { testDir } = setupWorkspace({
      "executive-a": { type: "project", peer: { chatId: USER_PEER } },
    });
    const r = resolveDomainFromEvent(
      makeEvent({ testDir, sessionKey: SESSION_KEY_PEER, chatId: USER_PEER, topicId: null }),
    );
    expect(r).not.toBeNull();
    expect(r!.domainName).toBe("executive-a");
    expect(r!.sessionKind).toBe("peer-direct");
  });

  test("group binding match", () => {
    const { testDir } = setupWorkspace({
      "co": { type: "project", group: { chatId: CHAT_GROUP_NEG } },
    });
    const r = resolveDomainFromEvent(
      makeEvent({ testDir, chatId: CHAT_GROUP_NEG, topicId: null }),
    );
    expect(r).not.toBeNull();
    expect(r!.domainName).toBe("co");
    expect(r!.sessionKind).toBe("group-direct");
  });

  test("wrong topicId → null", () => {
    const { testDir } = setupWorkspace({
      "engram": { type: "project", topic: { chatId: CHAT_GROUP, topicId: "999" } },
    });
    const r = resolveDomainFromEvent(
      makeEvent({ testDir, chatId: CHAT_GROUP, topicId: TOPIC }),
    );
    expect(r).toBeNull();
  });

  test("wrong chatId → null", () => {
    const { testDir } = setupWorkspace({
      "engram": { type: "project", topic: { chatId: "1234567890", topicId: TOPIC } },
    });
    const r = resolveDomainFromEvent(
      makeEvent({ testDir, chatId: CHAT_GROUP, topicId: TOPIC }),
    );
    expect(r).toBeNull();
  });

  test("topic binding requested, but registry entry has only peer binding → null", () => {
    const { testDir } = setupWorkspace({
      "executive-a": { type: "project", peer: { chatId: USER_PEER } },
    });
    // topic-thread resolver should NOT match a peer-only entry, even if chatId
    // happens to align.
    const r = resolveDomainFromEvent(
      makeEvent({
        testDir,
        sessionKey: SESSION_KEY_PEER,
        chatId: USER_PEER,
        topicId: TOPIC, // explicitly present but no matching topic entry
      }),
    );
    expect(r).toBeNull();
  });
});

// =========================================================================
//                          ARCHIVE REACTIVATION
// =========================================================================

describe("archive reactivation on message", () => {
  test("archived:true → flag cleared, registry rewritten", () => {
    const { testDir } = setupWorkspace({
      "engram": {
        type: "project",
        topic: { chatId: CHAT_GROUP, topicId: TOPIC },
        archived: true,
        archivedAt: "2026-06-01T00:00:00Z",
        archivePath: "memory/domains/archives/engram",
      },
    });
    const r = resolveDomainFromEvent(
      makeEvent({ testDir, chatId: CHAT_GROUP, topicId: TOPIC }),
    );
    expect(r).not.toBeNull();
    expect(r!.domainName).toBe("engram");

    // Registry file should now have archived flag removed.
    // Registry file should now have the `archived` flag cleared. The
    // timestamp (`archivedAt`) and path (`archivePath`) metadata is
    // preserved so the audit trail of when/where it was archived remains
    // even after reactivation — they get cleared only on next archive
    // event.
    const regRaw = readFileSync(
      join(testDir, "memory", "domains", "registry.json"),
      "utf-8",
    );
    const reg = JSON.parse(regRaw);
    expect(reg.domains.engram.archived).toBeUndefined();
    expect(reg.domains.engram.archivedAt).toBe("2026-06-01T00:00:00Z"); // preserved
    expect(reg.domains.engram.archivePath).toBe("memory/domains/archives/engram"); // preserved
  });

  test("not archived → registry untouched (no write-back)", () => {
    const { testDir } = setupWorkspace({
      "engram": { type: "project", topic: { chatId: CHAT_GROUP, topicId: TOPIC } },
    });
    const before = readFileSync(
      join(testDir, "memory", "domains", "registry.json"),
      "utf-8",
    );
    resolveDomainFromEvent(
      makeEvent({ testDir, chatId: CHAT_GROUP, topicId: TOPIC }),
    );
    const after = readFileSync(
      join(testDir, "memory", "domains", "registry.json"),
      "utf-8",
    );
    expect(after).toBe(before);
  });
});
