/**
 * engram-session-memory hook
 *
 * Replaces the built-in session-memory hook.
 * Saves session transcript to memory/agent-{id}/{session}/sessions/YYYY-MM-DD-{slug}.md
 * so it lands inside the QMD collection and is searchable.
 *
 * Config (hooks.internal.entries.engram-session-memory):
 *   messages: number  — how many messages to include (default: 40)
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const TZ = process.env.ENGRAM_TZ || process.env.TZ || "UTC";
const DEFAULT_MESSAGE_COUNT = 40;

function makeSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^а-яёa-z0-9\s-]/gi, " ")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 40)
    .replace(/^-|-$/g, "") || "session";
}

interface ParsedSession {
  content: string;
  firstUserMsg: string;
}

function readSessionContent(filePath: string, messageCount: number): ParsedSession | null {
  try {
    if (!existsSync(filePath)) {
      console.log(`[engram-session-memory] readSessionContent: file not found: ${filePath}`);
      return null;
    }
    const raw = readFileSync(filePath, "utf-8");
    const lines = raw.trim().split("\n");
    console.log(`[engram-session-memory] readSessionContent: ${lines.length} lines in ${filePath}`);

    const messages: string[] = [];
    let firstUserMsg = "";

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.type !== "message" || !entry.message) continue;

        const msg = entry.message;
        const role: string = msg.role;
        if (role !== "user" && role !== "assistant") continue;

        // Extract text content
        let text: string | null = null;
        if (Array.isArray(msg.content)) {
          text = msg.content.find((c: { type: string; text?: string }) => c.type === "text")?.text ?? null;
        } else if (typeof msg.content === "string") {
          text = msg.content;
        }

        if (!text) continue;
        // Skip system/metadata noise
        if (text.startsWith("/")) continue;
        if (text.startsWith("Conversation info")) continue;
        if (text.startsWith("Sender (untrusted")) continue;
        if (text.startsWith("=== HB-")) continue;

        if (role === "user" && !firstUserMsg) {
          firstUserMsg = text.trim();
        }
        messages.push(`${role}: ${text.slice(0, 800)}`);
      } catch {
        // skip malformed lines
      }
    }

    const recent = messages.slice(-messageCount);
    console.log(`[engram-session-memory] readSessionContent: extracted ${recent.length} messages`);
    if (recent.length === 0) return null;

    return { content: recent.join("\n\n"), firstUserMsg };
  } catch (e) {
    console.error(`[engram-session-memory] readSessionContent error:`, e);
    return null;
  }
}

function findSessionFile(agentId: string, sessionId?: string): string | undefined {
  const stateDir =
    process.env.OPENCLAW_STATE_DIR || join(homedir(), ".openclaw");
  const sessionsDir = join(stateDir, "agents", agentId, "sessions");
  console.log(`[engram-session-memory] findSessionFile: looking in ${sessionsDir}, sessionId=${sessionId}`);
  if (!existsSync(sessionsDir)) {
    console.log(`[engram-session-memory] findSessionFile: sessionsDir not found`);
    return undefined;
  }

  const files = readdirSync(sessionsDir);

  // Prefer the canonical .jsonl for this sessionId (before reset rotation)
  if (sessionId) {
    const canonical = `${sessionId}.jsonl`;
    if (files.includes(canonical)) {
      console.log(`[engram-session-memory] findSessionFile: found canonical ${canonical}`);
      return join(sessionsDir, canonical);
    }
  }

  // Fallback: latest .reset. file for this sessionId
  if (sessionId) {
    const resetPrefix = `${sessionId}.jsonl.reset.`;
    const resets = files
      .filter((f) => f.startsWith(resetPrefix))
      .sort()
      .reverse();
    if (resets.length > 0) {
      console.log(`[engram-session-memory] findSessionFile: found reset ${resets[0]}`);
      return join(sessionsDir, resets[0]);
    }
  }

  // Last resort: newest non-deleted .jsonl
  const live = files
    .filter((f) => f.endsWith(".jsonl") && !f.includes(".reset.") && !f.includes(".deleted."))
    .sort()
    .reverse();
  if (live.length > 0) {
    console.log(`[engram-session-memory] findSessionFile: fallback to newest live: ${live[0]}`);
    return join(sessionsDir, live[0]);
  }

  console.log(`[engram-session-memory] findSessionFile: no file found`);
  return undefined;
}

const handler = async (event: any) => {
  console.log(`[engram-session-memory] event: type=${event.type} action=${event.action} sessionKey=${event.sessionKey}`);

  if (event.type !== "command") return;
  if (event.action !== "new" && event.action !== "reset") return;

  const context = event.context || {};
  const workspaceDir = context.workspaceDir as string | undefined;
  console.log(`[engram-session-memory] workspaceDir=${workspaceDir}`);
  if (!workspaceDir) return;

  const agentId = (context.agentId as string | undefined) || "main";

  // Use event.sessionKey (top-level) for resolving the agent session key
  // context.sessionKey may differ; prefer the top-level event.sessionKey
  const rawKey = (event.sessionKey as string | undefined) || (context.sessionKey as string | undefined) || "main";
  const sessionKey = rawKey.includes(":")
    ? rawKey.split(":").slice(2).join("-") || "main"
    : rawKey;

  console.log(`[engram-session-memory] rawKey=${rawKey} sessionKey=${sessionKey} agentId=${agentId}`);

  // Skip subagent and cron sessions
  if (sessionKey.startsWith("subagent-")) return;
  if (sessionKey.startsWith("cron-")) return;

  // Message count from hook config
  const hookCfg = context.cfg?.hooks?.internal?.entries?.["engram-session-memory"] ?? {};
  const messageCount =
    typeof hookCfg.messages === "number" && hookCfg.messages > 0
      ? hookCfg.messages
      : DEFAULT_MESSAGE_COUNT;

  // Resolve session file
  const sessionEntry = (context.previousSessionEntry || context.sessionEntry || {}) as Record<string, unknown>;
  const sessionId = sessionEntry.sessionId as string | undefined;
  let sessionFile = sessionEntry.sessionFile as string | undefined;

  console.log(`[engram-session-memory] sessionId=${sessionId} sessionFile=${sessionFile}`);

  if (!sessionFile || !existsSync(sessionFile)) {
    console.log(`[engram-session-memory] sessionFile missing/not found, calling findSessionFile`);
    sessionFile = findSessionFile(agentId, sessionId);
  }
  if (!sessionFile) {
    console.log(`[engram-session-memory] no sessionFile, returning`);
    return;
  }

  const parsed = readSessionContent(sessionFile, messageCount);
  if (!parsed) {
    console.log(`[engram-session-memory] no parsed content, returning`);
    return;
  }

  const { content, firstUserMsg } = parsed;
  const slug = firstUserMsg
    ? makeSlug(firstUserMsg.slice(0, 60))
    : new Date().toISOString().slice(11, 16).replace(":", "");

  const today = new Date().toLocaleDateString("sv-SE", { timeZone: TZ });
  const nowIso = new Date(event.timestamp ?? Date.now()).toISOString();
  const dateStr = nowIso.slice(0, 10);
  const timeStr = nowIso.slice(11, 19);
  const timeSortable = timeStr.replace(/:/g, ""); // HHMMSS for filename sorting

  // Target: memory/agent-{agentId}/{sessionKey}/sessions/YYYY-MM-DD-HHMMSS-{slug}.md
  const targetDir = join(workspaceDir, "memory", `agent-${agentId}`, sessionKey, "sessions");
  console.log(`[engram-session-memory] targetDir=${targetDir} slug=${slug}`);
  mkdirSync(targetDir, { recursive: true });

  const filename = `${today}-${timeSortable}-${slug}.md`;
  const filePath = join(targetDir, filename);

  const md = [
    `# Session: ${dateStr} ${timeStr} UTC`,
    "",
    `- **Session Key**: ${event.sessionKey ?? rawKey}`,
    `- **Session ID**: ${sessionId ?? "unknown"}`,
    `- **Agent**: ${agentId}`,
    `- **Messages**: last ${messageCount}`,
    "",
    "## Conversation Summary",
    "",
    content,
    "",
  ].join("\n");

  writeFileSync(filePath, md, "utf-8");
  console.log(`[engram-session-memory] Saved → ${filePath}`);
};

export default handler;
