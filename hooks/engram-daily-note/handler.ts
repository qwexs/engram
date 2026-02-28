import { existsSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
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

      const notePath = join(agentDir, session.name, `${today}.md`);
      if (existsSync(notePath)) continue;

      mkdirSync(join(agentDir, session.name), { recursive: true });
      writeFileSync(notePath, TEMPLATE(today));
      created++;
      console.log(`[engram-daily-note] Created ${notePath}`);
    }
  }

  if (created > 0) {
    event.messages?.push(`📅 Created ${created} daily note(s) for ${today}`);
  }
};

export default handler;
