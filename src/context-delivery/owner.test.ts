import { afterEach, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { sealDeliveryOwnerPolicy } from "./contracts.ts";
import { ContextDeliveryOwner } from "./owner.ts";
import { DELIVERY_OWNER_POLICY_RELATIVE_PATH } from "./policy.ts";

const roots: string[] = [];

function digest(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function write(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof value === "string" ? value : `${JSON.stringify(value)}\n`);
}

function fixture() {
  const workspace = mkdtempSync(join(tmpdir(), "engram-owner-workspace-"));
  const stateRoot = mkdtempSync(join(tmpdir(), "engram-owner-state-"));
  roots.push(workspace, stateRoot);
  write(join(workspace, "engram.json"), {
    workspace: { id: "main" },
    oll: { adaptation: { mode: "active", companyRuleStore: "${ENGRAM_STATE_ROOT}/oll/company-rules" } },
  });
  return { workspace, stateRoot };
}

function policy(mode: "shadow" | "canary") {
  return sealDeliveryOwnerPolicy({
    schema: "engram.context-delivery-owner-policy.v2",
    revision: 2,
    mode,
    canarySessionKeys: ["agent:main:telegram:direct:42"],
    caps: {
      totalBytes: 24 * 1024,
      sourceBytes: { oll: 8 * 1024, domain: 12 * 1024, session: 8 * 1024, kg: 12 * 1024 },
      minContextTokenBudget: 16_000,
    },
  });
}

function activeWorkspaceRule(workspace: string): void {
  const text = "Use compact owner test updates";
  const id = randomUUID();
  write(join(workspace, "memory-state/oll/rules", `${id}.json`), {
    schema: "oll.adaptation-rule.v1",
    id,
    workspaceId: "main",
    scope: { level: "workspace", subject: "main" },
    status: "active",
    revision: 1,
    activatedAt: "2026-09-19T00:00:00.000Z",
    expiresAt: null,
    contentDigest: digest(text),
    rule: text,
  });
}

const context = (workspace: string) => ({
  runId: "run-owner-1",
  agentId: "main",
  sessionKey: "agent:main:telegram:direct:42",
  workspaceDir: workspace,
  channel: "telegram",
  accountId: "default",
  chatId: "42",
  senderId: "42",
  trigger: "user",
  contextTokenBudget: 272_000,
});

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("context delivery owner", () => {
  test("preserves legacy as a no-op when no owner policy is installed", () => {
    const env = fixture();
    const owner = new ContextDeliveryOwner({
      stateRoot: env.stateRoot,
      resolveAgentWorkspaceDir: () => env.workspace,
    });
    expect(owner.prepare({}, context(env.workspace))).toEqual({ context: null, receipt: null });
  });

  test("observes in shadow without contributing prompt context", () => {
    const env = fixture();
    activeWorkspaceRule(env.workspace);
    write(join(env.workspace, DELIVERY_OWNER_POLICY_RELATIVE_PATH), policy("shadow"));
    const owner = new ContextDeliveryOwner({
      stateRoot: env.stateRoot,
      resolveAgentWorkspaceDir: () => env.workspace,
      now: () => "2026-09-19T00:00:00.000Z",
    });
    const result = owner.prepare({}, context(env.workspace));
    expect(result.context).toBeNull();
    expect(result.receipt?.reason).toBe("OBSERVED_WOULD_DELIVER");
    expect(result.receipt?.sources.find((source) => source.source === "oll")?.selected).toBe(true);
  });

  test("returns one prependable envelope only for the exact canary", () => {
    const env = fixture();
    activeWorkspaceRule(env.workspace);
    write(join(env.workspace, "memory/agent-main/telegram-direct-42/2026-09-19.md"), "# Daily\n\n## Events\n- exact session event\n\n## Decisions\n\n## Active Threads\n- capsule rollout\n\n## Next\n- inspect model input\n");
    write(join(env.workspace, DELIVERY_OWNER_POLICY_RELATIVE_PATH), policy("canary"));
    const owner = new ContextDeliveryOwner({
      stateRoot: env.stateRoot,
      resolveAgentWorkspaceDir: () => env.workspace,
      now: () => "2026-09-19T00:00:00.000Z",
    });
    const result = owner.prepare({}, context(env.workspace));
    expect(result.context).toContain("engram-context-delivery:v1");
    expect(result.context).toContain("Use compact owner test updates");
    expect(result.context).toContain("exact session event");
    expect(result.context).toContain("engram-session-context:v1");
    expect(result.context?.match(/engram-context-delivery:v1/g)).toHaveLength(1);
    const missed = owner.prepare({}, {
      ...context(env.workspace), runId: "run-owner-2", sessionKey: "agent:main:telegram:direct:43", chatId: "43", senderId: "43",
    });
    expect(missed.context).toBeNull();
    expect(missed.receipt?.reason).toBe("CANARY_NOT_SELECTED");
  });

  test("fails closed on host workspace disagreement and non-user triggers", () => {
    const env = fixture();
    const other = mkdtempSync(join(tmpdir(), "engram-owner-other-"));
    roots.push(other);
    const owner = new ContextDeliveryOwner({ stateRoot: env.stateRoot, resolveAgentWorkspaceDir: () => other });
    expect(owner.prepare({}, context(env.workspace))).toEqual({ context: null, receipt: null });
    const matching = new ContextDeliveryOwner({ stateRoot: env.stateRoot, resolveAgentWorkspaceDir: () => env.workspace });
    expect(matching.prepare({}, { ...context(env.workspace), trigger: "cron" })).toEqual({ context: null, receipt: null });
  });

  test("accepts an omitted optional trigger only after canonical conversation checks", () => {
    const env = fixture();
    activeWorkspaceRule(env.workspace);
    write(join(env.workspace, DELIVERY_OWNER_POLICY_RELATIVE_PATH), policy("shadow"));
    const owner = new ContextDeliveryOwner({ stateRoot: env.stateRoot, resolveAgentWorkspaceDir: () => env.workspace });
    expect(owner.prepare({}, { ...context(env.workspace), trigger: undefined }).receipt?.reason).toBe("OBSERVED_WOULD_DELIVER");
    expect(owner.prepare({}, { ...context(env.workspace), trigger: undefined, sessionKey: "agent:main:cron:1" })).toEqual({ context: null, receipt: null });
  });
});
