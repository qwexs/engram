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
is the adapter boundary; live OpenClaw turn registration remains a separately
reviewed PR4 rollout step.
