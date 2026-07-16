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

Rule of thumb: add only self-owned collections here. Child workspaces should
maintain their own embeddings. Watchdog reports missing or over-broad
maintenance allowlists as `WD-QMD-008` / `WD-QMD-009`.

## Commands

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
- Top 2-3 results are usually sufficient
- Read full files only when QMD results indicate need
- Use multi-collection (`-c col1 -c col2`) for cross-cutting searches (e.g., KG + daily notes)
- Use `qmd search` (BM25-only) as fallback when GPU is busy or unavailable
