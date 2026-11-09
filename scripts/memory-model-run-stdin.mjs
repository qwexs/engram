/** Large-prompt transport only. Calls the installed public OpenClaw SDK;
 * never copies host code, modifies host argv/runtime, or reads auth values. */
import { readFileSync, realpathSync, existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

try {
  const [commandFlag, command, timeoutFlag, timeoutText, ...extra] = process.argv.slice(2);
  const timeout = Number(timeoutText);
  if (commandFlag !== "--command" || timeoutFlag !== "--timeout" || extra.length
    || !command || !Number.isSafeInteger(timeout) || timeout < 1) throw Error("INVALID_TRANSPORT_ARGUMENTS");
  const candidates = command.includes("/") ? [command] : (process.env.PATH ?? "").split(delimiter).map(p => join(p, command));
  const executable = candidates.find(p => existsSync(p) && statSync(p).isFile());
  if (!executable) throw Error("OPENCLAW_COMMAND_UNAVAILABLE");
  const require = createRequire(realpathSync(executable));
  const sdk = await import(pathToFileURL(require.resolve("openclaw/plugin-sdk/gateway-runtime")).href);
  const configSdk = await import(pathToFileURL(require.resolve("openclaw/plugin-sdk/config-runtime")).href);
  const raw = readFileSync(0, "utf8");
  if (Buffer.byteLength(raw) > 2 * 1024 * 1024) throw Error("INPUT_BOUND_EXCEEDED");
  const input = JSON.parse(raw);
  if (Object.keys(input).sort().join() !== "model,prompt,thinking"
    || !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._:-]+$/.test(input.model ?? "")
    || !["off", "low", "medium", "high"].includes(input.thinking)
    || typeof input.prompt !== "string" || !input.prompt.trim()) throw Error("INVALID_MODEL_REQUEST");
  const config = configSdk.loadConfig();
  const entries = config.agents?.entries ?? {};
  const ids = Array.isArray(entries) ? entries.map(x => x.id) : Object.keys(entries);
  const agentId = config.agents?.defaults?.systemAgent?.agentId ?? (ids.length === 1 ? ids[0] : null);
  if (!agentId || !ids.includes(agentId)) throw Error("MODEL_RUN_AGENT_UNAVAILABLE");
  const slash = input.model.indexOf("/");
  const sessionId = `model-run-${randomUUID()}`;
  const response = await sdk.callGatewayFromCli("agent", { timeout: String(timeout), expectFinal: true, json: true }, {
    agentId, sessionId, sessionKey: `agent:${agentId}:${sessionId}`,
    message: input.prompt, provider: input.model.slice(0, slash), model: input.model.slice(slash + 1),
    thinking: input.thinking, modelRun: true, promptMode: "none", cleanupBundleMcpOnRunEnd: true,
    idempotencyKey: randomUUID(),
  }, { clientName: "gateway-client", mode: "backend", scopes: ["operator.admin"], progress: false });
  console.log(JSON.stringify({
    ok: true, capability: "model.run", transport: "gateway",
    provider: response?.result?.meta?.agentMeta?.provider,
    model: response?.result?.meta?.agentMeta?.model,
    attempts: response?.result?.meta?.agentMeta?.fallbackAttempts ?? [],
    outputs: (response?.result?.payloads ?? []).map(p => ({ text: p.text, mediaUrl: p.mediaUrl, mediaUrls: p.mediaUrls })),
  }));
} catch {
  // Prompts, credentials and arbitrary SDK diagnostics must not reach logs.
  process.stderr.write("MODEL_RUN_STDIN_TRANSPORT_FAILED\n");
  process.exitCode = 1;
}
