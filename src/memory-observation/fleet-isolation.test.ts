import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { parseFleetIsolation, reportFleetResults, runFleetCommand, runFleetEntries, type FleetIsolation } from "./fleet-isolation";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const stateDir = mkdtempSync(join(tmpdir(), "fleet-isolation-test-")); dirs.push(stateDir);
  const config: FleetIsolation = { stateDir, operator: { channel: "telegram", target: "12345", accountId: "default" }, cooldownMs: 60_000 };
  const messages: string[] = [];
  const args = { schedulerId: "test-fleet", config, now: 100_000, results: [{ workspaceId: "a", exitCode: 1, output: "PRIVATE SOURCE" }, { workspaceId: "b", exitCode: 0 }],
    notify: async (message: string) => { messages.push(message); } };
  return { config, messages, args };
}

test("partial failure is durable, operator-only and does not fail healthy fleet", async () => {
  const { args, config, messages } = fixture();
  const result = await reportFleetResults({ ...args, notify: async (message, route) => {
    expect(route).toEqual(config.operator);
    expect(readFileSync(join(config.stateDir, "latest.json"), "utf8")).toContain("partial_failure");
    messages.push(message);
  } });
  expect(result.exitCode).toBe(0); expect(result.status).toBe("partial_failure");
  expect(messages).toHaveLength(1); expect(messages[0]).not.toContain("PRIVATE SOURCE");
  expect(readFileSync(join(config.stateDir, "passes.jsonl"), "utf8")).not.toContain("PRIVATE SOURCE");
});

test("repeated failures survive restart without notification flood; cooldown expires", async () => {
  const { args, messages, config } = fixture();
  for (let i = 0; i < 12; i++) expect((await reportFleetResults({ ...args, now: args.now + i * 1000 })).exitCode).toBe(0);
  expect(messages).toHaveLength(1);
  expect(readFileSync(join(config.stateDir, "passes.jsonl"), "utf8").trim().split("\n")).toHaveLength(12);
  await reportFleetResults({ ...args, now: 160_000 }); expect(messages).toHaveLength(2);
});

test("new failed project notifies immediately; healthy and alternating passes retain suppression", async () => {
  const { args, messages } = fixture();
  await reportFleetResults(args);
  await reportFleetResults({ ...args, results: [{ workspaceId: "a", exitCode: 0 }, { workspaceId: "b", exitCode: 1 }] });
  expect(messages).toHaveLength(2);
  await reportFleetResults({ ...args, results: args.results.map(r => ({ ...r, exitCode: 0 })) });
  await reportFleetResults(args); expect(messages).toHaveLength(2);
  await reportFleetResults({ ...args, results: [{ workspaceId: "a", exitCode: 0 }, { workspaceId: "b", exitCode: 1 }] });
  expect(messages).toHaveLength(2);
});

test('v1 acknowledgement migrates across an idle pass without a duplicate alert',async()=>{
 const {args,config,messages}=fixture();
 const fingerprint=createHash('sha256').update(JSON.stringify({schedulerId:args.schedulerId,route:config.operator,
  failures:[['a',1,null,[],[]]]})).digest('hex');
 writeFileSync(join(config.stateDir,'alert.json'),JSON.stringify({schema:'engram.fleet-alert.v1',fingerprint,notifiedAt:args.now}));
 await reportFleetResults({...args,now:args.now+1000,results:[{workspaceId:'a',exitCode:0,workState:'idle'},{workspaceId:'b',exitCode:0,workState:'idle'}]});
 const r=await reportFleetResults({...args,now:args.now+2000});
 expect(r.notification).toBe('cooldown');expect(messages).toHaveLength(0);
 expect(JSON.parse(readFileSync(join(config.stateDir,'alert.json'),'utf8')).schema).toBe('engram.fleet-alert.v2');
 await reportFleetResults({...args,now:args.now+60000});expect(messages).toHaveLength(1);
});

test('mixed failure sets suppress old workspace receipts and deliver a new failure code',async()=>{
 const {args,messages}=fixture();
 const a={workspaceId:'a',exitCode:1,semanticStatus:'error' as const,executionErrors:['evaluation:retry']};
 const b={workspaceId:'b',exitCode:1,semanticStatus:'error' as const,executionErrors:['evaluation:retry']};
 await reportFleetResults({...args,results:[a,{workspaceId:'b',exitCode:0}]});
 await reportFleetResults({...args,results:[{workspaceId:'a',exitCode:0},b]});
 await reportFleetResults({...args,results:[a,b]});expect(messages).toHaveLength(2);
 await reportFleetResults({...args,results:[{...a,executionErrors:['evaluation:terminal_failure']},b]});
 expect(messages).toHaveLength(3);expect(messages.at(-1)).toContain('evaluation:terminal_failure');
});

test('legacy migration never moves a newer per-workspace delivery receipt backwards',async()=>{
 const {args,config,messages}=fixture();
 const fingerprint=createHash('sha256').update(JSON.stringify({schedulerId:args.schedulerId,route:config.operator,failures:[['a',1,null,[],[]]]})).digest('hex');
 writeFileSync(join(config.stateDir,'alert.json'),JSON.stringify({schema:'engram.fleet-alert.v1',fingerprint,notifiedAt:100000}));
 await reportFleetResults({...args,now:101000});
 await reportFleetResults({...args,now:110000,results:[{workspaceId:'a',exitCode:1},{workspaceId:'b',exitCode:1}]});
 await reportFleetResults({...args,now:120000});
 await reportFleetResults({...args,now:160000});expect(messages).toHaveLength(1);
 await reportFleetResults({...args,now:170000});expect(messages).toHaveLength(2);
});

test('activity counts distinguish an empty pass, processed work and unverified activity without source text',async()=>{
 const {classifyFleetWorkerOutput}=await import('./fleet-isolation.ts');
 const {args,messages,config}=fixture();
 const child=(workspaceId:string,extra:any)=>({workspaceId,...classifyFleetWorkerOutput(workspaceId,{exitCode:0,output:JSON.stringify({
  schema:'engram.memory-batch-live-run.v1',workspaceId,execution:{status:'ok',errors:[]},...extra})})});
 const idle=child('idle',{fastPath:'no_pending_work',health:{pending:0,sourceDebtOpen:2}});
 const active=child('active',{evaluations:[{result:{status:'completed',sourceCount:3}}],health:{pending:1,sourceDebtOpen:4}});
 const resumed=child('resumed',{applicationStatusCounts:{completed:1,idle:1}});
 const unknown=child('unknown',{});
 const r=await reportFleetResults({...args,results:[{workspaceId:'failed',exitCode:1},idle,active,resumed,unknown]});
 expect(r.passCounts).toEqual({workspaces:5,withoutErrors:4,failed:1,idle:1,active:2,activityUnverified:1});
 expect(active.evaluatedSources).toBe(3);expect(idle.openDebt).toBe(2);
 expect(messages[0]).toContain('Workspace без ошибок в этом проходе: 4/5');
 expect(messages[0]).toContain('не подтверждение полноты памяти');expect(messages[0]).not.toContain('Остальные проекты обработаны');
 const stored=JSON.parse(readFileSync(join(config.stateDir,'latest.json'),'utf8'));
 expect(stored.results.find((r:any)=>r.workspaceId==='active').evaluatedSources).toBe(3);
 expect(stored.results.find((r:any)=>r.workspaceId==='idle').workState).toBe('idle');
});

test('failed notification after previous receipt does not acknowledge a new signature',async()=>{
 const {args,messages}=fixture();await reportFleetResults(args);
 const changed={...args,results:[{workspaceId:'a',exitCode:0},{workspaceId:'b',exitCode:1}]};
 await expect(reportFleetResults({...changed,notify:async()=>{throw Error('send_failed');}})).rejects.toThrow('send_failed');
 await reportFleetResults(changed);expect(messages).toHaveLength(2);
});

test("global failure remains nonzero even under notification cooldown", async () => {
  const { args } = fixture();
  for (let i = 0; i < 2; i++) {
    const result = await reportFleetResults({ ...args, results: [{ workspaceId: "a", exitCode: 1 }, { workspaceId: "b", error: "preflight" }] });
    expect(result.exitCode).toBe(1); expect(result.status).toBe("failed");
  }
});

test("failed delivery is not acknowledged; next pass retries", async () => {
  const { args, messages, config } = fixture();
  await expect(reportFleetResults({ ...args, notify: async () => { throw new Error("delivery down"); } })).rejects.toThrow("delivery down");
  expect(() => readFileSync(join(config.stateDir, "alert.json"))).toThrow();
  await reportFleetResults(args); expect(messages).toHaveLength(1);
});

test("unwritable journal or corrupt acknowledgement cannot yield successful pass", async () => {
  const { args, messages, config } = fixture();
  writeFileSync(join(config.stateDir, "alert.json"), "broken");
  await expect(reportFleetResults(args)).rejects.toThrow(); expect(messages).toHaveLength(0);
  const file = join(config.stateDir, "not-a-directory"); writeFileSync(file, "x");
  await expect(reportFleetResults({ ...args, config: { ...config, stateDir: file } })).rejects.toThrow();
});

test("explicit operator route required; group routes rejected", () => {
  const { config } = fixture();
  expect(() => parseFleetIsolation({ ...config, operator: { ...config.operator, target: "-100123" } })).toThrow();
  expect(() => parseFleetIsolation({ ...config, operator: undefined })).toThrow();
  expect(() => parseFleetIsolation({ ...config, cooldownMs: 0 })).toThrow();
});

test("failure, exception, timeout are isolated; later real child succeeds in sequence", async () => {
  let active = 0, maximum = 0;
  const order: string[] = [];
  const results = await runFleetEntries([{ id: "failed" }, { id: "exception" }, { id: "timeout" }, { id: "healthy" }], async entry => {
    active++; maximum = Math.max(maximum, active); order.push(entry.id);
    try {
      if (entry.id === "exception") throw Error("bad projection");
      return await runFleetCommand([process.execPath, "-e", entry.id === "timeout"
        ? "setInterval(() => {}, 1000)" : entry.id === "failed" ? "process.exit(1)" : "console.log('isolated healthy')"], tmpdir(), entry.id === "timeout" ? 100 : 2000);
    } finally { active--; }
  });
  expect(maximum).toBe(1); expect(order).toEqual(["failed", "exception", "timeout", "healthy"]);
  expect(results[0]!.exitCode).toBe(1); expect(results[1]!.error).toBeDefined();
  expect(results[2]!.timedOut).toBe(true); expect(results[3]!.exitCode).toBe(0);
  expect(results[3]!.output).toContain("isolated healthy");
});

test("real child drains stdout and stderr concurrently with bounded tails", async () => {
  const result = await runFleetCommand([process.execPath, "-e", "console.log('x'.repeat(50000)); console.error('y'.repeat(50000))"], tmpdir(), 2000);
  expect(result.exitCode).toBe(0); expect(result.output.length).toBeLessThanOrEqual(12000);
  expect(result.error.length).toBeLessThanOrEqual(2000);
});

test('zero-exit blocked worker is durable and notifies; malformed or foreign output cannot be green',async()=>{
 const {classifyFleetWorkerOutput}=await import('./fleet-isolation.ts');
 const {args,messages}=fixture();
 const output=JSON.stringify({schema:'engram.memory-batch-live-run.v1',workspaceId:'a',execution:{status:'ok',errors:[]},qualityBlockers:[{reason:'MODEL_TRANSITION_IDENTITY_CHANGED'}]});
 const result=classifyFleetWorkerOutput('a',{exitCode:0,output});
 expect(result.semanticStatus).toBe('blocked');
 const report=await reportFleetResults({...args,results:[{...result,workspaceId:'a'},{workspaceId:'b',exitCode:0}]});
 expect(report.status).toBe('partial_failure');expect(messages[0]).toContain('MODEL_TRANSITION_IDENTITY_CHANGED');
 expect(classifyFleetWorkerOutput('foreign',{exitCode:0,output}).semanticStatus).toBe('unverified');
 expect(classifyFleetWorkerOutput('a',{exitCode:0,output:output.slice(-20)}).semanticStatus).toBe('unverified');
});
test('execution alerts identify each workspace, stage and timeout without raw diagnostics',async()=>{
 const {classifyFleetWorkerOutput}=await import('./fleet-isolation.ts');
 const {args,messages,config}=fixture();
 const output=JSON.stringify({schema:'engram.memory-batch-live-run.v1',workspaceId:'a',execution:{status:'error',errors:['daily_note:qmd_pending','private source text\nsecret=1']}});
 const result=classifyFleetWorkerOutput('a',{exitCode:1,output,error:'PRIVATE PROVIDER DIAGNOSTIC'});
 await reportFleetResults({...args,results:[{...result,workspaceId:'a'},{workspaceId:'b',exitCode:1,timedOut:true},{workspaceId:'c',exitCode:0,semanticStatus:'ok'}]});
 expect(messages[0]).toContain('WS a: ошибка (daily_note:qmd_pending)');
 expect(messages[0]).toContain('\nWS b: тайм-аут');
 expect(messages[0]).not.toContain('private source');expect(messages[0]).not.toContain('PRIVATE PROVIDER');
 expect(readFileSync(join(config.stateDir,'latest.json'),'utf8')).not.toContain('secret=1');
 await reportFleetResults({...args,results:[{...result,executionErrors:['evaluation:terminal_failure'],workspaceId:'a'},{workspaceId:'b',exitCode:1,timedOut:true},{workspaceId:'c',exitCode:0,semanticStatus:'ok'}]});
 expect(messages).toHaveLength(2);expect(messages[1]).toContain('evaluation:terminal_failure');
});
