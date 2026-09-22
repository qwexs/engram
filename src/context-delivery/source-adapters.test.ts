import { afterEach, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { KG_V3_AUTHORITY_SCHEMA, KG_V3_SCHEMA_DIGEST } from "../kg-v3/index.ts";
import { parseCanonicalSessionKey, renderedDeliverySourceBytes } from "./contracts.ts";
import {
  resolveDomainContextSource,
  resolveKgContextSource,
  resolveOllContextSource,
  splitSourceOutcomes,
} from "./source-adapters.ts";

const roots: string[] = [];
const NOW = "2026-09-19T00:00:00.000Z";

function digest(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function json(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function fixture(workspaceId = "main"): { workspace: string; stateRoot: string; workspaceId: string } {
  const workspace = mkdtempSync(join(tmpdir(), "engram-source-adapter-"));
  const stateRoot = mkdtempSync(join(tmpdir(), "engram-source-state-"));
  roots.push(workspace, stateRoot);
  json(join(workspace, "engram.json"), {
    workspace: { id: workspaceId },
    oll: { adaptation: { mode: "active", companyRuleStore: "${ENGRAM_STATE_ROOT}/oll/company-rules", maxInjectedRuleBytes: 8192 } },
  });
  return { workspace, stateRoot, workspaceId };
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("context delivery source adapters", () => {
  test("reads only the guarded KG v3 current projection and denies group scope", () => {
    const env = fixture();
    const releaseDigest = digest("release");
    json(join(env.workspace, "memory-state", "kg-v3", "authority.json"), {
      schema: KG_V3_AUTHORITY_SCHEMA,
      workspaceId: "main",
      releaseDigest,
      schemaDigest: KG_V3_SCHEMA_DIGEST,
      mode: "canary",
    });
    json(join(env.workspace, "memory-state", "kg-v3", "default-context.json"), {
      schema: "engram.kg-v3-default-context.v1",
      workspaceId: "main",
      releaseDigest,
      mode: "v3-current",
      sources: ["life/v3/current-summary.md"],
      archiveIncludedInDefault: false,
      switchedAt: NOW,
    });
    const body = "<!-- engram-kg-v3-current -->\n# Current summary";
    mkdirSync(join(env.workspace, "life", "v3"), { recursive: true });
    writeFileSync(join(env.workspace, "life", "v3", "current-summary.md"), body);

    const direct = resolveKgContextSource({
      ...env,
      scope: parseCanonicalSessionKey("agent:main:telegram:direct:205")!,
      trustedPeer: true,
    });
    expect(direct.status).toBe("selected");
    if (direct.status === "selected") expect(direct.block.content).toContain("Current summary");
    expect(resolveKgContextSource({
      ...env,
      scope: parseCanonicalSessionKey("agent:main:telegram:group:-1001")!,
      trustedPeer: false,
    })).toEqual({ source: "kg", status: "omitted", reason: "SCOPE_DENIED" });
  });

  test("resolves active OLL rules without persisting conflicts", () => {
    const env = fixture();
    const ruleText = "Use compact status updates";
    const rule = {
      schema: "oll.adaptation-rule.v1",
      id: randomUUID(),
      workspaceId: "main",
      scope: { level: "workspace", subject: "main" },
      rule: ruleText,
      status: "active",
      revision: 1,
      activatedAt: NOW,
      expiresAt: null,
      contentDigest: digest(ruleText),
    };
    json(join(env.workspace, "memory-state", "oll", "rules", `${rule.id}.json`), rule);
    const outcome = resolveOllContextSource({
      workspace: env.workspace,
      stateRoot: env.stateRoot,
      target: { workspaceId: "main", sessionKind: "main", domainSubjects: [], personSubjects: [], multiPerson: false },
      now: NOW,
    });
    expect(outcome.status).toBe("selected");
    if (outcome.status === "selected") expect(outcome.block.content).toContain(ruleText);
  });

  test("builds a bounded legacy-equivalent domain block from one exact binding", () => {
    const env = fixture("project");
    json(join(env.workspace, "memory", "domains", "registry.json"), {
      domains: { launch: { type: "topic-thread", topic: { chatId: "-1001", topicId: "42" } } },
    });
    const domainDir = join(env.workspace, "memory", "domains", "launch");
    mkdirSync(domainDir, { recursive: true });
    writeFileSync(join(domainDir, "decisions.md"), "# Decisions\n\n### One\nKeep the launch date.\n");
    writeFileSync(join(domainDir, "status.md"), "# Status\n\nReady\n");
    writeFileSync(join(domainDir, "changelog.md"), "# Changelog\n\n## 2026-09-18\nPrepared\n");
    writeFileSync(join(domainDir, "agents.md"), "# Domain agent\n\nUse project vocabulary.\n");
    const outcome = resolveDomainContextSource({
      workspace: env.workspace,
      workspaceId: "project",
      scope: parseCanonicalSessionKey("agent:project:telegram:group:-1001:topic:42")!,
      maxRenderedBytes: 12 * 1024,
    });
    expect(outcome.status).toBe("selected");
    if (outcome.status === "selected") {
      expect(outcome.block.content).toContain("Accepted decisions: 1");
      expect(outcome.block.content).toContain("Prepared");
      expect(outcome.block.content).toContain("Use project vocabulary");
      expect(outcome.block.content).toContain("Keep the launch date");
    }
  });

  test("counts only real domain decisions and never lets enrichment evict the base block", () => {
    const env = fixture("project");
    json(join(env.workspace, "memory", "domains", "registry.json"), {
      domains: { launch: { type: "topic-thread", topic: { chatId: "-1001", topicId: "42" } } },
    });
    const domainDir = join(env.workspace, "memory", "domains", "launch");
    mkdirSync(domainDir, { recursive: true });
    writeFileSync(join(domainDir, "decisions.md"), `# Decisions\n\n<!-- ### fake comment -->\n\`\`\`md\n### fake fenced\n\`\`\`\n### One\nKeep one.\n### Two\nKeep two.\n### Three\nKeep three.\n## Later\nMust not join decision three.\n`);
    writeFileSync(join(domainDir, "status.md"), `# Status\n\n${"s".repeat(1_500)}\n`);
    writeFileSync(join(domainDir, "changelog.md"), `# Changelog\n\n## 2026-09-18\n${"c".repeat(700)}\n`);
    writeFileSync(join(domainDir, "agents.md"), `# Domain agent\n\n## Role\nKeep the exact domain.\n\n## Large rules\n${Array.from({ length: 80 }, (_, index) => `- Rule ${index}: ${"a".repeat(120)}`).join("\n")}\n\n## Tail\nPreserve complete records.\n`);
    const outcome = resolveDomainContextSource({
      workspace: env.workspace,
      workspaceId: "project",
      scope: parseCanonicalSessionKey("agent:project:telegram:group:-1001:topic:42")!,
      maxRenderedBytes: 12 * 1024,
    });
    expect(outcome.status).toBe("selected");
    if (outcome.status === "selected") {
      expect(outcome.block.content).toContain("Accepted decisions: 3");
      expect(outcome.block.content).toContain("Domain instructions");
      expect(outcome.block.content).toContain("Keep the exact domain");
      expect(outcome.block.content).not.toContain("fake fenced");
      expect(outcome.block.content).not.toContain("Must not join decision three");
      expect(renderedDeliverySourceBytes(outcome.block)).toBeLessThanOrEqual(12 * 1024);
      expect(outcome.block.content).not.toContain("## Tail");
    }
  });

  test("splits selected blocks and fail-closed omissions for the renderer", () => {
    const result = splitSourceOutcomes([
      { source: "kg", status: "omitted", reason: "SCOPE_DENIED" },
      { source: "oll", status: "selected", block: { source: "oll", artifactDigest: digest("oll"), content: "rule" } },
    ]);
    expect(result.sources.map((source) => source.source)).toEqual(["oll"]);
    expect(result.omissions).toEqual([{ source: "kg", reason: "SCOPE_DENIED" }]);
  });
});
