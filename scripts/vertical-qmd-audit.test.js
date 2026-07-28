import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
  auditVerticalAccess,
  normalizeVerticalAccess,
} from "./_lib/workspace-watchdog.js";

const temps = [];

afterEach(() => {
  while (temps.length > 0) {
    rmSync(temps.pop(), { recursive: true, force: true });
  }
});

function fixture({ registered = true, embedded = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "engram-vertical-qmd-"));
  temps.push(dir);
  const indexPath = join(dir, "index.sqlite");
  const db = new Database(indexPath);
  db.exec(`
    CREATE TABLE store_collections (name TEXT, path TEXT, pattern TEXT);
    CREATE TABLE documents (collection TEXT, hash TEXT, active INTEGER);
    CREATE TABLE content_vectors (hash TEXT);
  `);
  if (registered) {
    db.query("INSERT INTO store_collections VALUES (?, ?, ?)")
      .run("child-memory", "/srv/child/memory", "**/*.md");
  }
  db.query("INSERT INTO documents VALUES (?, ?, 1)")
    .run("child-memory", "hash-1");
  if (embedded) {
    db.query("INSERT INTO content_vectors VALUES (?)").run("hash-1");
  }
  db.close();
  return indexPath;
}

function config(indexPath, extra = {}) {
  return {
    qmd: {
      verticalAccess: {
        enabled: true,
        indexPath,
        collections: {
          "child-memory": { path: "/srv/child/memory" },
        },
        ...extra,
      },
    },
    domains: {},
  };
}

function registry(withReference = true) {
  return {
    domains: withReference
      ? {
          general: {
            type: "meta-domain",
            qmdCollections: ["child-memory"],
          },
        }
      : {},
  };
}

function audit(engram, domainRegistry = registry()) {
  const findings = [];
  auditVerticalAccess("/srv/upper", domainRegistry, engram, findings);
  return findings;
}

function codes(findings) {
  return findings.map((finding) => finding.code);
}

describe("optional vertical QMD audit", () => {
  test("flat configuration is unchanged", () => {
    expect(normalizeVerticalAccess({ qmd: {} }).enabled).toBe(false);
    expect(audit({ qmd: {} })).toEqual([]);
  });

  test("explicitly disabled configuration is unchanged", () => {
    const engram = { qmd: { verticalAccess: { enabled: false } } };
    expect(normalizeVerticalAccess(engram).enabled).toBe(false);
    expect(audit(engram)).toEqual([]);
  });

  test("invalid contract is reported", () => {
    expect(codes(audit({ qmd: { verticalAccess: {} } })))
      .toEqual(["WD-QMD-015"]);
  });

  test("missing collection is reported", () => {
    const engram = config(fixture({ registered: false }), {
      checkEmbeddings: false,
    });
    expect(codes(audit(engram))).toContain("WD-QMD-016");
  });

  test("wrong path and missing meta-domain reference are reported", () => {
    const engram = config(fixture(), { checkEmbeddings: false });
    engram.qmd.verticalAccess.collections["child-memory"].path = "/srv/expected";
    const findings = audit(engram, registry(false));
    expect(codes(findings)).toContain("WD-QMD-017");
    expect(codes(findings)).toContain("WD-QMD-018");
  });

  test("missing vectors are reported when explicitly requested", () => {
    const finding = audit(config(fixture(), { checkEmbeddings: true }))
      .find((item) => item.code === "WD-QMD-019");
    expect(finding.details.unembeddedDocuments).toBe(1);
  });

  test("fully embedded collection passes when vector auditing is enabled", () => {
    expect(audit(config(fixture({ embedded: true }), { checkEmbeddings: true }))).toEqual([]);
  });

  test("does not require vectors for read-only vertical access by default", () => {
    expect(audit(config(fixture()))).toEqual([]);
  });

  test("missing SQLite index is informational", () => {
    expect(codes(audit(config("/missing/index.sqlite"))))
      .toContain("WD-QMD-020");
  });
});
