#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { parseCanonicalSessionKey } from "../src/context-delivery/contracts.ts";
import {
  planDeliveryPolicyTransition,
  readInstalledDeliveryPolicy,
  writeDeliveryPolicyAtomic,
} from "../src/context-delivery/rollout.ts";

const PLUGIN_ID = "engram-context-delivery";
const repository = resolve(import.meta.dir, "..");
const command = process.argv[2] || "status";
const { values } = parseArgs({
  args: process.argv.slice(3),
  options: {
    workspace: { type: "string" },
    session: { type: "string", multiple: true },
    "approved-by": { type: "string" },
    "ack-plugin-install": { type: "boolean", default: false },
    "ack-policy-change": { type: "boolean", default: false },
    "ack-canary-e2e": { type: "boolean", default: false },
  },
  strict: true,
});

const workspaceArg = values.workspace;
if (!workspaceArg || !isAbsolute(workspaceArg)) throw new Error("--workspace must be an absolute path");
const workspace = resolve(workspaceArg);

function sha256(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function runOpenClaw(args: string[]): string {
  const result = spawnSync("openclaw", args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`openclaw ${args[0]} failed: ${(result.stderr || result.stdout).trim()}`);
  return result.stdout.trim();
}

function configBoolean(path: string): boolean {
  try {
    return JSON.parse(runOpenClaw(["config", "get", path])) === true;
  } catch {
    return false;
  }
}

async function buildPlugin(): Promise<{ bytes: Buffer; digest: `sha256:${string}` }> {
  const result = await Bun.build({
    entrypoints: [join(repository, "integrations", "openclaw-context-delivery", "index.ts")],
    target: "node",
    format: "esm",
    external: ["openclaw/plugin-sdk/core"],
    minify: false,
    sourcemap: "none",
    write: false,
  });
  if (!result.success || result.outputs.length !== 1) throw new Error(`context delivery plugin build failed: ${result.logs.map(String).join("; ")}`);
  const bytes = Buffer.from(await result.outputs[0]!.arrayBuffer());
  return { bytes, digest: sha256(bytes) };
}

function inspectPlugin(): any {
  const result = spawnSync("openclaw", ["plugins", "inspect", PLUGIN_ID, "--json", "--runtime"], { encoding: "utf8" });
  if (result.status !== 0) return { installed: false, enabled: false, status: "absent", digest: null, rootDir: null, diagnostics: [] };
  const value = JSON.parse(result.stdout);
  const plugin = value?.plugin ?? value;
  const source = typeof plugin?.source === "string" ? plugin.source : typeof value?.source === "string" ? value.source : null;
  return {
    installed: true,
    enabled: plugin?.enabled !== false,
    status: plugin?.status ?? value?.status ?? "unknown",
    source,
    rootDir: typeof plugin?.rootDir === "string" ? plugin.rootDir : source ? resolve(source, "..") : null,
    digest: source && existsSync(source) ? sha256(readFileSync(source)) : null,
    diagnostics: plugin?.diagnostics ?? value?.diagnostics ?? [],
  };
}

function permissions() {
  return {
    allowConversationAccess: configBoolean(`plugins.entries.${PLUGIN_ID}.hooks.allowConversationAccess`),
    allowPromptInjection: configBoolean(`plugins.entries.${PLUGIN_ID}.hooks.allowPromptInjection`),
  };
}

function assertAcknowledged(name: keyof typeof values): void {
  if (values[name] !== true) throw new Error(`operation requires --${String(name)}`);
}

function assertApproved(): string {
  const approvedBy = values["approved-by"]?.trim();
  if (!approvedBy) throw new Error("policy change requires --approved-by");
  return approvedBy;
}

function assertPluginReady(plugin: any, sourceDigest: string): void {
  const access = permissions();
  if (!plugin.installed || !plugin.enabled || plugin.status !== "loaded" || plugin.digest !== sourceDigest || plugin.diagnostics.length) {
    throw new Error("context delivery plugin loaded-byte read-back is not green");
  }
  if (!access.allowConversationAccess || !access.allowPromptInjection) throw new Error("context delivery hook permissions are not green");
}

function transition(mode: "legacy" | "shadow" | "canary" | "active", sessions: string[] = []) {
  assertAcknowledged("ack-policy-change");
  const approvedBy = assertApproved();
  const current = readInstalledDeliveryPolicy(workspace);
  const planned = planDeliveryPolicyTransition({ current, mode, canarySessionKeys: sessions });
  const policy = writeDeliveryPolicyAtomic({ workspace, expectedPolicyDigest: current.policyDigest, policy: planned.policy });
  return { schema: "engram.context-delivery-policy-transition.v1", approvedBy, from: planned.from, to: planned.to, policy };
}

const bundle = await buildPlugin();

if (command === "plan" || command === "status") {
  const plugin = inspectPlugin();
  console.log(JSON.stringify({
    schema: "engram.context-delivery-rollout-status.v1",
    sourcePluginDigest: bundle.digest,
    plugin,
    permissions: permissions(),
    policy: readInstalledDeliveryPolicy(workspace),
  }, null, 2));
} else if (command === "install") {
  assertAcknowledged("ack-plugin-install");
  const before = inspectPlugin();
  let backupPath: string | null = null;
  if (before.installed && before.rootDir && existsSync(before.rootDir)) {
    backupPath = join(workspace, "memory-state", "context-delivery", "rollout-backups", `${new Date().toISOString().replace(/[:.]/g, "-")}-${String(before.digest || "unknown").slice(-12)}`);
    mkdirSync(dirname(backupPath), { recursive: true, mode: 0o700 });
    cpSync(before.rootDir, backupPath, { recursive: true, errorOnExist: true });
  }
  const packageDirectory = mkdtempSync(join(tmpdir(), "engram-context-delivery-plugin-"));
  try {
    writeFileSync(join(packageDirectory, "index.js"), bundle.bytes, { mode: 0o600 });
    writeFileSync(join(packageDirectory, "package.json"), readFileSync(join(repository, "integrations", "openclaw-context-delivery", "package.json")));
    writeFileSync(join(packageDirectory, "openclaw.plugin.json"), readFileSync(join(repository, "integrations", "openclaw-context-delivery", "openclaw.plugin.json")));
    runOpenClaw(["plugins", "install", "--force", "--accept-capabilities", packageDirectory]);
    runOpenClaw(["plugins", "enable", PLUGIN_ID, "--accept-capabilities"]);
    runOpenClaw(["config", "set", `plugins.entries.${PLUGIN_ID}.hooks.allowConversationAccess`, "true", "--strict-json"]);
    runOpenClaw(["config", "set", `plugins.entries.${PLUGIN_ID}.hooks.allowPromptInjection`, "true", "--strict-json"]);
  } finally {
    rmSync(packageDirectory, { recursive: true, force: true });
  }
  const plugin = inspectPlugin();
  if (!plugin.installed || plugin.digest !== bundle.digest || plugin.diagnostics.length) throw new Error("installed plugin byte read-back failed");
  const access = permissions();
  if (!access.allowConversationAccess || !access.allowPromptInjection) throw new Error("installed plugin permission read-back failed");
  console.log(JSON.stringify({
    schema: "engram.context-delivery-plugin-install.v1",
    status: "installed-legacy-policy",
    sourcePluginDigest: bundle.digest,
    plugin,
    permissions: access,
    policy: readInstalledDeliveryPolicy(workspace),
    backupPath,
    gatewayRestartRequired: plugin.status !== "loaded",
  }, null, 2));
} else if (command === "shadow") {
  assertPluginReady(inspectPlugin(), bundle.digest);
  console.log(JSON.stringify(transition("shadow"), null, 2));
} else if (command === "canary") {
  assertPluginReady(inspectPlugin(), bundle.digest);
  const sessions = values.session ?? [];
  if (!sessions.length || sessions.some((key) => !parseCanonicalSessionKey(key))) throw new Error("canary requires canonical --session values");
  console.log(JSON.stringify(transition("canary", sessions), null, 2));
} else if (command === "active") {
  assertAcknowledged("ack-canary-e2e");
  assertPluginReady(inspectPlugin(), bundle.digest);
  console.log(JSON.stringify(transition("active"), null, 2));
} else if (command === "rollback") {
  console.log(JSON.stringify(transition("legacy"), null, 2));
} else {
  throw new Error(`unknown command: ${command}`);
}
