# PR3 main canary tooling runbook

These commands are intentionally inert until the operator supplies a reviewed
registry and canary manifest. They must be run from the canonical Engram
checkout. The plan command is the default and performs no writes.

```bash
bun scripts/kg-v3-canary.ts plan \
  --workspace /opt/openclaw/workspace --workspace-id main \
  --manifest /opt/openclaw/workspace/memory-state/kg-v3/canary-manifest.json

bun scripts/install-hooks.js --skill-dir /opt/openclaw/workspace/skills/engram \
  --hooks-dir /opt/openclaw/state/hooks --dry-run

bun scripts/kg-v3-canary.ts begin --ack-canary-begin \
  --workspace /opt/openclaw/workspace --workspace-id main \
  --manifest /opt/openclaw/workspace/memory-state/kg-v3/canary-manifest.json

# Read-only preview of the operator-controlled replay of the reviewed 20-30
# previously explicit user statements (this is not live-turn ingress):
bun scripts/kg-v3-canary-execute.ts plan \
  --workspace /opt/openclaw/workspace --workspace-id main \
  --manifest /opt/openclaw/workspace/memory-state/kg-v3/canary-manifest.json \
  --runtime-grants /opt/openclaw/workspace/memory-state/kg-v3/runtime-grants.json

# Execute the exact immutable manifest through TrustedKgRuntime. The executor
# constructs attested metadata from each request provenance and its unique
# grant binding, then derives every receipt from the canonical journal:
bun scripts/kg-v3-canary-execute.ts execute --ack-reviewed-replay \
  --workspace /opt/openclaw/workspace --workspace-id main \
  --manifest /opt/openclaw/workspace/memory-state/kg-v3/canary-manifest.json \
  --runtime-grants /opt/openclaw/workspace/memory-state/kg-v3/runtime-grants.json

bun scripts/kg-v3-canary.ts finalize --ack-canary-finalize \
  --workspace /opt/openclaw/workspace --workspace-id main \
  --manifest /opt/openclaw/workspace/memory-state/kg-v3/canary-manifest.json

bun scripts/kg-context-resolve.ts \
  --workspace /opt/openclaw/workspace --workspace-id main

bun scripts/kg-v3-canary.ts rollback --ack-rollback \
  --workspace /opt/openclaw/workspace --workspace-id main \
  --manifest /opt/openclaw/workspace/memory-state/kg-v3/canary-manifest.json
```

Hook installation and gateway restart are separate operator-controlled live
steps after code, manifest, benchmark, and dry-run gates. PR3 tooling does not
install hooks, restart the gateway, or create live registry/authority files.
The replay executor is deliberately not live-turn ingress. `TrustedKgRuntime`
is the adapter boundary; live OpenClaw turn registration is the separately
gated main-canary completion step below, before PR4 fleet rollout.

## Main-only live-turn completion gate

After the reviewed replay, read-back, benchmark, rollback drill, and guarded
context hook are green, the OpenClaw adapter is installed dormant and activated
with a separate local projection:

```bash
bun scripts/kg-v3-live-ingress.ts plan \
  --workspace /opt/openclaw/workspace --workspace-id main

bun scripts/kg-v3-live-ingress.ts install \
  --workspace /opt/openclaw/workspace --workspace-id main \
  --ack-plugin-install

# Operator restarts and verifies the gateway here. The plugin is still dormant
# because live-ingress.json does not exist yet.

bun scripts/kg-v3-live-ingress.ts activate \
  --workspace /opt/openclaw/workspace --workspace-id main \
  --approved-by '<operator authority>' \
  --ack-gateway-restarted --ack-live-ingress

bun scripts/kg-v3-live-ingress.ts status \
  --workspace /opt/openclaw/workspace --workspace-id main
```

This closes the live-turn gap inside the main canary; it is not fleet rollout.
The adapter uses server-stamped inbound metadata, supplies no classifier or
outbox, and exposes at most one typed KG mutation per eligible source turn.
Ordinary channel turns are authorized only after the plugin observes the full
`message_received → before_message_write → agent_turn_prepare →
before_tool_call` chain. Runtime prompt enrichment is expected and does not
participate in correlation. Collected/batched turns or any ambiguous/reordered
chain fail closed and therefore cannot prove the main live-turn gate.

Rollback:

```bash
bun scripts/kg-v3-live-ingress.ts rollback \
  --workspace /opt/openclaw/workspace --workspace-id main \
  --approved-by '<operator authority>' --ack-live-ingress-rollback
```

Rollback leaves committed assertions, journals, and read-back evidence intact.
PR4 fleet rollout remains separately gated on observed main live-turn evidence.
