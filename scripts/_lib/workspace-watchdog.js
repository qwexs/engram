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
import { join, relative, dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadEngramConfig, resolveQmdCommand } from "../config.js";

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

function parseQmdCollectionList(stdout) {
  const names = new Set();
  for (const line of stdout.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_.-]+) \(qmd:\/\//);
    if (m) names.add(m[1]);
  }
  return names;
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

function checkQmd(workspace, registry, engram, findings) {
  const qmd = resolveQmdCommand(workspace);
  const refs = [...collectRegistryQmdRefs(registry), ...collectEngramQmdRefs(engram)];
  const uniqueRefs = [...new Map(refs.map((r) => [r.collection, r])).values()];

  if (uniqueRefs.length === 0) return;

  const list = runCommand(qmd, ["collection", "list"], workspace, 30000);
  if (list.error || list.status !== 0) {
    findings.push(makeFinding({
      code: "WD-QMD-000",
      level: "warn",
      message: list.error ? `QMD command unavailable: ${qmd}` : `QMD collection list failed with code ${list.status}`,
      details: { error: list.error?.message || list.stderr || list.stdout },
    }));
    return;
  }
  const known = parseQmdCollectionList(list.stdout);

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

    if ((type === "topic-thread" || type === "meta-domain") && !entry?.topic) {
      findings.push(makeFinding({
        code: "WD-DOMAIN-004",
        level: "warn",
        message: `${type} domain has no topic binding`,
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
      if (TEST_ARTIFACT_RE.test(label) || hasTestTag || TEST_ARTIFACT_RE.test(text)) {
        findings.push(makeFinding({
          code: "WD-KG-004",
          level: "warn",
          message: "Likely test pollution in KG",
          path: factPath,
          details: { tags },
        }));
      }
    });
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
  if (options.qmd !== false) checkQmd(workspace, registry, engram, findings);
  checkCronConfig(workspace, engram, findings);

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
