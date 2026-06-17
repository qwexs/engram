// hooks/engram-session-start/handler.ts
import { existsSync, readFileSync, appendFileSync, mkdirSync, writeFileSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
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
  const agentId = event.context?.agentId || "main";
  const rawKey = event.context?.sessionKey || "main";
  const sessionKey = rawKey.includes(":") ? rawKey.split(":").slice(2).join("-") || "main" : rawKey;
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
    const memoryDir = join(workspaceDir, "memory");
    const domainsDir = join(memoryDir, "domains");
    const files = readdirSync(memoryDir).filter((f) => f.endsWith(".md") && /^\d{4}-\d{2}-\d{2}/.test(f));
    for (const file of files) {
      const dateMatch = file.match(/^(\d{4}-\d{2}-\d{2})/);
      if (!dateMatch)
        continue;
      const date = dateMatch[1];
      let sess = "main";
      try {
        const content2 = readFileSync(join(memoryDir, file), "utf-8").slice(0, 500);
        const m = content2.match(/Session Key.*?agent:[\w-]+:([\w-]+)/);
        if (m)
          sess = m[1];
      } catch {}
      const destDir = join(domainsDir, sess, date);
      mkdirSync(destDir, { recursive: true });
      renameSync(join(memoryDir, file), join(destDir, file));
      console.log(`[engram-session-start] Moved ${file} -> domains/${sess}/${date}/`);
    }
  } catch (e) {
    console.error(`[engram-session-start] Handoff move error:`, e);
  }
};
var handler_default = handler;
export {
  handler_default as default
};
