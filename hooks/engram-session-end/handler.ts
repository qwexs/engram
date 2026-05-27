import { existsSync, appendFileSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";

const TZ = process.env.ENGRAM_TZ || process.env.TZ || "UTC";

/** Get current ISO timestamp with timezone offset */
function localISO(tz: string): string {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: tz,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  }).formatToParts(now);

  const get = (t: string) => parts.find(p => p.type === t)?.value || "00";
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

const handler = async (event: any) => {
  if (event.type !== "command") return;
  if (event.action !== "new" && event.action !== "reset") return;

  const workspaceDir = event.context?.workspaceDir;
  if (!workspaceDir) return;

  const agentId = event.context?.agentId || "main";
  // sessionId may come as "agent:main:main" — extract session segment
  const rawSession = event.context?.sessionId || "main";
  const sessionKey = rawSession.includes(":") ? rawSession.split(":").slice(2).join("-") || "main" : rawSession;

  // Skip ephemeral runtime sessions.
  if (sessionKey.startsWith("subagent-")) return;
  if (/^cron-.+-run-/.test(sessionKey)) return;

  const today = new Date().toLocaleDateString("sv-SE", { timeZone: TZ });
  const notePath = join(workspaceDir, "memory", `agent-${agentId}`, sessionKey, `${today}.md`);

  if (!existsSync(notePath)) return;

  // Avoid duplicate session:end
  const content = readFileSync(notePath, "utf-8");
  const lines = content.trimEnd().split("\n");
  const lastLine = lines[lines.length - 1]?.trim() || "";
  if (lastLine.startsWith("<!-- session:end:")) return;

  const iso = localISO(TZ);
  appendFileSync(notePath, `\n<!-- session:end:${iso} -->\n`);
  console.log(`[engram-session-end] Wrote session:end to ${notePath}`);

  // Update BM25 index so next session starts with fresh search
  try {
    execSync("qmd update", { cwd: workspaceDir, timeout: 15000, stdio: "pipe" });
    console.log(`[engram-session-end] qmd update done`);
  } catch {
    console.log(`[engram-session-end] qmd update skipped (unavailable)`);
  }
};

export default handler;
