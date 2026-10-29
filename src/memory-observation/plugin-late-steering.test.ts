import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {AdmissionStore} from './admission-store.ts';
import {RUNTIME_AUTHORITY} from './runtime-authority.ts';

for(const hook of ['agent_turn_prepare','before_prompt_build'])test(`production ${hook} awaits late steering read before run attachment and admission`,async()=>{
 const root=mkdtempSync(join(tmpdir(),'engram-plugin-late-steer-'));let service:any;
 try{
  const result=await Bun.build({entrypoints:[join(import.meta.dir,'../../integrations/openclaw-memory-observation/index.ts')],target:'bun',format:'esm',write:false,plugins:[{
   name:'host-sdk-fixture',setup(build){
    build.onResolve({filter:/^openclaw\/plugin-sdk\//},a=>({path:a.path,namespace:'fixture'}));
    build.onLoad({filter:/.*/,namespace:'fixture'},()=>({loader:'js',contents:'export const definePluginEntry=x=>x;let read=async()=>({kind:"unavailable"});export const setFixtureRead=fn=>{read=fn;};export const readSessionTranscriptVisibleMessageDelta=async p=>read(p);'}));
    build.onLoad({filter:/integrations\/openclaw-memory-observation\/index\.ts$/},a=>({loader:'ts',contents:readFileSync(a.path,'utf8')+'\nexport {setFixtureRead} from "openclaw/plugin-sdk/session-transcript-runtime"; export const clearAdapters=()=>adapters.clear();'}));
   }
  }]});expect(result.success).toBe(true);
  const bytes=await result.outputs[0]!.text(),bundle=join(root,'plugin.mjs');writeFileSync(bundle,bytes);
  const digest='sha256:'+createHash('sha256').update(bytes).digest('hex');
  const sessionKey='agent:fixture:telegram:direct:100000001';const state=join(root,'memory-state/memory-observation');mkdirSync(state,{recursive:true});
  writeFileSync(join(root,'engram.json'),JSON.stringify({workspace:{id:'fixture'}}));
  writeFileSync(join(state,'projection.json'),JSON.stringify({schema:'engram.memory-observation-rollout.v1',workspaceId:'fixture',enabled:true,mode:'shadow',bindings:[{runtimeSessionKey:sessionKey,scopeClass:'self',scopeId:'fixture',requireOwner:true,allowedChannels:['telegram']}],pluginDigest:digest,inference:{provider:'openai',model:'openai/gpt-5.6-sol',evaluateAfter:'2026-08-24T19:00:00Z'},limits:{evidenceTtlHours:72,maxJobs:1000,maxBytes:67108864,maxQueueAgeHours:168,maxAttempts:2,claimTtlSeconds:300,maxInferenceCalls:0},approvedBy:'operator',approvedAt:'2026-08-24T19:00:00Z'}));
  const plugin=await import(bundle),hooks=new Map<string,Function>(),warnings:string[]=[];
  plugin.default.register({config:{agents:{entries:[{id:'fixture',workspace:root}]}},runtime:{},logger:{warn:(s:string)=>warnings.push(s),debug(){},info(){}},on:(name:string,fn:Function)=>hooks.set(name,fn),registerService:(s:any)=>service=s});
  function capture(id:string,char:string){
   const message:any={role:'user',idempotencyKey:'channel-user:v1:'+char.repeat(64),content:'Synthetic source '+id,__openclaw:{senderId:'100000001',senderIsOwner:true,transport:{channel:'telegram',messageId:id}}};
   hooks.get('message_received')!({messageId:id,senderId:'100000001',content:message.content},{sessionKey,channelId:'telegram'});
   hooks.get('before_message_write')!({sessionKey,message},{sessionKey});return message;
  }
  const first=capture('1','a');first.__openclaw.steerTargetRunId='previous-run';
  const second=capture('2','b'),store=new AdmissionStore(root,RUNTIME_AUTHORITY);
  const context={sessionKey,sessionId:'exact-session',runId:'next-run',trigger:'user'};
  // Missing host pages must NOT terminalize the pair; the next awaited hook retries.
  await hooks.get(hook)!({},context);expect(store.scanGapReceipts().records).toHaveLength(0);
  expect(store.scanCheckpoints().records.every(c=>c.stage==='persisted')).toBe(true);
  plugin.clearAdapters(); // Fresh process/cache sees both sources from durable checkpoints.
  let release!:(p:any)=>void;const pending=new Promise(resolve=>release=resolve);
  plugin.setFixtureRead(async(request:any)=>{expect(request).toMatchObject({sessionId:'exact-session',sessionKey,agentId:'fixture'});return pending;});
  const work=hooks.get(hook)!({},context);expect(work).toBeInstanceOf(Promise);
  await Promise.resolve();expect(store.scanCheckpoints().records.every(c=>c.stage==='persisted')).toBe(true);
  release({kind:'page',cursor:'tail',hasMore:false,entries:[{entryId:'source-1',message:first},{entryId:'source-2',message:second}]});await work;
  expect(warnings.filter(s=>s.includes('AMBIGUOUS_TURN'))).toHaveLength(0);
  expect(store.scanCheckpoints().records.find(c=>c.inboundMessageId==='1')).toMatchObject({stage:'persisted',steerTargetRunId:'previous-run',runId:null});
  expect(store.scanCheckpoints().records.find(c=>c.inboundMessageId==='2')).toMatchObject({stage:'run_attached',runId:'next-run'});
  hooks.get('agent_end')!({success:true,runId:'next-run',messages:[second,{role:'assistant',content:'Synthetic final result'}]},context);
  expect(store.scanCheckpoints().records.find(c=>c.inboundMessageId==='2')?.stage).toBe('ledger_admitted');
  expect(store.scanGapReceipts().records).toHaveLength(0);
 }finally{await service?.stop();rmSync(root,{recursive:true,force:true});}
});
