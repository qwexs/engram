import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { authorizeKgContext, buildRuleContextTarget, resolvePersonSubjects } from "./authorization.ts";
import { parseCanonicalSessionKey } from "./contracts.ts";

const roots: string[] = [];

function write(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value)}\n`);
}

function fixture() {
  const workspace = mkdtempSync(join(tmpdir(), "engram-delivery-auth-"));
  const stateRoot = mkdtempSync(join(tmpdir(), "engram-delivery-actors-"));
  roots.push(workspace, stateRoot);
  write(join(workspace, "engram.json"), {
    workspace: { id: "main" },
    oll: { adaptation: { actorRegistry: "${ENGRAM_STATE_ROOT}/oll/actors.v1.json" } },
  });
  return { workspace, stateRoot };
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("context delivery authorization", () => {
  test("requires one exact KG principal and grant for a trusted direct scope", () => {
    const env = fixture();
    write(join(env.workspace, "memory-state/kg-v3/authority.json"), {
      schema: "engram.kg-v3-authority.v1",
      workspaceId: "main",
      enabledSessionCapabilities: [{ sessionKey: "telegram-direct-42", capabilities: ["kg:v3:write"] }],
    });
    const grants = {
      schema: "engram.kg-v3-runtime-grants.v1",
      workspaceId: "main",
      revision: 1,
      principals: [{
        principalId: "alice",
        bindings: [{ transport: "telegram", actorId: "42" }],
        grants: [{ sessionKey: "telegram-direct-42", capabilities: ["kg:v3:write"] }],
      }],
    };
    write(join(env.workspace, "memory-state/kg-v3/runtime-grants.json"), grants);
    const scope = parseCanonicalSessionKey("agent:main:telegram:direct:42")!;
    expect(authorizeKgContext({ workspace: env.workspace, workspaceId: "main", scope })).toBe(true);
    grants.principals.push(structuredClone(grants.principals[0]!));
    write(join(env.workspace, "memory-state/kg-v3/runtime-grants.json"), grants);
    expect(authorizeKgContext({ workspace: env.workspace, workspaceId: "main", scope })).toBe(false);
  });

  test("never authorizes KG in group or topic scope", () => {
    const env = fixture();
    for (const key of ["agent:main:telegram:group:-1001", "agent:main:telegram:group:-1001:topic:42"]) {
      expect(authorizeKgContext({ workspace: env.workspace, workspaceId: "main", scope: parseCanonicalSessionKey(key)! })).toBe(false);
    }
  });

  test("resolves one actor to OLL aliases and strips person subjects from multi-person targets", () => {
    const env = fixture();
    write(join(env.stateRoot, "oll/actors.v1.json"), {
      schema: "oll.actor-registry.v1",
      revision: 1,
      principals: [{
        principalId: "person:alice",
        transportBindings: [{ channel: "telegram", accountId: "default", actorId: "42" }],
        grants: [],
      }],
    });
    const peer = parseCanonicalSessionKey("agent:main:telegram:direct:42")!;
    const subjects = resolvePersonSubjects({ ...env, scope: peer, accountId: "default" });
    expect(subjects).toEqual(["person:alice", "telegram:42", "telegram:user:42"]);
    expect(buildRuleContextTarget({ workspaceId: "main", scope: peer, personSubjects: subjects })).toMatchObject({
      sessionKind: "peer-direct", personSubjects: subjects, multiPerson: false,
    });
    const topic = parseCanonicalSessionKey("agent:main:telegram:group:-1001:topic:42")!;
    expect(buildRuleContextTarget({ workspaceId: "main", scope: topic, domainName: "launch", personSubjects: subjects })).toEqual({
      workspaceId: "main",
      sessionKind: "topic-thread",
      domainSubjects: ["launch"],
      personSubjects: [],
      multiPerson: true,
    });
  });
});
