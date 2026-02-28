import { existsSync, mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";

const TZ = process.env.ENGRAM_TZ || process.env.TZ || "UTC";

const handler = async (event: any) => {
  if (event.type !== "message" || event.action !== "received") return;

  const workspaceDir =
    event.context?.workspaceDir ||
    process.env.OPENCLAW_WORKSPACE ||
    process.env.CLAWD_WORKSPACE ||
    (process.env.USERPROFILE ? join(process.env.USERPROFILE, "clawd") : null) ||
    (process.env.HOME ? join(process.env.HOME, "clawd") : null);
  if (!workspaceDir) return;

  const logDir = join(workspaceDir, "workspace", "message-log");
  if (!existsSync(logDir)) {
    mkdirSync(logDir, { recursive: true });
  }

  const today = new Date().toLocaleDateString("sv-SE", { timeZone: TZ });
  const logPath = join(logDir, `${today}.jsonl`);

  const entry = {
    ts: new Date().toISOString(),
    from: event.context?.from,
    channel: event.context?.channelId,
    conversationId: event.context?.conversationId,
    messageId: event.context?.messageId,
    senderName: event.context?.metadata?.senderName || null,
    content: event.context?.content || "",
  };

  appendFileSync(logPath, JSON.stringify(entry) + "\n");
};

export default handler;
