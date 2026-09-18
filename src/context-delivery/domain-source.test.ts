import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCanonicalSessionKey } from "./contracts.ts";
import { resolveExactDomainBinding } from "./domain-source.ts";

const roots: string[] = [];

function fixture(domains: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), "engram-domain-source-"));
  roots.push(root);
  mkdirSync(join(root, "memory", "domains"), { recursive: true });
  for (const name of Object.keys(domains)) mkdirSync(join(root, "memory", "domains", name), { recursive: true });
  writeFileSync(join(root, "memory", "domains", "registry.json"), JSON.stringify({ domains }));
  return root;
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("exact domain source", () => {
  test("resolves exact topic, peer, and group bindings without mutation", () => {
    const root = fixture({
      topic: { type: "topic-thread", topic: { chatId: "-1001", topicId: "42" } },
      peer: { type: "peer-direct", peer: { chatId: "205" } },
      group: { type: "group-direct", group: { chatId: "-1002" } },
    });
    const topic = parseCanonicalSessionKey("agent:project:telegram:group:-1001:topic:42")!;
    const peer = parseCanonicalSessionKey("agent:project:telegram:direct:205")!;
    const group = parseCanonicalSessionKey("agent:project:telegram:group:-1002")!;
    expect(resolveExactDomainBinding({ workspace: root, workspaceId: "project", scope: topic })?.domainName).toBe("topic");
    expect(resolveExactDomainBinding({ workspace: root, workspaceId: "project", scope: peer })?.domainName).toBe("peer");
    expect(resolveExactDomainBinding({ workspace: root, workspaceId: "project", scope: group })?.domainName).toBe("group");
  });

  test("denies main, foreign workspace, inactive, pending, and wrong-type bindings", () => {
    const root = fixture({
      archived: { type: "peer-direct", peer: { chatId: "1" }, archived: true },
      pending: { type: "peer-direct", peer: { chatId: "2" }, pending: true },
      wrong: { type: "topic-thread", peer: { chatId: "3" } },
    });
    expect(resolveExactDomainBinding({ workspace: root, workspaceId: "project", scope: parseCanonicalSessionKey("agent:project:main")! })).toBeNull();
    expect(resolveExactDomainBinding({ workspace: root, workspaceId: "other", scope: parseCanonicalSessionKey("agent:project:telegram:direct:1")! })).toBeNull();
    for (const actor of ["1", "2", "3"]) {
      expect(resolveExactDomainBinding({ workspace: root, workspaceId: "project", scope: parseCanonicalSessionKey(`agent:project:telegram:direct:${actor}`)! })).toBeNull();
    }
  });

  test("fails closed on ambiguous exact bindings", () => {
    const root = fixture({
      first: { type: "peer-direct", peer: { chatId: "205" } },
      second: { type: "peer-direct", peer: { chatId: "205" } },
    });
    expect(() => resolveExactDomainBinding({
      workspace: root,
      workspaceId: "project",
      scope: parseCanonicalSessionKey("agent:project:telegram:direct:205")!,
    })).toThrow("ambiguous");
  });
});
