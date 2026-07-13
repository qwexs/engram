// @bun
// handler.ts
import { existsSync, readFileSync, appendFileSync, mkdirSync, writeFileSync, readdirSync, renameSync } from "fs";
import { join } from "path";

// ../_lib/parse-agent-id.ts
function splitAgentAndSession(sessionKey) {
  if (!sessionKey)
    return null;
  const m = sessionKey.match(/^agent:([^:]+):(.+)$/);
  if (!m)
    return null;
  const agentId = m[1];
  const sessionKeySeg = m[2].replace(/:/g, "-") || "main";
  return { agentId, sessionKey: sessionKeySeg };
}

// handler.ts
var TZ = process.env.ENGRAM_TZ || process.env.TZ || "UTC";
var TEMPLATE = (date) => `# ${date}

## Events

## Decisions

## Learnings

## Active Threads

## Next
`;
function localISO(tz) {
  const now = new Date;
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).formatToParts(now);
  const get = (t) => parts.find((p) => p.type === t)?.value || "00";
  const local = `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}`;
  const utc = new Date(now.toLocaleString("en-US", { timeZone: "UTC" }));
  const loc = new Date(now.toLocaleString("en-US", { timeZone: tz }));
  const diffMin = Math.round((loc.getTime() - utc.getTime()) / 60000);
  const sign = diffMin >= 0 ? "+" : "-";
  const absMin = Math.abs(diffMin);
  const offH = String(Math.floor(absMin / 60)).padStart(2, "0");
  const offM = String(absMin % 60).padStart(2, "0");
  return `${local}${sign}${offH}:${offM}`;
}
var handler = async (event) => {
  if (event.type !== "agent" || event.action !== "bootstrap")
    return;
  const workspaceDir = event.context?.workspaceDir;
  if (!workspaceDir)
    return;
  const rawKey = event.context?.sessionKey || event.sessionKey || "main";
  const split = splitAgentAndSession(rawKey);
  const agentId = split?.agentId || event.context?.agentId || "main";
  const sessionKey = split?.sessionKey || "main";
  if (sessionKey.startsWith("subagent-"))
    return;
  if (/^cron-.+-run-/.test(sessionKey))
    return;
  const today = new Date().toLocaleDateString("sv-SE", { timeZone: TZ });
  const sessionDir = join(workspaceDir, "memory", `agent-${agentId}`, sessionKey);
  const notePath = join(sessionDir, `${today}.md`);
  if (!existsSync(notePath)) {
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(notePath, TEMPLATE(today));
    console.log(`[engram-session-start] Created daily note ${notePath}`);
  }
  const content = existsSync(notePath) ? readFileSync(notePath, "utf-8") : "";
  const lines = content.trimEnd().split(`
`);
  const lastLine = lines[lines.length - 1]?.trim() || "";
  if (lastLine.startsWith("<!-- session:start:")) {
    console.log(`[engram-session-start] Skipped (last line already session:start)`);
    return;
  }
  const debounceMs = 15 * 60 * 1000;
  const now = Date.now();
  const recentStart = lines.slice().reverse().find((l) => l.trim().startsWith("<!-- session:start:"));
  if (recentStart) {
    const m = recentStart.match(/<!-- session:start:(.+?) -->/);
    if (m) {
      try {
        const ts = new Date(m[1]).getTime();
        if (!isNaN(ts) && now - ts < debounceMs) {
          console.log(`[engram-session-start] Skipped (session:start written < 15min ago)`);
          return;
        }
      } catch {}
    }
  }
  const iso = localISO(TZ);
  appendFileSync(notePath, `<!-- session:start:${iso} -->
`);
  console.log(`[engram-session-start] Wrote session:start to ${notePath}`);
  try {
    const heartbeatPath = join(workspaceDir, "memory", "heartbeat-state.json");
    if (existsSync(heartbeatPath)) {
      const raw = readFileSync(heartbeatPath, "utf-8");
      const state = JSON.parse(raw.charCodeAt(0) === 65279 ? raw.slice(1) : raw);
      if (!Array.isArray(state.activeSessions))
        state.activeSessions = [];
      if (!state.activeSessions.includes(sessionKey)) {
        state.activeSessions.push(sessionKey);
        writeFileSync(heartbeatPath, JSON.stringify(state, null, 2) + `
`);
        console.log(`[engram-session-start] Registered session '${sessionKey}' in activeSessions`);
      }
    }
  } catch (e) {
    console.warn(`[engram-session-start] Failed to register session in activeSessions: ${e.message}`);
  }
  try {
    const memoryDir = join(workspaceDir, "memory");
    const agentSessionDir = join(memoryDir, `agent-${agentId}`, sessionKey);
    const files = readdirSync(memoryDir).filter((f) => f.endsWith(".md") && /^\d{4}-\d{2}-\d{2}/.test(f));
    for (const file of files) {
      const dateMatch = file.match(/^(\d{4}-\d{2}-\d{2})/);
      if (!dateMatch)
        continue;
      const date = dateMatch[1];
      const destDir = join(agentSessionDir, date);
      mkdirSync(destDir, { recursive: true });
      renameSync(join(memoryDir, file), join(destDir, file));
      console.log(`[engram-session-start] Moved ${file} -> agent-${agentId}/${sessionKey}/${date}/`);
    }
  } catch (e) {
    console.error(`[engram-session-start] Handoff move error:`, e);
  }
};
var handler_default = handler;
export {
  handler_default as default
};
