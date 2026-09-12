import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { inspectQmdMaintenancePayload } from "./_lib/qmd-scheduler.js";
const script = "scripts/install-qmd-maintenance-cron.js", roots = [];
afterAll(() => roots.forEach(p => rmSync(p, { recursive: true, force: true })));
function fixture(name = "workspace") {
  const root = mkdtempSync(join(tmpdir(), "engram-qmd-cron-")); roots.push(root);
  const workspace = join(root, name), manifest = join(root, "manifest.json");
  mkdirSync(workspace); writeFileSync(join(workspace, "engram.json"), '{"agent":"main"}');
  writeFileSync(manifest, JSON.stringify({schema:"engram.qmd.global-registry.v1", index:{name:"test"},workspaces:[],collections:[]}));
  const run = (extra = [], env = {}) => Bun.spawnSync(["bun",script,"--workspace",workspace,"--manifest",manifest,...extra],
    { env:{...process.env,...env},stdout:"pipe",stderr:"pipe" });
  return { root, workspace, manifest, run };
}
test("fresh spec is disabled, deterministic and synchronous", () => {
  const f=fixture(), r=f.run(["--dry-run"]); expect(r.exitCode).toBe(0);
  const spec=JSON.parse(r.stdout); const parsed=inspectQmdMaintenancePayload(spec.payload);
  expect(spec.enabled).toBe(false); expect(spec.payload.kind).toBe("script");
  expect(spec.payload.toolsAllow).toEqual(["exec"]); expect(spec.payload.toolBudget).toBe(1);
  expect(spec.payload.timeoutSeconds).toBe(660); expect(parsed.execArgs.timeoutSeconds).toBe(650);
  expect(parsed.execArgs.workdir).toBe(f.workspace);
  expect(spec.schedule).toEqual({kind:"cron",expr:"33 * * * *",tz:"UTC",staggerMs:0});
});
test("scheduler passes paths as literal argv without shell parsing", () => {
  const f=fixture("work space ' $(printf substituted) `printf substituted` $USER");
  const spec=JSON.parse(f.run(["--dry-run"]).stdout), parsed=inspectQmdMaintenancePayload(spec.payload);
  expect(parsed.execArgs.command).toEqual(["bun",join(f.workspace,"skills/engram/scripts/qmd-maintenance-coordinator.ts"),"--manifest",f.manifest,"--workspace",f.workspace,"--timeout-ms","600000","--report",join(f.root,"maintenance-last-run.json")]);
});
test("invalid manifests, colliding outputs and conflicting activation flags fail", () => {
  const f=fixture();
  expect(f.run(["--dry-run","--report",f.manifest]).exitCode).toBe(2);
  expect(f.run(["--dry-run","--enabled","--disabled"]).exitCode).toBe(2);
  writeFileSync(f.manifest,'{"schema":"engram.qmd.global-maintenance-scheduler.v1"}');
  expect(f.run(["--dry-run"]).exitCode).toBe(2);
});
test("generated wrapper fails closed for nonzero, timeout, running and malformed exec", async () => {
  const f=fixture(), payload=JSON.parse(f.run(["--dry-run"]).stdout).payload;
  const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
  const run=new AsyncFunction("exec","json",payload.script);
  let calls=0, completion;
  await run(async()=>{calls++;return {status:"completed",exitCode:0};},v=>{completion=v;});
  expect(calls).toBe(1);expect(completion.state.status).toBe("completed");
  for(const result of [{status:"completed",exitCode:1},{status:"running",exitCode:0},{status:"timeout"},{},null]) {
    let emitted=false;
    await expect(run(async()=>result,()=>{emitted=true;})).rejects.toThrow(); expect(emitted).toBe(false);
  }
});
function fakeHost(root) {
  const state=join(root,"host.json"), log=join(root,"calls.jsonl"), binary=join(root,"openclaw.mjs");
  writeFileSync(state,'{"jobs":[]}');
  writeFileSync(binary,`#!/usr/bin/env bun
import {readFileSync,writeFileSync,appendFileSync} from "node:fs";
const state=${JSON.stringify(state)},log=${JSON.stringify(log)};
const a=process.argv.slice(2),val=k=>a[a.indexOf(k)+1];
appendFileSync(log,JSON.stringify(a)+"\\n");
const host=JSON.parse(readFileSync(state,"utf8"));
if(a.includes("--help")) console.log("--script --script-timeout-seconds --script-tool-budget --tools");
else if(a[1]==="list") console.log(JSON.stringify(host));
else if(["add","edit"].includes(a[1])) {
 const old=a[1]==="edit"?host.jobs.find(j=>j.id===a[2]):null;
 const job={...old,id:old?.id??"fixed-id",name:val("--name"),description:val("--description"),
 enabled:a.includes("--enable")?true:(a.includes("--disabled")||a.includes("--disable"))?false:old?.enabled??true,
 schedule:{kind:"cron",expr:val("--cron"),tz:val("--tz"),staggerMs:0},sessionTarget:"isolated",delivery:{mode:"none"},
 payload:{kind:"script",script:readFileSync(0,"utf8"),timeoutSeconds:Number(val("--script-timeout-seconds")),toolBudget:1,toolsAllow:["exec"]}};
 host.jobs=host.jobs.filter(j=>j.id!==job.id).concat(job);writeFileSync(state,JSON.stringify(host));console.log(JSON.stringify(job));
} else process.exit(2);
`,{mode:0o700});return {state,log,binary};
}
test("installer uses script stdin, readback and keeps one ID + activation on reinstall",()=>{
 const f=fixture(),host=fakeHost(f.root),run=extra=>f.run(extra,{ENGRAM_OPENCLAW:host.binary});
 let r=run([]);expect(r.stderr.toString()).toBe("");expect(r.exitCode).toBe(0);
 const declaration=join(f.root,"maintenance-scheduler.json");expect(JSON.parse(readFileSync(declaration)).enabled).toBe(false);
 expect(run(["--enabled"]).exitCode).toBe(0);expect(run([]).exitCode).toBe(0);
 const jobs=JSON.parse(readFileSync(host.state)).jobs;
 expect(jobs).toHaveLength(1);expect(jobs[0].id).toBe("fixed-id");expect(jobs[0].enabled).toBe(true);
 expect(JSON.parse(readFileSync(declaration)).payload).toEqual(jobs[0].payload);
 expect(readFileSync(host.log,"utf8")).not.toContain("--message");
 writeFileSync(host.state,JSON.stringify({jobs:[],hasMore:true,total:10}));expect(run([]).exitCode).toBe(2);
});
