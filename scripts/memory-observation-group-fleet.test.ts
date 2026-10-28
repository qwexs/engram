import {expect,test} from 'bun:test';
import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {configuredTopicBindings} from '../src/memory-observation/topic-bindings.ts';
import {sha256} from '../src/memory-observation/ledger.ts';

test('real fleet CLI separates healthy idle from persistent debt and requires delivery before acknowledgement',async()=>{
 const root=mkdtempSync(join(tmpdir(),'memory-fleet-reporting-cli-'));
 const repository=resolve(import.meta.dir,'..');
 const put=(path:string,value:unknown)=>{mkdirSync(dirname(path),{recursive:true});writeFileSync(path,JSON.stringify(value));};
 try {
  const build=await Bun.build({entrypoints:[join(repository,'integrations/openclaw-memory-observation/index.ts')],target:'node',format:'esm',
   external:['openclaw/plugin-sdk/core','openclaw/plugin-sdk/session-transcript-runtime'],minify:false,sourcemap:'none',write:false});
  expect(build.success).toBe(true);
  const pluginDigest='sha256:'+createHash('sha256').update(Buffer.from(await build.outputs[0]!.arrayBuffer())).digest('hex');
  const schedulerId='synthetic-topic-fleet',hash=sha256('policy'),at='2026-09-01T00:00:00.000Z';
  const workspaces=['alpha','beta'].map(id=>{
   const path=join(root,id);put(join(path,'engram.json'),{workspace:{id}});
   put(join(path,'memory/domains/registry.json'),{domains:{smm:{type:'topic-thread',topic:{chatId:'-100123',topicId:'2'}}}});
   mkdirSync(join(path,'memory/domains/smm'),{recursive:true});
   const bindings=configuredTopicBindings({agents:{entries:{[id]:{workspace:path}}},
    channels:{telegram:{groups:{'-100123':{enabled:true,topics:{'2':{enabled:true,agentId:id}}}}}}},path,id,['smm']);
   put(join(path,'memory-state/memory-observation/projection.json'),{
    schema:'engram.memory-observation-rollout.v4',workspaceId:id,enabled:true,mode:'canary',bindings,pluginDigest,
    inference:{provider:'openai',model:'openai/gpt-6-luna',evaluateAfter:at},
    evaluation:{mode:'batch-cron',policyDigest:hash,batch:{sourcePolicyDigest:hash,inactivityGapSeconds:300,
     maxTurns:8,maxEvidenceBytes:262144,maxAgeSeconds:900,maxInferenceCallsPerRun:1,schedulerId}},
    limits:{evidenceTtlHours:72,maxJobs:1000,maxBytes:67108864,maxQueueAgeHours:168,maxAttempts:2,claimTtlSeconds:300,maxInferenceCalls:1},
    consumers:{dailyNote:{mode:'canary',applyAfter:at,timezone:'UTC',allowedObservationClasses:['episodic.event','episodic.decision'],
     maxAppliesPerWake:1,qmdBinding:{resolver:'exact-session-registry',manifestPath:join(path,'manifest.json'),workspaceRegistryDigest:hash}}},
    captureOwnership:{owner:'observer',effectiveAfter:at,foregroundDailyNoteCapture:'disabled'},approvedBy:'operator',approvedAt:at,
   });
   return {id,path,bindings};
  });
  const bin=join(root,'bin'),log=join(root,'delivery.jsonl'),deny=join(root,'deny-delivery');mkdirSync(bin);
  // Any host-config or inference call fails; only synthetic message receipts are allowed.
  writeFileSync(join(bin,'openclaw'),`#!${process.execPath}\nimport {existsSync,appendFileSync} from 'node:fs';
if(process.argv[2]!=='message'||process.argv[3]!=='send'||existsSync(${JSON.stringify(deny)}))process.exit(91);
appendFileSync(${JSON.stringify(log)},'sent\\n');console.log(JSON.stringify({ok:true,messageId:'synthetic',chatId:'100000001'}));\n`,{mode:0o755});
  const manifest=join(root,'fleet.json'),stateDir=join(root,'state');
  put(manifest,{schema:'engram.memory-topic-fleet.v1',schedulerId,workspaces:workspaces.map(({id,path})=>({id,path})),memoryCompletenessWorkspaceIds:['alpha','beta'],
   failureIsolation:{stateDir,operator:{channel:'telegram',target:'100000001',accountId:'default'},cooldownMs:21600000}});
  const run=()=>Bun.spawnSync([process.execPath,join(repository,'scripts/memory-observation-group-fleet.ts'),'--manifest',manifest],
   {cwd:repository,env:{...process.env,TMPDIR:root,PATH:bin+':'+process.env.PATH}});
  const first=run();expect(first.exitCode,first.stderr.toString()).toBe(0);
  expect(JSON.parse(first.stdout.toString())).toMatchObject({reportingVersion:2,status:'ok',passCounts:{workspaces:2,withoutErrors:2,idle:2,active:0},
   completeness:{status:'not_observed',notification:'not_needed'}});
  expect(existsSync(log)).toBe(false);
  const addGap=(tag:string)=>{
   const w=workspaces[0]!,b=w.bindings[0]!,candidateId=sha256(tag);
   const body={schema:'engram.memory-admission-checkpoint.v1',candidateId,scope:{workspaceId:w.id,runtimeSessionKey:b.runtimeSessionKey,scopeClass:b.scopeClass,scopeId:b.scopeId},
    stage:'terminal_gap',createdAt:'2026-08-01T00:00:00.000Z',updatedAt:'2026-08-01T00:00:00.000Z'};
   put(join(w.path,'memory-state/memory-observation/v1/pre-admission/checkpoints',candidateId.slice(7)+'.json'),{...body,checkpointDigest:sha256(body)});
  };
  addGap('first-gap');
  const second=run();expect(second.exitCode,second.stderr.toString()).toBe(0);
  expect(JSON.parse(second.stdout.toString())).toMatchObject({status:'ok',passCounts:{idle:2},completeness:{status:'incomplete',remaining:1,notification:'sent'}});
  const third=run();expect(third.exitCode,third.stderr.toString()).toBe(0);
  expect(JSON.parse(third.stdout.toString()).completeness.notification).toBe('cooldown');
  expect(readFileSync(log,'utf8').trim().split('\n')).toHaveLength(1);
  const before=JSON.parse(readFileSync(join(stateDir,'memory-incidents.json'),'utf8')).notifiedFingerprint;
  addGap('second-gap');writeFileSync(deny,'deny');
  const denied=run();expect(denied.exitCode).toBe(1);
  expect(JSON.parse(readFileSync(join(stateDir,'memory-incidents.json'),'utf8')).notifiedFingerprint).toBe(before);
  rmSync(deny);
  const retried=run();expect(retried.exitCode,retried.stderr.toString()).toBe(0);
  expect(JSON.parse(retried.stdout.toString()).completeness).toMatchObject({remaining:2,notification:'sent'});
  expect(readFileSync(log,'utf8').trim().split('\n')).toHaveLength(2);
 } finally {rmSync(root,{recursive:true,force:true});}
});
