import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { canonicalizeJcs, Digest, sha256Digest } from "./handoff-v2";

type JsonObject = Record<string, any>;

export interface NightlyWindowV1 {
  mode: "daily" | "weekly";
  timezone: string;
  windowStart: string | null;
  windowEnd: string;
}

export interface NightlyContextV1 {
  schema: "oll.nightly-context.v1";
  workspaceId: string;
  snapshotAt: string;
  window: NightlyWindowV1;
  priorEvaluationAt: string | null;
  signalRevisions: Record<string, number>;
  signals: JsonObject[];
  observations: JsonObject[];
  tensions: JsonObject[];
  rules: JsonObject[];
  contextDigest: Digest;
}

export interface NightlyPreflightV1 {
  schema: "oll.nightly-preflight.v1";
  actionable: boolean;
  reasons: string[];
  counts: { signals: number; observations: number; tensions: number; rules: number };
  score: number;
}

function readObject(path: string): JsonObject {
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must contain an object`);
  return value;
}

function records(root: string): JsonObject[] {
  if (!existsSync(root)) return [];
  return readdirSync(root).filter((name) => name.endsWith(".json") && name !== "index.json").sort().flatMap((name) => {
    try { return [readObject(join(root, name))]; } catch { return []; }
  });
}

function localDateParts(date: Date, timezone: string): { year: number; month: number; day: number; weekday: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short",
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value || "";
  return { year: Number(get("year")), month: Number(get("month")), day: Number(get("day")), weekday: get("weekday") };
}

function zonedMidnightUtc(year: number, month: number, day: number, timezone: string): Date {
  const target = Date.UTC(year, month - 1, day, 0, 0, 0, 0);
  let guess = target;
  for (let index = 0; index < 4; index += 1) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    }).formatToParts(new Date(guess));
    const get = (type: string) => Number(parts.find((part) => part.type === type)?.value || 0);
    const represented = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
    guess += target - represented;
  }
  return new Date(guess);
}

export function determineNightlyWindow(options: {
  now: string;
  timezone: string;
  weeklyEnabled: boolean;
  weekStart: "monday";
}): NightlyWindowV1 {
  const instant = new Date(options.now);
  if (!Number.isFinite(instant.getTime())) throw new Error("invalid nightly timestamp");
  const local = localDateParts(instant, options.timezone);
  const weekly = options.weeklyEnabled && local.weekday === "Mon";
  if (!weekly) return { mode: "daily", timezone: options.timezone, windowStart: null, windowEnd: instant.toISOString() };
  const end = zonedMidnightUtc(local.year, local.month, local.day, options.timezone);
  const priorDate = new Date(Date.UTC(local.year, local.month - 1, local.day - 7));
  const start = zonedMidnightUtc(priorDate.getUTCFullYear(), priorDate.getUTCMonth() + 1, priorDate.getUTCDate(), options.timezone);
  return { mode: "weekly", timezone: options.timezone, windowStart: start.toISOString(), windowEnd: end.toISOString() };
}

function inSnapshot(record: JsonObject, snapshotAt: string): boolean {
  return Number.isFinite(Date.parse(record.createdAt)) && Date.parse(record.createdAt) <= Date.parse(snapshotAt);
}

export function buildNightlyContext(options: {
  workspace: string;
  workspaceId: string;
  snapshotAt: string;
  window: NightlyWindowV1;
}): NightlyContextV1 {
  const workspace = resolve(options.workspace);
  const state = readObject(join(workspace, "memory-state", "oll", "state.json"));
  if (state.workspaceId !== options.workspaceId) throw new Error("nightly state workspace mismatch");
  const priorEvaluationAt = state?.evaluation?.lastCompletedAt || null;
  const processed = state?.evaluation?.signalRevisions || {};
  const signals = records(join(workspace, "memory-state", "oll", "signals"))
    .filter((signal) => ["pending", "review_required", "reviewed"].includes(signal.status))
    .filter((signal) => inSnapshot(signal, options.snapshotAt))
    .filter((signal) => Number(signal.revision || 0) > Number(processed[signal.id] || 0) || !priorEvaluationAt || Date.parse(signal.createdAt) > Date.parse(priorEvaluationAt))
    .map((signal) => ({
      id: signal.id, revision: signal.revision, type: signal.type, scope: signal.scope,
      statement: signal.statement, expectedBehavior: signal.expectedBehavior,
      authorizationDecision: signal.authorizationDecision, confidence: signal.confidence,
      status: signal.status, createdAt: signal.createdAt,
    }))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const since = options.window.mode === "weekly" ? options.window.windowStart : priorEvaluationAt;
  const afterSince = (record: JsonObject) => !since || Date.parse(record.createdAt) >= Date.parse(since);
  const observations = records(join(workspace, "ops", "observations"))
    .filter((record) => record.status === "pending" && inSnapshot(record, options.snapshotAt) && afterSince(record))
    .map(({ id, observation, category, description, createdAt, status }) => ({ id, observation, category, description: description || null, createdAt, status }))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const tensions = records(join(workspace, "ops", "tensions"))
    .filter((record) => record.status === "pending" && inSnapshot(record, options.snapshotAt) && (options.window.mode === "weekly" || afterSince(record)))
    .map(({ id, tension, type, confidence, fact1, fact2, createdAt, status }) => ({ id, tension, type, confidence, fact1, fact2, createdAt, status }))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const rules = records(join(workspace, "memory-state", "oll", "rules"))
    .filter((rule) => options.window.mode === "weekly" || ["active", "rejected", "suspended"].includes(rule.status))
    .map(({ id, scope, rule, risk, status, revision, activatedAt, supersededBy, contentDigest }) => ({ id, scope, rule, risk, status, revision, activatedAt, supersededBy, contentDigest }))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const signalRevisions = Object.fromEntries(signals.map((signal) => [signal.id, signal.revision]));
  const base = {
    schema: "oll.nightly-context.v1" as const,
    workspaceId: options.workspaceId,
    snapshotAt: options.snapshotAt,
    window: options.window,
    priorEvaluationAt,
    signalRevisions,
    signals,
    observations,
    tensions,
    rules,
  };
  return { ...base, contextDigest: sha256Digest(canonicalizeJcs(base)) };
}

export function preflightNightlyContext(context: NightlyContextV1): NightlyPreflightV1 {
  const reasons: string[] = [];
  const corrections = context.signals.filter((signal) => signal.type === "correction").length;
  const directInstructions = context.signals.filter((signal) => ["preference", "workflow"].includes(signal.type)).length;
  const quality = context.signals.filter((signal) => signal.type === "quality").length;
  const friction = context.observations.filter((observation) => observation.category === "friction").length;
  const patterns = context.observations.filter((observation) => observation.category === "pattern").length;
  if (corrections) reasons.push("explicit_correction");
  if (directInstructions) reasons.push("preference_or_workflow_signal");
  if (quality >= 2) reasons.push("repeated_quality_signal");
  if (context.tensions.length) reasons.push("pending_tension");
  if (patterns || friction >= 2) reasons.push("operational_pattern");
  if (context.window.mode === "weekly" && (context.signals.length || context.observations.length || context.tensions.length)) reasons.push("weekly_unresolved_context");
  const counts = { signals: context.signals.length, observations: context.observations.length, tensions: context.tensions.length, rules: context.rules.length };
  return {
    schema: "oll.nightly-preflight.v1",
    actionable: reasons.length > 0,
    reasons: [...new Set(reasons)].sort(),
    counts,
    score: corrections * 10 + directInstructions * 5 + quality * 2 + friction * 3 + patterns + context.tensions.length * 4,
  };
}
