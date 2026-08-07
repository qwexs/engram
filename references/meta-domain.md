# Meta-Domain Reference

> Vertical QMD access for upper-level agents (Ур.0, Ур.1) across lower-level workspaces.

## Concept

A **meta-domain** is a domain type that provides vertical QMD access to collections from
lower-level workspaces. It is not tied to a single topic or project — instead, it aggregates
search across multiple workspace collections via the `qmdCollections` field in `registry.json`.

Meta-domains solve the **vertical access** problem: a manager (Ур.1) or director (Ур.0) needs
to search across all projects (Ур.3) and domains, not just their own workspace.

## When to use

| Scenario | Binding type | Example |
|-----------|-------------|---------|
| Topic "General" in a managers group | `topic` | `managers-general` (topic 1 in group -100XXXXXXXXXX) |
| DM of a director | `peer` | `alice-general` (DM chatId 100000001) |
| Group without topics | `group` | Not typical, but supported |

## Creating a meta-domain

```bash
# Meta-domain for a Telegram topic (e.g., General topic in managers group)
bun skills/engram/scripts/add-domain.js --domain managers-general \
  --type meta-domain \
  --topic -100XXXXXXXXXX:1 \
  --qmd-collections "managers-memory,managers-domains,projectA-memory,projectA-domains" \
  --description "General: meta-domain for managers group"

# Meta-domain for a DM (e.g., director's personal assistant)
bun skills/engram/scripts/add-domain.js --domain alice-general \
  --type meta-domain \
  --peer 100000001 \
  --qmd-collections "alice-memory,managers-memory,managers-domains,projectA-memory,projectA-domains" \
  --description "General: meta-domain for Executive A"
```

## Registry schema

```json
{
  "domains": {
    "alice-general": {
      "type": "meta-domain",
      "cadenceDays": 2,
      "staleAfterDays": 90,
      "cadenceAdaptive": true,
      "cadenceAdaptiveWindowDays": 7,
      "peer": { "chatId": "100000001" },
      "description": "General: meta-domain for Executive A",
      "created": "2026-07-14",
      "metaDomain": true,
      "qmdCollections": [
        "alice-memory",
        "managers-memory",
        "managers-domains",
        "projectA-memory",
        "projectA-domains"
      ]
    }
  }
}
```

### Fields

| Field | Required | Description |
|-------|----------|-------------|
| `type` | ✅ | Must be `"meta-domain"` |
| `metaDomain` | ✅ | Must be `true` — marks this as a meta-domain for propagation |
| `qmdCollections` | ✅ | Array of QMD collection names this domain can search |
| `topic` | one of | `{ chatId, topicId }` — if bound to a Telegram topic |
| `peer` | one of | `{ chatId }` — if bound to a DM |
| `group` | one of | `{ chatId }` — if bound to a group without topics |
| `cadenceDays` | optional | Heartbeat cadence (default: 2) |
| `staleAfterDays` | optional | Archive threshold (default: 90) |

## Auto-propagation

When a new domain is created via `add-domain.js`, the script automatically propagates the new
domain's QMD collection names (`domain-{slug}` and `life-projects-{slug}` if KG entity exists)
to all `meta-domain` entries in the same `registry.json`.

This means: **when you add a new project domain, all meta-domains automatically gain access to it.**

### What gets propagated

| New domain creates | Propagated to meta-domains |
|---|---|
| `domain-{slug}` | ✅ Always |
| `life-projects-{slug}` | ✅ If `--kg-entity` is set and entity exists |

### Limitations

- Propagation is **within the same registry.json** only (same workspace).
- Cross-workspace propagation (e.g., adding an initiative domain and updating an executive registry)
  is **not automatic** — it requires manual update or a separate script.
- When a domain is removed, its collections are **not automatically removed** from meta-domain
  `qmdCollections`. Run `engram/scripts/sync-meta-collections.js` (planned) or clean up manually.

## Heartbeat integration

Meta-domains are processed by heartbeat Phase 3 (`hb-domains`) and Phase 3.5 (`hb-domains-write`)
like any other domain. The `domains-runner.js` recognizes `meta-domain` as a valid type with
expected files: `decisions.md`, `status.md`, `changelog.md`.

## Cross-workspace considerations

In a multi-workspace deployment (e.g., AcmeCorp: alice, bob, managers, projectA):

1. **Each workspace has its own `registry.json`** — meta-domains are per-workspace.
2. **QMD collections are global** — any workspace can reference any collection name.
3. **Propagation works within a workspace** — when adding a domain to `managers/`, it propagates
   to meta-domains in the same `managers/registry.json`.
4. **Cross-workspace sync is manual** — adding an initiative domain does not automatically update
   executive workspaces' `qmdCollections`. This is by design: cross-workspace dependencies should
   be explicit.

### Recommended workflow for new projects

```bash
# 1. Create project workspace and QMD collections
qmd collection add /path/to/newproject --name newproject-memory --mask "**/*.md"
qmd collection add /path/to/newproject/memory/domains --name newproject-domains --mask "**/*.md"

# 2. Add domains in the new project workspace
cd /path/to/newproject
bun skills/engram/scripts/add-domain.js --domain newproject-smm \
  --type topic-thread --topic -100XXXXXXXX:NN \
  --description "SMM for new project"

# 3. Manually update meta-domains in upper-level workspaces
#    Add "newproject-memory" and "newproject-domains" to qmdCollections
#    in managers/registry.json, alice/registry.json, bob/registry.json
```

## Drift risks and mitigations

| Risk | Mitigation |
|------|-----------|
| Domain added, meta-domain not updated | Auto-propagation handles same-workspace. Cross-workspace: manual. |
| Domain removed, stale collection in meta-domain | Run `qmd collection list` to verify. Remove stale entries. |
| Collection renamed | Update `qmdCollections` in all meta-domains manually. |
| QMD collection doesn't exist | QMD silently skips missing collections in multi-collection search. |

## File structure

```
memory/domains/{domain-name}/
├── README.md       # Domain description + QMD collections list
├── decisions.md    # Rules and decisions
├── status.md       # Current state
├── changelog.md    # Action log
├── agents.md       # Subagent boilerplate (injected by hooks)
└── archives/       # Changelog rotation
```
