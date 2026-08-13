import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const TZ = process.env.ENGRAM_TZ || process.env.TZ || "UTC";

const handler = async (event: any) => {
  if (event.type !== "gateway" || event.action !== "startup") return;

  const workspaceDir = event.context?.workspaceDir;
  if (!workspaceDir) return;

  const memoryDir = join(workspaceDir, "memory");
  if (!existsSync(memoryDir)) return;

  const today = new Date().toLocaleDateString("sv-SE", { timeZone: TZ });

  // Scan all agent-* directories
  const entries = readdirSync(memoryDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("agent-")) continue;

    const agentDir = join(memoryDir, entry.name);
    const sessions = readdirSync(agentDir, { withFileTypes: true });

    for (const session of sessions) {
      if (!session.isDirectory()) continue;
      if (session.name.startsWith("subagent-")) continue;
      if (/^cron-.+-run-/.test(session.name)) continue;

      const notePath = join(agentDir, session.name, `${today}.md`);
      // Gateway startup must not materialize a note for every historical
      // session directory. Active sessions create their note lazily in the
      // agent:bootstrap hook; here we only reconcile state for notes that
      // already exist.
      if (existsSync(notePath)) updateLastDailyNote(workspaceDir, session.name, today);
    }
  }
};

export default handler;

function updateLastDailyNote(workspaceDir: string, sessionKey: string, date: string) {
  const statePath = join(workspaceDir, "memory", "heartbeat-state.json");
  if (!existsSync(statePath)) return;
  try {
    const raw = readFileSync(statePath, "utf-8");
    const state = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
    if (!state.lastDailyNoteCreated || typeof state.lastDailyNoteCreated !== "object")
      state.lastDailyNoteCreated = {};
    if (state.lastDailyNoteCreated[sessionKey] === date) return;
    state.lastDailyNoteCreated[sessionKey] = date;
    writeJsonAtomic(statePath, state);
  } catch (e: any) {
    console.warn(`[engram-daily-note] Could not update heartbeat-state: ${e.message}`);
  }
}

function writeJsonAtomic(path: string, value: any) {
  const tmp = `${path}.tmp-${randomUUID()}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  renameSync(tmp, path);
}
