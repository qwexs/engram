import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";

export type FleetResult = { workspaceId: string; exitCode?: number; output?: string; error?: string; timedOut?: boolean;
  semanticStatus?: "ok"|"blocked"|"error"|"unverified"; blockedReasons?: string[]; executionErrors?: string[];
  workState?: "idle"|"active"|"unverified"; evaluatedSources?: number; pendingSources?: number; openDebt?: number };
// Notification metadata only: never relay provider messages, paths or source text.
function safeCodes(values: unknown): string[] {
  return Array.isArray(values) ? [...new Set(values.filter((x): x is string =>
    typeof x === 'string' && /^[A-Za-z][A-Za-z0-9_:-]{0,99}$/.test(x)))].sort().slice(0, 4) : [];
}
export function describeFleetResult(result?: FleetResult): string {
  if (!result) return 'не проверен';
  if (result.timedOut) return 'тайм-аут';
  if (result.semanticStatus === 'blocked') return 'блокировка' + suffix(safeCodes(result.blockedReasons));
  if (result.semanticStatus === 'unverified') return 'результат не подтверждён';
  if (result.semanticStatus === 'error' || result.exitCode !== 0) {
    const codes = safeCodes(result.executionErrors);
    return 'ошибка' + (codes.length ? suffix(codes) : Number.isInteger(result.exitCode) ? ` (exit ${result.exitCode})` : ' запуска');
  }
  return result.semanticStatus === 'ok' ? 'успешен' : 'результат не подтверждён';
}
function suffix(codes: string[]): string { return codes.length ? ' (' + codes.join(', ') + ')' : ''; }
/** A zero child exit is not proof that active scopes were processable. */
export function classifyFleetWorkerOutput(workspaceId:string,result:Omit<FleetResult,"workspaceId">):Omit<FleetResult,"workspaceId"> {
  try {
    const r=JSON.parse(result.output??'');
    if(r.schema!=="engram.memory-batch-live-run.v1"||r.workspaceId!==workspaceId
      ||!["ok","error"].includes(r.execution?.status)||!Array.isArray(r.execution?.errors))throw Error('unverified');
    const blockers=r.qualityBlockers??[];
    if(!Array.isArray(blockers)||blockers.some((b:any)=>!/^[-A-Z0-9_:]+$/.test(b.reason??'')))throw Error('unverified');
    const blockedReasons:string[]=[...new Set<string>(blockers.map((b:any)=>b.reason))].sort();
    const evaluations = Array.isArray(r.evaluations) ? r.evaluations.map((e:any)=>e.result) : r.evaluation ? [r.evaluation] : [];
    const applications = Array.isArray(r.applications) ? r.applications.map((a:any)=>a.result) : r.apply ? [r.apply] : [];
    const active = [...evaluations,...applications].some((v:any)=>typeof v?.status==='string' && !['idle','busy','disabled'].includes(v.status))
      || Number.isSafeInteger(r.domains?.applied) && r.domains.applied > 0
      || r.applicationStatusCounts && Object.entries(r.applicationStatusCounts).some(([status,n])=>!['idle','busy','disabled'].includes(status) && typeof n==='number' && n>0);
    const workState = r.fastPath==='no_pending_work' ? 'idle' : active ? 'active' : 'unverified';
    const count=(value:unknown)=>typeof value==='number' && Number.isSafeInteger(value) && value>=0 ? value : undefined;
    const evaluatedSources=evaluations.length ? evaluations.filter((e:any)=>['completed','duplicate'].includes(e?.status))
      .reduce((n:number,e:any)=>n+(count(e.sourceCount)??0),0) : r.fastPath==='no_pending_work' ? 0 : undefined;
    return {...result,semanticStatus:blockedReasons.length?'blocked':r.execution.status,blockedReasons,
      executionErrors:safeCodes(r.execution.errors),workState,evaluatedSources,
      pendingSources:count(r.health?.pending),openDebt:count(r.health?.sourceDebtOpen)};
  }catch{return {...result,semanticStatus:'unverified',blockedReasons:[]};}
}
export type FleetIsolation = { stateDir: string; operator: { channel: "telegram"; target: string; accountId: string }; cooldownMs: number };
type LegacyAlertState = { schema: "engram.fleet-alert.v1"; fingerprint: string; notifiedAt: number };
type AlertState = { schema: "engram.fleet-alert.v2"; acknowledgements: Record<string,number>; legacy?: Omit<LegacyAlertState,'schema'> };
const ALERT_HASH = /^[a-f0-9]{64}$/;
function readAlertState(path:string):AlertState {
  let value:any;
  try { value=JSON.parse(readFileSync(path,'utf8')); }
  catch(error:any) { if(error.code==='ENOENT')return {schema:'engram.fleet-alert.v2',acknowledgements:{}}; throw error; }
  const validTime=(v:unknown)=>typeof v==='number' && Number.isFinite(v) && v>=0;
  const validLegacy=(v:any)=>v && typeof v.fingerprint==='string' && (v.fingerprint==='' || ALERT_HASH.test(v.fingerprint)) && validTime(v.notifiedAt);
  if(value?.schema==='engram.fleet-alert.v1' && validLegacy(value))
    return {schema:'engram.fleet-alert.v2',acknowledgements:{},...(value.fingerprint ? {legacy:{fingerprint:value.fingerprint,notifiedAt:value.notifiedAt}} : {})};
  if(value?.schema!=='engram.fleet-alert.v2' || !value.acknowledgements || typeof value.acknowledgements!=='object'
    || Array.isArray(value.acknowledgements) || Object.entries(value.acknowledgements).some(([key,time])=>!ALERT_HASH.test(key)||!validTime(time))
    || value.legacy!==undefined && !validLegacy(value.legacy))throw Error('invalid fleet alert state');
  return value;
}

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
  const failures = args.results.filter(r => r.exitCode !== 0 || r.timedOut === true || r.semanticStatus && r.semanticStatus !== 'ok');
  const status = failures.length === 0 ? "ok" : failures.length === args.results.length ? "failed" : "partial_failure";
  const healthy=args.results.filter(r=>!failures.includes(r));
  const passCounts={workspaces:args.results.length,withoutErrors:healthy.length,failed:failures.length,
    idle:healthy.filter(r=>r.workState==='idle').length,active:healthy.filter(r=>r.workState==='active').length,
    activityUnverified:healthy.filter(r=>!r.workState || r.workState==='unverified').length};
  // Never copy source messages/provider diagnostics into notifications or the summary journal.
  const summary = { schema: "engram.fleet-pass.v1", reportingVersion:2, schedulerId: args.schedulerId, at: new Date(now).toISOString(), status, passCounts,
    results: args.results.map(r => ({ workspaceId: r.workspaceId, exitCode: r.exitCode ?? null, timedOut: r.timedOut === true,
      ...(r.workState?{workState:r.workState}:{}),
      ...Object.fromEntries(['evaluatedSources','pendingSources','openDebt'].flatMap(key=>{
        const value=r[key as keyof FleetResult];return typeof value==='number' && Number.isSafeInteger(value) && value>=0 ? [[key,value]] : [];
      })),
      ...(r.semanticStatus?{semanticStatus:r.semanticStatus,blockedReasons:safeCodes(r.blockedReasons),executionErrors:safeCodes(r.executionErrors)}: {}) })) };
  mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  appendFileSync(join(config.stateDir, "passes.jsonl"), JSON.stringify(summary) + "\n", { mode: 0o600 });
  atomicJson(join(config.stateDir, "latest.json"), summary);
  const statePath = join(config.stateDir, "alert.json");
  const previous=readAlertState(statePath);
  // Keep only live receipts. Healthy/idle passes never clear suppression.
  previous.acknowledgements=Object.fromEntries(Object.entries(previous.acknowledgements)
    .filter(([,at])=>now<at || now-at<config.cooldownMs));
  if (!failures.length) {
    atomicJson(statePath, previous);
    return { ...summary, notification: "not_needed", exitCode: 0 };
  }
  const failureKey=(r:FleetResult)=>[r.workspaceId,r.timedOut ? 'timeout' : r.exitCode ?? 'exception',r.semanticStatus??null,safeCodes(r.blockedReasons),safeCodes(r.executionErrors)];
  const receiptKeys=failures.map(r=>createHash('sha256').update(JSON.stringify({schedulerId:args.schedulerId,route:config.operator,failure:failureKey(r)})).digest('hex'));
  // Migrate an acknowledged v1 set without resending the same alert.
  const fingerprint = createHash("sha256").update(JSON.stringify({ schedulerId: args.schedulerId, route: config.operator,
    failures: failures.map(failureKey).sort() })).digest("hex");
  if(previous.legacy?.fingerprint===fingerprint && now>=previous.legacy.notifiedAt && now-previous.legacy.notifiedAt<config.cooldownMs)
    for(const key of receiptKeys)previous.acknowledgements[key]=Math.max(previous.acknowledgements[key]??0,previous.legacy.notifiedAt);
  if (receiptKeys.every(key=>previous.acknowledgements[key]!==undefined && now>=previous.acknowledgements[key]! && now-previous.acknowledgements[key]!<config.cooldownMs)) {
    atomicJson(statePath,previous);
    return { ...summary, notification: "cooldown", exitCode: status === "failed" ? 1 : 0 };
  }
  const message = `Memory Worker: ${status === "failed" ? "сбой текущего прохода во всех workspace" : "ошибки текущего прохода"}.\n`
    + `Ошибки текущего запуска по workspace:\n${failures.map(r => 'WS ' + r.workspaceId + ': ' + describeFleetResult(r)).join('\n')}.\n`
    + `Workspace без ошибок в этом проходе: ${passCounts.withoutErrors}/${passCounts.workspaces}`
    + ` (с работой: ${passCounts.active}; пустой проход: ${passCounts.idle}; активность не подтверждена: ${passCounts.activityUnverified}).\n`
    + (status === "failed" ? "Общий запуск завершён с ошибкой." : "Общее расписание продолжает работу.")
    + "\nЭто статус запуска, не подтверждение полноты памяти. Незакрытые источники и проверенное восстановление учитываются отдельно. ISS-19.";
  await args.notify(message, config.operator); // No acknowledgement on failed/unknown delivery.
  for(const key of receiptKeys)previous.acknowledgements[key]=now;
  atomicJson(statePath, previous);
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
