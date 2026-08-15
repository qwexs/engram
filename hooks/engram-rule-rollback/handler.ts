import { resolve } from "node:path";
import { suspendRulesFromNotification } from "../../src/oll/adaptation-store.js";

function replyMessageId(context: any): string | null {
  const metadata = context?.metadata || {};
  const candidates = [
    context?.replyToMessageId,
    context?.reply_to_message_id,
    context?.replyTo?.messageId,
    context?.replyTo?.message_id,
    metadata.replyToMessageId,
    metadata.reply_to_message_id,
    metadata.replyTo?.messageId,
    metadata.replyTo?.message_id,
    metadata.quotedMessageId,
  ];
  const value = candidates.find((candidate) => candidate !== null && candidate !== undefined && String(candidate).trim());
  return value === undefined ? null : String(value);
}

const handler = async (event: any) => {
  if (event.type !== "message" || event.action !== "received") return;
  const match = /^\s*отменить\s+(\d+(?:\s*,\s*\d+)*)[.!]?\s*$/iu.exec(String(event.context?.content || ""));
  if (!match) return;
  const replyId = replyMessageId(event.context);
  if (!replyId) return;
  const workspace = event.context?.workspaceDir || process.env.OPENCLAW_WORKSPACE || process.env.CLAWD_WORKSPACE;
  if (!workspace) return;
  const stateRoot = process.env.ENGRAM_STATE_ROOT || "/opt/openclaw/state/engram";
  try {
    const result = suspendRulesFromNotification({
      workspace: resolve(workspace),
      stateRoot: resolve(stateRoot),
      replyMessageId: replyId,
      itemNumbers: match[1].split(",").map((value) => Number(value.trim())),
    });
    if (Array.isArray(event.messages)) {
      event.messages.push(`[OLL rollback applied] Приостановлены пункты ${match[1]} из сообщения ${replyId}. Rule IDs: ${result.suspendedRuleIds.join(", ")}. Подтверди пользователю отмену; не запускай повторную отмену.`);
    }
  } catch (error: any) {
    if (Array.isArray(event.messages)) {
      event.messages.push(`[OLL rollback not applied] Команда отмены не выполнена: ${String(error?.message || error)}. Сообщи пользователю кратко и не утверждай, что правило отменено.`);
    }
  }
};

export default handler;
