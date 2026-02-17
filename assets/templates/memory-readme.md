# Memory Structure - Session-Based Isolation

This directory contains session-separated memory for OpenClaw agent.

## Architecture: Session Keys

OpenClaw uses **session keys** to identify isolated contexts:

```
agent:<agentId>:<sessionKey>
```

**Examples:**
- `agent:{{AGENT_ID}}:main` — Personal chat (main session)
- `agent:{{AGENT_ID}}:telegram:group:-100XXXXXXXXXX` — Telegram group
- `agent:{{AGENT_ID}}:discord:channel:XXXXXXXXXX` — Discord channel

### Session Key → File Path Mapping

Session keys contain colons (`:`) which are problematic for file paths on Windows/macOS.

**Mapping rule:**
1. Extract platform and ID from session key
2. Drop intermediate qualifiers (`group:`, `channel:`, etc.)
3. Use format: `{platform}-{id}` (removing `-100` prefix for Telegram supergroups)

**Examples:**
| Session Key | Memory Path |
|-------------|-------------|
| `agent:{{AGENT_ID}}:main` | `memory/agent-{{AGENT_ID}}/main/` |
| `agent:{{AGENT_ID}}:telegram:group:-100XXXXXXXXXX` | `memory/agent-{{AGENT_ID}}/telegram-XXXXXXXXXX/` |
| `agent:{{AGENT_ID}}:discord:channel:XXXXXXXXXX` | `memory/agent-{{AGENT_ID}}/discord-XXXXXXXXXX/` |

## Why Session-Based Isolation?

**Security & Privacy**: Different sessions (personal chat, group chats, Discord channels) should NOT share memory. This prevents:
- Personal information leaking to group chats
- Group discussions appearing in personal memory
- Cross-contamination between different communities

## Directory Structure

```
memory/
  agent-{{AGENT_ID}}/
    main/                                    # agent:{{AGENT_ID}}:main
      YYYY-MM-DD.md                          # Daily notes (personal)
      archives/YYYY-MM/                      # Rotated daily notes
    
    telegram-{id}/                           # agent:{{AGENT_ID}}:telegram-{id}
      YYYY-MM-DD.md                          # Daily notes (group)
      users/                                 # Group participant profiles
      knowledge/                             # Group knowledge base
    
    discord-{id}/                            # agent:{{AGENT_ID}}:discord-{id} (future)
      YYYY-MM-DD.md
  
  templates/
    group-knowledge/                         # Templates for new groups
      clients.md
      contacts.md
      decisions.md
      resources.md
  
  README.md
```

## Session Types

### Main Session (`agent:{{AGENT_ID}}:main`)
- **Access**: Full access to MEMORY.md + life/ (Knowledge Graph)
- **QMD Collection**: `openclaw-memory-agent-{{AGENT_ID}}-main`
- **Privacy**: Highest — contains personal decisions, learnings, preferences

### Group Sessions (`agent:{{AGENT_ID}}:{platform}-{id}`)
- **Access**: NO access to MEMORY.md or other sessions
- **QMD Collection**: `openclaw-memory-agent-{{AGENT_ID}}-{platform}-{id}`
- **Privacy**: Group-isolated — only this group's context

## Rules

1. **NEVER cross session boundaries** — personal ≠ groups ≠ channels
2. **Each session has its own daily notes** (`YYYY-MM-DD.md`)
3. **MEMORY.md is ONLY for main session** (root-level file, not per-session)
4. **QMD search MUST use `-c` flag** to specify session collection
5. **No references between sessions** — treat each as independent

## QMD Collections

```bash
# Main session search
qmd query "topic" -c openclaw-memory-agent-{{AGENT_ID}}-main

# Group session search
qmd query "topic" -c openclaw-memory-agent-{{AGENT_ID}}-{platform}-{id}
```

**Collection naming pattern:** `openclaw-memory-agent-{agentId}-{sessionKey}`

## Creating New Sessions

Use the add-session script:
```bash
bun skills/engram/scripts/add-session.js --platform telegram --id {groupId}
```

Or manually:
1. Create `memory/agent-{{AGENT_ID}}/{platform}-{id}/`
2. Copy `memory/templates/group-knowledge/` → `knowledge/`
3. Add QMD collection
4. Add session key to `memory/heartbeat-state.json` → `lastDailyNoteCreated`
5. Run `qmd update`

## Daily Note Rotation

When a daily note exceeds **1000 lines**, during heartbeat:
- Moved to `memory/agent-{{AGENT_ID}}/{session}/archives/YYYY-MM/YYYY-MM-DD.md`
- Replaced with stub: `# YYYY-MM-DD` + `(rotated, see archives/)`
- Archives indexed by QMD and searchable
