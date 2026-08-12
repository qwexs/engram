#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import {
  activateKgLiveIngress,
  planKgLiveIngress,
  rollbackKgLiveIngress,
} from "../src/kg-v3/live-rollout.ts";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    workspace: { type: "string" },
    "workspace-id": { type: "string" },
    repository: { type: "string" },
    "grant-session-key": { type: "string", default: "main" },
    "approved-by": { type: "string" },
    "ack-plugin-install": { type: "boolean", default: false },
    "ack-gateway-restarted": { type: "boolean", default: false },
    "ack-live-ingress": { type: "boolean", default: false },
    "ack-live-ingress-rollback": { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
  strict: true,
});

if (values.help || !positionals[0]) {
  console.log(`kg-v3-live-ingress <plan|install|activate|status|rollback> [options]

plan      Read-only readiness and exact plugin bundle digest
install   Build and install the global plugin dormant (requires --ack-plugin-install)
activate  Write the main-only live projection after restart (requires --ack-gateway-restarted --ack-live-ingress)
status    Read back source/installed plugin digests and local projection
rollback  Disable the local projection, preserving all data/evidence (requires --ack-live-ingress-rollback)

Common options:
  --workspace <path>             default /opt/openclaw/workspace
  --workspace-id <id>            default from engram.json
  --repository <path>            default canonical skill checkout
  --grant-session-key <key>      default main
  --approved-by <authority>      required for activate/rollback`);
  process.exit(values.help ? 0 : 1);
}

const command = positionals[0];
const repository = resolve(values.repository || dirname(dirname(new URL(import.meta.url).pathname)));
const workspace = resolve(values.workspace || "/opt/openclaw/workspace");
const workspaceConfig = JSON.parse(readFileSync(join(workspace, "engram.json"), "utf8"));
const workspaceId = values["workspace-id"] || workspaceConfig?.workspace?.id;
const grantSessionKey = values["grant-session-key"] || "main";
if (typeof workspaceId !== "string" || !workspaceId) throw new Error("workspace id is required");

async function buildPlugin() {
  const entry = join(repository, "integrations", "openclaw-kg-v3", "index.ts");
  const result = await Bun.build({ entrypoints: [entry], target: "node", format: "esm", external: ["openclaw/plugin-sdk/core"], minify: false, sourcemap: "none", write: false });
  if (!result.success || result.outputs.length !== 1) throw new Error(`plugin build failed: ${result.logs.map(String).join("; ")}`);
  const bytes = Buffer.from(await result.outputs[0].arrayBuffer());
  return { bytes, digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}` as `sha256:${string}` };
}

function inspectPlugin() {
  const result = spawnSync("openclaw", ["plugins", "inspect", "engram-kg-v3", "--json", "--runtime"], { encoding: "utf8" });
  if (result.status !== 0) return { installed: false, status: "absent", source: null, digest: null, error: (result.stderr || result.stdout).trim() };
  const value = JSON.parse(result.stdout);
  const source = typeof value?.source === "string" ? value.source : typeof value?.plugin?.source === "string" ? value.plugin.source : null;
  const digest = source && existsSync(source) ? `sha256:${createHash("sha256").update(readFileSync(source)).digest("hex")}` : null;
  return { installed: true, status: value?.status || value?.plugin?.status || "unknown", source, digest, toolNames: value?.toolNames || value?.plugin?.toolNames || [], diagnostics: value?.diagnostics || [] };
}

function localProjection() {
  const path = join(workspace, "memory-state", "kg-v3", "live-ingress.json");
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
}

const bundle = await buildPlugin();

if (command === "plan") {
  console.log(JSON.stringify(planKgLiveIngress({ workspace, workspaceId, repository, pluginDigest: bundle.digest, grantSessionKey }), null, 2));
} else if (command === "install") {
  if (values["ack-plugin-install"] !== true) throw new Error("plugin install requires --ack-plugin-install");
  const plan = planKgLiveIngress({ workspace, workspaceId, repository, pluginDigest: bundle.digest, grantSessionKey });
  if (!plan.ready) throw new Error("live ingress readiness gates are not green");
  const packageDir = mkdtempSync(join(tmpdir(), "engram-kg-v3-plugin-"));
  try {
    writeFileSync(join(packageDir, "index.js"), bundle.bytes, { mode: 0o600 });
    writeFileSync(join(packageDir, "package.json"), readFileSync(join(repository, "integrations", "openclaw-kg-v3", "package.json")));
    writeFileSync(join(packageDir, "openclaw.plugin.json"), readFileSync(join(repository, "integrations", "openclaw-kg-v3", "openclaw.plugin.json")));
    const installed = spawnSync("openclaw", ["plugins", "install", "--force", packageDir], { encoding: "utf8" });
    if (installed.status !== 0) throw new Error(`plugin install failed: ${(installed.stderr || installed.stdout).trim()}`);
    const permission = spawnSync("openclaw", ["config", "set", "plugins.entries.engram-kg-v3.hooks.allowConversationAccess", "true", "--strict-json"], { encoding: "utf8" });
    if (permission.status !== 0) throw new Error(`plugin conversation-hook permission failed: ${(permission.stderr || permission.stdout).trim()}`);
  } finally {
    rmSync(packageDir, { recursive: true, force: true });
  }
  const readBack = inspectPlugin();
  if (!readBack.installed || readBack.digest !== bundle.digest) throw new Error("installed plugin byte read-back mismatch");
  if (readBack.diagnostics.length > 0) throw new Error(`installed plugin diagnostics are not clean: ${JSON.stringify(readBack.diagnostics)}`);
  console.log(JSON.stringify({ schema: "engram.kg-v3-live-ingress-install.v1", status: "installed-dormant", pluginDigest: bundle.digest, plugin: readBack, projection: localProjection(), gatewayRestartRequired: true }, null, 2));
} else if (command === "activate") {
  if (values["ack-gateway-restarted"] !== true) throw new Error("activation requires --ack-gateway-restarted");
  const approvedBy = values["approved-by"];
  if (!approvedBy) throw new Error("activation requires --approved-by");
  const plugin = inspectPlugin();
  if (!plugin.installed || plugin.status !== "loaded" || plugin.digest !== bundle.digest) throw new Error("installed plugin is not loaded with the planned bytes");
  const projection = activateKgLiveIngress({ workspace, workspaceId, repository, pluginDigest: bundle.digest, grantSessionKey, approvedBy, acknowledge: values["ack-live-ingress"] });
  console.log(JSON.stringify({ schema: "engram.kg-v3-live-ingress-activation.v1", status: "active", plugin, projection }, null, 2));
} else if (command === "status") {
  const plugin = inspectPlugin();
  const projection = localProjection();
  const plan = planKgLiveIngress({ workspace, workspaceId, repository, pluginDigest: bundle.digest, grantSessionKey });
  console.log(JSON.stringify({ schema: "engram.kg-v3-live-ingress-status.v1", workspaceId, sourcePluginDigest: bundle.digest, plugin, projection, plan, activeReadBack: Boolean(plugin.installed && plugin.status === "loaded" && plugin.digest === bundle.digest && projection?.enabled === true && projection?.pluginDigest === bundle.digest && plan.ready) }, null, 2));
} else if (command === "rollback") {
  const approvedBy = values["approved-by"];
  if (!approvedBy) throw new Error("rollback requires --approved-by");
  console.log(JSON.stringify(rollbackKgLiveIngress({ workspace, workspaceId, disabledBy: approvedBy, acknowledge: values["ack-live-ingress-rollback"] }), null, 2));
} else {
  throw new Error(`unknown command: ${basename(command)}`);
}
