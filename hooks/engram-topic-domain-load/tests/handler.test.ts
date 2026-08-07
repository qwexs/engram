/**
 * engram-topic-domain-load (v4 — bootstrap delivery)
 *
 * Run:
 *   cd <path-to-engram-skill>
 *   bun test hooks/engram-topic-domain-load/tests/handler.test.ts
 *
 * Notes:
 *   - Bun loads .ts natively, so we import the handler with the explicit
 *     `.ts` extension (Bun does not require a build step).
 *   - v4 contract: for `message:received` and `agent:bootstrap` events whose
 *     session kind is `topic-thread` and that match a bound domain in
 *     `memory/domains/registry.json`, the handler pushes the domain payload
 *     (decisions + status + last changelog entry + agents body) into
 *     `event.messages`. The daily-note file is NOT touched, no system event
 *     is enqueued, no `openclaw` subprocess is spawned. Idempotency is
 *     delegated to the OpenClaw bootstrap pipeline (bootstrap is one-shot).
 *   - Test isolation: every test creates a fresh `mkdtempSync` workspace
 *     and cleans it up in `finally`. process.env is NEVER mutated at
 *     module load; any per-test env tweaks (e.g. ENGRAM_TZ) are set in
 *     `beforeAll`/`afterAll` with explicit restores so neighbouring test
 *     files (e.g. `scripts/hooks-state.test.ts`) are not affected.
 *   - All date strings are derived via `Intl.DateTimeFormat` with an
 *     explicit `timeZone: "UTC"` so test output is reproducible across
 *     host timezones without depending on the parent process's TZ.
 */

import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import handler from "../handler.ts";

const CHAT = "100000000001";   // fixture: anonymized Telegram supergroup id (unsigned)
const TOPIC = "60";            // fixture: topic id
const AGENT_ID = "sample-agent";

/** Build "today" in UTC, deterministically, without mutating process.env. */
function todayUtc(): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}
type WorkspaceOpts = {
  chatId?: string;          // chatId stored in registry (default CHAT, no leading minus)
  topicId?: string;         // topicId stored in registry (default TOPIC)
  agentId?: string;         // agentId stored in sessionKey
  withAgentsFile?: boolean; // also create agents.md
  archived?: boolean;       // mark domain as archived in registry
};

type Fixture = {
  testDir: string;
  sessionKey: string;
  absChatId: string;
  domainName: string;
  domainDir: string;
};

function setupWorkspace(opts: WorkspaceOpts = {}): Fixture {
  const chatId = opts.chatId ?? CHAT;
  const topicId = opts.topicId ?? TOPIC;
  const agentId = opts.agentId ?? AGENT_ID;
  const testDir = mkdtempSync(join(tmpdir(), "engram-tdl-v4-"));
  const domainName = "engram";

  // Registry
  mkdirSync(join(testDir, "memory", "domains"), { recursive: true });
  const registry: any = {
    domains: {
      [domainName]: {
        type: "project",
        topic: { chatId, topicId },
        kgEntity: "projects/engram",
      },
    },
  };
  if (opts.archived) registry.domains[domainName].archived = true;
  writeFileSync(
    join(testDir, "memory", "domains", "registry.json"),
    JSON.stringify(registry, null, 2) + "\n",
  );

  // Domain files
  const domainDir = join(testDir, "memory", "domains", domainName);
  mkdirSync(domainDir, { recursive: true });
  writeFileSync(join(domainDir, "decisions.md"), "# decisions\n\n### 2026-06-30 — First decision\n\nRationale.\n");
  writeFileSync(join(domainDir, "status.md"), "# status\n\nCurrent status line.\n");
  writeFileSync(join(domainDir, "changelog.md"), "## 2026-06-30\n\nDid the thing.\n");
  if (opts.withAgentsFile) {
    writeFileSync(
      join(domainDir, "agents.md"),
      "# Domain AGENTS — engram (custom)\n\n## Custom rule\nUser-defined agents body.\n",
    );
  }

  const absChatId = chatId.replace(/^-/, "");
  const sessionKey = `agent:${agentId}:telegram-group--${absChatId}-topic-${topicId}`;
  return { testDir, sessionKey, absChatId, domainName, domainDir };
}

type EventOpts = {
  testDir: string;
  sessionKey: string;
  type?: "message" | "agent";
  action?: string;
  chatId?: string;
  topicId?: string;
  /** OC66 internal: deliver topicId/chatId via context.metadata. */
  oc66Internal?: boolean;
  /** OC66 plugin: deliver topicId via event.threadId, chatId via context.conversationId. */
  oc66Plugin?: boolean;
  /** Force `event.messages` to be undefined or null (defensive). */
  dropMessages?: boolean;
};

function makeEvent(opts: EventOpts): any {
  const e: any = {
    type: opts.type ?? "message",
    action: opts.action ?? "received",
    sessionKey: opts.sessionKey,
    context: {
      workspaceDir: opts.testDir,
      agentId: AGENT_ID,
    },
  };

  if (opts.oc66Internal) {
    e.context.metadata = {
      threadId: opts.topicId ?? TOPIC,
      to: opts.chatId ?? CHAT,
    };
    e.context.conversationId = `telegram:${(opts.chatId ?? CHAT).replace(/^-/, "")}`;
  } else if (opts.oc66Plugin) {
    e.threadId = opts.topicId ?? TOPIC;
    e.context.conversationId = `telegram:${(opts.chatId ?? CHAT).replace(/^-/, "")}`;
  } else {
    e.context.chatId = opts.chatId ?? CHAT;
    e.context.topicId = opts.topicId ?? TOPIC;
  }

  if (opts.dropMessages) delete e.messages;
  return e;
}

describe("engram-topic-domain-load v4 — bootstrap delivery", () => {
  let logSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    logSpy = spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // BOUND TOPIC → payload pushed to event.messages
  // -------------------------------------------------------------------------

  describe("bound topic-thread → injects payload via event.messages", () => {
    test("message:received pushes a domain payload onto event.messages", async () => {
      const fx = setupWorkspace();
      try {
        const event: any = makeEvent({ testDir: fx.testDir, sessionKey: fx.sessionKey });
        event.messages = [];

        await expect(handler(event)).resolves.toBeUndefined();

        expect(event.messages).toHaveLength(1);
        const payload = event.messages[0];
        expect(typeof payload).toBe("string");

        // Payload structure
        expect(payload).toContain("Engram Domain Context (auto)");
        expect(payload).toContain("topic-thread");
        expect(payload).toContain("projects/engram");
        expect(payload).toContain("Domain");
        expect(payload).toContain("engram");
        expect(payload).toContain("Status");
        expect(payload).toContain("changelog");
        // System-event hash marker (8-hex, the canonical v4 marker)
        expect(payload).toMatch(/engram-system-event-hash:[a-f0-9]{8}/);
        // Agents block (fallback because no agents.md was created)
        expect(payload).toContain("Domain AGENTS");
        expect(payload).toContain("fallback");
        expect(payload).toContain("⚠️");
        expect(payload).toMatch(/session=topic-thread/);

        // Session label
        expect(payload).toContain(`chat \`${fx.absChatId}\`, topic \`${TOPIC}\``);

        // Daily note file is NEVER touched by v4
        const sessionDir = join(
          fx.testDir,
          "memory",
          `agent-${AGENT_ID}`,
          `telegram-group--${fx.absChatId}-topic-${TOPIC}`,
        );
        const todayFile = join(sessionDir, `${todayUtc()}.md`);
        expect(existsSync(todayFile)).toBe(false);

        // Log fired exactly once
        const injected = logSpy.mock.calls.filter(
          (c: unknown[]) =>
            typeof c[0] === "string" &&
            c[0].includes("[engram-topic-domain-load] Injected domain context"),
        );
        expect(injected).toHaveLength(1);
      } finally {
        rmSync(fx.testDir, { recursive: true, force: true });
      }
    });

    test("agent:bootstrap also delivers via event.messages (bootstrap is the canonical v4 surface)", async () => {
      const fx = setupWorkspace();
      try {
        const event: any = makeEvent({
          testDir: fx.testDir,
          sessionKey: fx.sessionKey,
          type: "agent",
          action: "bootstrap",
        });
        event.messages = [];

        await handler(event);

        expect(event.messages).toHaveLength(1);
        expect(event.messages[0]).toMatch(/engram-system-event-hash:[a-f0-9]{8}/);
      } finally {
        rmSync(fx.testDir, { recursive: true, force: true });
      }
    });

    test("payload uses agents.md when present (no fallback warning)", async () => {
      const fx = setupWorkspace({ withAgentsFile: true });
      try {
        const event: any = makeEvent({ testDir: fx.testDir, sessionKey: fx.sessionKey });
        event.messages = [];

        await handler(event);

        expect(event.messages).toHaveLength(1);
        const payload = event.messages[0];
        expect(payload).toContain("Domain AGENTS");
        expect(payload).toContain("User-defined agents body");
        // No fallback warning when agents.md is present
        expect(payload).not.toMatch(/⚠️[^]*fallback/);
        // Source tag in the footer
        expect(payload).toMatch(/source=file/);
      } finally {
        rmSync(fx.testDir, { recursive: true, force: true });
      }
    });

    test("missing domain files (decisions/status/changelog/agents) still delivers via fallback", async () => {
      // No domain dir on disk at all — registry alone is enough to bind.
      const fx = setupWorkspace();
      try {
        rmSync(fx.domainDir, { recursive: true, force: true });
        const event: any = makeEvent({ testDir: fx.testDir, sessionKey: fx.sessionKey });
        event.messages = [];

        await handler(event);

        expect(event.messages).toHaveLength(1);
        const payload = event.messages[0];
        // status.md / changelog.md missing → Russian placeholder text
        expect(payload).toContain("_status.md пуст_");
        expect(payload).toContain("_changelog.md пуст_");
        // agents.md missing → fallback + ⚠️
        expect(payload).toContain("fallback");
        expect(payload).toContain("⚠️");
        expect(payload).toMatch(/source=fallback/);
      } finally {
        rmSync(fx.testDir, { recursive: true, force: true });
      }
    });

    test("event.messages not an array → handler returns silently (no throw)", async () => {
      const fx = setupWorkspace();
      try {
        const event: any = makeEvent({ testDir: fx.testDir, sessionKey: fx.sessionKey });
        // Make messages a non-array (defensive case)
        event.messages = "not-an-array";

        await expect(handler(event)).resolves.toBeUndefined();
        // messages field unchanged
        expect(event.messages).toBe("not-an-array");
      } finally {
        rmSync(fx.testDir, { recursive: true, force: true });
      }
    });

    test("event.messages absent → handler returns silently (no throw)", async () => {
      const fx = setupWorkspace();
      try {
        const event: any = makeEvent({
          testDir: fx.testDir,
          sessionKey: fx.sessionKey,
          dropMessages: true,
        });

        await expect(handler(event)).resolves.toBeUndefined();
        expect(event.messages).toBeUndefined();
      } finally {
        rmSync(fx.testDir, { recursive: true, force: true });
      }
    });

    test("hash is 8 hex chars and reflects status+changelog+decisions content", async () => {
      const fx = setupWorkspace();
      try {
        const event: any = makeEvent({ testDir: fx.testDir, sessionKey: fx.sessionKey });
        event.messages = [];

        await handler(event);
        const first = event.messages[0].match(/engram-system-event-hash:([a-f0-9]+)/)![1];
        expect(first).toMatch(/^[a-f0-9]{8}$/);

        // Mutate status.md → new hash on the next call
        writeFileSync(
          join(fx.domainDir, "status.md"),
          "# status\n\nCurrent status line.\n\nAdditional line after edit.\n",
        );
        const event2: any = makeEvent({ testDir: fx.testDir, sessionKey: fx.sessionKey });
        event2.messages = [];
        await handler(event2);
        const second = event2.messages[0].match(/engram-system-event-hash:([a-f0-9]+)/)![1];
        expect(second).not.toBe(first);
        expect(second).toMatch(/^[a-f0-9]{8}$/);
      } finally {
        rmSync(fx.testDir, { recursive: true, force: true });
      }
    });
  });

  // -------------------------------------------------------------------------
  // UNBOUND TOPIC → no delivery
  // -------------------------------------------------------------------------

  describe("unbound topic-thread → no delivery", () => {
    test("wrong topicId → messages stays empty, no log", async () => {
      const fx = setupWorkspace({ topicId: "999" });
      try {
        const event: any = makeEvent({ testDir: fx.testDir, sessionKey: fx.sessionKey });
        event.messages = [];
        await handler(event);
        expect(event.messages).toHaveLength(0);
        const injected = logSpy.mock.calls.filter(
          (c: unknown[]) =>
            typeof c[0] === "string" &&
            c[0].includes("[engram-topic-domain-load] Injected"),
        );
        expect(injected).toHaveLength(0);
      } finally {
        rmSync(fx.testDir, { recursive: true, force: true });
      }
    });

    test("wrong chatId → messages stays empty", async () => {
      const fx = setupWorkspace({ chatId: "1234567890" });
      try {
        const event: any = makeEvent({ testDir: fx.testDir, sessionKey: fx.sessionKey });
        event.messages = [];
        await handler(event);
        expect(event.messages).toHaveLength(0);
      } finally {
        rmSync(fx.testDir, { recursive: true, force: true });
      }
    });

    test("empty registry → messages stays empty", async () => {
      const fx = setupWorkspace();
      try {
        writeFileSync(
          join(fx.testDir, "memory", "domains", "registry.json"),
          JSON.stringify({ domains: {} }, null, 2) + "\n",
        );
        const event: any = makeEvent({ testDir: fx.testDir, sessionKey: fx.sessionKey });
        event.messages = [];
        await handler(event);
        expect(event.messages).toHaveLength(0);
      } finally {
        rmSync(fx.testDir, { recursive: true, force: true });
      }
    });

    test("missing topicId in event → topic-thread gate fails, no delivery", async () => {
      const fx = setupWorkspace();
      try {
        const event: any = makeEvent({
          testDir: fx.testDir,
          sessionKey: fx.sessionKey,
          topicId: "",
        });
        event.messages = [];
        await handler(event);
        expect(event.messages).toHaveLength(0);
      } finally {
        rmSync(fx.testDir, { recursive: true, force: true });
      }
    });

    test("missing chatId in event → no delivery", async () => {
      const fx = setupWorkspace();
      try {
        const event: any = makeEvent({
          testDir: fx.testDir,
          sessionKey: fx.sessionKey,
          chatId: "",
        });
        event.messages = [];
        await handler(event);
        expect(event.messages).toHaveLength(0);
      } finally {
        rmSync(fx.testDir, { recursive: true, force: true });
      }
    });
  });

  // -------------------------------------------------------------------------
  // CHAT-ID SIGN SYMMETRY
  // -------------------------------------------------------------------------

  describe("chatId sign symmetry", () => {
    test("registry: unsigned, event: signed (-chat) → matches and delivers", async () => {
      const fx = setupWorkspace({ chatId: CHAT });
      try {
        const event: any = makeEvent({
          testDir: fx.testDir,
          sessionKey: fx.sessionKey,
          chatId: `-${CHAT}`,
        });
        event.messages = [];
        await handler(event);
        expect(event.messages).toHaveLength(1);
        expect(event.messages[0]).toContain(`chat \`${CHAT}\`, topic \`${TOPIC}\``);
      } finally {
        rmSync(fx.testDir, { recursive: true, force: true });
      }
    });

    test("registry: signed (-chat), event: unsigned → matches and delivers", async () => {
      const fx = setupWorkspace({ chatId: `-${CHAT}` });
      try {
        const event: any = makeEvent({
          testDir: fx.testDir,
          sessionKey: fx.sessionKey,
          chatId: CHAT,
        });
        event.messages = [];
        await handler(event);
        expect(event.messages).toHaveLength(1);
        expect(event.messages[0]).toContain(`chat \`${CHAT}\`, topic \`${TOPIC}\``);
      } finally {
        rmSync(fx.testDir, { recursive: true, force: true });
      }
    });
  });

  // -------------------------------------------------------------------------
  // OPENCLAW 2026.6.6 EVENT-SHAPE FALLBACKS
  // -------------------------------------------------------------------------

  describe("OpenClaw 2026.6.6 event-shape fallbacks", () => {
    test("OC66 internal: context.metadata.threadId + metadata.to → resolves and delivers", async () => {
      const fx = setupWorkspace();
      try {
        const event: any = makeEvent({
          testDir: fx.testDir,
          sessionKey: fx.sessionKey,
          oc66Internal: true,
        });
        event.messages = [];
        await handler(event);
        expect(event.messages).toHaveLength(1);
        expect(event.messages[0]).toContain(`chat \`${fx.absChatId}\`, topic \`${TOPIC}\``);
      } finally {
        rmSync(fx.testDir, { recursive: true, force: true });
      }
    });

    test("OC66 plugin: top-level event.threadId + context.conversationId → resolves and delivers", async () => {
      const fx = setupWorkspace();
      try {
        const event: any = makeEvent({
          testDir: fx.testDir,
          sessionKey: fx.sessionKey,
          oc66Plugin: true,
        });
        event.messages = [];
        await handler(event);
        expect(event.messages).toHaveLength(1);
        expect(event.messages[0]).toContain(`chat \`${fx.absChatId}\`, topic \`${TOPIC}\``);
      } finally {
        rmSync(fx.testDir, { recursive: true, force: true });
      }
    });

    test("OC66 internal: signed chatId in metadata.to vs unsigned in registry → still matches", async () => {
      const fx = setupWorkspace({ chatId: CHAT });
      try {
        const event: any = makeEvent({
          testDir: fx.testDir,
          sessionKey: fx.sessionKey,
          oc66Internal: true,
          chatId: `-${CHAT}`,
        });
        event.messages = [];
        await handler(event);
        expect(event.messages).toHaveLength(1);
      } finally {
        rmSync(fx.testDir, { recursive: true, force: true });
      }
    });
  });

  // -------------------------------------------------------------------------
  // EVENT-SURFACE GATING
  // -------------------------------------------------------------------------

  describe("event-surface gating", () => {
    test("wrong event.type → no delivery", async () => {
      const fx = setupWorkspace();
      try {
        const event: any = makeEvent({
          testDir: fx.testDir,
          sessionKey: fx.sessionKey,
          type: "session",
          action: "start",
        });
        event.messages = [];
        await handler(event);
        expect(event.messages).toHaveLength(0);
      } finally {
        rmSync(fx.testDir, { recursive: true, force: true });
      }
    });

    test("wrong event.action → no delivery", async () => {
      const fx = setupWorkspace();
      try {
        const event: any = makeEvent({
          testDir: fx.testDir,
          sessionKey: fx.sessionKey,
          action: "sent",
        });
        event.messages = [];
        await handler(event);
        expect(event.messages).toHaveLength(0);
      } finally {
        rmSync(fx.testDir, { recursive: true, force: true });
      }
    });

    test("missing sessionKey (but event has workspaceDir + chatId + topicId) → still delivers (v4 uses event.context, not sessionKey)", async () => {
      // v4 contract: sessionKey is one of three workspaceDir sources
      // (event.context.workspaceDir, OPENCLAW_WORKSPACE env, sessionKey
      // via workspace-resolver). As long as the event carries
      // workspaceDir and chatId/topicId in event.context, the handler
      // resolves and delivers — the sessionKey is no longer required.
      // This differs from the v3 spawn-based design which needed a
      // --session-key to call the openclaw CLI.
      const fx = setupWorkspace();
      try {
        const event: any = {
          type: "message",
          action: "received",
          // sessionKey deliberately omitted
          context: {
            workspaceDir: fx.testDir,
            agentId: AGENT_ID,
            chatId: CHAT,
            topicId: TOPIC,
          },
          messages: [],
        };
        await expect(handler(event)).resolves.toBeUndefined();
        expect(event.messages).toHaveLength(1);
        expect(event.messages[0]).toMatch(/engram-system-event-hash:[a-f0-9]{8}/);
      } finally {
        rmSync(fx.testDir, { recursive: true, force: true });
      }
    });

    test("missing sessionKey + no workspaceDir + no agentId → no delivery", async () => {
      // Without any workspace resolution path, the handler must skip
      // cleanly. event.context.chatId/topicId are present but the
      // resolver never gets far enough to consult them.
      const event: any = {
        type: "message",
        action: "received",
        // sessionKey, context.workspaceDir, context.agentId all omitted
        context: {
          chatId: CHAT,
          topicId: TOPIC,
        },
        messages: [],
      };
      await expect(handler(event)).resolves.toBeUndefined();
      expect(event.messages).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // FAILURE MODES
  // -------------------------------------------------------------------------

  describe("failure modes", () => {
    test("corrupt registry.json → no delivery, no throw", async () => {
      const fx = setupWorkspace();
      try {
        writeFileSync(
          join(fx.testDir, "memory", "domains", "registry.json"),
          "not-json",
        );
        const event: any = makeEvent({ testDir: fx.testDir, sessionKey: fx.sessionKey });
        event.messages = [];
        await handler(event);
        expect(event.messages).toHaveLength(0);
      } finally {
        rmSync(fx.testDir, { recursive: true, force: true });
      }
    });

    test("missing registry.json → no delivery, no throw", async () => {
      const fx = setupWorkspace();
      try {
        rmSync(join(fx.testDir, "memory", "domains", "registry.json"));
        const event: any = makeEvent({ testDir: fx.testDir, sessionKey: fx.sessionKey });
        event.messages = [];
        await handler(event);
        expect(event.messages).toHaveLength(0);
      } finally {
        rmSync(fx.testDir, { recursive: true, force: true });
      }
    });

    test("read error on engram.json (corrupt) → falls back to default qmd/kg, still delivers", async () => {
      const fx = setupWorkspace();
      try {
        // Corrupt engram.json — the handler swallows the JSON.parse error
        // (try/catch) and uses default qmd.index='default' and
        // workspaceKgCollection='life'. The payload is still delivered.
        writeFileSync(join(fx.testDir, "engram.json"), "{not valid json");
        const event: any = makeEvent({ testDir: fx.testDir, sessionKey: fx.sessionKey });
        event.messages = [];
        await handler(event);
        expect(event.messages).toHaveLength(1);
      } finally {
        rmSync(fx.testDir, { recursive: true, force: true });
      }
    });
  });

  // -------------------------------------------------------------------------
  // UNARCHIVE-ON-MESSAGE
  // -------------------------------------------------------------------------

  describe("unarchive-on-message", () => {
    test("archived topic-bound domain is reactivated on first message", async () => {
      const fx = setupWorkspace({ archived: true });
      try {
        // Sanity: registry starts with archived: true
        const before = JSON.parse(
          readFileSync(join(fx.testDir, "memory", "domains", "registry.json"), "utf-8"),
        );
        expect(before.domains[fx.domainName].archived).toBe(true);

        const event: any = makeEvent({ testDir: fx.testDir, sessionKey: fx.sessionKey });
        event.messages = [];
        await handler(event);

        // Payload delivered
        expect(event.messages).toHaveLength(1);

        // Registry re-written with archived flag cleared
        const after = JSON.parse(
          readFileSync(join(fx.testDir, "memory", "domains", "registry.json"), "utf-8"),
        );
        expect(after.domains[fx.domainName].archived).toBeUndefined();
        // Other fields preserved
        expect(after.domains[fx.domainName].type).toBe("project");
        expect(after.domains[fx.domainName].topic).toEqual({ chatId: CHAT, topicId: TOPIC });
        expect(after.domains[fx.domainName].kgEntity).toBe("projects/engram");
      } finally {
        rmSync(fx.testDir, { recursive: true, force: true });
      }
    });
  });

  // -------------------------------------------------------------------------
  // V4 DELIVERY SEMANTICS — bootstrap is one-shot by design
  // -------------------------------------------------------------------------

  describe("v4 delivery semantics", () => {
    test("two consecutive calls on the same bound topic each push a payload (v4 has no idempotency gate)", async () => {
      // v4 does not check the daily note for a prior marker; the bootstrap
      // delivery is one-shot by the surrounding OpenClaw pipeline, not by
      // the handler. This test pins the current contract: every matching
      // call pushes a payload. If idempotency is reintroduced later, this
      // test will need to be updated to match the new contract.
      const fx = setupWorkspace();
      try {
        const e1: any = makeEvent({ testDir: fx.testDir, sessionKey: fx.sessionKey });
        e1.messages = [];
        await handler(e1);
        expect(e1.messages).toHaveLength(1);

        const e2: any = makeEvent({ testDir: fx.testDir, sessionKey: fx.sessionKey });
        e2.messages = [];
        await handler(e2);
        expect(e2.messages).toHaveLength(1);
        // Same hash (same content) but two distinct payloads
        const h1 = e1.messages[0].match(/engram-system-event-hash:([a-f0-9]+)/)![1];
        const h2 = e2.messages[0].match(/engram-system-event-hash:([a-f0-9]+)/)![1];
        expect(h1).toBe(h2);
      } finally {
        rmSync(fx.testDir, { recursive: true, force: true });
      }
    });
  });
});
