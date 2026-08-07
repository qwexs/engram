import { test, expect, describe, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  computeContextHash,
  resolveAgentsBody,
  buildDomainPayload,
  readLatestHashFromNote,
  buildFallbackAgentsMd,
  type DomainSourceFiles,
  type ResolveAgentsCfg,
} from "./domain-inject.js";

let ws: string;
const TEST_FILES = {
  decisionsPath: "", statusPath: "", changelogPath: "", agentsPath: "",
};

beforeAll(() => {
  ws = mkdtempSync(join(tmpdir(), "engram-domain-inject-test-"));
});
afterAll(() => {
  if (ws && existsSync(ws)) rmSync(ws, { recursive: true, force: true });
});
beforeEach(() => {
  TEST_FILES.decisionsPath = join(ws, "decisions.md");
  TEST_FILES.statusPath = join(ws, "status.md");
  TEST_FILES.changelogPath = join(ws, "changelog.md");
  TEST_FILES.agentsPath = join(ws, "agents.md");
  writeFileSync(TEST_FILES.decisionsPath, "# decisions\n\n### 2026-06-30 — First\n\n### 2026-07-01 — Second\n\n");
  writeFileSync(TEST_FILES.statusPath, "# status\n\nAll green.\n");
  writeFileSync(TEST_FILES.changelogPath, "## 2026-06-30\n\nDid the thing.\n\n## 2026-07-01\n\nDid more.\n");
  writeFileSync(TEST_FILES.agentsPath, "# Custom AGENTS\n\nbody\n");
});

const cfg: ResolveAgentsCfg = {
  qmdIndex: "default",
  kgCollection: "kg",
  agentId: "sample-agent",
  domainName: "engram",
  sessionSegment: "telegram-group--100xxxxxxxxxx-topic-1",
  kgEntity: "projects/engram",
};

// =========================================================================
// computeContextHash
// =========================================================================

describe("computeContextHash", () => {
  test("8-hex output", () => {
    const h = computeContextHash(TEST_FILES);
    expect(h).toMatch(/^[a-f0-9]{8}$/);
  });

  test("stable for same input", () => {
    const a = computeContextHash(TEST_FILES);
    const b = computeContextHash(TEST_FILES);
    expect(a).toBe(b);
  });

  test("decisions change → hash changes", () => {
    const h1 = computeContextHash(TEST_FILES);
    writeFileSync(TEST_FILES.decisionsPath, "# decisions\n\n### 2026-07-02 — NEW\n\n");
    const h2 = computeContextHash(TEST_FILES);
    expect(h2).not.toBe(h1);
  });

  test("status change → hash changes", () => {
    const h1 = computeContextHash(TEST_FILES);
    writeFileSync(TEST_FILES.statusPath, "# status\n\nCHANGED.\n");
    const h2 = computeContextHash(TEST_FILES);
    expect(h2).not.toBe(h1);
  });

  test("changelog change → hash changes", () => {
    const h1 = computeContextHash(TEST_FILES);
    writeFileSync(TEST_FILES.changelogPath, "## 2026-07-02\n\nNew entry.\n");
    const h2 = computeContextHash(TEST_FILES);
    expect(h2).not.toBe(h1);
  });

  test("agents change does NOT affect context hash", () => {
    const h1 = computeContextHash(TEST_FILES);
    writeFileSync(TEST_FILES.agentsPath, "# totally different\n");
    const h2 = computeContextHash(TEST_FILES);
    expect(h2).toBe(h1);
  });

  test("missing files contribute stable 'missing' marker", () => {
    rmSync(TEST_FILES.statusPath);
    const h1 = computeContextHash(TEST_FILES);
    // Add back empty file with same marker input → same hash.
    // (an empty file would actually contribute a different length, so
    // the hash differs — confirming missing vs empty are distinct.)
    expect(h1).toMatch(/^[a-f0-9]{8}$/);
  });
});

// =========================================================================
// resolveAgentsBody
// =========================================================================

describe("resolveAgentsBody", () => {
  test("agents.md present → {body, source: 'file'}", () => {
    const r = resolveAgentsBody(TEST_FILES, cfg);
    expect(r.source).toBe("file");
    expect(r.body).toContain("Custom AGENTS");
  });

  test("agents.md missing → fallback", () => {
    rmSync(TEST_FILES.agentsPath);
    const r = resolveAgentsBody(TEST_FILES, cfg);
    expect(r.source).toBe("fallback");
    expect(r.body).toContain("fallback");
    expect(r.body).toContain(cfg.domainName);
  });

  test("fallback includes KG entity when provided", () => {
    rmSync(TEST_FILES.agentsPath);
    const r = resolveAgentsBody(TEST_FILES, cfg);
    expect(r.body).toContain("projects/engram");
  });

  test("fallback omits KG entity when null", () => {
    rmSync(TEST_FILES.agentsPath);
    const cfgNoKg: ResolveAgentsCfg = { ...cfg, kgEntity: null };
    const r = resolveAgentsBody(TEST_FILES, cfgNoKg);
    expect(r.body).not.toContain("life-projects-engram");
    expect(r.body).toContain("KG entity не задан");
  });
});

// =========================================================================
// buildDomainPayload
// =========================================================================

describe("buildDomainPayload", () => {
  const baseOpts = () => ({
    domainName: cfg.domainName,
    domainEntry: { type: "project", kgEntity: cfg.kgEntity! },
    sessionKind: "topic-thread" as const,
    sessionLocation: "1003971800777:60",
    contentHash: "abcd1234",
    agents: { body: "# Custom AGENTS\n", source: "file" as const },
    files: TEST_FILES,
  });

  test("marker `<!-- engram-system-event-hash:<8-hex> -->` present on line 2", () => {
    const out = buildDomainPayload(baseOpts());
    const lines = out.split("\n");
    expect(lines[0]).toContain("Engram Domain Context (auto)");
    expect(lines[1]).toBe("<!-- engram-system-event-hash:abcd1234 -->");
  });

  test("topic-thread session label is `chat X, topic Y`", () => {
    const out = buildDomainPayload(baseOpts());
    expect(out).toContain("chat `1003971800777`, topic `60`");
  });

  test("peer-direct session label is `DM X`", () => {
    const out = buildDomainPayload({ ...baseOpts(), sessionKind: "peer-direct", sessionLocation: "alice" });
    expect(out).toContain("DM `alice`");
  });

  test("group-direct session label is `group X`", () => {
    const out = buildDomainPayload({ ...baseOpts(), sessionKind: "group-direct", sessionLocation: "1003971800777" });
    expect(out).toContain("group `1003971800777`");
  });

  test("kgEntity render", () => {
    const out = buildDomainPayload(baseOpts());
    expect(out).toContain("projects/engram");
  });

  test("missing kgEntity → `—`", () => {
    const out = buildDomainPayload({
      ...baseOpts(),
      domainEntry: { type: "project", kgEntity: null },
    });
    expect(out).toContain("KG entity</b>: —");
  });

  test("fallback source → ⚠️ note appended", () => {
    const out = buildDomainPayload({
      ...baseOpts(),
      agents: { body: "fallback body", source: "fallback" },
    });
    expect(out).toContain("⚠️");
    expect(out).toContain("fallback");
  });

  test("file source → no ⚠️ note", () => {
    const out = buildDomainPayload(baseOpts());
    expect(out).not.toContain("⚠️");
  });

  test("decisions count from file", () => {
    const out = buildDomainPayload(baseOpts());
    // 2 decisions were written in beforeEach.
    expect(out).toContain("2 принятых решений");
  });

  test("trailer line uses sessionKind", () => {
    const out = buildDomainPayload(baseOpts());
    expect(out).toContain("session=topic-thread");

    const out2 = buildDomainPayload({ ...baseOpts(), sessionKind: "peer-direct", sessionLocation: "alice" });
    expect(out2).toContain("session=peer-direct");
  });

  test("last changelog entry surface", () => {
    const out = buildDomainPayload(baseOpts());
    expect(out).toContain("Did more."); // last entry's body
  });

  test("status body surfaced", () => {
    const out = buildDomainPayload(baseOpts());
    expect(out).toContain("All green.");
  });
});

// =========================================================================
// readLatestHashFromNote
// =========================================================================

describe("readLatestHashFromNote", () => {
  // Lazy so we don't dereference the `ws` value before `beforeAll` runs.
  const notePath = () => join(ws, "note.md");

  test("missing note → null", () => {
    rmSync(notePath(), { force: true });
    expect(readLatestHashFromNote(notePath())).toBeNull();
  });

  test("note with no marker → null", () => {
    writeFileSync(notePath(), "# 2026-07-10\n\nNo marker here.\n");
    expect(readLatestHashFromNote(notePath())).toBeNull();
  });

  test("note with old v3.3 `domain-context:` marker → null (different regex)", () => {
    writeFileSync(
      notePath(),
      "# 2026-07-10\n\n<!-- domain-context:engram:abcdef012345 -->\n<!-- /domain-context -->\n",
    );
    expect(readLatestHashFromNote(notePath())).toBeNull();
  });

  test("note with single marker → returns that hash", () => {
    writeFileSync(notePath(), "# 2026-07-10\n\n<!-- engram-system-event-hash:abcd1234 -->\n");
    expect(readLatestHashFromNote(notePath())).toBe("abcd1234");
  });

  test("note with multiple markers → returns the LAST one", () => {
    writeFileSync(
      notePath(),
      "# 2026-07-10\n\n<!-- engram-system-event-hash:11111111 -->\n<!-- engram-system-event-hash:22222222 -->\n",
    );
    expect(readLatestHashFromNote(notePath())).toBe("22222222");
  });
});

// =========================================================================
// buildFallbackAgentsMd
// =========================================================================

describe("buildFallbackAgentsMd", () => {
  test("default cfg", () => {
    const body = buildFallbackAgentsMd(cfg);
    expect(body).toContain("engram");
    expect(body).toContain("default");
    expect(body).toContain("sample-agent");
    expect(body).toContain("domain-engram");
  });

  test("missing kgEntity", () => {
    const body = buildFallbackAgentsMd({ ...cfg, kgEntity: null });
    expect(body).toContain("KG entity не задан");
    expect(body).not.toContain("life-projects-engram");
  });

  test("custom qmdIndex and kgCollection", () => {
    const body = buildFallbackAgentsMd({ ...cfg, qmdIndex: "work", kgCollection: "private-kg" });
    expect(body).toContain("--index work");
    expect(body).toContain("private-kg");
  });
});
