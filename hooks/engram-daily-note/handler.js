// hooks/engram-daily-note/handler.ts
import { existsSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
var TZ = process.env.ENGRAM_TZ || process.env.TZ || "UTC";
var TEMPLATE = (date) => `# ${date}

## Events

## Decisions

## Learnings

## Active Threads

## Next
`;
var handler = async (event) => {
  if (event.type !== "gateway" || event.action !== "startup")
    return;
  const workspaceDir = event.context?.workspaceDir;
  if (!workspaceDir)
    return;
  const memoryDir = join(workspaceDir, "memory");
  if (!existsSync(memoryDir))
    return;
  const today = new Date().toLocaleDateString("sv-SE", { timeZone: TZ });
  const entries = readdirSync(memoryDir, { withFileTypes: true });
  let created = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("agent-"))
      continue;
    const agentDir = join(memoryDir, entry.name);
    const sessions = readdirSync(agentDir, { withFileTypes: true });
    for (const session of sessions) {
      if (!session.isDirectory())
        continue;
      if (session.name.startsWith("subagent-"))
        continue;
      if (/^cron-.+-run-/.test(session.name))
        continue;
      const notePath = join(agentDir, session.name, `${today}.md`);
      if (existsSync(notePath))
        continue;
      mkdirSync(join(agentDir, session.name), { recursive: true });
      writeFileSync(notePath, TEMPLATE(today));
      created++;
      console.log(`[engram-daily-note] Created ${notePath}`);
    }
  }
  if (created > 0) {
    event.messages?.push(`\uD83D\uDCC5 Created ${created} daily note(s) for ${today}`);
  }
};
var handler_default = handler;
export {
  handler_default as default
};
