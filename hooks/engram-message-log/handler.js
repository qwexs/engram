// hooks/engram-message-log/handler.ts
import { existsSync, mkdirSync, appendFileSync, statSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
var TZ = process.env.ENGRAM_TZ || process.env.TZ || "UTC";
var MAX_FILE_SIZE_MB = 10;
var RETENTION_DAYS = 7;
var MAX_CONTENT_LENGTH = 500;
var handler = async (event) => {
  if (event.type !== "message" || event.action !== "received")
    return;
  const workspaceDir = event.context?.workspaceDir || process.env.OPENCLAW_WORKSPACE || process.env.CLAWD_WORKSPACE || (process.env.USERPROFILE ? join(process.env.USERPROFILE, "clawd") : null) || (process.env.HOME ? join(process.env.HOME, "clawd") : null);
  if (!workspaceDir)
    return;
  const logDir = join(workspaceDir, "workspace", "message-log");
  if (!existsSync(logDir)) {
    mkdirSync(logDir, { recursive: true });
  }
  const today = new Date().toLocaleDateString("sv-SE", { timeZone: TZ });
  const logPath = join(logDir, `${today}.jsonl`);
  const rawContent = event.context?.content || "";
  const content = rawContent.length > MAX_CONTENT_LENGTH ? rawContent.slice(0, MAX_CONTENT_LENGTH) + "…" : rawContent;
  const entry = {
    ts: new Date().toISOString(),
    from: event.context?.from,
    channel: event.context?.channelId,
    conversationId: event.context?.conversationId,
    messageId: event.context?.messageId,
    senderName: event.context?.metadata?.senderName || null,
    content
  };
  if (existsSync(logPath)) {
    try {
      const size = statSync(logPath).size;
      if (size > MAX_FILE_SIZE_MB * 1024 * 1024)
        return;
    } catch {}
  }
  appendFileSync(logPath, JSON.stringify(entry) + `
`);
  try {
    const files = readdirSync(logDir).filter((f) => f.endsWith(".jsonl"));
    const cutoff = new Date;
    cutoff.setDate(cutoff.getDate() - RETENTION_DAYS);
    const cutoffStr = cutoff.toLocaleDateString("sv-SE", { timeZone: TZ });
    for (const file of files) {
      const dateStr = file.replace(".jsonl", "");
      if (dateStr < cutoffStr) {
        unlinkSync(join(logDir, file));
        console.log(`[engram-message-log] Deleted old log: ${file}`);
      }
    }
  } catch {}
};
var handler_default = handler;
export {
  handler_default as default
};
