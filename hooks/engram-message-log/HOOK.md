---
name: engram-message-log
description: "Log incoming messages to JSONL for future pattern-detect analysis"
metadata:
  {
    "openclaw": {
      "emoji": "📝",
      "events": ["message:received"],
      "export": "default"
    }
  }
---

# engram-message-log

Logs incoming messages to `workspace/message-log/YYYY-MM-DD.jsonl` for pattern-detect analysis.

Fields: ts, from, channel, conversationId, messageId, senderName, content (truncated to 500 chars).

Limits:
- Content truncated to 500 chars per message
- File capped at 10 MB/day (stops writing when exceeded)
- Auto-deletes logs older than 7 days
