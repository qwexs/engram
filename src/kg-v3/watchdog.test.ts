import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { KG_V3_SCHEMA_DIGEST } from "./core.ts";
import { auditKgV3 } from "./watchdog.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const json = (path: string, value: unknown) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value)); };
const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const digest = `sha256:${"b".repeat(64)}`;
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "kg-watchdog-")); roots.push(root);
  const state = join(root, "memory-state", "kg-v3");
  const store = join(root, "life", "v3");
  const authority = join(state, "authority.json");
  const assertion = read(join(import.meta.dir, "../../tests/fixtures/kg-v3/assertion.valid.json"));
  assertion.object.value = "PRIVATE FACT NEVER IN FINDINGS";
  json(authority, { schema: "engram.kg-v3-authority.v1", workspaceId: "main", releaseDigest: digest, schemaDigest: KG_V3_SCHEMA_DIGEST,
    mode: "canary", enabledSessionCapabilities: [{ sessionKey: "main", capabilities: ["kg:v3:write"] }], currentProjectionVersion: 1, approvedBy: "operator", approvedAt: "2026-08-12T15:00:00Z" });
  json(join(state, "registry.json"), { schema: "engram.kg-v3-registry.v1", workspaceId: "main", revision: 1, entities: [] });
  const assertionPath = join(store, "assertions", `${assertion.id}.json`);
  json(assertionPath, assertion);
  const operationPath = join(state, "operations", `${assertion.provenance.operationId.slice(7)}.json`);
  json(operationPath, { schema: "engram.kg-v3-operation.v1", operationId: assertion.provenance.operationId, payloadDigest: digest,
    workspaceId: "main", entityId: assertion.entityId, action: "write", actionProvenance: assertion.provenance,
    status: "committed", assertionId: assertion.id, assertionAfter: assertion, previousId: null, previousAfter: null,
    receipt: { schema: "engram.kg-v3-receipt.v1", operationId: assertion.provenance.operationId, payloadDigest: digest, assertionId: assertion.id, status: "committed", reason: null, committedAt: assertion.createdAt },
    projectionCommitted: true, qmdDirty: { status: "disabled", generation: null, collections: [], error: null } });
  writeFileSync(join(store, "current-summary.md"), "# Fixture current\n");
  writeFileSync(join(store, "search-index.md"), "# Fixture search\n");
  return { root, state, store, authority, assertionPath, operationPath };
}
function snapshot(root: string): string {
  const hash = createHash("sha256");
  function visit(path: string) {
    for (const name of readdirSync(path).sort()) {
      const file = join(path, name); hash.update(file);
      if (statSync(file).isDirectory()) visit(file); else hash.update(readFileSync(file));
    }
  }
  visit(root); return hash.digest("hex");
}
const audit = (root: string) => auditKgV3({ workspace: root, workspaceId: "main", now: new Date("2026-09-08T00:00:00Z") });
const defects = (root: string) => audit(root).filter((f) => f.level !== "info");

test("healthy read-only v3 rollout is not required to have live ingress; archive is untouched", () => {
  const f = fixture();
  json(join(f.root, "life", "legacy", "items.json"), { garbage: "not current authority" });
  const before = snapshot(f.root);
  expect(defects(f.root)).toEqual([]);
  expect(audit(f.root).find((v) => v.code === "WD-KGV3-013")?.details).toMatchObject({ assertions: 1, operations: 1, complete: true });
  expect(snapshot(f.root)).toBe(before);
});

test("state with missing or malformed authority fails closed; no initialization", () => {
  const f = fixture(); rmSync(f.authority);
  const before = snapshot(f.root);
  expect(defects(f.root).map((v) => v.code)).toContain("WD-KGV3-001");
  expect(snapshot(f.root)).toBe(before);
  writeFileSync(f.authority, "{bad PRIVATE FACT NEVER IN FINDINGS");
  expect(JSON.stringify(audit(f.root))).not.toContain("PRIVATE FACT");
  expect(defects(f.root).map((v) => v.code)).toContain("WD-KGV3-001");
});

test("explicit expected v3 activation detects a completely missing tree", () => {
  const f = fixture(); rmSync(f.state, { recursive: true }); rmSync(f.store, { recursive: true });
  expect(audit(f.root)).toEqual([]);
  expect(auditKgV3({ workspace: f.root, workspaceId: "main", expectActive: true }).some((v) => v.code === "WD-KGV3-001")).toBe(true);
});

test("enabled ingress uses canonical validator and distinguishes unverified loaded digest", () => {
  const f = fixture(); const ingress = join(f.state, "live-ingress.json");
  json(ingress, { schema: "engram.kg-v3-live-ingress.v1", workspaceId: "main", releaseDigest: digest, pluginDigest: digest,
    mode: "canary", enabled: true, grantSessionKey: "main", allowedContextKinds: ["direct"], requireOwner: true, approvedBy: "operator", approvedAt: "2026-08-12T15:00:00Z" });
  expect(defects(f.root)).toEqual([]);
  expect(audit(f.root).some((v) => v.code === "WD-KGV3-003")).toBe(true);
  expect(auditKgV3({ workspace: f.root, workspaceId: "main", expectedPluginDigest: `sha256:${"c".repeat(64)}` }).some((v) => v.code === "WD-KGV3-002" && v.level === "error")).toBe(true);
  rmSync(ingress);
  expect(auditKgV3({ workspace: f.root, workspaceId: "main", expectLiveIngress: true }).some((v) => v.code === "WD-KGV3-002" && v.level === "error")).toBe(true);
});

test("journal receipt mismatch and corrupt assertions are surfaced without fact contents", () => {
  const f = fixture(); const record = read(f.operationPath); record.receipt.payloadDigest = `sha256:${"c".repeat(64)}`; json(f.operationPath, record);
  const assertion = read(f.assertionPath); assertion.workspaceId = "other"; json(f.assertionPath, assertion);
  expect(defects(f.root).map((v) => v.code)).toEqual(expect.arrayContaining(["WD-KGV3-007", "WD-KGV3-008"]));
  expect(JSON.stringify(audit(f.root))).not.toContain("PRIVATE FACT");
});

test("nonterminal WAL is reported but never recovered; unresolved dirty publication stays independent", () => {
  const f = fixture(); const record = read(f.operationPath);
  record.status = "prepared"; record.receipt = null; record.projectionCommitted = false;
  json(f.operationPath, record); const before = snapshot(f.root);
  expect(defects(f.root).some((v) => v.code === "WD-KGV3-011")).toBe(true);
  expect(snapshot(f.root)).toBe(before);
  record.status = "committed"; record.receipt = { operationId: record.operationId, payloadDigest: record.payloadDigest, assertionId: record.assertionId, status: "committed" };
  record.qmdDirty.status = "error"; json(f.operationPath, record);
  expect(defects(f.root).some((v) => v.code === "WD-KGV3-010")).toBe(true);
});

test("committed missing assertion, missing derived projection and invalid access state are visible", () => {
  const f = fixture(); rmSync(join(f.store, "current-summary.md"));
  json(join(f.state, "access", "state.json"), { schema: "wrong" });
  expect(defects(f.root).map((v) => v.code)).toEqual(expect.arrayContaining(["WD-KGV3-005", "WD-KGV3-012"]));
  rmSync(f.assertionPath);
  expect(defects(f.root).some((v) => v.code === "WD-KGV3-009")).toBe(true);
});

test("bounded partial scan is explicit and suppresses unproven missing-journal joins", () => {
  const f = fixture(); json(join(f.state, "operations", `${"f".repeat(64)}.json`), {});
  const findings = auditKgV3({ workspace: f.root, workspaceId: "main", maxFiles: 1 });
  expect(findings.some((v) => v.code === "WD-KGV3-006")).toBe(true);
  expect(findings.find((v) => v.code === "WD-KGV3-013")?.details?.complete).toBe(false);
});

test("fresh pending journal is informational and intentionally disabled ingress is not a fault", () => {
  const f = fixture(); const record = read(f.operationPath);
  record.status = "prepared"; record.receipt = null;
  json(f.operationPath, record);
  json(join(f.state, "live-ingress.json"), { schema: "engram.kg-v3-live-ingress.v1", workspaceId: "main", enabled: false });
  const findings = auditKgV3({ workspace: f.root, workspaceId: "main", now: new Date(record.actionProvenance.observedAt) });
  expect(findings.find((v) => v.code === "WD-KGV3-011")?.level).toBe("info");
  expect(findings.find((v) => v.code === "WD-KGV3-002")?.level).toBe("info");
  expect(auditKgV3({ workspace: f.root, workspaceId: "main", expectLiveIngress: true }).find((v) => v.code === "WD-KGV3-002")?.level).toBe("error");
});
