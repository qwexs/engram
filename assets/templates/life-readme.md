# Knowledge Graph

Structured memory layer based on Tiago Forte's flat three-folder structure (people/projects/archives), extended with atomic facts, memory decay, and automated extraction.

## Structure

```
life/
├── projects/          # Active work with clear goals/deadlines
│   └── <name>/
│       ├── summary.md
│       └── items.json
├── people/            # People (summary.md + items.json per person)
│   └── <name>/
│       ├── summary.md
│       └── items.json
├── archives/          # Inactive items from the other three
├── index.md           # Master index of all entities
└── README.md          # This file
```

## Three Folders

- **People** — Individuals the agent interacts with or knows about.
- **Projects** — Everything active: projects, tools, infrastructure, groups, services. If it's not a person and not archived, it's here.
- **Archives** — Inactive items. Nothing gets deleted, just moved here.

Simple routing: person → `people/`, archived → `archives/`, everything else → `projects/`.

## Tiered Retrieval

Each entity has two files:

1. **summary.md** — Concise overview. Load first for quick context.
2. **items.json** — Array of atomic facts. Load only when granular detail needed.

This keeps context windows lean. Most conversations only need the summary.

## Atomic Fact Schema (items.json)

```json
[
  {
    "id": "<entity>-001",
    "fact": "Human-readable fact statement",
    "category": "relationship|milestone|status|preference|context",
    "confidence": 0.85,
    "abstractionLevel": "episode|pattern|principle",
    "tags": ["tag1", "tag2"],
    "timestamp": "2026-02-08",
    "source": "2026-02-07",
    "status": "active|superseded",
    "supersededBy": null,
    "relatedEntities": ["people/alice", "projects/projectmix"],
    "lastAccessed": "2026-02-08",
    "accessCount": 1
  }
]
```

### Fields

| Field | Description |
|-------|-------------|
| `id` | Unique ID within the entity: `<entity-slug>-NNN` |
| `fact` | Human-readable fact statement |
| `category` | One of: `relationship`, `milestone`, `status`, `preference`, `context` |
| `confidence` | Float 0.0-1.0. How certain we are about this fact (see Confidence Rubric) |
| `abstractionLevel` | One of: `episode`, `pattern`, `principle` (see Abstraction Levels) |
| `tags` | Array of strings for additional categorization and search |
| `timestamp` | When the fact became true (ISO date) |
| `source` | Where the fact was learned (daily note date, conversation, etc.) |
| `status` | `active` or `superseded` — facts are NEVER deleted |
| `supersededBy` | ID of the fact that replaced this one (null if active) |
| `relatedEntities` | Cross-references to other entities (relative paths within life/) |
| `lastAccessed` | Last time this fact was used in a conversation |
| `accessCount` | Number of times this fact has been accessed |

### Confidence Rubric

| Score | Meaning | Example |
|-------|---------|---------|
| 1.0 | Stated directly by user | "I use VS Code" |
| 0.8-0.9 | Extracted from explicit conversation context | User discussed a project → infer involvement |
| 0.5-0.7 | Indirect inference | Mentioned in passing, inferred from behavior |
| 0.1-0.4 | Unconfirmed, hearsay | Third-party mention, speculative |

### Abstraction Levels

| Level | Name | Description | Decay behavior |
|-------|------|-------------|----------------|
| L1 | `episode` | Specific event or action (e.g., "Deployed v2.0 on 2026-02-10") | Standard decay |
| L2 | `pattern` | Recurring behavior or ongoing state (e.g., "Prefers Bun over Node") | Included in summary if Warm+ |
| L3 | `principle` | Timeless truth or rule (e.g., "Never delete facts, only supersede") | Always included in summary |

### Categories

- **relationship** — How entities relate to each other
- **milestone** — Significant events, achievements, transitions
- **status** — Current state (job title, project phase, etc.)
- **preference** — Likes, dislikes, working style
- **context** — Background information, descriptive facts

### No-Deletion Rule

Facts are NEVER deleted. When something changes:
1. Set old fact `status` to `"superseded"`
2. Set old fact `supersededBy` to the new fact's ID
3. Create new fact with `status: "active"`

This preserves full history. The `supersededBy` chain traces evolution over time.

## Memory Decay

### Access Tracking

Every time a fact is used in conversation:
1. Increment `accessCount`
2. Set `lastAccessed` to today

### Recency Tiers

During weekly summary synthesis, facts are sorted into three tiers:

| Tier | Recency | In summary.md? | Notes |
|------|---------|-----------------|-------|
| **Hot** | Accessed in last 7 days | Yes (prominent) | Front-of-mind |
| **Warm** | Accessed 8-30 days ago | Yes (lower priority) | Available but secondary |
| **Cold** | Not accessed in 30+ days | No (omitted) | Still in items.json, searchable via QMD |

**Low-confidence acceleration:** Facts with `confidence < 0.5` use a Cold threshold of 14 days instead of 30.

### Frequency Resistance

Facts with high `accessCount` resist decay. A frequently-referenced fact stays Warm even after a few weeks of inactivity.

Rule of thumb: `accessCount >= 10` bumps Cold to Warm.

### Weekly Synthesis

The agent rewrites `summary.md` from active facts during heartbeats (weekly):
1. Load all facts with `status: "active"` from `items.json`
2. Sort by tier: Hot > Warm > Cold
3. Within each tier, sort by `accessCount` (descending)
4. **Abstraction-aware inclusion:**
   - `principle` (L3) — always include in summary regardless of tier
   - `pattern` (L2) — include if Warm or Hot
   - `episode` (L1) — standard decay rules
5. Write included facts into `summary.md`
6. Omit Cold episodes from summary (they remain searchable in items.json)

## Entity Creation Rules

Not every noun deserves an entity. Create one when:
- Mentioned **3+ times** across conversations
- Has a **direct relationship** to the user
- Is a **significant project, person, or company** in the user's life

Otherwise, capture in daily notes and let it live there.

## Privacy

- Knowledge graph is **main session ONLY** (same isolation as MEMORY.md)
- Group chats (Telegram, Discord) **CANNOT access** life/ directory
- Session-specific user profiles in `memory/` remain separate
- Global entities here are the richer, cross-session personal knowledge

## QMD Integration

```bash
# Search knowledge graph
qmd query "topic" -c life

# After changes
qmd update
```

Collection: `life` (path: `life/`, mask: `**/*.md`)

## Heartbeat Extraction

During periodic heartbeats, the agent:
1. Scans recent daily notes for new information
2. Extracts durable facts (relationships, status changes, milestones, decisions)
3. Writes facts to appropriate entity `items.json`
4. Updates `summary.md` when new Hot facts arrive
5. Creates new entities when creation rules are met
6. Runs `qmd update` after changes

Extraction deliberately skips: casual chat, transient requests, already-captured information.
