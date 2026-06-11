#!/usr/bin/env bun
/**
 * deliver-research.js — Morning delivery processor for research results
 *
 * Usage:
 *   bun skills/engram/scripts/deliver-research.js [--dry-run] [--force]
 *
 * Reads delivery queue and outputs messages for agent to send via message tool.
 * Only delivers during 8:00-10:00 Moscow time (unless --force).
 *
 * Exit codes:
 *   0 — all deliveries processed (or dry-run)
 *   1 — error
 */

import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { readFileSync, writeFileSync, readdirSync, existsSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKSPACE = process.env.ENGRAM_WORKSPACE || process.cwd() || join(__dirname, "..", "..", "..");
const QUEUE_DIR = join(WORKSPACE, "workspace", "research", "delivery-queue");
const RESEARCH_DIR = join(WORKSPACE, "workspace", "research");

// --- Arg parsing ---
const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const force = argv.includes("--force");

// --- Time check: only deliver during 8:00-10:00 Moscow time ---
function isDeliveryWindow() {
  if (force) return true;
  
  const now = new Date();
  // Moscow timezone: UTC+3
  const moscowHour = (now.getUTCHours() + 3) % 24;
  
  return moscowHour >= 8 && moscowHour < 10;
}

// --- Main ---
try {
  if (!existsSync(QUEUE_DIR)) {
    if (dryRun) {
      console.log("[deliver-research] No delivery queue found");
    }
    process.exit(0);
  }
  
  const files = readdirSync(QUEUE_DIR).filter(f => f.endsWith(".json"));
  
  if (!files.length) {
    if (dryRun) {
      console.log("[deliver-research] Queue is empty");
    }
    process.exit(0);
  }
  
  // Read all pending deliveries
  const pending = [];
  for (const file of files) {
    try {
      const content = readFileSync(join(QUEUE_DIR, file), "utf-8");
      const item = JSON.parse(content);
      
      if (!item.delivered) {
        pending.push({ file, item });
      }
    } catch (e) {
      console.error(`[deliver-research] Failed to read ${file}: ${e.message}`);
    }
  }
  
  if (!pending.length) {
    if (dryRun) {
      console.log("[deliver-research] No pending deliveries");
    }
    process.exit(0);
  }
  
  // Check time window
  if (!isDeliveryWindow()) {
    if (dryRun) {
      console.log(`[deliver-research] ${pending.length} pending, but outside delivery window (8-10 MSK)`);
    }
    process.exit(0);
  }
  
  // Dry run: just report what would be delivered
  if (dryRun) {
    console.log(`[deliver-research] ${pending.length} pending deliveries:`);
    for (const { item } of pending) {
      console.log(`  - ${item.experiment_id}: ${item.message.slice(0, 60)}...`);
    }
    process.exit(0);
  }
  
  // Load experiment specs to get chat_id
  const messages = [];
  
  for (const { file, item } of pending) {
    const expId = item.experiment_id;
    const specPath = join(RESEARCH_DIR, expId, "spec.yaml");
    
    let chatId = item.chat_id;
    
    // If chat_id not in queue item, read from spec
    if (!chatId) {
      try {
        const { parseYAML } = await import("./experiment-spec.js");
        const specContent = readFileSync(specPath, "utf-8");
        const spec = parseYAML(specContent);
        chatId = spec?.delivery?.group_notify?.chat_id || null;
      } catch (e) {
        console.error(`[deliver-research] Failed to read spec for ${expId}: ${e.message}`);
        continue;
      }
    }
    
    if (!chatId) {
      console.error(`[deliver-research] No chat_id for ${expId}, skipping`);
      continue;
    }
    
    messages.push({
      chat_id: chatId,
      message: item.message,
      experiment_id: expId,
      queueFile: join(QUEUE_DIR, file),
    });
  }
  
  // Combine multiple messages to same chat into digest (if needed)
  const byChat = {};
  for (const msg of messages) {
    if (!byChat[msg.chat_id]) byChat[msg.chat_id] = [];
    byChat[msg.chat_id].push(msg);
  }
  
  // Output delivery instructions (agent will parse and send via message tool)
  for (const [chatId, msgs] of Object.entries(byChat)) {
    if (msgs.length === 1) {
      // Single message
      console.log(JSON.stringify({
        action: "send",
        chat_id: chatId,
        message: msgs[0].message,
        experiment_id: msgs[0].experiment_id,
      }));
    } else {
      // Multiple messages → combine into digest
      const digest = `📊 Итоги исследований:\n\n` + msgs.map((m, i) => 
        `${i + 1}. ${m.message.replace(/\n+/g, " ")}`
      ).join("\n\n");
      
      console.log(JSON.stringify({
        action: "send",
        chat_id: chatId,
        message: digest,
        experiment_ids: msgs.map(m => m.experiment_id),
      }));
    }
    
    // Mark as delivered
    for (const msg of msgs) {
      try {
        const queueItem = JSON.parse(readFileSync(msg.queueFile, "utf-8"));
        queueItem.delivered = true;
        queueItem.delivered_at = new Date().toISOString();
        writeFileSync(msg.queueFile, JSON.stringify(queueItem, null, 2));
      } catch (e) {
        console.error(`[deliver-research] Failed to mark ${msg.experiment_id} as delivered: ${e.message}`);
      }
    }
  }
  
  console.log(`[deliver-research] ✅ ${messages.length} deliveries processed`);
  process.exit(0);
} catch (e) {
  console.error(`[deliver-research] Error: ${e.message}`);
  process.exit(1);
}
