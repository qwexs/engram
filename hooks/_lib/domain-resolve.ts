/**
 * Domain resolution helper shared by all `*-domain-load` hooks.
 *
 * Given an OpenClaw `message:received` event, resolves which domain (if any)
 * is bound to the session the message arrived in. Supports three session kinds:
 *
 *   - `topic-thread`  — Telegram group with topics (chatId + topicId)
 *   - `peer-direct`   — Telegram direct/DM chat (chatId = userId)
 *   - `group-direct`  — Telegram group without topics (chatId only)
 *
 * The resolution pipeline:
 *   1. Extract `sessionKey`, `workspaceDir`, `agentId` from the event.
 *   2. Extract `chatId` and `topicId` (optional) from the event via a
 *      multi-layer fallback chain (context → conversationId → metadata).
 *   3. Determine `sessionKind` from whether `topicId` is present and
 *      whether the chat looks like a DM (positive userId) vs a group
 *      (negative chatId).
 *   4. Build the `sessionSegment` matching engram-session-start's convention.
 *   5. Look up the domain in `memory/domains/registry.json` using the
 *      kind-specific binding key (`entry.topic`, `entry.peer`, or `entry.group`).
 *   6. Return a fully-resolved result or null.
 *
 * Idempotency, payload construction, and delivery are handled by
 * `_lib/domain-inject.ts` and `_lib/system-event.ts` respectively.
 * This module is pure resolution — no side effects apart from reading
 * the registry (and clearing `archived` flag on reactivation, which
 * mirrors the v3.5 topic-hook behaviour).
 *
 * @module _lib/domain-resolve
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseAgentIdFromSessionKey, resolveWorkspaceByAgentId } from "../engram-topic-domain-load/workspace-resolver.js";

/** All supported session kinds for domain-load hooks. */
export type SessionKind = "topic-thread" | "peer-direct" | "group-direct";

/** The fully-resolved domain context ready for payload construction. */
export type ResolvedDomain = {
  domainName: string;
  domainEntry: any;
  sessionKind: SessionKind;
  sessionSegment: string;
  sessionLocation: string;
  chatId: string;
  absChatId: string;
  topicId: string | null;
  agentId: string;
  workspaceDir: string;
  sessionKey: string;
};

/** Input options for `resolveDomainFromEvent`. */
export type ResolveOpts = {
  /** Restrict to specific session kinds. Default: all three. */
  kinds?: SessionKind[];
};

const ALL_KINDS: SessionKind[] = ["topic-thread", "peer-direct", "group-direct"];

function resolveTz(): string {
  return process.env.ENGRAM_TZ || process.env.TZ || "UTC";
}

/**
 * Resolve the domain bound to the session the message arrived in.
 *
 * Returns `null` if:
 *   - the event is not a `message:received`,
 *   - `chatId` cannot be resolved,
 *   - the session kind is not in the allowed `kinds`,
 *   - no matching domain entry exists in the registry,
 *   - the registry is missing or corrupt.
 *
 * On match, if the domain entry has `archived: true`, the flag is cleared
 * and the registry is re-written (reactivation-on-message, same as v3.5
 * topic-hook behaviour).
 */
export function resolveDomainFromEvent(
  event: any,
  opts?: ResolveOpts,
): ResolvedDomain | null {
  if (event.type !== "message" || event.action !== "received") return null;

  const allowedKinds = opts?.kinds || ALL_KINDS;

  // --- sessionKey → agentId ---
  const sessionKey: string =
    event.sessionKey || event.context?.sessionKey || "";
  const resolvedAgentId = parseAgentIdFromSessionKey(sessionKey);

  // --- workspaceDir ---
  const workspaceDir =
    event.context?.workspaceDir ||
    process.env.OPENCLAW_WORKSPACE ||
    (resolvedAgentId ? resolveWorkspaceByAgentId(resolvedAgentId) : null);
  if (!workspaceDir) return null;

  // --- Extract chatId + topicId from event (multi-layer fallback) ---
  const conversationId: string = event.context?.conversationId || "";
  let topicId: string | null = null;
  let chatId: string | null = null;

  // Layer 1: direct context fields (each independent — peer-direct /
  // group-direct events carry chatId only, no topicId; topic-thread
  // events carry both).
  if (event.context?.chatId) {
    chatId = String(event.context.chatId);
  }
  if (event.context?.topicId) {
    topicId = String(event.context.topicId);
  }

  // Layer 2: conversationId regex
  if (!chatId || !topicId) {
    const m = conversationId.match(/^telegram:(-?\d+)(?::topic:(\d+))?$/);
    if (m) {
      if (!chatId) chatId = m[1];
      if (!topicId) topicId = m[2] || null;
    }
  }

  // Layer 3: OpenClaw 2026.6.6 metadata fallbacks
  if (!topicId) {
    const fromMeta = event.context?.metadata?.threadId;
    const fromTop = event.threadId;
    if (typeof fromMeta === "string" && fromMeta.length > 0) {
      topicId = fromMeta;
    } else if (typeof fromTop === "string" && fromTop.length > 0) {
      topicId = fromTop;
    }
  }
  if (!chatId) {
    const fromConv = conversationId.match(/^telegram:(-?\d+)/);
    if (fromConv) {
      chatId = fromConv[1];
    } else {
      const fromMeta =
        event.context?.metadata?.to || event.context?.metadata?.originatingTo;
      if (typeof fromMeta === "string" && fromMeta.length > 0) {
        chatId = fromMeta;
      }
    }
  }

  if (!chatId) return null;

  // --- Determine sessionKind ---
  // topicId present → topic-thread (group with topics)
  // chatId is positive (user id) → peer-direct (DM)
  // chatId is negative (group id, no topic) → group-direct
  let sessionKind: SessionKind;
  if (topicId) {
    sessionKind = "topic-thread";
  } else if (!chatId.startsWith("-")) {
    sessionKind = "peer-direct";
  } else {
    sessionKind = "group-direct";
  }

  // Filter by allowed kinds
  if (!allowedKinds.includes(sessionKind)) return null;

  const absChatId = chatId.replace(/^-/, "");

  // --- Build sessionSegment ---
  // Matches engram-session-start's convention:
  //   topic-thread:  "telegram-group--{absChatId}-topic-{topicId}"
  //   peer-direct:   "telegram-direct--{chatId}"
  //   group-direct:  "telegram-group--{absChatId}"
  const sessionSegment =
    sessionKind === "topic-thread"
      ? `telegram-group--${absChatId}-topic-${topicId}`
      : sessionKind === "peer-direct"
        ? `telegram-direct--${chatId}`
        : `telegram-group--${absChatId}`;

  // --- Registry lookup ---
  const registryPath = join(workspaceDir, "memory", "domains", "registry.json");
  if (!existsSync(registryPath)) return null;

  let registry: any;
  try {
    registry = JSON.parse(readFileSync(registryPath, "utf-8"));
  } catch {
    return null;
  }
  if (!registry.domains || typeof registry.domains !== "object") return null;

  // Kind-specific registry key:
  //   topic-thread:  entry.topic = { chatId, topicId }
  //   peer-direct:   entry.peer  = { chatId }
  //   group-direct:  entry.group = { chatId }
  const bindingKey = sessionKind === "topic-thread" ? "topic" : sessionKind === "peer-direct" ? "peer" : "group";

  let domainName: string | null = null;
  let domainEntry: any = null;

  for (const [name, entry] of Object.entries<any>(registry.domains)) {
    if (!entry || typeof entry !== "object") continue;
    const binding = entry[bindingKey];
    if (!binding) continue;

    if (sessionKind === "topic-thread") {
      if (
        binding.topicId === topicId &&
        String(binding.chatId).replace(/^-/, "") === absChatId
      ) {
        domainName = name;
        domainEntry = entry;
        break;
      }
    } else {
      // peer-direct and group-direct: match by chatId only
      if (String(binding.chatId).replace(/^-/, "") === absChatId) {
        domainName = name;
        domainEntry = entry;
        break;
      }
    }
  }

  if (!domainName || !domainEntry) return null;

  // --- Unarchive-on-message ---
  if (domainEntry.archived === true) {
    delete domainEntry.archived;
    const archivesDir = join(
      workspaceDir,
      "memory",
      "domains",
      "archives",
      domainName,
    );
    if (existsSync(archivesDir)) {
      console.log(
        `[domain-resolve] Reactivating archived domain "${domainName}"`,
      );
    }
    registry.domains[domainName] = domainEntry;
    try {
      writeFileSync(registryPath, JSON.stringify(registry, null, 2) + "\n");
    } catch {}
  }

  // --- Build sessionLocation ---
  //   topic-thread: "{absChatId}:{topicId}"
  //   peer-direct:  "{chatId}"
  //   group-direct: "{absChatId}"
  const sessionLocation =
    sessionKind === "topic-thread"
      ? `${absChatId}:${topicId}`
      : sessionKind === "peer-direct"
        ? chatId
        : absChatId;

  const agentId = resolvedAgentId || event.context?.agentId || "main";

  return {
    domainName,
    domainEntry,
    sessionKind,
    sessionSegment,
    sessionLocation,
    chatId,
    absChatId,
    topicId,
    agentId,
    workspaceDir,
    sessionKey,
  };
}