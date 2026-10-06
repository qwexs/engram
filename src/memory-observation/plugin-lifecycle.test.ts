import {test, expect} from 'bun:test';
import {mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CompletionMirrorFeed, type CompletionPage} from './completion-mirror-feed.ts';

const target = {agentId:'fixture',sessionKey:'agent:fixture:main',sessionId:'fixture-session'};
const request = {...target,candidateId:'fixture-candidate',runId:'fixture-run',sourceTurnId:'channel-user:v1:'+'a'.repeat(64)};
function deferred<T>() {
 let resolve!: (value:T)=>void, reject!: (error:unknown)=>void;
 const promise = new Promise<T>((yes,no)=>{resolve=yes;reject=no;});
 return {promise,resolve,reject};
}
async function fixture() {
 const root=mkdtempSync(join(tmpdir(),'engram-lifecycle-test-'));
 const entry=join(import.meta.dir,'../../integrations/openclaw-memory-observation/index.ts');
 const result=await Bun.build({entrypoints:[entry],target:'bun',format:'esm',write:false,plugins:[{
  name:'host-fixture',setup(build){
   build.onResolve({filter:/^openclaw\/plugin-sdk\//},a=>({path:a.path,namespace:'fixture'}));
   build.onLoad({filter:/.*/,namespace:'fixture'},()=>({loader:'js',contents:'export const definePluginEntry=x=>x; export const readSessionTranscriptVisibleMessageDelta=async()=>({kind:"unavailable"});'}));
   build.onLoad({filter:/integrations\/openclaw-memory-observation\/index\.ts$/},a=>({loader:'ts',contents:readFileSync(a.path,'utf8')+`
    export {CompletionMirrorFeed as Feed};
    export const injectFeed=(feed)=>completionFeeds.set('fixture',feed);
    export const tick=tickCompletionFeeds;
    export const inspect=()=>({feeds:completionFeeds.size,retries:completionRetries.size,adapters:adapters.size,
     completionTimer:!!completionTimer,lifecycleTimer:!!lifecycleTimer,running:!!completionTickWork});
    export const retry=()=>completionRetries.get('fixture');
    export const due=()=>{const r=completionRetries.get('fixture');if(r)r.nextAt=0;};
   `}));
  }
 }]});
 expect(result.success).toBe(true);
 const bundle=join(root,'plugin.mjs');writeFileSync(bundle,await result.outputs[0]!.text());
 const plugin=await import(bundle);let service:any;const warnings:string[]=[];
 const api={config:{agents:{entries:[]}},runtime:{},logger:{warn:(s:string)=>warnings.push(s),info(){}},on(){},registerService(s:any){service=s;}};
 plugin.default.register(api);
 return {root,plugin,service,api,warnings,async close(){await service.stop();rmSync(root,{recursive:true,force:true});}};
}

for(const stage of ['startup-read','periodic-read','revalidate'] as const) test(`stop fences ${stage}, preserves durable pending, and permits clean restart`,async()=>{
 const f=await fixture();const pending=deferred<CompletionPage>();let reads=0,delivered=0;
 try {
  const feedRoot=join(f.root,'feed');
  const feed=new f.plugin.Feed({root:feedRoot,target,read:async()=>{
   reads++;
   if(stage==='revalidate' && reads===1) return {kind:'page',cursor:'tail',hasMore:false,entries:[]};
   return pending.promise;
  },deliver:async()=>{delivered++;return 'done';}});
  feed.register(request);
  if(stage==='periodic-read') await f.service.start();
  f.plugin.injectFeed(feed);
  const work=stage==='periodic-read'?f.plugin.tick(f.api):f.service.start();
  // Let the revalidation read start without relying on a timing sleep.
  for(let i=0;i<20 && reads<(stage==='revalidate'?2:1);i++) await Promise.resolve();
  expect(reads).toBe(stage==='revalidate'?2:1);
  const file=join(feedRoot,readdirSync(feedRoot)[0]!);const before=readFileSync(file,'utf8');
  const stopping=f.service.stop();
  expect(f.plugin.inspect().feeds).toBe(0);
  await stopping;await work; // Must drain BEFORE the outstanding host read resolves.
  expect(f.plugin.inspect()).toEqual({feeds:0,retries:0,adapters:0,completionTimer:false,lifecycleTimer:false,running:false});
  await f.service.start();await f.service.start();
  expect(f.plugin.inspect().completionTimer).toBe(true);
  // Old host data must not overwrite the new generation or admit a final.
  pending.resolve({kind:'page',cursor:'late-tail',hasMore:false,entries:[{entryId:'late',message:{role:'assistant',provider:'openclaw',model:'delivery-mirror',content:'late final',openclawDeliveryMirror:{kind:'message-tool-source-reply',final:true,toolCallId:'tool',sourceTurnId:request.sourceTurnId}}}]});
  for(let i=0;i<10;i++) await Promise.resolve();
  expect(readFileSync(file,'utf8')).toBe(before);expect(delivered).toBe(0);
  expect(f.plugin.inspect().completionTimer).toBe(true);expect(f.warnings).toHaveLength(0);
  await f.service.stop();await f.service.stop();
  expect(f.plugin.inspect().lifecycleTimer).toBe(false);
 } finally {pending.resolve({kind:'unavailable'});await f.close();}
});

test('completion failures retain debt, redact details and back off with a bounded delay',async()=>{
 const f=await fixture();let calls=0;
 try {
  const feed=new f.plugin.Feed({root:join(f.root,'feed'),target,read:async()=>{calls++;throw new Error('private transcript /secret/path');},deliver:async()=> 'retry'});
  feed.register(request);f.plugin.injectFeed(feed);
  await f.service.start();expect(calls).toBe(1);expect(feed.status().pending).toBe(1);
  expect(f.warnings[0]).toContain('"stage":"read"');expect(f.warnings[0]).toContain('"code":"UNCLASSIFIED"');
  expect(f.warnings[0]).not.toContain('private transcript');expect(f.warnings[0]).not.toContain('/secret/path');
  await f.plugin.tick(f.api);expect(calls).toBe(1);
  for(let i=0;i<8;i++){f.plugin.due();await f.plugin.tick(f.api);}
  expect(f.plugin.retry().failures).toBe(6);expect(f.warnings.at(-1)).toContain('"retryMs":300000');
  expect(feed.status().pending).toBe(1);
 } finally {await f.close();}
});

test('an empty feed is evicted without deleting its durable cursor',async()=>{
 const f=await fixture();
 try {
  let ticks=0;f.plugin.injectFeed({status:()=>({pending:0}),tick:async()=>{ticks++;}});
  await f.service.start();expect(ticks).toBe(0);expect(f.plugin.inspect().feeds).toBe(0);
 } finally {await f.close();}
});

test('stop during admission retains the matched final for idempotent replay',async()=>{
 const root=mkdtempSync(join(tmpdir(),'engram-stop-admission-'));const controller=new AbortController();
 const admission=deferred<'done'>();let entered=false,reads=0;
 try {
  const feed=new CompletionMirrorFeed({root,target,read:async()=>({kind:'page',cursor:'tail',hasMore:false,entries:++reads===1?[{entryId:'final',message:{role:'assistant',provider:'openclaw',model:'delivery-mirror',content:'result',openclawDeliveryMirror:{kind:'message-tool-source-reply',final:true,toolCallId:'tool',sourceTurnId:request.sourceTurnId}}}]:[]}),deliver:async()=>{entered=true;return admission.promise;}});
  feed.register(request);const work=feed.tick(controller.signal);
  for(let i=0;i<20&&!entered;i++) await Promise.resolve();expect(entered).toBe(true);
  controller.abort();await expect(work).rejects.toThrow('COMPLETION_STOPPED');
  const file=join(root,readdirSync(root)[0]!);const before=readFileSync(file,'utf8');
  admission.resolve('done');for(let i=0;i<10;i++) await Promise.resolve();
  expect(readFileSync(file,'utf8')).toBe(before);expect(feed.status()).toEqual({pending:1,matched:1,blocked:null});
 } finally {admission.resolve('done');rmSync(root,{recursive:true,force:true});}
});

test('immediate stop/start fences old startup and late SDK rejection',async()=>{
 const f=await fixture();const late=deferred<CompletionPage>();
 try {
  const feed=new f.plugin.Feed({root:join(f.root,'feed'),target,read:()=>late.promise,deliver:async()=> 'retry'});
  feed.register(request);f.plugin.injectFeed(feed);
  const first=f.service.start();expect(f.service.start()).toBe(first);
  const stopping=f.service.stop();const second=f.service.start();
  await second;await stopping;await first;
  late.reject(new Error('late host failure'));
  for(let i=0;i<10;i++) await Promise.resolve();
  expect(f.plugin.inspect()).toEqual({feeds:0,retries:0,adapters:0,completionTimer:true,lifecycleTimer:true,running:false});
  expect(f.warnings).toHaveLength(0);expect(feed.status().pending).toBe(1);
 } finally {late.resolve({kind:'unavailable'});await f.close();}
});

test('stop during expiry cannot remove pending or publish an unresolved receipt',async()=>{
 const root=mkdtempSync(join(tmpdir(),'engram-stop-expiry-'));const controller=new AbortController();
 const expiry=deferred<'done'>();let entered=false,now=new Date('2026-10-02T00:00:00Z');
 try {
  const feed=new CompletionMirrorFeed({root,target,now:()=>now,maxWaitMs:1,read:async()=>({kind:'page',cursor:'tail',hasMore:false,entries:[]}),deliver:async()=> 'retry',expire:async()=>{entered=true;return expiry.promise;}});
  feed.register(request);now=new Date(now.getTime()+10);const work=feed.tick(controller.signal);
  for(let i=0;i<20&&!entered;i++) await Promise.resolve();expect(entered).toBe(true);
  controller.abort();await expect(work).rejects.toThrow('COMPLETION_STOPPED');
  expiry.resolve('done');for(let i=0;i<10;i++) await Promise.resolve();
  expect(feed.status().pending).toBe(1);expect(readdirSync(root).filter(p=>p.startsWith('unresolved-'))).toHaveLength(0);
 } finally {expiry.resolve('done');rmSync(root,{recursive:true,force:true});}
});
