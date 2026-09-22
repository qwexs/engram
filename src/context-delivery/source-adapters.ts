import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { resolveKgDefaultContext } from "../kg-v3/context.ts";
import { defaultContextArchiveLeakage } from "../kg-v3/benchmark.ts";
import { resolveRuleContext, type RuleContextTargetV1 } from "../oll/rule-context.ts";
import type {
  CanonicalDeliveryScope,
  DeliveryReason,
  DeliverySource,
  DeliverySourceBlock,
  DeliverySourceOutcome,
} from "./contracts.ts";
import { renderedDeliverySourceBytes } from "./contracts.ts";
import { resolveExactDomainBinding } from "./domain-source.ts";
import {
  h2MarkdownBlocks,
  h3MarkdownRecords,
  neutralizeDeliveryMarkers,
} from "./markdown-records.ts";

export class DeliverySourceAdapterError extends Error {
  constructor(readonly reason: DeliveryReason, message: string) {
    super(message);
  }
}

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function readInside(workspace: string, relativePath: string): string {
  const root = realpathSync(resolve(workspace));
  const path = realpathSync(resolve(join(root, relativePath)));
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  if (!path.startsWith(prefix)) throw new DeliverySourceAdapterError("SOURCE_INVALID", "context source path escapes workspace");
  const before = statSync(path);
  if (!before.isFile()) throw new DeliverySourceAdapterError("SOURCE_INVALID", "context source is not a regular file");
  const content = readFileSync(path, "utf8");
  const after = statSync(path);
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
    throw new DeliverySourceAdapterError("SNAPSHOT_UNAVAILABLE", "context source changed during snapshot read");
  }
  return content;
}

export function resolveKgContextSource(options: {
  workspace: string;
  workspaceId: string;
  scope: CanonicalDeliveryScope;
  trustedPeer: boolean;
}): DeliverySourceOutcome {
  const allowed = options.scope.kind === "main"
    || (options.scope.kind === "peer-direct" && options.trustedPeer);
  if (!allowed) return { source: "kg", status: "omitted", reason: "SCOPE_DENIED" };
  const context = resolveKgDefaultContext({ workspace: options.workspace, workspaceId: options.workspaceId });
  if (context.mode !== "v3-current" || context.archiveIncludedInDefault || context.sources.length !== 1) {
    return { source: "kg", status: "omitted", reason: "SOURCE_INVALID" };
  }
  const content = readInside(options.workspace, context.sources[0]!).trim();
  if (!content) return { source: "kg", status: "omitted", reason: "SOURCE_MISSING" };
  if (defaultContextArchiveLeakage({ ...context, embeddedBodies: [content] })) {
    return { source: "kg", status: "omitted", reason: "SOURCE_INVALID" };
  }
  return {
    source: "kg",
    status: "selected",
    block: { source: "kg", artifactDigest: sha256(content), content },
  };
}

export function resolveOllContextSource(options: {
  workspace: string;
  stateRoot: string;
  target: RuleContextTargetV1;
  now?: string;
}): DeliverySourceOutcome {
  const config = JSON.parse(readInside(options.workspace, "engram.json"));
  if (config?.oll?.adaptation?.mode !== "active") {
    return { source: "oll", status: "omitted", reason: "SOURCE_MISSING" };
  }
  const request = {
    workspace: options.workspace,
    stateRoot: options.stateRoot,
    target: options.target,
    now: options.now,
  };
  const resolution = resolveRuleContext(request);
  const readBack = resolveRuleContext(request);
  if (resolution.status !== readBack.status || resolution.contextHash !== readBack.contextHash
    || resolution.payload !== readBack.payload || JSON.stringify(resolution.provenance) !== JSON.stringify(readBack.provenance)) {
    return { source: "oll", status: "omitted", reason: "SNAPSHOT_UNAVAILABLE" };
  }
  if (resolution.status === "overflow") return { source: "oll", status: "omitted", reason: "BUDGET_SOURCE_CAP" };
  if (!resolution.payload) {
    return { source: "oll", status: "omitted", reason: resolution.conflicts.length ? "SOURCE_INVALID" : "SOURCE_MISSING" };
  }
  return {
    source: "oll",
    status: "selected",
    block: { source: "oll", artifactDigest: sha256(resolution.payload), content: resolution.payload },
  };
}

function firstLines(text: string, count: number): string {
  return text.replace(/\r/g, "").split("\n").slice(0, count).join("\n").trim();
}

function lastChangelogEntry(text: string): string {
  const lines = text.replace(/\r/g, "").split("\n");
  const starts = lines.flatMap((line, index) => /^##\s+\d{4}-\d{2}-\d{2}/.test(line) ? [index] : []);
  return starts.length ? lines.slice(starts.at(-1)!).join("\n").trim() : "";
}

function recentDecisionEntries(records: string[], count: number): string[] {
  const selected: string[] = [];
  let bytes = 0;
  for (const entry of records.slice().reverse()) {
    const size = Buffer.byteLength(entry, "utf8");
    if (size > 2 * 1024 || bytes + size > 4 * 1024) continue;
    selected.push(neutralizeDeliveryMarkers(entry));
    bytes += size;
    if (selected.length === count) break;
  }
  return selected;
}

function domainContent(options: {
  head: string[];
  decisions: string[];
  changelog: string[];
  instructions: string[];
}): string {
  return [
    ...options.head,
    "## Recent accepted decisions",
    options.decisions.length ? options.decisions.join("\n\n") : "_empty_",
    "",
    ...options.changelog,
    "",
    "## Domain instructions",
    options.instructions.length ? options.instructions.join("\n\n") : "_empty_",
  ].join("\n");
}

function domainBlockFits(content: string, maxRenderedBytes: number): boolean {
  return renderedDeliverySourceBytes({ source: "domain", artifactDigest: sha256(content), content }) <= maxRenderedBytes;
}

export function resolveDomainContextSource(options: {
  workspace: string;
  workspaceId: string;
  scope: CanonicalDeliveryScope;
  maxRenderedBytes: number;
}): DeliverySourceOutcome {
  if (!Number.isSafeInteger(options.maxRenderedBytes) || options.maxRenderedBytes < 128) {
    throw new DeliverySourceAdapterError("SOURCE_INVALID", "invalid domain rendered-byte cap");
  }
  if (options.scope.kind === "main") return { source: "domain", status: "omitted", reason: "SCOPE_DENIED" };
  const registryBefore = readInside(options.workspace, "memory/domains/registry.json");
  const binding = resolveExactDomainBinding(options);
  if (!binding) return { source: "domain", status: "omitted", reason: "DOMAIN_UNBOUND" };

  const domainBase = `memory/domains/${binding.domainName}`;
  const decisions = readInside(options.workspace, `${domainBase}/decisions.md`);
  const status = readInside(options.workspace, `${domainBase}/status.md`);
  const changelog = readInside(options.workspace, `${domainBase}/changelog.md`);
  const agents = readInside(options.workspace, `${domainBase}/agents.md`);
  const registryAfter = readInside(options.workspace, "memory/domains/registry.json");
  if (sha256(registryBefore) !== sha256(registryAfter)) {
    return { source: "domain", status: "omitted", reason: "SNAPSHOT_UNAVAILABLE" };
  }
  const decisionRecords = h3MarkdownRecords(decisions);
  const decisionsCount = decisionRecords.length;
  const recentDecisions = recentDecisionEntries(decisionRecords, 3);
  const head = [
    "# Engram Domain Context",
    `Domain: ${binding.domainName}`,
    `Type: ${binding.domainType}`,
    `Accepted decisions: ${decisionsCount}`,
    "",
    "## Status",
    neutralizeDeliveryMarkers(firstLines(status, 40)) || "_empty_",
    "",
  ];
  const changelogSection = [
    "## Latest changelog entry",
    neutralizeDeliveryMarkers(lastChangelogEntry(changelog)) || "_empty_",
  ];
  const selectedInstructions: string[] = [];
  const instructionBlocks = h2MarkdownBlocks(neutralizeDeliveryMarkers(agents.trim()));
  let content = domainContent({ head, decisions: [], changelog: changelogSection, instructions: selectedInstructions });
  if (!domainBlockFits(content, options.maxRenderedBytes)) {
    return { source: "domain", status: "omitted", reason: "BUDGET_SOURCE_CAP" };
  }
  for (const instruction of instructionBlocks) {
    const candidate = domainContent({
      head,
      decisions: [],
      changelog: changelogSection,
      instructions: [...selectedInstructions, instruction],
    });
    if (!domainBlockFits(candidate, options.maxRenderedBytes)) break;
    selectedInstructions.push(instruction);
    content = candidate;
  }
  const selectedDecisions: string[] = [];
  for (const decision of recentDecisions) {
    const candidate = domainContent({
      head,
      decisions: [...selectedDecisions, decision],
      changelog: changelogSection,
      instructions: selectedInstructions,
    });
    if (!domainBlockFits(candidate, options.maxRenderedBytes)) break;
    selectedDecisions.push(decision);
    content = candidate;
  }
  const stableFiles = { decisions, status, changelog, agents };
  for (const [name, value] of Object.entries(stableFiles)) {
    if (sha256(readInside(options.workspace, `${domainBase}/${name}.md`)) !== sha256(value)) {
      return { source: "domain", status: "omitted", reason: "SNAPSHOT_UNAVAILABLE" };
    }
  }
  const artifactDigest = sha256(content);
  return {
    source: "domain",
    status: "selected",
    block: { source: "domain", artifactDigest, content },
  };
}

export function splitSourceOutcomes(outcomes: DeliverySourceOutcome[]): {
  sources: DeliverySourceBlock[];
  omissions: Array<{ source: DeliverySource; reason: DeliveryReason }>;
} {
  return {
    sources: outcomes.flatMap((outcome) => outcome.status === "selected" ? [outcome.block] : []),
    omissions: outcomes.flatMap((outcome) => outcome.status === "omitted" ? [{ source: outcome.source, reason: outcome.reason }] : []),
  };
}
