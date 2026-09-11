import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildQmdMaintenancePayload } from "./_lib/qmd-scheduler.js";
import { auditQmdScheduler, auditWorkshopReviews } from "./_lib/qmd-scheduler-watchdog.js";
import { normalizeCronInventory } from "./_lib/watchdog-runtime.js";
let workspace;
beforeEach(()=>workspace=mkdtempSync(join(tmpdir(),"qmd-watchdog-")));
afterEach(()=>rmSync(workspace,{recursive:true,force:true}));
function fixture(){
 const declarationPath=join(workspace,"scheduler.json"),report=join(workspace,"report.json");
 const job={id:"job",enabled:true,name:"QMD",sessionTarget:"isolated",delivery:{mode:"none"},
 schedule:{kind:"cron",expr:"33 * * * *",tz:"UTC",staggerMs:0},
 payload:buildQmdMaintenancePayload({workspace,manifest:join(workspace,"manifest.json"),report}),
 state:{lastRunStatus:"ok",lastRunAtMs:Date.now()}};
 writeFileSync(declarationPath,JSON.stringify({schema:"engram.qmd.global-maintenance-scheduler.v1",...job,jobId:job.id}));
 writeFileSync(report,JSON.stringify({schema:"engram.qmd.maintenance-run.v1",status:"ok",provenance:[{workspaceId:"main",failed:0}]}));
 const inventory=normalizeCronInventory({jobs:[job]});
 const audit=()=>auditQmdScheduler(workspace,{qmd:{maintenance:{mode:"coordinated"}}},inventory,{declarationPath});
 return {job,inventory,audit,report,declarationPath};
}
const codes=out=>out.map(f=>f.code);
test("healthy pinned script and receipt pass; command downgrade detected",()=>{
 const f=fixture();expect(f.audit()).toEqual([]);
 f.job.payload={kind:"command",argv:["bun","qmd-maintenance-coordinator.ts"]};
 expect(codes(f.audit())).toContain("WD-QMD-SCHEDULER-DRIFT");expect(codes(f.audit())).toContain("WD-QMD-SCHEDULER-CONTRACT");
});
test("partial caller visibility never proves job missing",()=>{
 const f=fixture();f.inventory.jobs=[];f.inventory.complete=false;
 expect(f.audit().every(f=>f.level!=="error")).toBe(true);
 expect(codes(f.audit())).toContain("WD-QMD-SCHEDULER-UNVERIFIED");
});
test("scheduler ok cannot hide partial/provenance/embed failure",()=>{
 const f=fixture();writeFileSync(f.report,JSON.stringify({schema:"engram.qmd.maintenance-run.v1",status:"partial",embed:{ok:false},provenance:[{failed:1}]}));
 expect(codes(f.audit())).toContain("WD-QMD-SCHEDULER-REPORT");expect(codes(f.audit())).toContain("WD-QMD-SCHEDULER-PROVENANCE");
});
test("stale, disabled, never run and duplicate jobs are separate findings",()=>{
 const f=fixture();f.job.state.lastRunAtMs=Date.now()-4*3600000;
 expect(codes(f.audit())).toContain("WD-QMD-SCHEDULER-STALE");
 delete f.job.state.lastRunStatus;expect(codes(f.audit())).toContain("WD-QMD-SCHEDULER-NEVER-RUN");
 f.inventory.jobs.push({...f.job,id:"another"});expect(codes(f.audit())).toContain("WD-QMD-SCHEDULER-DUPLICATE");
 f.job.enabled=false;expect(codes(f.audit())).toContain("WD-QMD-SCHEDULER-DISABLED");
});
test("wrapper changes fail even when copied into declaration; auditor never evaluates them",()=>{
 const f=fixture();f.job.payload.script=f.job.payload.script.replace('r.exitCode !== 0','false');
 const d=JSON.parse(require('node:fs').readFileSync(f.declarationPath));d.payload=f.job.payload;writeFileSync(f.declarationPath,JSON.stringify(d));
 expect(codes(f.audit())).toContain("WD-QMD-SCHEDULER-CONTRACT");
});
test("Workshop containment error vs unrun; another agent is out of scope",()=>{
 const job={id:"w",name:"skill-collection-review-main",declarationKey:"skill-collection-review:main",enabled:true,state:{lastStatus:"error",lastError:"Workshop root containment requires a supported runtime"}};
 expect(codes(auditWorkshopReviews("main",normalizeCronInventory([job])))).toEqual(["WD-WORKSHOP-RUNTIME"]);
 expect(auditWorkshopReviews("other",normalizeCronInventory([job]))).toEqual([]);
 job.state={};expect(codes(auditWorkshopReviews("main",normalizeCronInventory([job])))).toEqual(["WD-WORKSHOP-UNVERIFIED"]);
});

test("clean coordinator pass is valid and does not claim new embeddings",()=>{
 const f=fixture();writeFileSync(f.report,JSON.stringify({schema:"engram.qmd.maintenance-run.v1",status:"clean",provenance:[{failed:0}]}));
 expect(f.audit()).toEqual([]);
});

test("missing timeout cannot be recognized as a bounded script",()=>{
 const f=fixture();delete f.job.payload.timeoutSeconds;
 expect(codes(f.audit())).toContain("WD-QMD-SCHEDULER-CONTRACT");
});
