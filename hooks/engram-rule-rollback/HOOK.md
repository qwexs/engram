---
name: engram-rule-rollback
description: "Suspend optimistic OLL rules when a user replies to their notification with numbered items"
metadata:
  {
    "openclaw": {
      "emoji": "↩️",
      "events": ["message:received"],
      "export": "default"
    }
  }
---

# engram-rule-rollback

Recognizes an exact reply such as `Отменить 1` or `Отменить 1, 2` to an
`oll.rule-activation-notification.v1` message. The selected canonical rules are
changed from `active` to `suspended`; no rule or audit history is deleted. A
system context note is added so the active agent can confirm the rollback.
