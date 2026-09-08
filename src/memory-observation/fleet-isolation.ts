import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";

export type FleetResult = { workspaceId: string; exitCode?: number; output?: string; error?: string; timedOut?: boolean };
export type FleetIsolation = { stateDir: string; operator: { channel: "telegram"; target: string; accountId: string }; cooldownMs: number };
type AlertState = { schema: "engram.fleet-alert.v1"; fingerprint: string; notifiedAt: number };

export async function runFleetEntries<T extends { id: string }>(entries: T[], run: (entry: T) => Promise<Omit<FleetResult, "workspaceId">>) {
  const results: FleetResult[] = [];
  for (const entry of entries) {
    try { results.push({ ...await run(entry), workspaceId: entry.id }); }
    catch (error) { results.push({ workspaceId: entry.id, error: String(error).slice(-2000) }); }
  }
  return results;
}

export function parseFleetIsolation(value: any): FleetIsolation {
  if (!value || !isAbsolute(value.stateDir ?? "") || value.operator?.channel !== "telegram"
    || !/^[1-9][0-9]*$/.test(value.operator?.target ?? "")
    || !/^[a-zA-Z0-9_-]+$/.test(value.operator?.accountId ?? "")
    || !Number.isSafeInteger(value.cooldownMs) || value.cooldownMs < 60_000 || value.cooldownMs > 86_400_000)
    throw new Error("invalid fleet isolation configuration (explicit direct operator route required)");
  return value;
}

function atomicJson(path: string, value: unknown) {
  const tmp = path + "." + randomUUID() + ".tmp";
  writeFileSync(tmp, JSON.stringify(value) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
}

/** Caller holds the fleet lease. Persist failures before acknowledging partial success. */
export async function reportFleetResults(args: {
  schedulerId: string; results: FleetResult[]; config: FleetIsolation; now?: number;
  notify: (message: string, route: FleetIsolation["operator"]) => Promise<void>;
}) {
  const config = parseFleetIsolation(args.config), now = args.now ?? Date.now();
  if (!args.results.length || new Set(args.results.map(r => r.workspaceId)).size !== args.results.length)
    throw new Error("invalid fleet results");
  const failures = args.results.filter(r => r.exitCode !== 0 || r.timedOut === true);
  const status = failures.length === 0 ? "ok" : failures.length === args.results.length ? "failed" : "partial_failure";
  // Never copy source messages/provider diagnostics into notifications or the summary journal.
  const summary = { schema: "engram.fleet-pass.v1", schedulerId: args.schedulerId, at: new Date(now).toISOString(), status,
    results: args.results.map(r => ({ workspaceId: r.workspaceId, exitCode: r.exitCode ?? null, timedOut: r.timedOut === true })) };
  mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  appendFileSync(join(config.stateDir, "passes.jsonl"), JSON.stringify(summary) + "\n", { mode: 0o600 });
  atomicJson(join(config.stateDir, "latest.json"), summary);
  const statePath = join(config.stateDir, "alert.json");
  let previous: AlertState | undefined;
  try {
    previous = JSON.parse(readFileSync(statePath, "utf8"));
    if (previous?.schema !== "engram.fleet-alert.v1" || typeof previous.fingerprint !== "string"
      || !Number.isFinite(previous.notifiedAt)) throw new Error("invalid fleet alert state");
  } catch (error: any) { if (error.code !== "ENOENT") throw error; }
  if (!failures.length) {
    atomicJson(statePath, { schema: "engram.fleet-alert.v1", fingerprint: "", notifiedAt: 0 });
    return { ...summary, notification: "not_needed", exitCode: 0 };
  }
  const fingerprint = createHash("sha256").update(JSON.stringify({ schedulerId: args.schedulerId, route: config.operator,
    failures: failures.map(r => [r.workspaceId, r.timedOut ? "timeout" : r.exitCode ?? "exception"]).sort() })).digest("hex");
  if (previous?.fingerprint === fingerprint && now >= previous.notifiedAt && now - previous.notifiedAt < config.cooldownMs)
    return { ...summary, notification: "cooldown", exitCode: status === "failed" ? 1 : 0 };
  const message = `Memory Worker: ${status === "failed" ? "сбой всех проектов" : "частичный сбой"}.\n`
    + `Ошибки: ${failures.map(r => r.workspaceId + (r.timedOut ? " (таймаут)" : "")).join(", ")}.\n`
    + `Успешно: ${args.results.length - failures.length}/${args.results.length}. `
    + (status === "failed" ? "Общий запуск завершён с ошибкой." : "Остальные проекты обработаны; общее расписание продолжает работу.")
    + "\nИстория сбоев сохранена. ISS-19.";
  await args.notify(message, config.operator); // No acknowledgement on failed/unknown delivery.
  atomicJson(statePath, { schema: "engram.fleet-alert.v1", fingerprint, notifiedAt: now });
  return { ...summary, notification: "sent", exitCode: status === "failed" ? 1 : 0 };
}

/** Bounded shell-free child call. Kill the process group on timeout, including descendants. */
export async function runFleetCommand(argv: string[], cwd: string, timeoutMs: number) {
  const child = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", detached: true });
  let timedOut = false;
  const stopChild = () => {
    try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} }
  };
  const terminate = () => { stopChild(); process.exit(143); };
  const interrupt = () => { stopChild(); process.exit(130); };
  process.once("exit", stopChild);
  process.once("SIGTERM", terminate);
  process.once("SIGINT", interrupt);
  const timeout = setTimeout(() => {
    timedOut = true;
    stopChild();
  }, timeoutMs);
  const tail = async (stream: ReadableStream<Uint8Array>, limit: number) => {
    const decoder = new TextDecoder(); let value = "";
    for await (const chunk of stream) value = (value + decoder.decode(chunk, { stream: true })).slice(-limit);
    return (value + decoder.decode()).slice(-limit);
  };
  try {
    const [exitCode, output, error] = await Promise.all([child.exited, tail(child.stdout, 12000), tail(child.stderr, 2000)]);
    return { exitCode, output, error, timedOut };
  } finally {
    clearTimeout(timeout);
    process.removeListener("exit", stopChild);
    process.removeListener("SIGTERM", terminate);
    process.removeListener("SIGINT", interrupt);
  }
}

export async function notifyFleetOperator(message: string, route: FleetIsolation["operator"]) {
  const result = await runFleetCommand(["openclaw", "message", "send", "--channel", route.channel,
    "--account", route.accountId, "--target", route.target, "--message", message, "--json"], process.cwd(), 45_000);
  if (result.exitCode !== 0 || result.timedOut) throw new Error("fleet operator notification failed");
  // CLI can return success-like envelopes for failed sends: require a real Telegram receipt.
  const start = result.output.indexOf("{");
  let value: any;
  try { value = JSON.parse(result.output.slice(start)); } catch { throw new Error("fleet operator notification receipt missing"); }
  const payload = value.payload ?? value;
  if (!payload.messageId || String(payload.chatId) !== route.target || payload.ok === false)
    throw new Error("fleet operator notification receipt unconfirmed");
}
