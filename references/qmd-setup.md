# QMD Setup

QMD provides hybrid search (BM25 + vector embeddings + rerank) for the memory system.

## Installation

Two variants available:

### Local (GPU via Vulkan/CUDA)
```bash
npm i -g @nicepkg/qmd
```
- Uses local llama.cpp for embeddings
- Requires GPU (Vulkan or CUDA)
- Zero external API calls

### Jina Fork (API-based, no GPU needed)
```bash
npm i -g @qwexs/qmd
```
- Uses Jina AI API for embeddings and reranking
- No GPU required
- Requires `JINA_API_KEY`

## Environment Variables (Jina Fork)

```bash
QMD_LLM_PROVIDER=jina              # Enable Jina provider
JINA_API_KEY=xxx                    # Required
JINA_PROXY_URL=http://proxy:8080   # Optional proxy
JINA_EMBED_MODEL=jina-embeddings-v3           # Default
JINA_RERANK_MODEL=jina-reranker-v2-base-multilingual  # Default
JINA_EMBED_DIMENSIONS=1024         # Default
```

## Environment Variables (OpenAI Provider)

```bash
QMD_LLM_PROVIDER=openai
OPENAI_API_KEY=sk-proj-xxx
# Optional:
OPENAI_EMBED_MODEL=text-embedding-3-small
OPENAI_GENERATE_MODEL=gpt-4o-mini
OPENAI_BASE_URL=https://your-provider.com/v1
```

## Environment Variables (Ollama Provider)

Use [Ollama Cloud](https://ollama.com/cloud) or a self-hosted Ollama instance.
Same provider — flip `OLLAMA_BASE_URL` to point at the local server.

```bash
QMD_LLM_PROVIDER=ollama
# Cloud (Ollama API key from https://ollama.com/settings/keys):
OLLAMA_API_KEY=ollama_xxx
# Self-hosted (default base URL is https://ollama.com; override for local instance):
# OLLAMA_BASE_URL=http://localhost:11434
# Optional:
OLLAMA_EMBED_MODEL=nomic-embed-text      # default; also mxbai-embed-large, embeddinggemma, qwen3-embedding:0.6b
OLLAMA_EMBED_DIMENSIONS=                 # default — model decides (nomic = 768)
OLLAMA_PROXY_URL=                        # optional HTTP proxy
```

> **Search-only:** Ollama has no native `/api/rerank`. Rerank uses cosine
> similarity over the embeddings (slightly different ranking from Jina's
> trained reranker — usually fine for BM25-first hybrid search). Skip
> Ollama if you depend on cross-encoder rerank quality.

## Collections

The memory system uses these QMD collections:

| Collection | Path | Mask | Purpose |
|-----------|------|------|---------|
| `openclaw-root` | workspace root | `*.md` | Root files (SOUL.md, AGENTS.md, etc.) |
| `openclaw-memory-agent-{id}-main` | `memory/agent-{id}/main/` | `**/*.md` | Main session memory |
| `openclaw-memory-agent-{id}-{platform}-{groupId}` | `memory/agent-{id}/{platform}-{groupId}/` | `**/*.md` | Group session memory |
| `life` | `life/` | `**/*.md` | Knowledge Graph |
| `domains` | `memory/domains/` | `**/*.md` | Subagent domain files |

### Adding a Collection

```bash
qmd collection add <path> --name <name> --mask "**/*.md"
```

### Listing Collections

```bash
qmd collection list
```

### Maintenance Allowlist

Upper-level workspaces may register lower-level collections for vertical read
access (for example via meta-domain `qmdCollections`). Keep those collections
available for explicit `qmd query -c ...` calls, but do not make the upper
workspace re-embed them on every heartbeat.

Use `engram.json` `qmd.collections` as the heartbeat maintenance allowlist:

```json
{
  "qmd": {
    "collection": "openclaw-memory-agent-main-main",
    "collections": [
      "openclaw-memory-agent-main-main",
      "life",
      "openclaw-root"
    ]
  }
}
```

For the legacy isolated topology, add only self-owned collections here.
Embeddings are physical-index local: a vector created in a child SQLite is not
available to an upper SQLite. Therefore isolated vertical hybrid search either
duplicates vectors in the upper index or requires federation; child
maintenance alone can provide only child-index search, not parent-index vector
coverage. Watchdog reports missing or over-broad legacy maintenance allowlists
as `WD-QMD-008` / `WD-QMD-009`.

## Physical index and embed concurrency

An index is a physical SQLite file, not a persistent QMD process. With normal
CLI usage, each `qmd embed` invocation starts its own process, loads the model,
and releases it when the command exits.

The Takeron target is one global physical index with unique collections.
Workspace/session collection scope controls access; the shared SQLite stores
each document and vector once. Main uses the same index but its readable scope
contains only technical collections.

The QMD embed lock protects that physical index. The Engram coordinator adds a
longer maintenance lease and dirty generations so all workspace writes become
one index-wide `update` followed by one explicit multi-collection incremental
`embed`. Routine maintenance never uses `-f`.

Until the topology rollout, workspace-local `.qmd/index.sqlite` files remain
active. Separate indexes have separate QMD locks and could still load several
models concurrently, so legacy heartbeat jobs stay disabled or staggered and
manual backfill remains sequential. The coordinator/core PR does not migrate
or delete those indexes.

## Commands

Для новых operator read-вызовов используйте Engram CLI. Он сам выбирает workspace, QMD selector и физический индекс, а коллекции проверяет до запуска QMD.

```bash
bun bin/engram --workspace /path/to/workspace qmd resolve
bun bin/engram --workspace /path/to/workspace qmd capabilities
bun bin/engram --workspace /path/to/workspace qmd status
bun bin/engram --workspace /path/to/workspace qmd doctor --strict

bun bin/engram --workspace /path/to/workspace \
  qmd search "search text" -c <collection>
bun bin/engram --workspace /path/to/workspace \
  qmd query "search text" -c <collection> -c <collection>
```

Новая команда без `-c` или с коллекцией вне readable allowlist завершится до `Bun.spawn`. CLI не экспортирует raw `update` и `embed`: maintenance coordinator использует общий core, а существующие production call sites остаются legacy до отдельного rollout.

Ниже приведены прямые команды QMD для настройки коллекций, maintenance и диагностики legacy-интеграций. Не добавляйте новые raw QMD-вызовы в runtime-код: architecture audit фиксирует текущий migration debt.

```bash
# Hybrid search (BM25 + vectors + rerank)
qmd query "search text" -c <collection>

# Multi-collection search
qmd query "search text" -c life -c openclaw-memory-agent-main-main

# BM25-only search (no GPU, faster)
qmd search "search text" -c <collection>

# Update BM25 index (CPU, instant) — run after any file changes
qmd update

# Update vector embeddings (GPU or Jina API)
qmd embed

# Add collection
qmd collection add <path> --name <name> --mask "<pattern>"

# List collections
qmd collection list
```

## Strategy

- Use `qmd query` with `-c` flag for session-isolated search
- Run `qmd update` after writing new memory (instant, safe to run often)
- Run `qmd embed` during heartbeats only (resource-intensive)
- Treat the index-local lock as a correctness guard, not a host-wide resource limiter
- Top 2-3 results are usually sufficient
- Read full files only when QMD results indicate need
- Use multi-collection (`-c col1 -c col2`) for cross-cutting searches (e.g., KG + daily notes)
- Use `qmd search` (BM25-only) as fallback when GPU is busy or unavailable

CLI contract и JSON schemas: [qmd-cli.md](qmd-cli.md). Production canary и rollback: [qmd-cli-rollout.md](qmd-cli-rollout.md).
