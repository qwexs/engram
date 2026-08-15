import { afterEach, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import handler, { resolveBootstrapRuleTarget, RULE_CONTEXT_BOOTSTRAP_NAME } from "./handler";

const roots: string[] = [];

function digest(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function write(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

function setup(mode: "active" | "observe-only" = "active") {
  const workspace = mkdtempSync(join(tmpdir(), "engram-pr6-hook-"));
  const stateRoot = mkdtempSync(join(tmpdir(), "engram-pr6-hook-state-"));
  roots.push(workspace, stateRoot);
  const config = {
    schemaVersion: 1,
    workspace: { id: "main" },
    agent: "agent-main",
    oll: {
      adaptation: {
        enabled: true,
        mode,
        actorRegistry: "${ENGRAM_STATE_ROOT}/oll/actors.v1.json",
        companyRuleStore: "${ENGRAM_STATE_ROOT}/oll/company-rules",
        maxInjectedRuleBytes: 8192,
      },
    },
  };
  write(join(workspace, "engram.json"), config);
  write(join(stateRoot, "oll", "actors.v1.json"), {
    schema: "oll.actor-registry.v1",
    revision: 1,
    principals: [{
      principalId: "person:alice",
      transportBindings: [{ channel: "telegram", accountId: "default", actorId: "42" }],
      grants: [],
    }],
  });
  return { workspace, stateRoot, config };
}

function activeRule(level: "person" | "domain" | "workspace", subject: string, text: string) {
  return {
    schema: "oll.adaptation-rule.v1",
    id: randomUUID(),
    workspaceId: "main",
    scope: { level, subject },
    rule: text,
    sourceSignals: [randomUUID()],
    risk: "low",
    status: "active",
    expectedImprovement: "test",
    costOfInaction: "test",
    rollbackRef: "suspend:test",
    decision: {
      action: "activate_rule",
      runId: randomUUID(),
      actionId: digest(text),
      reason: "test",
      decidedAt: "2026-08-12T01:00:00.000Z",
    },
    activatedAt: "2026-08-12T01:00:00.000Z",
    reviewDueAt: null,
    expiresAt: null,
    rolloutBatchId: "pr6-test",
    supersededBy: null,
    revision: 1,
    contentDigest: digest(`content:${text}`),
  };
}

function storeRule(workspace: string, value: ReturnType<typeof activeRule>): void {
  write(join(workspace, "memory-state", "oll", "rules", `${value.id}.json`), value);
}

function bootstrap(workspace: string, stateRoot: string, segment: string) {
  return {
    type: "agent",
    action: "bootstrap",
    sessionKey: `agent:main:${segment}`,
    context: {
      workspaceDir: workspace,
      sessionKey: `agent:main:${segment}`,
      engramStateRoot: stateRoot,
      accountId: "default",
      bootstrapFiles: [{
        name: "AGENTS.md",
        path: join(workspace, "AGENTS.md"),
        content: "baseline agent policy",
        missing: false,
      }],
    },
    messages: [] as string[],
  };
}

function injectedRuleContext(event: ReturnType<typeof bootstrap>) {
  return event.context.bootstrapFiles.find((file) => file.name === RULE_CONTEXT_BOOTSTRAP_NAME);
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("PR 6 generic bootstrap rule hook", () => {
  test("peer-direct resolves one exact actor binding and injects that person's active rule", async () => {
    const env = setup();
    const person = activeRule("person", "person:alice", "Use Alice's concise reply format");
    storeRule(env.workspace, person);
    const event = bootstrap(env.workspace, env.stateRoot, "telegram-direct-42");
    const target = resolveBootstrapRuleTarget(event, env.config, env.stateRoot);
    expect(target).toMatchObject({
      sessionKind: "peer-direct",
      multiPerson: false,
      personSubjects: ["person:alice", "telegram:42", "telegram:user:42"],
    });
    const cachedBootstrapFiles = event.context.bootstrapFiles;
    await handler(event);
    expect(event.messages).toHaveLength(0);
    expect(cachedBootstrapFiles).toHaveLength(1);
    expect(event.context.bootstrapFiles).toHaveLength(2);
    expect(injectedRuleContext(event)?.content).toContain("Use Alice's concise reply format");
    expect(injectedRuleContext(event)?.content).toMatch(/engram-bootstrap-context-hash:sha256:[0-9a-f]{64}/);
    expect(injectedRuleContext(event)?.missing).toBe(false);
  });

  test("normalizes the native OpenClaw colon-form session key before scope resolution", async () => {
    const env = setup();
    const person = activeRule("person", "person:alice", "Use the native-session rule");
    storeRule(env.workspace, person);
    const event = bootstrap(env.workspace, env.stateRoot, "telegram:direct:42");

    expect(resolveBootstrapRuleTarget(event, env.config, env.stateRoot)).toMatchObject({
      sessionKind: "peer-direct",
      multiPerson: false,
      personSubjects: ["person:alice", "telegram:42", "telegram:user:42"],
    });
    await handler(event);
    expect(injectedRuleContext(event)?.content).toContain("Use the native-session rule");
  });

  test("group and topic bootstraps are multi-person and never receive person-private rules", async () => {
    const env = setup();
    const person = activeRule("person", "person:alice", "Alice private rule");
    const workspace = activeRule("workspace", "main", "Shared workspace rule");
    storeRule(env.workspace, person);
    storeRule(env.workspace, workspace);
    const group = bootstrap(env.workspace, env.stateRoot, "telegram-group--100");
    await handler(group);
    expect(injectedRuleContext(group)?.content).toContain("Shared workspace rule");
    expect(injectedRuleContext(group)?.content).not.toContain("Alice private rule");

    const topic = bootstrap(env.workspace, env.stateRoot, "telegram-group--100-topic-7");
    await handler(topic);
    expect(injectedRuleContext(topic)?.content).not.toContain("Alice private rule");
  });

  test("bound domain rules reach topic bootstrap without changing the existing domain payload", async () => {
    const env = setup();
    write(join(env.workspace, "memory", "domains", "registry.json"), {
      schemaVersion: 1,
      domains: {
        reports: { type: "topic-thread", topic: { chatId: "100", topicId: "7" } },
      },
    });
    write(join(env.workspace, "memory", "domains", "reports", "status.md"), { status: "ok" });
    const domain = activeRule("domain", "reports", "Use the reports-domain structure");
    storeRule(env.workspace, domain);
    const event = bootstrap(env.workspace, env.stateRoot, "telegram-group--100-topic-7");
    const target = resolveBootstrapRuleTarget(event, env.config, env.stateRoot);
    expect(target).toMatchObject({ sessionKind: "topic-thread", domainSubjects: ["reports"], multiPerson: true });
    await handler(event);
    expect(injectedRuleContext(event)?.content).toContain("Use the reports-domain structure");
  });

  test("observe-only mode keeps runtime injection disabled for PR7 rollout", async () => {
    const env = setup("observe-only");
    storeRule(env.workspace, activeRule("workspace", "main", "Must stay inactive"));
    const event = bootstrap(env.workspace, env.stateRoot, "main");
    await handler(event);
    expect(event.messages).toHaveLength(0);
    expect(event.context.bootstrapFiles).toHaveLength(1);
    expect(injectedRuleContext(event)).toBeUndefined();
  });

  test("unknown bootstrap session kinds fail closed instead of inheriting main rules", async () => {
    const env = setup();
    storeRule(env.workspace, activeRule("workspace", "main", "Main-only rule"));
    const event = bootstrap(env.workspace, env.stateRoot, "subagent:worker:123");
    expect(resolveBootstrapRuleTarget(event, env.config, env.stateRoot)).toBeNull();
    await handler(event);
    expect(injectedRuleContext(event)).toBeUndefined();
  });

  test("a suspended rule disappears from the next bootstrap and stale managed entries are removed", async () => {
    const env = setup();
    const rule = activeRule("workspace", "main", "Temporary active rule");
    storeRule(env.workspace, rule);
    const active = bootstrap(env.workspace, env.stateRoot, "main");
    await handler(active);
    expect(injectedRuleContext(active)?.content).toContain("Temporary active rule");

    storeRule(env.workspace, { ...rule, status: "suspended", revision: 2 });
    const suspended = bootstrap(env.workspace, env.stateRoot, "main");
    suspended.context.bootstrapFiles.push(injectedRuleContext(active)!);
    await handler(suspended);
    expect(injectedRuleContext(suspended)).toBeUndefined();
    expect(suspended.context.bootstrapFiles).toHaveLength(1);
  });
});
