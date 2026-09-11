import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';

test('production plugin adapter registers tool-delivered finals in its durable feed', async () => {
 const root=mkdtempSync(join(tmpdir(),'engram-plugin-wiring-'));
 try {
  const entry=join(import.meta.dir,'../../integrations/openclaw-memory-observation/index.ts');
  const result=await Bun.build({entrypoints:[entry],target:'bun',format:'esm',write:false,plugins:[{
   name:'host-sdk-fixture',setup(build){
    build.onResolve({filter:/^openclaw\/plugin-sdk\//},args=>({path:args.path,namespace:'host-fixture'}));
    build.onLoad({filter:/.*/,namespace:'host-fixture'},()=>({loader:'js',contents:'export const definePluginEntry=x=>x; export const readSessionTranscriptVisibleMessageDelta=async()=>({kind:"missing"});'}));
    build.onLoad({filter:/integrations\/openclaw-memory-observation\/index\.ts$/},args=>({loader:'ts',contents:readFileSync(args.path,'utf8')+'\nexport {adapterFor};'}));
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
  plugin.default.register({...api,on:(name:string,fn:Function)=>hooks.set(name,fn),registerService(){},logger:{warn(){warnings++;}}});
  for(const role of ['assistant','tool'])hooks.get('before_message_write')!({message:{role}},{});
  expect(warnings).toBe(0);
  hooks.get('before_message_write')!({message:{role:'user'}},{});
  expect(warnings).toBe(1); // Invalid user identity must still fail closed.
  const {adapterFor}=plugin;const adapter=adapterFor(api,sessionKey);expect(adapter).not.toBeNull();
  const context={sessionKey,sessionId:'fixture-session',runId:'fixture-run',trigger:'user'};
  const user={role:'user',idempotencyKey:sourceTurnId,content:'Prepare the agreed report',__openclaw:{senderIsOwner:true,transport:{channel:'telegram',messageId:'42'}}};
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
 } finally {rmSync(root,{recursive:true,force:true});}
});
