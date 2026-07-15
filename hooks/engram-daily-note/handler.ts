import { existsSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const TZ = process.env.ENGRAM_TZ || process.env.TZ || "UTC";

const TEMPLATE = (date: string) => `# ${date}

## Events

## Decisions

## Learnings

## Active Threads

## Next
`;

const handler = async (event: any) => {
  if (event.type !== "gateway" || event.action !== "startup") return;

  const workspaceDir = event.context?.workspaceDir;
  if (!workspaceDir) return;

  const memoryDir = join(workspaceDir, "memory");
  if (!existsSync(memoryDir)) return;

  const today = new Date().toLocaleDateString("sv-SE", { timeZone: TZ });

  // Scan all agent-* directories
  const entries = readdirSync(memoryDir, { withFileTypes: true });
  let created = 0;

  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("agent-")) continue;

    const agentDir = join(memoryDir, entry.name);
    const sessions = readdirSync(agentDir, { withFileTypes: true });

    for (const session of sessions) {
      if (!session.isDirectory()) continue;
      if (session.name.startsWith("subagent-")) continue;
      if (/^cron-.+-run-/.test(session.name)) continue;

      const notePath = join(agentDir, session.name, `${today}.md`);
      if (existsSync(notePath)) continue;

      mkdirSync(join(agentDir, session.name), { recursive: true });
      writeFileSync(notePath, TEMPLATE(today));
      created++;
      console.log(`[engram-daily-note] Created ${notePath}`);
      // Update heartbeat-state.json: lastDailyNoteCreated.<session> = today
      updateLastDailyNote(workspaceDir, session.name, today);
    }
  }

  if (created > 0) {
    event.messages?.push(`📅 Created ${created} daily note(s) for ${today}`);
  }
};

export default handler;

function updateLastDailyNote(workspaceDir: string, sessionKey: string, date: string) {
  const statePath = join(workspaceDir, "memory", "heartbeat-state.json");
  if (!existsSync(statePath)) return;
  try {
    const raw = readFileSync(statePath, "utf-8");
    const state = JSON.parse(raw);
    if (!state.lastDailyNoteCreated || typeof state.lastDailyNoteCreated !== "object")
      state.lastDailyNoteCreated = {};
    if (state.lastDailyNoteCreated[sessionKey] === date) return;
    state.lastDailyNoteCreated[sessionKey] = date;
    writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");
  } catch (e: any) {
    console.warn(`[engram-daily-note] Could not update heartbeat-state: ${e.message}`);
  }
}
