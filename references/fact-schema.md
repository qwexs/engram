# Atomic Fact Schema v2

## Schema

Each fact in `items.json` follows this structure:

```json
{
  "id": "<entity>-NNN",
  "fact": "Human-readable fact statement",
  "category": "relationship|milestone|status|preference|context",
  "confidence": 0.85,
  "abstractionLevel": "episode|pattern|principle",
  "tags": ["tag1", "tag2"],
  "timestamp": "2026-02-08",
  "source": "2026-02-07",
  "status": "active|superseded",
  "supersededBy": null,
  "relatedEntities": ["people/sergey", "projects/projectmix"],
  "lastAccessed": "2026-02-08",
  "accessCount": 1
}
```

## Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique ID: `<entity-slug>-NNN` |
| `fact` | string | Human-readable fact statement |
| `category` | enum | `relationship`, `milestone`, `status`, `preference`, `context` |
| `confidence` | float | 0.0-1.0 certainty score |
| `abstractionLevel` | enum | `episode`, `pattern`, `principle` |
| `tags` | string[] | Free-form labels for search |
| `timestamp` | date | When the fact became true |
| `source` | string | Where learned (daily note date, etc.) |
| `status` | enum | `active` or `superseded` |
| `supersededBy` | string? | ID of replacing fact (null if active) |
| `relatedEntities` | string[] | Cross-references (relative paths in life/) |
| `lastAccessed` | date | Last conversation use |
| `accessCount` | int | Times accessed |

## Confidence Rubric

| Score | Meaning | Example |
|-------|---------|---------|
| 1.0 | Stated directly by user | "I use VS Code" |
| 0.8-0.9 | Extracted from explicit context | User discussed project → infer involvement |
| 0.5-0.7 | Indirect inference | Mentioned in passing |
| 0.1-0.4 | Unconfirmed, hearsay | Third-party mention |

## Abstraction Levels

| Level | Name | Description | Decay |
|-------|------|-------------|-------|
| L1 | `episode` | Specific event ("Deployed v2.0 on 2026-02-10") | Standard |
| L2 | `pattern` | Recurring behavior ("Prefers Bun over Node") | In summary if Warm+ |
| L3 | `principle` | Timeless rule ("Never delete facts") | Always in summary |

## Categories

- **relationship** — How entities relate to each other
- **milestone** — Significant events, achievements, transitions
- **status** — Current state (job title, project phase, etc.)
- **preference** — Likes, dislikes, working style
- **context** — Background information, descriptive facts
- **decision** — Explicit decisions made (architectural, process, tooling)
- **correction** — Updates to previous facts (supersedes old info)

## No-Deletion Rule

Facts are **NEVER deleted**. When something changes:

1. Set old fact `status` to `"superseded"`
2. Set old fact `supersededBy` to the new fact's ID
3. Create new fact with `status: "active"`

The `supersededBy` chain traces evolution over time.

## Access Tracking

Every time a fact is used in conversation:
1. Increment `accessCount`
2. Set `lastAccessed` to today

This drives memory decay — see [decay-rules.md](decay-rules.md).
