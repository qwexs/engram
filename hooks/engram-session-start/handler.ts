import { existsSync, readFileSync, appendFileSync, mkdirSync, writeFileSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";

const TZ = process.env.ENGRAM_TZ || process.env.TZ || "UTC";

const TEMPLATE = (date: string) => `# ${date}

## Events

## Decisions

## Learnings

## Active Threads

## Next
`;

/** Get current ISO timestamp with timezone offset */
function localISO(tz: string): string {
  const now = new Date();
  // Format with timezone to get the local representation
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: tz,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  }).formatToParts(now);

  const get = (t: string) => parts.find(p => p.type === t)?.value || "00";
  const local = `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}`;

  // Calculate offset
  const utc = new Date(now.toLocaleString("en-US", { timeZone: "UTC" }));
  const loc = new Date(now.toLocaleString("en-US", { timeZone: tz }));
  const diffMin = Math.round((loc.getTime() - utc.getTime()) / 60000);
  const sign = diffMin >= 0 ? "+" : "-";
  const absMin = Math.abs(diffMin);
  const offH = String(Math.floor(absMin / 60)).padStart(2, "0");
  const offM = String(absMin % 60).padStart(2, "0");

  return `${local}${sign}${offH}:${offM}`;
}

const handler = async (event: any) => {
  if (event.type !== "agent" || event.action !== "bootstrap") return;

  const workspaceDir = event.context?.workspaceDir;
  if (!workspaceDir) return;

  const agentId = event.context?.agentId || "main";
  // sessionKey comes as "agent:main:main" — extract the session segment
  const rawKey = event.context?.sessionKey || "main";
  const sessionKey = rawKey.includes(":") ? rawKey.split(":").slice(2).join("-") || "main" : rawKey;

  // Skip ephemeral runtime sessions — they don't need daily notes.
  if (sessionKey.startsWith("subagent-")) return;
  if (/^cron-.+-run-/.test(sessionKey)) return;

  const today = new Date().toLocaleDateString("sv-SE", { timeZone: TZ });
  const sessionDir = join(workspaceDir, "memory", `agent-${agentId}`, sessionKey);
  const notePath = join(sessionDir, `${today}.md`);

  // Create daily note if missing (fallback — normally engram-daily-note handles this)
  if (!existsSync(notePath)) {
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(notePath, TEMPLATE(today));
    console.log(`[engram-session-start] Created daily note ${notePath}`);
  }

  // Skip if there's already a session:start within the last 15 minutes (debounce repeated bootstraps)
  const content = existsSync(notePath) ? readFileSync(notePath, "utf-8") : "";
  const lines = content.trimEnd().split("\n");
  const lastLine = lines[lines.length - 1]?.trim() || "";
  if (lastLine.startsWith("<!-- session:start:")) {
    console.log(`[engram-session-start] Skipped (last line already session:start)`);
    return;
  }
  // Also skip if any session:start was written in the last 15 minutes
  const debounceMs = 15 * 60 * 1000;
  const now = Date.now();
  const recentStart = lines.slice().reverse().find(l => l.trim().startsWith("<!-- session:start:"));
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
  appendFileSync(notePath, `<!-- session:start:${iso} -->\n`);
  console.log(`[engram-session-start] Wrote session:start to ${notePath}`);

  // Move handoff .md files from memory/ root to memory/agent-{agentId}/{sessionKey}/YYYY-MM-DD/.
  // The legacy layout (memory/domains/{session}/) conflated sessions and domains — domains are
  // curated memory contours registered in memory/domains/registry.json, while sessions are
  // runtime agent contexts. Handoff files belong to the session that produced them, so they
  // now land next to daily notes in the agent-{id} subtree. See ISS-7 for history.
  try {
    const memoryDir = join(workspaceDir, "memory");
    const agentSessionDir = join(memoryDir, `agent-${agentId}`, sessionKey);
    const files = readdirSync(memoryDir).filter(f => f.endsWith(".md") && /^\d{4}-\d{2}-\d{2}/.test(f));
    for (const file of files) {
      const dateMatch = file.match(/^(\d{4}-\d{2}-\d{2})/);
      if (!dateMatch) continue;
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

export default handler;
