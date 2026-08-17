#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import {
  acknowledgeRuleActivationNotification,
  listPendingRuleActivationNotifications,
  suspendRulesFromNotification,
} from "../src/oll/adaptation-store";

const command = process.argv[2];
const { values } = parseArgs({
  args: process.argv.slice(3),
  options: {
    workspace: { type: "string", multiple: true },
    "state-root": { type: "string" },
    "notification-id": { type: "string" },
    "message-id-uri": { type: "string" },
    "reply-message-id-uri": { type: "string" },
    items: { type: "string" },
  },
  strict: true,
});

const required = (name: keyof typeof values): string => {
  const value = values[name];
  if (typeof value !== "string" || !value) throw new Error(`--${name} is required`);
  return value;
};

function oneWorkspace(): string {
  const workspaces = values.workspace;
  if (!Array.isArray(workspaces) || workspaces.length !== 1) throw new Error("exactly one --workspace is required");
  return resolve(workspaces[0]);
}

function route(session: string): { channel: "telegram"; chatId: string; target: string; threadId?: string } {
  const direct = /^telegram-direct-(\d+)$/.exec(session);
  if (direct) return { channel: "telegram", chatId: direct[1], target: `telegram:${direct[1]}` };
  const topic = /^telegram-group-(-?\d+)-topic-(\d+)$/.exec(session);
  if (topic) return { channel: "telegram", chatId: topic[1], target: `telegram:${topic[1]}`, threadId: topic[2] };
  const group = /^telegram-group-(-?\d+)$/.exec(session);
  if (group) return { channel: "telegram", chatId: group[1], target: `telegram:${group[1]}` };
  throw new Error(`unsupported notification session: ${session}`);
}

try {
  if (command === "pending") {
    const workspaces = values.workspace;
    if (!Array.isArray(workspaces) || workspaces.length === 0) throw new Error("at least one --workspace is required");
    const deliveries = workspaces.flatMap((workspace) => listPendingRuleActivationNotifications({ workspace: resolve(workspace) }).map((notification) => ({
      workspace: resolve(workspace),
      notificationId: notification.notificationId,
      message: notification.messageText,
      ...route(notification.targetSession),
    })));
    console.log(JSON.stringify({ status: "ok", deliveries }));
  } else if (command === "ack") {
    const notification = acknowledgeRuleActivationNotification({
      workspace: oneWorkspace(),
      notificationId: required("notification-id"),
      messageId: decodeURIComponent(required("message-id-uri")),
    });
    console.log(JSON.stringify({ status: "acknowledged", notification }));
  } else if (command === "rollback") {
    const itemNumbers = required("items").split(",").map((value) => Number(value.trim()));
    const result = suspendRulesFromNotification({
      workspace: oneWorkspace(),
      stateRoot: resolve(required("state-root")),
      notificationId: typeof values["notification-id"] === "string" ? values["notification-id"] : null,
      replyMessageId: typeof values["reply-message-id-uri"] === "string" ? decodeURIComponent(values["reply-message-id-uri"]) : null,
      itemNumbers,
    });
    console.log(JSON.stringify({ status: "reverted", ...result }));
  } else {
    throw new Error("use pending, ack or rollback");
  }
} catch (error: any) {
  console.error(JSON.stringify({ status: "error", error: String(error?.message || error) }));
  process.exit(1);
}
