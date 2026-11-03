#!/usr/bin/env bun
/** Canonical operator: switch = qualification -> plan -> apply -> read-back.
 * No plugin installation/restart, QMD rollout, scheduler or job migration. */
import { existsSync, mkdirSync, readFileSync, writeFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { acquireProcessLease } from "../src/memory-observation/process-lease.ts";
import { resolveMemoryObservationProjection } from "../src/memory-observation/projection.ts";
import { configuredProviderBoundary, readExecutionProfiles, legacyProfileSnapshots } from "../src/memory-observation/execution-profiles.ts";
import { applyProfileSwitch, planProfileSwitch, setProfileLifecycle } from "../src/memory-observation/execution-profile-control.ts";
import { qualifyExecutionModel } from "../src/memory-observation/model-profile-qualification.ts";
import { openClawRawModelRunProvider } from "../src/memory-observation/batch-shadow-openclaw-provider.ts";
import type { Digest } from "../src/memory-observation/ledger.ts";
const args=process.argv.slice(2),command=args.shift();
const opt=(key:string)=>{const i=args.indexOf("--"+key);return i>=0?args[i+1]:undefined;};
const required=(key:string)=>{const v=opt(key);if(!v||v.startsWith("--"))throw Error("required --"+key);return v;};
const read=(p:string)=>JSON.parse(readFileSync(p,"utf8"));
const output=(path:string,value:unknown)=>{mkdirSync(dirname(path),{recursive:true,mode:0o700});writeFileSync(path,JSON.stringify(value,null,2)+"\n",{flag:"wx",mode:0o600});};
if(command==="--help"||!command){console.log("memory-observation-model.ts status|qualify|plan|switch --workspace <absolute> [--model <provider/model> --thinking medium|high --approved-by <actor> --qualification <json> --out <json>]\napply --plan <json> [--journal-root <absolute>]\nlifecycle --workspace <absolute> --profile <sha256:id> --state active|drain|retired --approved-by <actor>");process.exit(0);}
if(command==="apply"){
  const plan=read(resolve(required("plan"))),model=plan.after.revisions.find((r:any)=>r.profile.profileId===plan.after.defaults.base).profile.template.runner.requestedModel;
  console.log(JSON.stringify(applyProfileSwitch(plan,configuredProviderBoundary(model),resolve(opt("journal-root")??join(plan.workspace,"ops/memory-model-control")))));
  process.exit(0);
}
const input=required("workspace");if(!isAbsolute(input)||realpathSync(input)!==input)throw Error("PROFILE_CANONICAL_WORKSPACE_REQUIRED");
const workspace=input,workspaceId=read(join(workspace,"engram.json")).workspace.id;
const projection=resolveMemoryObservationProjection({workspace,workspaceId});
if(command==="status"){
  const registry=readExecutionProfiles(workspace,projection);
  console.log(JSON.stringify({workspaceId,mode:registry?"execution-profiles":"legacy",defaults:registry?.defaults??null,
    revisions:registry?.revisions.map(r=>({id:r.profile.profileId,model:r.profile.template.runner.requestedModel,thinking:r.profile.template.runner.thinking,
      contextual:!!r.profile.template.contextual,lifecycle:r.lifecycle,evaluationPolicyDigest:r.profile.template.evaluationPolicyDigest}))??[],
    legacyProjectionModel:projection.inference.model,tokenBudgetEnforcement:"unavailable",thinkingReadback:"requested-only"}));process.exit(0);
}
if(command==="lifecycle"){
  const state=required("state");if(!["active","drain","retired"].includes(state))throw Error("PROFILE_LIFECYCLE_INVALID");
  console.log(JSON.stringify(setProfileLifecycle(workspace,workspaceId,required("profile") as Digest,state as "active"|"drain"|"retired",required("approved-by"))));process.exit(0);
}
if(!["plan","switch","qualify"].includes(command))throw Error("PROFILE_COMMAND_INVALID");
const model=required("model"),thinking=required("thinking");if(thinking!=="medium"&&thinking!=="high")throw Error("PROFILE_THINKING_REQUIRED");
const boundary=configuredProviderBoundary(model);
let qualification=opt("qualification")?read(resolve(required("qualification"))):null;
if(command==="plan"&&!qualification)throw Error("PROFILE_QUALIFICATION_REQUIRED");
if(!qualification){
  const release=acquireProcessLease(join(tmpdir(),"engram-memory-batch-inference-"+(process.getuid?.()??"user")));
  if(!release)throw Error("PROFILE_WORKER_BUSY");
  try {qualification=await qualifyExecutionModel({model,thinking,boundary,complete:openClawRawModelRunProvider({cwd:workspace})});}
  finally{release();}
  if(opt("qualification-out"))output(resolve(required("qualification-out")),qualification);
}
if(command==="qualify"){
  if(opt("out"))output(resolve(required("out")),qualification);
  console.log(JSON.stringify(qualification));process.exit(qualification.passed?0:1);
}
const currentProfiles=readExecutionProfiles(workspace,projection);
const legacyBoundaries=currentProfiles?.legacyBoundaries??Object.fromEntries([...new Set(legacyProfileSnapshots(workspace,projection).map(s=>s.projection.inference.model))].map(m=>[m,configuredProviderBoundary(m)]));
const plan=planProfileSwitch({workspace,workspaceId,model,thinking,boundary,legacyBoundaries,qualification,approvedBy:required("approved-by"),approvedAt:new Date().toISOString()});
const out=resolve(opt("out")??join(workspace,"ops/memory-model-control",plan.planId.slice(7)+".plan.json"));
if(!existsSync(out))output(out,plan);else if(JSON.stringify(read(out))!==JSON.stringify(plan))throw Error("PROFILE_PLAN_OUTPUT_CONFLICT");
if(command==="plan")console.log(JSON.stringify({status:"planned",planId:plan.planId,planPath:out,defaults:plan.after.defaults}));
else console.log(JSON.stringify({...applyProfileSwitch(plan,configuredProviderBoundary(model),resolve(opt("journal-root")??join(workspace,"ops/memory-model-control"))),planPath:out}));
