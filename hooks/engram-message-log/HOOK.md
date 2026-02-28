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

Logs all incoming messages to `workspace/message-log/YYYY-MM-DD.jsonl`.

Fields: ts, from, channel, conversationId, messageId, senderName, content (full text).

Full text is stored for pattern-detect.js analysis. After testing, will switch to preview-only mode.
