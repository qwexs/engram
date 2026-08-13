#!/usr/bin/env bun
/**
 * Read-only Engram workspace auditor.
 *
 * This module intentionally performs NO writes. It detects configuration and
 * filesystem drift around an Engram workspace and returns a structured report.
 */

import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join, relative, dirname, resolve, isAbsolute, win32 } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { legacyOllAdmissionState, loadEngramConfig } from "../config.js";
import { DEPRECATED_HEARTBEAT_KEYS, LEGACY_OLL_PHASES } from "../../src/oll/legacy-migration.ts";
import { listQmdCollections, readQmdCapabilities } from "./qmd-provision.js";
import { legacyKgMutationState } from "./kg-v3-authority.ts";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = resolve(MODULE_DIR, "..");
const SKILL_DIR = resolve(SCRIPTS_DIR, "..");

const VALID_KG_CATEGORIES = new Set([
  "relationship",
  "milestone",
  "status",
  "preference",
  "context",
  "decision",
  "correction",
]);

const TEST_ARTIFACT_RE = /(^|[\\/]|[-_])(test|tests|fixture|fixtures|dummy|sample)([-_]|$|[\\/])/i;
const TEST_TAGS = new Set(["test", "tests", "fixture", "fixtures", "dummy", "sample"]);

// Patterns that indicate heartbeat extraction garbage in KG
const HB_GARBAGE_RE = /^(hb-rethink-|hb-domains-write-|hb-extract-|hb-synthesis-)/;
const HB_GARBAGE_PHRASES = [
  "No tensions in queue",
  "No tensions to evaluate",
  "No patterns",
  "No new content patterns",
  "No formal pattern",
];
const HB_GARBAGE_TAG_SET = new Set(["heartbeat", "extraction", "daily"]);

export function makeFinding({ code, level = "warn", message, path, fixable = false, details = {} }) {
  return {
    code,
    level,
    message,
    ...(path ? { path } : {}),
    fixable: Boolean(fixable),
    ...(details && Object.keys(details).length ? { details } : {}),
  };
}

function safeJson(file, findings, code, label = file) {
  if (!existsSync(file)) return { ok: false, missing: true, data: null };
  try {
    return { ok: true, missing: false, data: JSON.parse(readFileSync(file, "utf-8")) };
  } catch (e) {
    findings.push(makeFinding({
      code,
      level: "error",
      message: `Invalid JSON: ${e.message}`,
      path: label,
    }));
    return { ok: false, missing: false, data: null };
  }
}

function rel(workspace, path) {
  return relative(workspace, path).replace(/\\/g, "/") || ".";
}

function isDir(path) {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

function listDirs(path) {
  if (!isDir(path)) return [];
  return readdirSync(path, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

function walkFiles(dir, filename, out = []) {
  if (!isDir(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, filename, out);
    else if (entry.name === filename) out.push(full);
  }
  return out;
}

function getAgentId(workspace) {
  const cfg = loadEngramConfig(workspace);
  return String(cfg.agent || "agent-main").replace(/^agent-/, "") || "main";
}

// Non-QMD watchdog checks remain synchronous. QMD diagnostics are routed via
// the typed core below, never through this generic process helper.
function runCommand(command, args, cwd, timeout = 30000) {
  const r = spawnSync(command, args, {
    cwd,
    encoding: "utf-8",
    timeout,
    env: process.env,
  });
  return {
    status: r.status ?? (r.error ? 127 : 0),
    stdout: r.stdout || "",
    stderr: r.stderr || "",
    error: r.error || null,
  };
}

function sessionKeyForTopic(topic) {
  if (!topic?.chatId || topic?.topicId == null) return null;
  const chat = String(topic.chatId).startsWith("-") ? String(topic.chatId).slice(1) : String(topic.chatId);
  return `telegram-group--${chat}-topic-${topic.topicId}`;
}

function collectRegistryQmdRefs(registry) {
  const refs = [];
  for (const [domain, entry] of Object.entries(registry?.domains || {})) {
    for (const collection of entry?.qmdCollections || []) {
      refs.push({ source: "registry", domain, collection: String(collection) });
    }
  }
  return refs;
}

function collectEngramQmdRefs(engram) {
  const refs = [];
  if (engram?.qmd?.collection) {
    refs.push({ source: "engram", domain: null, collection: String(engram.qmd.collection) });
  }
  for (const [domain, entry] of Object.entries(engram?.domains || {})) {
    for (const collection of entry?.qmdCollections || []) {
      refs.push({ source: "engram", domain, collection: String(collection) });
    }
  }
  return refs;
}

export function parseQmdCollections(stdout) {
  const collections = new Map();
  let current = null;
  for (const line of String(stdout || "").split(/\r?\n/)) {
    const name = line.match(/^\s*([A-Za-z0-9][A-Za-z0-9_.:-]*)\s+\(qmd:\/\/[^)]+\/?\)/);
    if (name) {
      current = name[1];
      collections.set(current, { files: null, path: null, pattern: null });
      continue;
    }
    const files = line.match(/^\s*Files:\s*(\d+)\s*$/i);
    if (current && files) {
      collections.set(current, { ...collections.get(current), files: Number(files[1]) });
      continue;
    }
    const path = line.match(/^\s*Path:\s*(.+?)\s*$/i);
    if (current && path) {
      collections.set(current, { ...collections.get(current), path: unquoteYamlScalar(path[1]) });
      continue;
    }
    const pattern = line.match(/^\s*Pattern:\s*(.+?)\s*$/i);
    if (current && pattern) {
      collections.set(current, { ...collections.get(current), pattern: unquoteYamlScalar(pattern[1]) });
    }
  }
  return collections;
}

function parseQmdCollectionList(stdout) {
  return new Set(parseQmdCollections(stdout).keys());
}

function unquoteYamlScalar(value) {
  const text = String(value ?? "").trim();
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1);
  }
  return text;
}

export function parseQmdIndexCollections(text) {
  const collections = new Map();
  const lines = String(text || "").split(/\r?\n/);
  let inCollections = false;
  let current = null;
  for (const line of lines) {
    if (/^collections:\s*$/.test(line)) {
      inCollections = true;
      current = null;
      continue;
    }
    if (!inCollections) continue;
    if (/^[A-Za-z0-9_-]+:\s*$/.test(line)) break;

    const name = line.match(/^  ([A-Za-z0-9][A-Za-z0-9_.:-]*):\s*$/);
    if (name) {
      current = name[1];
      collections.set(current, { path: null, pattern: null });
      continue;
    }
    const kv = line.match(/^    (path|pattern):\s*(.+?)\s*$/);
    if (current && kv) {
      collections.set(current, { ...collections.get(current), [kv[1]]: unquoteYamlScalar(kv[2]) });
    }
  }
  return collections;
}

function normalizePathForCompare(workspace, value) {
  if (!value) return "";
  let text = String(value).replace(/^\\\\\?\\/, "");
  const isWinAbs = /^[A-Za-z]:[\\/]/.test(text);
  if (isWinAbs) {
    text = win32.normalize(text).replace(/\\/g, "/");
  } else if (isAbsolute(text)) {
    text = resolve(text).replace(/\\/g, "/");
  } else {
    text = resolve(workspace, text).replace(/\\/g, "/");
  }
  return process.platform === "win32" || isWinAbs ? text.toLowerCase() : text;
}

function isInsideDir(parent, child) {
  const p = normalizePathForCompare(parent, parent).replace(/\/$/, "");
  const c = normalizePathForCompare(parent, child).replace(/\/$/, "");
  return c === p || c.startsWith(p + "/");
}

function safeReportPath(workspace, value) {
  if (!value) return value;
  const normalized = normalizePathForCompare(workspace, value).replace(/\/$/, "");
  const root = normalizePathForCompare(workspace, workspace).replace(/\/$/, "");
  if (normalized === root) return ".";
  if (normalized.startsWith(root + "/")) return normalized.slice(root.length + 1);
  return "[outside-workspace]";
}

function isRecursiveGlob(pattern) {
  return String(pattern || "").split(/[\\/]+/).includes("**");
}

function expectedDomainCollectionPath(workspace, collection) {
  if (!collection.startsWith("domain-")) return null;
  const slug = collection.slice("domain-".length);
  if (!slug) return null;
  return join(workspace, "memory", "domains", slug);
}

function readQmdIndexCollections(workspace, findings) {
  const indexPath = join(workspace, ".qmd", "index.yml");
  if (!existsSync(indexPath)) return new Map();
  try {
    return parseQmdIndexCollections(readFileSync(indexPath, "utf-8"));
  } catch (e) {
    findings.push(makeFinding({
      code: "WD-QMD-002",
      level: "warn",
      message: `Could not read .qmd/index.yml: ${e.message}`,
      path: ".qmd/index.yml",
    }));
    return new Map();
  }
}

function enrichQmdMetadata(collections, indexCollections) {
  for (const [name, meta] of indexCollections.entries()) {
    if (!collections.has(name)) continue;
    collections.set(name, { ...collections.get(name), ...meta });
  }
}

function checkQmdCollectionSanity(
  workspace,
  collections,
  findings,
  referencedCollections = new Set(),
  allowedExternalCollections = new Set()
) {
  const workspaceRoot = normalizePathForCompare(workspace, workspace).replace(/\/$/, "");
  for (const [name, meta] of collections.entries()) {
    const collectionPath = meta?.path ? normalizePathForCompare(workspace, meta.path).replace(/\/$/, "") : "";
    const pattern = String(meta?.pattern || "");

    const expectedDomainPath = expectedDomainCollectionPath(workspace, name);
    const isExternal = collectionPath && !isInsideDir(workspace, collectionPath);
    const isDeclaredExternal = isExternal && allowedExternalCollections.has(name);

    if (expectedDomainPath && collectionPath && !isDeclaredExternal) {
      const expected = normalizePathForCompare(workspace, expectedDomainPath).replace(/\/$/, "");
      if (collectionPath !== expected) {
        findings.push(makeFinding({
          code: "WD-QMD-010",
          level: "warn",
          message: `Domain QMD collection path mismatch: ${name}`,
          path: ".qmd/index.yml",
          details: {
            collection: name,
            expectedPath: rel(workspace, expectedDomainPath),
            actualPath: safeReportPath(workspace, meta.path),
          },
        }));
      }
    }

    if (collectionPath === workspaceRoot && isRecursiveGlob(pattern)) {
      findings.push(makeFinding({
        code: "WD-QMD-011",
        level: "warn",
        message: `QMD collection indexes the entire workspace recursively: ${name}`,
        path: ".qmd/index.yml",
        details: { collection: name, path: safeReportPath(workspace, meta.path), pattern },
      }));
    }

    if (name.startsWith("domain-") && meta?.files === 0 && !referencedCollections.has(name)) {
      findings.push(makeFinding({
        code: "WD-QMD-012",
        level: "info",
        message: `Domain QMD collection indexes zero files: ${name}`,
        path: ".qmd/index.yml",
        details: { collection: name, path: safeReportPath(workspace, meta.path), pattern, files: 0 },
      }));
    }

    if (isExternal && !isDeclaredExternal) {
      findings.push(makeFinding({
        code: "WD-QMD-013",
        level: "warn",
        message: `QMD collection path is outside the workspace: ${name}`,
        path: ".qmd/index.yml",
        details: { collection: name, path: safeReportPath(workspace, meta.path) },
      }));
    }
  }
}

function runValidate(workspace, findings) {
  const agentId = getAgentId(workspace);
  const script = join(SKILL_DIR, "scripts", "validate.js");
  if (!existsSync(script)) {
    findings.push(makeFinding({
      code: "WD-CORE-001",
      level: "error",
      message: "validate.js not found",
      path: rel(workspace, script),
    }));
    return;
  }

  const r = runCommand("bun", [script, "--agent-id", agentId], workspace, 120000);
  if (r.error) {
    findings.push(makeFinding({
      code: "WD-CORE-001",
      level: "error",
      message: `validate.js failed to start: ${r.error.message}`,
      details: { command: `bun ${script} --agent-id ${agentId}` },
    }));
    return;
  }
  if (r.status !== 0) {
    findings.push(makeFinding({
      code: "WD-CORE-001",
      level: "error",
      message: `validate.js exited with code ${r.status}`,
      details: {
        stdoutTail: r.stdout.split(/\r?\n/).slice(-20).join("\n"),
        stderrTail: r.stderr.split(/\r?\n/).slice(-20).join("\n"),
      },
    }));
  }
}

function parseQmdCapabilities(stdout) {
  try {
    const parsed = JSON.parse(String(stdout || "").trim());
    return parsed?.schema === "qmd.capabilities.v1" ? parsed : null;
  } catch {
    return null;
  }
}

function checkQmd(workspace, registry, engram, findings, options = {}) {
  const refs = [...collectRegistryQmdRefs(registry), ...collectEngramQmdRefs(engram)];
  const uniqueRefs = [...new Map(refs.map((r) => [r.collection, r])).values()];

  const list = options.qmdListStdout != null
    ? { status: 0, stdout: String(options.qmdListStdout), stderr: "", error: null }
    : (() => {
      try {
        const result = listQmdCollections({ workspace, timeoutMs: 30000 });
        return {
          status: result.exitCode ?? (result.spawnError ? 127 : 0),
          stdout: result.stdout,
          stderr: result.stderr,
          error: result.spawnError ? new Error(result.spawnError.message) : null,
        };
      } catch (error) {
        return { status: 127, stdout: "", stderr: "", error: error instanceof Error ? error : new Error(String(error)) };
      }
      })();
  if (list.error || list.status !== 0) {
    findings.push(makeFinding({
      code: "WD-QMD-000",
      level: "warn",
      message: list.error ? "QMD command unavailable" : `QMD collection list failed with code ${list.status}`,
      details: { error: list.error?.message || list.stderr || list.stdout },
    }));
    return;
  }
  const cliCollections = parseQmdCollections(list.stdout);
  const known = new Set(cliCollections.keys());
  const indexCollections = readQmdIndexCollections(workspace, findings);
  const collections = new Map(cliCollections);
  enrichQmdMetadata(collections, indexCollections);
  const maintenanceCollections = Array.isArray(engram?.qmd?.collections)
    ? [...new Set(engram.qmd.collections.map((c) => String(c)).filter(Boolean))]
    : [];
  let qmdCapabilities = null;
  if (maintenanceCollections.length > 1) {
    const capabilities = options.qmdCapabilitiesStdout != null
      ? { status: 0, stdout: String(options.qmdCapabilitiesStdout), stderr: "", error: null }
      : (() => {
        try {
          const result = readQmdCapabilities({ workspace, timeoutMs: 30000 });
          return {
            status: result.exitCode ?? (result.spawnError ? 127 : 0),
            stdout: result.stdout,
            stderr: result.stderr,
            error: result.spawnError ? new Error(result.spawnError.message) : null,
          };
        } catch {
          return { status: 127, stdout: "", stderr: "", error: null };
        }
        })();
    if (!capabilities.error && capabilities.status === 0) {
      qmdCapabilities = parseQmdCapabilities(capabilities.stdout);
    }
  }
  checkQmdEmbedCoverage(engram, findings, qmdCapabilities);
  const referencedCollections = new Set(uniqueRefs.map((r) => r.collection));
  const allowedExternalCollections = new Set(
    collectMetaDomainCollections(registry, engram).map((r) => r.collection)
  );

  checkQmdCollectionSanity(
    workspace,
    collections,
    findings,
    referencedCollections,
    allowedExternalCollections
  );

  for (const ref of uniqueRefs) {
    if (!known.has(ref.collection)) {
      const candidate = ref.collection.startsWith("domain-") ? null : `domain-${ref.collection}`;
      const candidateExists = candidate ? known.has(candidate) : false;
      findings.push(makeFinding({
        code: candidateExists ? "WD-QMD-004" : "WD-QMD-001",
        level: "error",
        message: candidateExists
          ? `QMD collection reference is missing but canonical domain-prefixed candidate exists: ${ref.collection}`
          : `QMD collection reference is missing: ${ref.collection}`,
        path: ref.source === "registry" ? "memory/domains/registry.json" : "engram.json",
        details: { source: ref.source, domain: ref.domain, collection: ref.collection, ...(candidateExists ? { candidate } : {}) },
      }));
      continue;
    }
    const meta = collections.get(ref.collection);
    if (meta?.files === 0) {
      findings.push(makeFinding({
        code: "WD-QMD-007",
        level: "warn",
        message: `QMD collection reference exists but indexes zero files: ${ref.collection}`,
        path: ref.source === "registry" ? "memory/domains/registry.json" : "engram.json",
        details: { source: ref.source, domain: ref.domain, collection: ref.collection, files: 0 },
      }));
    }
  }

  const domainFolders = listDirs(join(workspace, "memory", "domains"));
  for (const slug of domainFolders) {
    const expected = `domain-${slug}`;
    if (!known.has(expected)) {
      findings.push(makeFinding({
        code: "WD-QMD-005",
        level: "warn",
        message: `Domain folder exists but corresponding QMD collection is missing: ${expected}`,
        path: `memory/domains/${slug}`,
        details: { expectedCollection: expected },
      }));
    }
  }
}

export function checkQmdEmbedCoverage(engram, findings, capabilities = null) {
  const maintenance = Array.isArray(engram?.qmd?.collections)
    ? [...new Set(engram.qmd.collections.map((c) => String(c)).filter(Boolean))]
    : [];
  if (maintenance.length <= 1) return;
  if (capabilities?.embed?.multipleCollections === true) return;

  findings.push(makeFinding({
    code: "WD-QMD-014",
    level: "warn",
    message: "Heartbeat lists multiple qmd embed collections, but the installed QMD does not report multi-collection embed support.",
    path: "engram.json",
    details: {
      embeddedCollection: maintenance[0],
      uncoveredCollections: maintenance.slice(1),
      configuredCollections: maintenance,
      capabilitySchema: capabilities?.schema ?? null,
      multipleCollections: capabilities?.embed?.multipleCollections ?? false,
    },
  }));
}

function collectMetaDomainCollections(registry, engram) {
  const refs = [];
  for (const [domain, entry] of Object.entries(registry?.domains || {})) {
    const isMeta = entry?.type === "meta-domain" || entry?.metaDomain === true;
    if (!isMeta) continue;
    for (const collection of entry?.qmdCollections || []) {
      refs.push({ source: "registry", domain, collection: String(collection) });
    }
  }
  for (const [domain, entry] of Object.entries(engram?.domains || {})) {
    const isMeta = entry?.type === "meta-domain" || entry?.metaDomain === true;
    if (!isMeta) continue;
    for (const collection of entry?.qmdCollections || []) {
      refs.push({ source: "engram", domain, collection: String(collection) });
    }
  }
  return refs;
}

export function normalizeVerticalAccess(engram) {
  const raw = engram?.qmd?.verticalAccess;
  if (raw == null || raw?.enabled === false) {
    return { enabled: false, errors: [], config: null };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      enabled: true,
      errors: ["verticalAccess must be an object"],
      config: null,
    };
  }

  const errors = [];
  const collections = new Map();
  if (!raw.indexPath || typeof raw.indexPath !== "string") {
    errors.push("verticalAccess.indexPath must be an explicit SQLite path");
  }
  if (!raw.collections || typeof raw.collections !== "object" || Array.isArray(raw.collections)) {
    errors.push("verticalAccess.collections must be a non-empty object map");
  } else {
    for (const [name, spec] of Object.entries(raw.collections)) {
      if (!name.trim()) {
        errors.push("collection names must be non-empty");
        continue;
      }
      if (spec != null && (typeof spec !== "object" || Array.isArray(spec))) {
        errors.push(`collections.${name} must be an object`);
        continue;
      }
      collections.set(name, { path: spec?.path ? String(spec.path) : null });
    }
  }
  if (collections.size === 0) {
    errors.push("verticalAccess.collections must contain at least one collection");
  }

  return {
    enabled: true,
    errors,
    config: {
      indexPath: raw.indexPath ? String(raw.indexPath) : null,
      collections,
      requireMetaDomainReference: raw.requireMetaDomainReference !== false,
      // Vertical collections are read/query registrations, not heartbeat
      // maintenance ownership. Vector auditing is opt-in because an upper
      // workspace normally embeds only its own qmd.collections.
      checkEmbeddings: raw.checkEmbeddings === true,
    },
  };
}

export function inspectVerticalIndex(indexPath, expectedNames, checkEmbeddings = true) {
  if (!indexPath || !existsSync(indexPath)) {
    throw new Error("configured QMD SQLite index not found");
  }

  const names = [...new Set(expectedNames.map(String).filter(Boolean))];
  const db = new Database(indexPath, { readonly: true });
  try {
    const registered = new Map();
    for (const row of db.query("SELECT name, path, pattern FROM store_collections").all()) {
      registered.set(String(row.name), {
        path: String(row.path),
        pattern: String(row.pattern || ""),
      });
    }

    const unembedded = new Map(names.map((name) => [name, 0]));
    if (checkEmbeddings && names.length > 0) {
      const placeholders = names.map(() => "?").join(",");
      const rows = db.query(`
        SELECT d.collection AS collection, COUNT(DISTINCT d.hash) AS count
        FROM documents d
        WHERE d.active = 1 AND d.collection IN (${placeholders})
          AND NOT EXISTS (
            SELECT 1 FROM content_vectors cv WHERE cv.hash = d.hash
          )
        GROUP BY d.collection
      `).all(...names);
      for (const row of rows) {
        unembedded.set(String(row.collection), Number(row.count || 0));
      }
    }
    return { registered, unembedded };
  } finally {
    db.close();
  }
}

export function auditVerticalAccess(workspace, registry, engram, findings) {
  const normalized = normalizeVerticalAccess(engram);
  if (!normalized.enabled) return;

  if (normalized.errors.length > 0) {
    findings.push(makeFinding({
      code: "WD-QMD-015",
      level: "warn",
      message: "Invalid optional vertical QMD access contract.",
      path: "engram.json#qmd.verticalAccess",
      details: { errors: normalized.errors },
    }));
    return;
  }

  const cfg = normalized.config;
  let inspected;
  try {
    inspected = inspectVerticalIndex(
      resolve(workspace, cfg.indexPath),
      [...cfg.collections.keys()],
      cfg.checkEmbeddings
    );
  } catch (error) {
    findings.push(makeFinding({
      code: "WD-QMD-020",
      level: "info",
      message: "Vertical QMD SQLite inspection could not be completed read-only.",
      path: "engram.json#qmd.verticalAccess",
      details: {
        error: error?.message || String(error),
        indexPath: cfg.indexPath,
      },
    }));
    return;
  }

  const metaRefs = new Set(
    collectMetaDomainCollections(registry, engram).map((ref) => ref.collection)
  );
  for (const [name, spec] of cfg.collections) {
    const actual = inspected.registered.get(name);
    if (!actual) {
      findings.push(makeFinding({
        code: "WD-QMD-016",
        level: "error",
        message: `Expected vertical QMD collection is missing: ${name}`,
        path: "engram.json#qmd.verticalAccess",
        details: { collection: name },
      }));
      continue;
    }

    if (spec.path) {
      const expectedPath = normalizePathForCompare(workspace, spec.path);
      const actualPath = normalizePathForCompare(workspace, actual.path);
      if (actualPath !== expectedPath) {
        findings.push(makeFinding({
          code: "WD-QMD-017",
          level: "error",
          message: `Vertical QMD collection path mismatch: ${name}`,
          path: "engram.json#qmd.verticalAccess",
          details: { collection: name, expectedPath, actualPath },
        }));
      }
    }

    if (cfg.requireMetaDomainReference && !metaRefs.has(name)) {
      findings.push(makeFinding({
        code: "WD-QMD-018",
        level: "warn",
        message: `Expected vertical collection is not referenced by a meta-domain: ${name}`,
        path: "engram.json#qmd.verticalAccess",
        details: { collection: name },
      }));
    }

    const unembeddedDocuments = inspected.unembedded.get(name) || 0;
    if (cfg.checkEmbeddings && unembeddedDocuments > 0) {
      findings.push(makeFinding({
        code: "WD-QMD-019",
        level: "warn",
        message: `Vertical QMD collection has active documents without vectors: ${name}`,
        path: "engram.json#qmd.verticalAccess",
        details: { collection: name, unembeddedDocuments },
      }));
    }
  }

}

function expectedMaintenanceCollections(workspace, registry, engram, indexCollections = new Map()) {
  const expected = new Set(["openclaw-root", "life"]);
  const primary = engram?.qmd?.collection ? String(engram.qmd.collection) : "";
  if (primary) {
    expected.add(primary);
    if (primary.endsWith("-memory")) expected.add(primary.replace(/-memory$/, "-domains"));
  }
  const workspaceKg = engram?.qmd?.workspaceKgCollection
    ? String(engram.qmd.workspaceKgCollection)
    : "";
  if (workspaceKg) expected.add(workspaceKg);
  for (const [name, meta] of indexCollections.entries()) {
    if (meta?.path && isInsideDir(workspace, meta.path)) expected.add(name);
  }
  for (const slug of listDirs(join(workspace, "memory", "domains"))) {
    expected.add(`domain-${slug}`);
  }
  for (const [slug, entry] of Object.entries(registry?.domains || {})) {
    if (entry?.pending) continue;
    expected.add(`domain-${slug}`);
  }
  return expected;
}

function checkQmdMaintenanceCollections(workspace, registry, engram, findings) {
  const metaRefs = collectMetaDomainCollections(registry, engram);
  if (metaRefs.length === 0) return;

  const maintenance = Array.isArray(engram?.qmd?.collections)
    ? engram.qmd.collections.map((c) => String(c)).filter(Boolean)
    : [];
  if (maintenance.length === 0) {
    findings.push(makeFinding({
      code: "WD-QMD-008",
      level: "warn",
      message: "Workspace has meta-domain vertical QMD access but no qmd.collections maintenance allowlist; heartbeat qmd embed may re-embed child collections.",
      path: "engram.json",
      details: { metaDomains: [...new Set(metaRefs.map((r) => r.domain))].sort() },
    }));
    return;
  }

  const indexCollections = readQmdIndexCollections(workspace, findings);
  const expected = expectedMaintenanceCollections(workspace, registry, engram, indexCollections);
  const metaAccess = new Set(metaRefs.map((r) => r.collection));
  const overreach = maintenance
    .filter((collection) => metaAccess.has(collection) && !expected.has(collection))
    .sort();
  if (overreach.length > 0) {
    findings.push(makeFinding({
      code: "WD-QMD-009",
      level: "warn",
      message: "qmd.collections includes vertical child access collections; upper-level heartbeat may re-embed child workspaces that maintain themselves.",
      path: "engram.json",
      details: { collections: overreach },
    }));
  }
}

function requiredDomainFiles(type) {
  const files = ["README.md", "decisions.md", "status.md", "changelog.md"];
  if (type === "dev-project" || type === "cron-task") files.push("workflow.md");
  if (["topic-thread", "peer-direct", "group-direct", "meta-domain"].includes(type)) files.push("agents.md");
  return files;
}

function sameTopicChat(a, b) {
  const aChat = a?.topic?.chatId == null ? null : String(a.topic.chatId).replace(/^-/, "");
  const bChat = b?.topic?.chatId == null ? null : String(b.topic.chatId).replace(/^-/, "");
  return Boolean(aChat && bChat && aChat === bChat);
}

function hasLikelyDomainAggregate(collections, engram) {
  const set = new Set(collections.map((c) => String(c)));
  if (set.has("domains")) return true;

  const baseCollection = engram?.qmd?.collection ? String(engram.qmd.collection) : "";
  if (baseCollection.endsWith("-memory") && set.has(baseCollection.replace(/-memory$/, "-domains"))) {
    return true;
  }

  // Workspace-specific public installs often name the aggregate collection
  // <workspace>-domains. Treat any listed *-domains collection as covering
  // sibling domain docs; QMD existence is checked separately in checkQmd().
  return [...set].some((c) => c === "domains" || c.endsWith("-domains"));
}

function checkMetaDomainCoverage(registry, engram, findings) {
  const domains = registry?.domains || {};
  for (const [metaSlug, meta] of Object.entries(domains)) {
    const isMeta = meta?.type === "meta-domain" || meta?.metaDomain === true;
    if (!isMeta) continue;

    const collections = Array.isArray(meta?.qmdCollections)
      ? meta.qmdCollections.map((c) => String(c))
      : [];
    const collectionSet = new Set(collections);
    const hasAggregate = hasLikelyDomainAggregate(collections, engram);

    for (const [childSlug, child] of Object.entries(domains)) {
      if (childSlug === metaSlug) continue;
      if (child?.pending) continue;
      if (!["topic-thread", "peer-direct", "group-direct"].includes(child?.type)) continue;

      // For Telegram topic meta-domains, only require siblings in the same chat.
      // For non-topic meta-domains, require all chat-like sibling contours.
      if (meta?.topic && child?.topic && !sameTopicChat(meta, child)) continue;

      const expectedCollection = `domain-${childSlug}`;
      if (collectionSet.has(expectedCollection) || hasAggregate) continue;

      findings.push(makeFinding({
        code: "WD-DOMAIN-006",
        level: "warn",
        message: `Meta-domain search contour does not include child domain collection: ${expectedCollection}`,
        path: `memory/domains/registry.json#${metaSlug}`,
        details: {
          metaDomain: metaSlug,
          childDomain: childSlug,
          expectedCollection,
        },
      }));
    }
  }
}

function checkDomains(workspace, registry, engram, findings) {
  const domainsDir = join(workspace, "memory", "domains");
  const domainFolders = new Set(listDirs(domainsDir));
  const registryDomains = registry?.domains || {};

  for (const [slug, entry] of Object.entries(registryDomains)) {
    const domainDir = join(domainsDir, slug);
    const type = entry?.type || engram?.domains?.[slug]?.type || "dev-project";

    if (!domainFolders.has(slug)) {
      findings.push(makeFinding({
        code: "WD-DOMAIN-001",
        level: "error",
        message: `Registry domain has no folder: ${slug}`,
        path: "memory/domains/registry.json",
        details: { domain: slug },
      }));
      continue;
    }

    if (type === "topic-thread" && !entry?.topic) {
      findings.push(makeFinding({
        code: "WD-DOMAIN-004",
        level: "warn",
        message: `${type} domain has no topic binding`,
        path: `memory/domains/registry.json#${slug}`,
        details: { domain: slug, type },
      }));
    }
    if (type === "meta-domain" && !entry?.topic && !entry?.peer && !entry?.group) {
      findings.push(makeFinding({
        code: "WD-DOMAIN-004",
        level: "warn",
        message: "meta-domain has no chat binding",
        path: `memory/domains/registry.json#${slug}`,
        details: { domain: slug, type },
      }));
    }
    if (type === "peer-direct" && !entry?.peer) {
      findings.push(makeFinding({
        code: "WD-DOMAIN-004",
        level: "warn",
        message: "peer-direct domain has no peer binding",
        path: `memory/domains/registry.json#${slug}`,
      }));
    }
    if (type === "group-direct" && !entry?.group) {
      findings.push(makeFinding({
        code: "WD-DOMAIN-004",
        level: "warn",
        message: "group-direct domain has no group binding",
        path: `memory/domains/registry.json#${slug}`,
      }));
    }
    if (type === "meta-domain" && (!Array.isArray(entry?.qmdCollections) || entry.qmdCollections.length === 0)) {
      findings.push(makeFinding({
        code: "WD-DOMAIN-003",
        level: "warn",
        message: "meta-domain has no qmdCollections",
        path: `memory/domains/registry.json#${slug}`,
      }));
    }

    for (const file of requiredDomainFiles(type)) {
      if (!existsSync(join(domainDir, file))) {
        findings.push(makeFinding({
          code: "WD-DOMAIN-005",
          level: "warn",
          message: `Required domain file missing: ${file}`,
          path: `memory/domains/${slug}/${file}`,
          details: { domain: slug, type },
        }));
      }
    }
  }

  for (const folder of domainFolders) {
    if (!registryDomains[folder]) {
      findings.push(makeFinding({
        code: "WD-DOMAIN-002",
        level: "warn",
        message: `Domain folder has no registry entry: ${folder}`,
        path: `memory/domains/${folder}`,
      }));
    }
  }

  checkMetaDomainCoverage(registry, engram, findings);
}

function checkHeartbeatState(workspace, registry, findings) {
  const agentId = getAgentId(workspace);
  const agentDir = join(workspace, "memory", `agent-${agentId}`);
  const sessionDirs = new Set(listDirs(agentDir));
  const statePath = join(workspace, "memory", "heartbeat-state.json");
  const stateResult = safeJson(statePath, findings, "WD-SESSION-000", "memory/heartbeat-state.json");
  if (!stateResult.ok) {
    if (stateResult.missing) {
      findings.push(makeFinding({
        code: "WD-SESSION-000",
        level: "error",
        message: "heartbeat-state.json is missing",
        path: "memory/heartbeat-state.json",
      }));
    }
    return;
  }

  const state = stateResult.data || {};
  const lastDaily = state.lastDailyNoteCreated && typeof state.lastDailyNoteCreated === "object"
    ? state.lastDailyNoteCreated
    : {};
  const stateSessions = new Set(Object.keys(lastDaily));
  const activeSessions = new Set(Array.isArray(state.activeSessions) ? state.activeSessions : []);

  // Session dirs that are ephemeral by design and should not be tracked
  // in heartbeat-state. Hooks (engram-daily-note, engram-session-start)
  // and heartbeat-runner all skip these, so watchdog should too.
  const EPHEMERAL_SESSION_PATTERNS = [
    /^cron-.+-run-/, // isolated cron run sessions
    /^subagent-/,    // spawned subagent sessions
  ];
  function isEphemeralSession(name) {
    return EPHEMERAL_SESSION_PATTERNS.some((p) => p.test(name));
  }

  for (const session of sessionDirs) {
    if (isEphemeralSession(session)) continue;
    if (!stateSessions.has(session)) {
      findings.push(makeFinding({
        code: "WD-SESSION-001",
        level: "warn",
        message: `Session dir exists but heartbeat-state.lastDailyNoteCreated has no entry: ${session}`,
        path: `memory/agent-${agentId}/${session}`,
      }));
    }
    if (session.startsWith("openai-") && !activeSessions.has(session) && !stateSessions.has(session)) {
      findings.push(makeFinding({
        code: "WD-SESSION-003",
        level: "warn",
        message: `Stale openai session dir outside active heartbeat state: ${session}`,
        path: `memory/agent-${agentId}/${session}`,
      }));
    }
  }

  for (const session of stateSessions) {
    if (!sessionDirs.has(session)) {
      findings.push(makeFinding({
        code: "WD-SESSION-002",
        level: "warn",
        message: `heartbeat-state references missing session dir: ${session}`,
        path: "memory/heartbeat-state.json",
      }));
    }
    const date = String(lastDaily[session] || "");
    if (date && /^\d{4}-\d{2}-\d{2}/.test(date)) {
      const ageDays = Math.floor((Date.now() - Date.parse(date.slice(0, 10) + "T00:00:00Z")) / 86400000);
      if (ageDays > 30) {
        findings.push(makeFinding({
          code: "WD-SESSION-005",
          level: "warn",
          message: `Session in heartbeat-state is older than 30 days: ${session}`,
          path: "memory/heartbeat-state.json",
          details: { session, lastDailyNoteCreated: date, ageDays },
        }));
      }
    }
  }

  // WD-SESSION-006: daily notes consistently empty (only heartbeat reports)
  // Check the most recent 7 daily notes for each active session — if all have
  // 0 events/decisions/learnings, the agent is not recording session activity.
  for (const session of activeSessions) {
    const sessionDir = join(agentDir, session);
    if (!isDir(sessionDir)) continue;
    const notes = readdirSync(sessionDir)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
      .sort()
      .slice(-7);
    if (notes.length < 3) continue; // need at least 3 days to evaluate
    let emptyCount = 0;
    for (const note of notes) {
      const text = readFileSync(join(sessionDir, note), "utf-8");
      // Check if Events/Decisions/Learnings sections have any content
      const eventsMatch = text.match(/## Events\n\n([\s\S]*?)(?:\n## |$)/);
      const decisionsMatch = text.match(/## Decisions\n\n([\s\S]*?)(?:\n## |$)/);
      const learningsMatch = text.match(/## Learnings\n\n([\s\S]*?)(?:\n## |$)/);
      const hasContent = (eventsMatch?.[1]?.trim() || decisionsMatch?.[1]?.trim() || learningsMatch?.[1]?.trim());
      if (!hasContent) emptyCount++;
    }
    if (emptyCount === notes.length) {
      findings.push(makeFinding({
        code: "WD-SESSION-006",
        level: "warn",
        message: `Daily notes for session "${session}" are empty for ${emptyCount} consecutive days — agent is not recording events/decisions/learnings`,
        path: `memory/agent-${agentId}/${session}`,
        details: { session, emptyDays: emptyCount, checkedDays: notes.length },
      }));
    }
  }

  for (const [slug, entry] of Object.entries(registry?.domains || {})) {
    const session = sessionKeyForTopic(entry?.topic);
    if (session && !sessionDirs.has(session) && !stateSessions.has(session)) {
      findings.push(makeFinding({
        code: "WD-SESSION-004",
        level: "info",
        message: `Topic-bound domain has no matching session dir/state yet: ${slug}`,
        path: `memory/domains/registry.json#${slug}`,
        details: { expectedSession: session },
      }));
    }
  }
}

function checkSkillGeneratedArtifacts(findings, options = {}) {
  const skillDir = options.skillDir || SKILL_DIR;
  const checks = [
    { relPath: join("memory", "agent-*"), globPrefix: join(skillDir, "memory"), reason: "agent session memory must not be generated inside the Engram skill repo" },
    { relPath: join("memory", "domains"), requireNonEmpty: true, reason: "domain memory must be generated in the workspace, not into the Engram skill repo" },
    { relPath: join("life", "_derived"), reason: "derived KG exports must be generated in the workspace, not into the Engram skill repo" },
    { relPath: join("ops", "watchdog"), reason: "watchdog reports must be generated in the workspace, not into the Engram skill repo" },
    { relPath: join("workspace", "ops", "watchdog"), reason: "watchdog reports must be generated in the workspace, not into the Engram skill repo" },
  ];

  for (const check of checks) {
    if (check.globPrefix) {
      for (const dir of listDirs(check.globPrefix)) {
        if (!dir.startsWith("agent-")) continue;
        findings.push(makeFinding({
          code: "WD-ARTIFACT-001",
          level: "warn",
          message: `Generated runtime artifact found inside Engram skill repo: memory/${dir}`,
          path: `skill:memory/${dir}`,
          details: { reason: check.reason },
        }));
      }
      continue;
    }
    const full = join(skillDir, check.relPath);
    if (!existsSync(full)) continue;
    if (check.requireNonEmpty && readdirSync(full).length === 0) continue;
    findings.push(makeFinding({
      code: "WD-ARTIFACT-001",
      level: "warn",
      message: `Generated runtime artifact found inside Engram skill repo: ${check.relPath.replace(/\\/g, "/")}`,
      path: `skill:${check.relPath.replace(/\\/g, "/")}`,
      details: { reason: check.reason },
    }));
  }
}

function checkKg(workspace, findings) {
  const files = walkFiles(join(workspace, "life"), "items.json");
  for (const file of files) {
    const label = rel(workspace, file);
    const parsed = safeJson(file, findings, "WD-KG-001", label);
    if (!parsed.ok) continue;

    const data = parsed.data;
    if (Array.isArray(data)) {
      findings.push(makeFinding({
        code: "WD-KG-002",
        level: "error",
        message: "Legacy KG items format: bare array instead of v2 wrapper",
        path: label,
      }));
      continue;
    }
    if (!data || typeof data !== "object" || !Array.isArray(data.facts)) {
      findings.push(makeFinding({
        code: "WD-KG-001",
        level: "error",
        message: "KG items.json must be an object with facts[]",
        path: label,
      }));
      continue;
    }

    data.facts.forEach((fact, index) => {
      const factPath = `${label}#facts[${index}]`;
      if (fact?.title && fact?.content && !fact?.fact) {
        findings.push(makeFinding({
          code: "WD-KG-002",
          level: "error",
          message: "Old seed fields detected (title/content without fact)",
          path: factPath,
        }));
      }
      for (const field of ["fact", "category", "timestamp", "lastAccessed", "accessCount"]) {
        if (fact?.[field] == null) {
          findings.push(makeFinding({
            code: "WD-KG-001",
            level: "error",
            message: `KG fact missing required v2 field: ${field}`,
            path: factPath,
          }));
        }
      }
      if (fact?.category && !VALID_KG_CATEGORIES.has(String(fact.category))) {
        findings.push(makeFinding({
          code: "WD-KG-003",
          level: "warn",
          message: `Non-canonical KG category: ${fact.category}`,
          path: factPath,
        }));
      }
      const tags = Array.isArray(fact?.tags) ? fact.tags.map((t) => String(t).toLowerCase()) : [];
      const hasTestTag = tags.some((tag) => TEST_TAGS.has(tag));
      const text = String(fact?.fact || fact?.content || fact?.description || "");

      // WD-KG-004: test pollution
      if (fact?.status === 'superseded') return;
      if (TEST_ARTIFACT_RE.test(label) || hasTestTag || TEST_ARTIFACT_RE.test(text)) {
        findings.push(makeFinding({
          code: "WD-KG-004",
          level: "warn",
          message: "Likely test pollution in KG",
          path: factPath,
          details: { tags },
        }));
      }

      // WD-KG-005: heartbeat extraction garbage
      if (fact?.status === "active") {
        const factTags = new Set(tags);
        const isHbTagged = factTags.has("heartbeat") && factTags.has("extraction") && factTags.has("daily");
        const isHbRunId = HB_GARBAGE_RE.test(text);
        const isHbPhrase = HB_GARBAGE_PHRASES.some((p) => text.startsWith(p) || text === p);
        if (isHbTagged || isHbRunId || isHbPhrase) {
          findings.push(makeFinding({
            code: "WD-KG-005",
            level: "warn",
            message: "Heartbeat extraction garbage in KG — fact is a heartbeat artifact, not a real memory",
            path: factPath,
            fixable: true,
            details: {
              reason: isHbRunId ? "heartbeat-run-id" : (isHbPhrase ? "heartbeat-phrase" : "heartbeat-tags"),
              text: text.slice(0, 120),
              fix: legacyKgMutationState(workspace).allowed
                ? 'Before KG v3 cutover, create a reviewed replacement through the compatibility writer with --supersedes ' + fact?.id + '; do not mutate the orphan directly.'
                : "Historical v2 archive is immutable after KG v3 cutover; record remediation separately.",
            },
          }));
        }
      }
    });

    // WD-KG-006: entity with all facts superseded
    const activeCount = data.facts.filter((f) => f?.status === "active").length;
    const supersededCount = data.facts.filter((f) => f?.status === "superseded").length;
    if (activeCount === 0 && supersededCount > 0) {
      findings.push(makeFinding({
        code: "WD-KG-006",
        level: "info",
        message: `KG entity has 0 active facts (${supersededCount} superseded) — consider removing the entity or re-seeding`,
        path: label,
        details: { entityId: data.entityId, activeCount, supersededCount },
      }));
    }
  }
}

function checkCronConfig(workspace, engram, findings) {
  if (!engram?.cron?.expectedJobName) {
    findings.push(makeFinding({
      code: "WD-CRON-006",
      level: "warn",
      message: "engram.json has no cron.expectedJobName; cron drift checks are limited/disabled",
      path: "engram.json",
    }));
  }
}

// WD-CRON-007: verify the generated heartbeat payload matches its ownership
// boundary. Clean installs use the deterministic script payload; the old
// message marker is meaningful only for a pre-cutover compatibility job.
function checkCronPayloadVersion(workspace, findings, engram = {}) {
  const result = runCommand("openclaw", ["cron", "list", "--json"], workspace, 30000);
  if (result.status !== 0 || !result.stdout) return;
  let jobs;
  try { jobs = JSON.parse(result.stdout); } catch { return; }
  if (!Array.isArray(jobs)) return;
  const expectedName = engram?.cron?.expectedJobName;
  const candidates = jobs.filter((job) => job?.name && (expectedName ? job.name === expectedName : job.name.includes("Heartbeat")));
  for (const job of candidates) {
    const payload = String(job?.payload?.script ?? job?.payload?.source ?? job?.payload?.message ?? "");
    if (!payload) continue;
    const nightlyOwned = engram?.oll?.scheduleOwner === "nightly";
    if (nightlyOwned) {
      const hasLegacyFlags = ["--spawn-rethink", "--spawn-rethink2", "--spawn-autoresearch", "--recover-stale-oll-locks"].some((flag) => payload.includes(flag));
      if (!payload.includes("Generated by install-deterministic-heartbeat-cron.js") || hasLegacyFlags) {
        findings.push(makeFinding({
          code: "WD-CRON-007",
          level: "warn",
          message: "Heartbeat cron violates the nightly OLL ownership boundary. Re-run: bun skills/engram/scripts/install-deterministic-heartbeat-cron.js --action install",
          path: `cron:${job.name}`,
          fixable: true,
        }));
      }
    } else if (!payload.includes("Forward OLL rethink alerts")) {
      findings.push(makeFinding({
        code: "WD-CRON-007",
        level: "warn",
        message: "Legacy heartbeat cron payload is outdated — missing Step 4 (Forward OLL rethink alerts). Re-run: bun skills/engram/scripts/install-cron.js install",
        path: `cron:${job.name}`,
        fixable: true,
      }));
    }
    return;
  }
}

function checkOllState(workspace, findings, engram = {}) {
  const statePath = join(workspace, "memory", "heartbeat-state.json");
  const stateResult = safeJson(statePath, findings, "WD-SESSION-000", "memory/heartbeat-state.json");
  if (!stateResult.ok || !stateResult.data) return;
  const state = stateResult.data || {};
  const admission = legacyOllAdmissionState(workspace);

  if (admission.enabled) {
    findings.push(makeFinding({
      code: "WD-OLL-010",
      level: "error",
      message: "Legacy heartbeat OLL admission is still enabled; run the reviewed oll-legacy-cutover command before nightly rollout",
      path: "engram.json",
      details: { reason: admission.reason },
    }));
  } else {
    const deprecated = DEPRECATED_HEARTBEAT_KEYS.filter((key) => Object.prototype.hasOwnProperty.call(state, key));
    const legacyRuns = LEGACY_OLL_PHASES.filter((phase) => Object.prototype.hasOwnProperty.call(state.subagentRuns || {}, phase));
    if (deprecated.length > 0 || legacyRuns.length > 0) {
      findings.push(makeFinding({
        code: "WD-OLL-011",
        level: "error",
        message: "Deprecated heartbeat OLL state was reintroduced after cutover",
        path: "memory/heartbeat-state.json",
        details: { deprecatedKeys: deprecated, legacySubagentRuns: legacyRuns },
      }));
    }
    const nightlyStatePath = join(workspace, "memory-state", "oll", "state.json");
    const nightlyState = safeJson(nightlyStatePath, findings, "WD-OLL-012", "memory-state/oll/state.json");
    if (!nightlyState.ok || nightlyState.data?.schema !== "oll-nightly-state.v1") {
      findings.push(makeFinding({
        code: "WD-OLL-012",
        level: "error",
        message: "Nightly OLL workspace state is missing or has the wrong schema",
        path: "memory-state/oll/state.json",
      }));
    } else if (nightlyState.data.nightlyEnabled !== Boolean(engram?.oll?.nightly?.enabled)) {
      findings.push(makeFinding({
        code: "WD-OLL-012",
        level: "error",
        message: "Nightly OLL state/config activation mismatch",
        path: "memory-state/oll/state.json",
        details: { state: nightlyState.data.nightlyEnabled, config: engram?.oll?.nightly?.enabled },
      }));
    }

    const rolloutStatePath = join(workspace, "memory-state", "oll", "rollout.json");
    const rolloutRequired = Boolean(engram?.oll?.nightly?.enabled) || engram?.oll?.adaptation?.mode === "active";
    if (rolloutRequired) {
      const rolloutState = safeJson(rolloutStatePath, findings, "WD-OLL-015", "memory-state/oll/rollout.json");
      const expectedStatus = engram?.oll?.adaptation?.mode === "active" ? "active" : "observe_only_canary";
      if (
        !rolloutState.ok
        || rolloutState.data?.schema !== "oll.workspace-rollout-state.v1"
        || rolloutState.data?.workspaceId !== engram?.workspace?.id
        || rolloutState.data?.status !== expectedStatus
        || rolloutState.data?.targetMode !== engram?.oll?.adaptation?.mode
      ) {
        findings.push(makeFinding({
          code: "WD-OLL-015",
          level: "error",
          message: "Nightly/adaptation activation has no matching verified rollout projection",
          path: "memory-state/oll/rollout.json",
          details: {
            expectedStatus,
            expectedMode: engram?.oll?.adaptation?.mode || null,
            actualStatus: rolloutState.data?.status || null,
            actualMode: rolloutState.data?.targetMode || null,
          },
        }));
      }
    }

    const adaptationRoot = join(workspace, "memory-state", "oll");
    for (const directory of [
      "signals", "rules", "reviews", "operations", "audit",
      "handoffs/incoming", "handoffs/applied", "handoffs/rejected", "apply-journal",
    ]) {
      const path = join(adaptationRoot, directory);
      if (!existsSync(path)) {
        findings.push(makeFinding({
          code: "WD-OLL-014",
          level: "warn",
          message: `Managed adaptation store directory is missing: ${directory}`,
          path: rel(workspace, path),
        }));
        continue;
      }
      try {
        for (const name of readdirSync(path)) {
          const filePath = join(path, name);
          if (!statSync(filePath).isFile()) continue;
          if (!name.endsWith(".json")) {
            findings.push(makeFinding({
              code: "WD-OLL-014",
              level: "error",
              message: "Managed adaptation stores must contain JSON only and remain outside QMD text masks",
              path: rel(workspace, filePath),
            }));
            continue;
          }
          if (!["signals", "rules", "reviews"].includes(directory)) continue;
          const projection = safeJson(filePath, findings, "WD-OLL-014", rel(workspace, filePath));
          if (projection.ok && projection.data?.workspaceId !== engram?.workspace?.id) {
            findings.push(makeFinding({
              code: "WD-OLL-014",
              level: "error",
              message: "Managed adaptation projection belongs to another workspace",
              path: rel(workspace, filePath),
              details: { expected: engram?.workspace?.id, actual: projection.data?.workspaceId || null },
            }));
          }
        }
      } catch { /* read-only best effort */ }
    }
  }

  // Legacy heartbeat OLL diagnostics are meaningful only while that admission
  // path still owns adaptation. After cutover, WD-OLL-013 below reports any
  // active legacy queue or handoff artifact without suggesting legacy repair.
  if (admission.enabled) {
    // Check: rethinkInProgress stuck for > 2 hours (stale lock)
    const rethinkStaleHours = 2;
    if (state.rethinkInProgress && state.rethinkStartedAt) {
    const ageHours = (Date.now() - Date.parse(state.rethinkStartedAt)) / 3600000;
    if (ageHours > rethinkStaleHours) {
      findings.push(makeFinding({
        code: "WD-OLL-001",
        level: "error",
        message: `rethinkInProgress has been stuck for ${ageHours.toFixed(1)}h (threshold ${rethinkStaleHours}h). Stale lock — hb-rethink will re-fire every tick. Run: bun skills/engram/scripts/heartbeat-state.js --set rethinkInProgress false --set rethinkStartedAt null`,
        path: "memory/heartbeat-state.json",
        fixable: true,
        details: { startedAt: state.rethinkStartedAt, ageHours: Math.round(ageHours * 10) / 10 },
      }));
    }
    }

  // Check: lastRethink is null but rethinkCount > 0 (handoff never applied)
    if (!state.lastRethink && (state.rethinkCount || 0) > 0) {
    findings.push(makeFinding({
      code: "WD-OLL-002",
      level: "warn",
      message: `rethinkCount is ${state.rethinkCount} but lastRethink is null — rethink handoffs were never applied. Check that HB-RETHINK.md has Step 7 (Persist handoff to disk) and handoff/ folder is not empty.`,
      path: "memory/heartbeat-state.json",
    }));
    }

  // Check: lastRethink is null AND rethinkInProgress is false —
  // rethink time-gate alone needs daysSinceRethink>=7d plus recent weekly synthesis;
  // without lastRethink, daysSinceRethink is 999 so the 7d floor is satisfied once synthesis is recent
    if (!state.lastRethink && !state.rethinkInProgress && (state.rethinkCount || 0) === 0) {
    // This is normal for a fresh install, but only if subagentRuns.hb-rethink doesn't show prior spawns
    const rethinkRuns = state.subagentRuns?.["hb-rethink"];
    if (rethinkRuns && rethinkRuns.status === "ok") {
      findings.push(makeFinding({
        code: "WD-OLL-003",
        level: "warn",
        message: "lastRethink is null but hb-rethink has status=ok — handoff was not applied. Check handoff/ dir and applyRethinkHandoffs() in heartbeat-runner.js.",
        path: "memory/heartbeat-state.json",
      }));
    }
    }

  // Check: rethink2InProgress stuck
    if (state.rethink2InProgress && state.rethink2StartedAt) {
    const ageHours = (Date.now() - Date.parse(state.rethink2StartedAt)) / 3600000;
    if (ageHours > rethinkStaleHours) {
      findings.push(makeFinding({
        code: "WD-OLL-004",
        level: "error",
        message: `rethink2InProgress has been stuck for ${ageHours.toFixed(1)}h. Stale lock — run: bun skills/engram/scripts/heartbeat-state.js --set rethink2InProgress false --set rethink2StartedAt null`,
        path: "memory/heartbeat-state.json",
        fixable: true,
        details: { startedAt: state.rethink2StartedAt, ageHours: Math.round(ageHours * 10) / 10 },
      }));
    }
    }

  // Check: autoresearchInProgress stuck (TTL is 30 min by default)
    if (state.autoresearchInProgress && state.autoresearchStartedAt) {
    const ageHours = (Date.now() - Date.parse(state.autoresearchStartedAt)) / 3600000;
    if (ageHours > 2) {
      findings.push(makeFinding({
        code: "WD-OLL-005",
        level: "error",
        message: `autoresearchInProgress has been stuck for ${ageHours.toFixed(1)}h. Stale lock — run: bun skills/engram/scripts/heartbeat-state.js --set autoresearchInProgress false --set autoresearchStartedAt null`,
        path: "memory/heartbeat-state.json",
        fixable: true,
        details: { startedAt: state.autoresearchStartedAt, ageHours: Math.round(ageHours * 10) / 10 },
      }));
    }
    }
  }

  // Check: spawn queue has stuck "queued" files older than 1 hour
  const spawnsDir = join(workspace, "workspace", "ops", "heartbeat-spawns");
  if (existsSync(spawnsDir)) {
    try {
      for (const file of readdirSync(spawnsDir)) {
        if (!file.endsWith(".json")) continue;
        const filePath = join(spawnsDir, file);
        const parsed = safeJson(filePath, [], `WD-OLL-006`, rel(workspace, filePath));
        if (!parsed.ok || !parsed.data) continue;
        const status = parsed.data.status;
        if (!admission.enabled && LEGACY_OLL_PHASES.includes(parsed.data.phase) && ["queued", "spawned", "running"].includes(status)) {
          findings.push(makeFinding({
            code: "WD-OLL-013",
            level: "error",
            message: `Active legacy OLL queue record remains after cutover: ${file}`,
            path: rel(workspace, filePath),
            details: { phase: parsed.data.phase, status },
          }));
        }
        const createdAt = parsed.data.createdAt;
        if (status === "queued" && createdAt) {
          const ageMin = (Date.now() - Date.parse(createdAt)) / 60000;
          if (ageMin > 60) {
            findings.push(makeFinding({
              code: "WD-OLL-006",
              level: "warn",
              message: `Spawn queue file stuck in "queued" state for ${ageMin.toFixed(0)} min: ${file}`,
              path: rel(workspace, filePath),
              fixable: true,
              details: { file, status, createdAt, ageMin: Math.round(ageMin) },
            }));
          }
        }
      }
    } catch { /* ignore */ }
  }

  // Check: handoff/ dir has files but applyRethinkHandoffs never processes them
  const handoffDir = join(workspace, "workspace", "ops", "heartbeat-spawns", "handoff");
  if (existsSync(handoffDir)) {
    try {
      const handoffFiles = readdirSync(handoffDir).filter((f) => f.endsWith(".md"));
      if (!admission.enabled) {
        for (const file of handoffFiles) {
          const text = readFileSync(join(handoffDir, file), "utf8");
          if (/=== HB-(RETHINK2?|AUTORESEARCH) HANDOFF ===/.test(text)) {
            findings.push(makeFinding({
              code: "WD-OLL-013",
              level: "error",
              message: `Legacy OLL handoff remains in the active handoff directory: ${file}`,
              path: rel(workspace, join(handoffDir, file)),
            }));
          }
        }
      }
      if (admission.enabled && handoffFiles.length > 5) {
        findings.push(makeFinding({
          code: "WD-OLL-007",
          level: "warn",
          message: `${handoffFiles.length} unprocessed handoff files in handoff/ — applyRethinkHandoffs() may not be running or failing. Check heartbeat-runner.js Phase 5 apply step.`,
          path: rel(workspace, handoffDir),
          details: { count: handoffFiles.length },
        }));
      }
    } catch { /* ignore */ }
  }

  // WD-OLL-008: legacy observations pipeline health
  const obsDir = join(workspace, "workspace", "ops", "observations");
  const obsIndex = admission.enabled
    ? safeJson(join(obsDir, "index.json"), [], "WD-OLL-008", "workspace/ops/observations/index.json")
    : { ok: false };
  if (obsIndex.ok && obsIndex.data) {
    const total = obsIndex.data.lastId || 0;
    const pending = (obsIndex.data.observations || []).length;
    const stats = obsIndex.data.stats || {};
    const archived = stats.archived || 0;
    if (total === 0 && (state.rethinkCount || 0) > 0) {
      findings.push(makeFinding({
        code: "WD-OLL-008",
        level: "warn",
        message: `OLL has run rethink ${state.rethinkCount || 0} time(s) but no observations exist. Pipeline is on idle — agent should write observations via memory-observe.js.`,
        path: "workspace/ops/observations/index.json",
        fixable: false,
      }));
    }
    if (total > 0 && pending === 0 && archived >= total) {
      findings.push(makeFinding({
        code: "WD-OLL-008",
        level: "info",
        message: `All ${total} observations archived — pipeline has no active signal. Normal after rethink cleanup, but if persistent, agent is not capturing friction.`,
        path: "workspace/ops/observations/index.json",
      }));
    }
  }

  // WD-OLL-009: unapplied human-review proposals in recent rethink handoffs
  const doneDir = join(workspace, "workspace", "ops", "heartbeat-spawns", "done");
  if (admission.enabled && existsSync(doneDir)) {
    try {
      const rethinkFiles = readdirSync(doneDir)
        .filter((f) => f.includes("hb-rethink") && f.endsWith(".md"))
        .sort()
        .reverse()
        .slice(0, 3);
      for (const file of rethinkFiles) {
        const text = readFileSync(join(doneDir, file), "utf8");
        if (/\[PROPOSAL:human-review\]/i.test(text)) {
          findings.push(makeFinding({
            code: "WD-OLL-009",
            level: "info",
            message: `Rethink handoff ${file} has human-review proposals. Review and implement or dismiss — audit trail records them but does not auto-edit source files.`,
            path: rel(workspace, join(doneDir, file)),
            fixable: false,
          }));
          break;
        }
      }
    } catch { /* ignore */ }
  }
}

function discoverRuntimeHooksDir(workspace, options = {}) {
  if (options.hooksDir) return resolve(String(options.hooksDir));
  const openclaw = runCommand("openclaw", ["hooks", "list", "--json"], workspace, 30000);
  if (openclaw.status === 0 && openclaw.stdout) {
    try {
      const data = JSON.parse(openclaw.stdout);
      if (typeof data?.managedHooksDir === "string" && data.managedHooksDir) return data.managedHooksDir;
      if (typeof data?.workspaceDir === "string" && data.workspaceDir) return join(data.workspaceDir, "hooks");
    } catch {}
  }
  const stateDir = process.env.OPENCLAW_STATE_DIR
    || (process.env.OPENCLAW_CONFIG_PATH ? dirname(process.env.OPENCLAW_CONFIG_PATH) : null)
    || join(process.env.HOME || process.env.USERPROFILE || "", ".openclaw");
  return stateDir ? join(stateDir, "hooks") : null;
}

function checkHooks(workspace, findings, options = {}) {
  const sourceHooksDir = join(SKILL_DIR, "hooks");
  if (!isDir(sourceHooksDir)) {
    findings.push(makeFinding({
      code: "WD-HOOK-000",
      level: "info",
      message: "Engram source hooks directory is missing; hook drift check skipped",
      path: rel(workspace, sourceHooksDir),
    }));
    return;
  }

  const runtimeHooksDir = discoverRuntimeHooksDir(workspace, options);
  if (!runtimeHooksDir || !isDir(runtimeHooksDir)) {
    findings.push(makeFinding({
      code: "WD-HOOK-000",
      level: "info",
      message: "OpenClaw runtime hooks directory was not found; hook drift check skipped",
      details: runtimeHooksDir ? { runtimeHooksDir } : {},
    }));
    return;
  }

  for (const name of listDirs(sourceHooksDir).filter((n) => n.startsWith("engram-"))) {
    const sourceHandler = join(sourceHooksDir, name, "handler.ts");
    const runtimeDir = join(runtimeHooksDir, name);
    const runtimeHandler = join(runtimeDir, "handler.js");
    const runtimeHookMd = join(runtimeDir, "HOOK.md");
    if (!existsSync(runtimeDir) || !existsSync(runtimeHandler)) {
      findings.push(makeFinding({
        code: "WD-HOOK-001",
        level: "warn",
        message: `Engram runtime hook is missing or not built: ${name}`,
        path: runtimeDir,
        details: { sourceHook: sourceHandler, runtimeHooksDir },
      }));
      continue;
    }
    try {
      const sourceMtime = statSync(sourceHandler).mtimeMs;
      const runtimeMtime = statSync(runtimeHandler).mtimeMs;
      if (runtimeMtime + 1000 < sourceMtime) {
        findings.push(makeFinding({
          code: "WD-HOOK-002",
          level: "warn",
          message: `Engram runtime hook appears older than source; reinstall hooks: ${name}`,
          path: runtimeHandler,
          details: { sourceHook: sourceHandler, runtimeHooksDir },
        }));
      }
    } catch {}
    if (!existsSync(runtimeHookMd)) {
      findings.push(makeFinding({
        code: "WD-HOOK-003",
        level: "warn",
        message: `Engram runtime hook is missing HOOK.md: ${name}`,
        path: runtimeHookMd,
        details: { runtimeHooksDir },
      }));
    }
  }
}

/**
 * Load OpenClaw platform config (openclaw.json).
 * Returns { agents, groups } or null if unavailable.
 */
function loadOpenclawConfig() {
  const stateDir = process.env.OPENCLAW_STATE_DIR
    || (process.env.OPENCLAW_CONFIG_PATH ? dirname(process.env.OPENCLAW_CONFIG_PATH) : null)
    || join(process.env.HOME || process.env.USERPROFILE || "", ".openclaw");
  const configPath = join(stateDir, "openclaw.json");
  if (!existsSync(configPath)) return null;
  try {
    const raw = JSON.parse(readFileSync(configPath, "utf-8"));
    const defaultsWorkspace = raw?.agents?.defaults?.workspace ? String(raw.agents.defaults.workspace) : null;
    const agents = (raw?.agents?.list || []).map((a) => ({
      id: String(a?.id || ""),
      workspace: a?.workspace ? String(a.workspace) : null,
    }));
    const groups = raw?.channels?.telegram?.groups || {};
    return { agents, groups, configPath, defaultsWorkspace };
  } catch {
    return null;
  }
}

/**
 * Scan session trajectory files of all agents to find actual group+topic → agent mappings.
 * Session files are named by UUID, but the sessionKey (containing group+topic)
 * is stored in the first line of *.trajectory.jsonl.
 * Returns Map of "groupId:topicId" → Set of agentIds that handled sessions there.
 */
function scanSessionRouting(agents) {
  const stateDir = process.env.OPENCLAW_STATE_DIR
    || (process.env.OPENCLAW_CONFIG_PATH ? dirname(process.env.OPENCLAW_CONFIG_PATH) : null)
    || join(process.env.HOME || process.env.USERPROFILE || "", ".openclaw");
  const agentsDir = join(stateDir, "agents");
  const routing = new Map(); // "groupId:topicId" → Set<agentId>
  const ROUTE_RE = /^agent:([a-zA-Z0-9_-]+):telegram:group:(-?\d+):topic:(\d+)$/;

  for (const agent of agents) {
    const agentSessionsDir = join(agentsDir, agent.id, "sessions");
    if (!isDir(agentSessionsDir)) continue;
    for (const file of readdirSync(agentSessionsDir)) {
      if (!file.endsWith(".trajectory.jsonl")) continue;
      const filePath = join(agentSessionsDir, file);
      try {
        // Only read first line — session.started event has sessionKey
        const fd = readFileSync(filePath, { encoding: "utf-8", flag: "r" });
        const firstLine = fd.split(/\r?\n/, 1)[0];
        if (!firstLine) continue;
        const parsed = JSON.parse(firstLine);
        const sessionKey = parsed?.sessionKey;
        if (!sessionKey) continue;
        const m = sessionKey.match(ROUTE_RE);
        if (!m) continue;
        const agentId = m[1];
        const groupId = m[2];
        const topicId = m[3];
        const key = `${groupId}:${topicId}`;
        if (!routing.has(key)) routing.set(key, new Set());
        routing.get(key).add(agentId);
      } catch { /* skip unreadable files */ }
    }
  }

  return routing;
}

/**
 * WD-ROUTE: Check Telegram topic routing — detect topics that landed on the
 * wrong agent (or on main as fallback) because they were missing from the
 * channel config.
 *
 * Runs once from the platform-default workspace (agents.defaults.workspace)
 * to avoid duplicating global findings across per-workspace audits.
 * Read-only: scans session transcripts and compares with channel config.
 */
function checkTelegramRouting(workspace, findings, options = {}) {
  if (options.routing === false) return;

  const openclawCfg = loadOpenclawConfig();
  if (!openclawCfg) {
    findings.push(makeFinding({
      code: "WD-ROUTE-000",
      level: "info",
      message: "openclaw.json not found; Telegram routing check skipped",
      path: "openclaw.json",
    }));
    return;
  }

  // Only run from the platform-default workspace to avoid duplicate findings
  const defaultWorkspace = openclawCfg.defaultsWorkspace;
  if (!defaultWorkspace || resolve(workspace) !== resolve(defaultWorkspace)) return;

  const { agents, groups } = openclawCfg;
  const agentIds = new Set(agents.map((a) => a.id));

  // Build expected routing from config: "groupId:topicId" → agentId
  const expected = new Map(); // "groupId:topicId" → agentId
  const groupHasTopics = new Map(); // groupId → boolean (has explicit topic config)

  for (const [groupId, groupCfg] of Object.entries(groups)) {
    const topics = groupCfg?.topics || {};
    groupHasTopics.set(groupId, Object.keys(topics).length > 0);
    for (const [topicId, topicCfg] of Object.entries(topics)) {
      const key = `${groupId}:${topicId}`;
      const assignedAgent = topicCfg?.agentId ? String(topicCfg.agentId) : null;
      if (assignedAgent) {
        expected.set(key, assignedAgent);
      }
    }
  }

  // Scan actual session transcripts across all agents
  const actual = scanSessionRouting(agents);

  // Compare actual vs expected
  for (const [key, actualAgents] of actual) {
    const [groupId, topicId] = key.split(":");
    const expectedAgent = expected.get(key);
    const groupCfg = groups[groupId];
    const isKnownGroup = Boolean(groupCfg);

    for (const actualAgent of actualAgents) {
      // Skip legacy/test sessions
      if (actualAgent === "zu") continue;

      if (!isKnownGroup) {
        // WD-ROUTE-003: messages from a group not in config at all
        findings.push(makeFinding({
          code: "WD-ROUTE-003",
          level: "warn",
          message: `Session exists for group ${groupId} topic ${topicId} on agent "${actualAgent}", but group is not in channels.telegram.groups config`,
          path: `agent:${actualAgent}:sessions`,
          details: { groupId, topicId, actualAgent, expectedAgent: null },
        }));
        continue;
      }

      if (!groupHasTopics.get(groupId)) {
        // Group has no topic-level config — all topics go to the group's default agent.
        // This is fine if the group is not a forum, but worth noting for forums.
        // We skip this: non-forum groups or groups where all topics go to one agent.
        continue;
      }

      if (!expectedAgent) {
        // WD-ROUTE-001: topic is active but not in config → fell back to main
        findings.push(makeFinding({
          code: "WD-ROUTE-001",
          level: "error",
          message: `Topic ${topicId} in group ${groupId} has sessions on agent "${actualAgent}" but is not configured in channels.telegram.groups — messages fall back to default agent instead of the intended project agent`,
          path: `channels.telegram.groups["${groupId}"].topics["${topicId}"]`,
          fixable: true,
          details: {
            groupId,
            topicId,
            actualAgent,
            expectedAgent: null,
            fix: `Add topic "${topicId}" with the correct agentId to group ${groupId} in openclaw.json`,
          },
        }));
        continue;
      }

      if (expectedAgent !== actualAgent) {
        // WD-ROUTE-002: topic configured for agent A but sessions exist on agent B
        findings.push(makeFinding({
          code: "WD-ROUTE-002",
          level: "error",
          message: `Topic ${topicId} in group ${groupId} is configured for agent "${expectedAgent}" but sessions found on agent "${actualAgent}" — routing conflict or stale sessions from before config change`,
          path: `channels.telegram.groups["${groupId}"].topics["${topicId}"]`,
          details: {
            groupId,
            topicId,
            actualAgent,
            expectedAgent,
          },
        }));
      }
    }
  }

  // WD-ROUTE-004: configured topic has no sessions at all (info, not error)
  for (const [key, expectedAgent] of expected) {
    if (!actual.has(key)) {
      const [groupId, topicId] = key.split(":");
      findings.push(makeFinding({
        code: "WD-ROUTE-004",
        level: "info",
        message: `Topic ${topicId} in group ${groupId} is configured for agent "${expectedAgent}" but has no sessions yet`,
        path: `channels.telegram.groups["${groupId}"].topics["${topicId}"]`,
        details: { groupId, topicId, expectedAgent },
      }));
    }
  }
}

export function auditWorkspace(workspaceInput, options = {}) {
  const workspace = resolve(String(workspaceInput || process.cwd()));
  const findings = [];

  if (!existsSync(workspace) || !isDir(workspace)) {
    findings.push(makeFinding({
      code: "WD-ARGS-001",
      level: "error",
      message: `Workspace does not exist or is not a directory: ${workspace}`,
    }));
    return finalizeReport(workspace, findings, options);
  }

  const engramPath = join(workspace, "engram.json");
  const engramResult = safeJson(engramPath, findings, "WD-CONFIG-001", "engram.json");
  const engram = engramResult.ok ? engramResult.data : {};

  const registryPath = join(workspace, "memory", "domains", "registry.json");
  const registryResult = safeJson(registryPath, findings, "WD-DOMAIN-000", "memory/domains/registry.json");
  const registry = registryResult.ok ? registryResult.data : { domains: {} };
  if (!registryResult.ok && registryResult.missing) {
    findings.push(makeFinding({
      code: "WD-DOMAIN-000",
      level: "warn",
      message: "Domain registry missing; domain drift checks are limited",
      path: "memory/domains/registry.json",
    }));
  }
  if (registryResult.ok && (typeof registry.domains !== "object" || registry.domains === null || Array.isArray(registry.domains))) {
    findings.push(makeFinding({
      code: "WD-DOMAIN-000",
      level: "error",
      message: "registry.domains must be an object",
      path: "memory/domains/registry.json",
    }));
  }

  if (options.core !== false) runValidate(workspace, findings);
  if (registry?.domains && typeof registry.domains === "object" && !Array.isArray(registry.domains)) {
    checkDomains(workspace, registry, engram, findings);
    checkHeartbeatState(workspace, registry, findings);
  }
  checkKg(workspace, findings);
  checkOllState(workspace, findings, engram);
  checkSkillGeneratedArtifacts(findings, options);
  if (options.qmd !== false) {
    checkQmd(workspace, registry, engram, findings, options);
    auditVerticalAccess(workspace, registry, engram, findings);
  }
  checkQmdMaintenanceCollections(workspace, registry, engram, findings);
  if (options.hooks !== false) checkHooks(workspace, findings, options);
  checkCronConfig(workspace, engram, findings);
  // Live cron inspection is opt-in at the library boundary. The watchdog CLI
  // enables it explicitly; synthetic callers remain deterministic and do not
  // pay an unrelated OpenClaw subprocess on every workspace assertion.
  if (options.cronPayload === true) {
    checkCronPayloadVersion(workspace, findings, engram);
  }
  checkTelegramRouting(workspace, findings, options);

  return finalizeReport(workspace, findings, options);
}

export function finalizeReport(workspace, findings, options = {}) {
  const deduped = [];
  const seen = new Set();
  for (const finding of findings) {
    const key = JSON.stringify([finding.code, finding.level, finding.message, finding.path || "", finding.details || {}]);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(finding);
  }
  findings = deduped;
  const errors = findings.filter((f) => f.level === "error").length;
  const warnings = findings.filter((f) => f.level === "warn").length;
  const info = findings.filter((f) => f.level === "info").length;
  return {
    schema: "engram.watchdog.v1",
    generatedAt: new Date().toISOString(),
    workspace,
    status: errors > 0 ? "error" : warnings > 0 ? "warn" : "ok",
    summary: {
      errors,
      warnings,
      info,
      findings: findings.length,
      fixed: 0,
      readOnly: true,
    },
    findings,
    ...(options.meta ? { meta: options.meta } : {}),
  };
}

export function mergeReports(reports) {
  const findings = reports.flatMap((r) => r.findings.map((f) => ({ ...f, workspace: r.workspace })));
  const errors = findings.filter((f) => f.level === "error").length;
  const warnings = findings.filter((f) => f.level === "warn").length;
  const info = findings.filter((f) => f.level === "info").length;
  return {
    schema: "engram.watchdog.v1",
    generatedAt: new Date().toISOString(),
    status: errors > 0 ? "error" : warnings > 0 ? "warn" : "ok",
    summary: {
      workspaces: reports.length,
      errors,
      warnings,
      info,
      findings: findings.length,
      fixed: 0,
      readOnly: true,
    },
    reports,
  };
}

export function discoverWorkspaces(workspacesDir) {
  const root = resolve(String(workspacesDir || ""));
  if (!isDir(root)) return [];
  return listDirs(root)
    .map((name) => join(root, name))
    .filter((dir) => existsSync(join(dir, "engram.json")) || existsSync(join(dir, "memory")) || existsSync(join(dir, "life")));
}
