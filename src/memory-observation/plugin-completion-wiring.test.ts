import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';

for (const mode of ['message-tool', 'native-restart'] as const) test(`production plugin completion wiring: ${mode}`, async () => {
 let service:any;
 const root=mkdtempSync(join(tmpdir(),'engram-plugin-wiring-'));
 try {
  const entry=join(import.meta.dir,'../../integrations/openclaw-memory-observation/index.ts');
  const result=await Bun.build({entrypoints:[entry],target:'bun',format:'esm',write:false,plugins:[{
   name:'host-sdk-fixture',setup(build){
    build.onResolve({filter:/^openclaw\/plugin-sdk\//},args=>({path:args.path,namespace:'host-fixture'}));
    build.onLoad({filter:/.*/,namespace:'host-fixture'},()=>({loader:'js',contents:'export const definePluginEntry=x=>x; let read=async()=>({kind:"missing"}); export const setFixtureRead=fn=>{read=fn;}; export const readSessionTranscriptVisibleMessageDelta=async p=>read(p);'}));
    build.onLoad({filter:/integrations\/openclaw-memory-observation\/index\.ts$/},args=>({loader:'ts',contents:readFileSync(args.path,'utf8')+'\nexport {adapterFor}; export {setFixtureRead} from "openclaw/plugin-sdk/session-transcript-runtime"; export const forgetCaches=()=>{completionFeeds.clear();adapters.clear();};'}));
   }
  }]});
  expect(result.success).toBe(true);
  const bytes=await result.outputs[0]!.text(); const bundle=join(root,'plugin.mjs');writeFileSync(bundle,bytes);
  const pluginDigest='sha256:'+createHash('sha256').update(bytes).digest('hex');
  const sessionKey='agent:fixture-main:telegram:direct:100000001';
  const sourceTurnId='channel-user:v1:'+'a'.repeat(64);
  const state=join(root,'memory-state/memory-observation');mkdirSync(state,{recursive:true});
  writeFileSync(join(root,'engram.json'),JSON.stringify({workspace:{id:'fixture-main'}}));
  writeFileSync(join(state,'projection.json'),JSON.stringify({
   schema:'engram.memory-observation-rollout.v1',workspaceId:'fixture-main',enabled:true,mode:'shadow',
   bindings:[{runtimeSessionKey:sessionKey,scopeClass:'self',scopeId:'workspace:fixture-main',requireOwner:true,allowedChannels:['telegram']}],
   pluginDigest,inference:{provider:'openai',model:'openai/gpt-5.6-sol',evaluateAfter:'2026-08-24T19:00:00.000Z'},
   limits:{evidenceTtlHours:72,maxJobs:1000,maxBytes:67108864,maxQueueAgeHours:168,maxAttempts:2,claimTtlSeconds:300,maxInferenceCalls:0},
   approvedBy:'operator',approvedAt:'2026-08-24T19:00:00.000Z'
  }));
  const api={pluginConfig:{completionMirrorCapture:true},runtime:{},config:{agents:{entries:[{id:'fixture-main',workspace:root}]}},logger:{warn(){},debug(){}}};
  const plugin=await import(bundle);
  const hooks=new Map<string,Function>();let warnings=0;
  plugin.default.register({...api,on:(name:string,fn:Function)=>hooks.set(name,fn),registerService(value:any){service=value;},logger:{warn(){warnings++;}}});
  for(const role of ['assistant','tool'])hooks.get('before_message_write')!({message:{role}},{});
  expect(warnings).toBe(0);
  const cronSessionKey='agent:fixture-main:cron:fixture-job:trigger';
  hooks.get('before_message_write')!({message:{role:'user'}},{sessionKey:cronSessionKey});
  expect(warnings).toBe(0); // Internal cron prompts are user-shaped but are not channel turns.
  hooks.get('before_message_write')!({sessionKey:cronSessionKey,message:{role:'user'}},{sessionKey});
  expect(warnings).toBe(1); // Conflicting runtime surfaces must not bypass fail-closed identity checks.
  hooks.get('before_message_write')!({message:{role:'user'}},{});
  expect(warnings).toBe(2); // Invalid user identity must still fail closed.
  const {adapterFor}=plugin;const adapter=adapterFor(api,sessionKey);expect(adapter).not.toBeNull();
  const context={sessionKey,sessionId:'fixture-session',runId:'fixture-run',trigger:'user'};
  const user={role:'user',idempotencyKey:sourceTurnId,content:'Prepare the agreed report',__openclaw:{runId:context.runId,mirrorOrigin:'codex-app-server',mirrorIdentity:'fixture-mirror:prompt',senderIsOwner:true,transport:{channel:'telegram',messageId:'42'}}};
  adapter.captureMessageReceived({messageId:'42',senderId:'100000001',content:user.content,timestamp:Date.now()/1000},{sessionKey,messageId:'42',senderId:'100000001',channelId:'telegram'});
  adapter.adoptPersistedUser({sessionKey,message:user},context);
  adapter.attachRun({},context);
  const completed=adapter.completeAgentEnd({success:true,runId:context.runId,messages:[user,{role:'assistant',content:[{type:'toolCall',name:'message',arguments:{}}]}]},context);
  expect(completed.status).toBe('captured');
  const feeds=join(state,'v1/completion-mirrors');const names=readdirSync(feeds).filter(n=>n.endsWith('.json'));expect(names).toHaveLength(1);
  const feed=JSON.parse(readFileSync(join(feeds,names[0]!),'utf8'));expect(feed.pending).toHaveLength(1);
  expect(feed.pending[0].request.sourceTurnId).toBe(sourceTurnId);
  expect(feed.pending[0].request.sessionKey).toBe(sessionKey);
  expect(feed.pending[0].request.runId).toBe(context.runId);
  if(mode==='native-restart') {
   plugin.forgetCaches(); // Real service restoration, not a fake hasPending callback.
   let reads=0;
   plugin.setFixtureRead(async()=>({kind:'page',cursor:'host-tail',hasMore:false,entries:++reads===1?[
    {entryId:'source-entry',message:user},
    {entryId:'final-entry',message:{role:'assistant',provider:'openai',model:'fixture-model',stopReason:'stop',content:'Report prepared: synthetic result link',
      __openclaw:{runId:context.runId,runTerminal:true,mirrorOrigin:'codex-app-server',mirrorIdentity:'fixture-mirror:assistant'}}}
   ]:[]}));
   await service.start();
   const after=JSON.parse(readFileSync(join(feeds,names[0]!),'utf8'));expect(after.pending).toHaveLength(0);
   // Inspect the actual ledger evidence and durable disposition produced by callbacks.
   const evidenceRoot=join(state,'v1/evidence');
   const evidenceNames=readdirSync(evidenceRoot).filter(n=>n.endsWith('.json'));
   expect(evidenceNames.length).toBe(1);
   const evidence=JSON.parse(readFileSync(join(evidenceRoot,evidenceNames[0]!),'utf8'));
   expect(JSON.stringify(evidence)).toContain('Report prepared: synthetic result link');
   expect(JSON.stringify(evidence)).toContain('native_run_terminal');
   const gaps=join(state,'v1/receipts/admission-gaps');
   try {expect(readdirSync(gaps).filter(n=>n.endsWith('.json'))).toHaveLength(0);} catch(e:any){if(e.code!=='ENOENT')throw e;}
  }

 } finally {service?.stop();rmSync(root,{recursive:true,force:true});}
});
