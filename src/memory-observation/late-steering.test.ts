import {test, expect, afterEach} from 'bun:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {OpenClawObservationRuntimeAdapter} from './runtime-adapter.ts';
import {AdmissionStore} from './admission-store.ts';
import {RUNTIME_AUTHORITY} from './runtime-authority.ts';
import {reconcileLateSteering} from './late-steering.ts';
import type {CompletionPage} from './completion-mirror-feed.ts';

const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
const sessionKey='agent:fixture:telegram:direct:100000001';
const context={agentId:'fixture',sessionKey,sessionId:'exact-session',runId:'next-run',trigger:'user'};
const now=new Date('2026-10-29T10:00:00Z');
function fixture(durable=false){
 const root=durable?mkdtempSync(join(tmpdir(),'engram-late-steer-')):undefined;if(root)roots.push(root);
 let binding:any={workspaceId:'fixture',scopeClass:'self',scopeId:'fixture',requireOwner:true,allowedChannels:['telegram'],admit:()=>({status:'admitted'})};
 const create=()=>new OpenClawObservationRuntimeAdapter({authority:RUNTIME_AUTHORITY,workspace:root,resolveBinding:key=>key===sessionKey?binding:null,now:()=>now});
 const a=create();
 const persist=(id:string,char:string)=>{
  a.captureMessageReceived({messageId:id,senderId:'100000001',channel:'telegram'},{sessionKey,messageId:id,senderId:'100000001',channelId:'telegram'});
  const message:any={role:'user',idempotencyKey:'channel-user:v1:'+char.repeat(64),content:'Synthetic source '+id,__openclaw:{senderId:'100000001',senderIsOwner:true,transport:{channel:'telegram',messageId:id}}};
  a.adoptPersistedUser({sessionKey,message},{sessionKey});return message;
 };
 const first=persist('1','a'),second=persist('2','b');
 // Host annotations arrive AFTER the initial write hook, not before it.
 const hostFirst=structuredClone(first);hostFirst.__openclaw.steerTargetRunId='previous-run';
 const page=(messages:any[]=[hostFirst,second]):CompletionPage=>({kind:'page',cursor:'tail',hasMore:false,entries:messages.map((message,i)=>({entryId:'entry-'+i,message}))});
 return {a,root,create,first,second,hostFirst,page,setBinding:(b:any)=>binding=b};
}

test('late host attestation is durable across restart; ordinary run attaches and original deadlines survive',async()=>{
 const f=fixture(true),store=new AdmissionStore(f.root!,RUNTIME_AUTHORITY),before=store.scanCheckpoints().records;
 const restored=f.create();let reads=0;
 await reconcileLateSteering(restored,context,async request=>{reads++;expect(request).toMatchObject({agentId:'fixture',sessionKey,sessionId:'exact-session',maxMessages:256});return f.page();});
 const after=store.scanCheckpoints().records;
 const steer=after.find(c=>c.inboundMessageId==='1')!,old=before.find(c=>c.inboundMessageId==='1')!;
 expect(steer).toMatchObject({stage:'persisted',runId:null,steerTargetRunId:'previous-run',createdAt:old.createdAt,expiresAt:old.expiresAt});
 const next=f.create();expect(next.attachRun({},context).status).toBe('attached');
 expect(store.scanGapReceipts().records).toHaveLength(0);
 expect(next.completeAgentEnd({success:true,runId:context.runId,messages:[f.second,{role:'assistant',content:'Synthetic completed answer'}]},context).status).toBe('admitted');
 await reconcileLateSteering(next,context,async()=>{throw Error('duplicate run must not read');});
 expect(next.attachRun({},context).status).toBe('duplicate');expect(reads).toBe(1);
 expect(store.readCheckpoint(steer.candidateId)?.stage).toBe('persisted');
});

for(const scenario of ['missing','unavailable','reset','throw','partial','budget','oversized','duplicate-source','wrong-source','wrong-transport','wrong-actor','wrong-owner','wrong-content','wrong-reply','mixed-run'] as const)
test(`unverified ${scenario} retains sources and never creates an ambiguity gap`,async()=>{
 const f=fixture(true);const messages=[structuredClone(f.hostFirst),structuredClone(f.second)];
 if(scenario==='duplicate-source')messages.push(structuredClone(f.hostFirst));
 if(scenario==='wrong-source')messages[1].idempotencyKey='channel-user:v1:'+'c'.repeat(64);
 if(scenario==='wrong-transport')messages[1].__openclaw.transport.messageId='other';
 if(scenario==='wrong-actor')messages[1].__openclaw.senderId='other';
 if(scenario==='wrong-owner')messages[1].__openclaw.senderIsOwner=false;
 if(scenario==='wrong-content')messages[1].content='changed';
 if(scenario==='wrong-reply')messages[1].__openclaw.transport.replyToId='other';
 if(scenario==='mixed-run')messages[0].__openclaw.runId='own-run';
 const read=async():Promise<CompletionPage>=>{
  if(scenario==='throw')throw Error('private SDK error content');
  if(['missing','unavailable'].includes(scenario))return {kind:scenario as 'missing'|'unavailable'};
  if(scenario==='reset')return {kind:'reset',cursor:'restart',reason:'generation_mismatch'};
  const page=f.page(messages) as Extract<CompletionPage,{kind:'page'}>;
  if(scenario==='partial'||scenario==='budget')page.hasMore=true;
  if(scenario==='oversized')page.requiredBytes=2*1024*1024;
  return page;
 };
 const store=new AdmissionStore(f.root!,RUNTIME_AUTHORITY),before=store.scanCheckpoints().records;
 await expect(reconcileLateSteering(f.a,context,read,undefined,{maxPages:scenario==='budget'?1:32,maxTotalBytes:16*1024*1024,timeoutMs:100})).rejects.toThrow();
 expect(store.scanCheckpoints().records).toEqual(before);expect(store.scanGapReceipts().records).toHaveLength(0);
 // A later exact read can retry; the first unavailable read did not poison state.
 await reconcileLateSteering(f.a,context,async()=>f.page());expect(f.a.attachRun({},context).status).toBe('attached');
});

test('true ordinary ambiguity still fails closed after a complete verified read',async()=>{
 const f=fixture(true);await reconcileLateSteering(f.a,context,async()=>f.page([f.first,f.second]));
 expect(()=>f.a.attachRun({},context)).toThrow('multiple persisted turns');
 expect(new AdmissionStore(f.root!,RUNTIME_AUTHORITY).scanGapReceipts().records).toHaveLength(2);
});

for(const stop of ['abort','timeout'] as const)test(`${stop} fences late SDK results and consumes late rejection`,async()=>{
 const f=fixture(true),store=new AdmissionStore(f.root!,RUNTIME_AUTHORITY),before=store.scanCheckpoints().records;
 let release!:(p:CompletionPage)=>void;const pending=new Promise<CompletionPage>(resolve=>release=resolve);
 const signal=new AbortController();const work=reconcileLateSteering(f.a,context,()=>pending,signal.signal,{maxPages:32,maxTotalBytes:1024*1024,timeoutMs:10});
 if(stop==='abort')signal.abort();await expect(work).rejects.toThrow();release(f.page());
 await new Promise(resolve=>setTimeout(resolve,1));expect(store.scanCheckpoints().records).toEqual(before);
});

test('source changes during host read and revoked scope cannot enrich checkpoints',async()=>{
 const f=fixture(true);await expect(reconcileLateSteering(f.a,context,async()=>{
  f.a.captureMessageReceived({messageId:'3',senderId:'100000001',channel:'telegram'},{sessionKey,messageId:'3',senderId:'100000001',channelId:'telegram'});
  f.a.adoptPersistedUser({sessionKey,message:{role:'user',idempotencyKey:'channel-user:v1:'+'c'.repeat(64),content:'Fresh source during read',__openclaw:{senderId:'100000001',senderIsOwner:true,transport:{channel:'telegram',messageId:'3'}}}},{sessionKey});
  return f.page();
 })).rejects.toThrow('changed during host read');
 expect(new AdmissionStore(f.root!,RUNTIME_AUTHORITY).scanCheckpoints().records.every(c=>!c.steerTargetRunId)).toBe(true);
 const g=fixture(true);await expect(reconcileLateSteering(g.a,context,async()=>{g.setBinding(null);return g.page();})).rejects.toThrow();
 expect(new AdmissionStore(g.root!,RUNTIME_AUTHORITY).scanCheckpoints().records.every(c=>!c.steerTargetRunId)).toBe(true);
});

test('dedicated CAS cannot retarget, bypass a terminal gap, bind a run, or extend expiry',()=>{
 const f=fixture(true),store=new AdmissionStore(f.root!,RUNTIME_AUTHORITY),cp=store.scanCheckpoints().records[0]!;
 const enriched=store.confirmSteeringTarget(cp.candidateId,cp.checkpointDigest,'previous-run',now);
 expect(()=>store.confirmSteeringTarget(cp.candidateId,cp.checkpointDigest,'previous-run',now)).toThrow('changed during host read');
 expect(()=>store.confirmSteeringTarget(cp.candidateId,enriched.checkpointDigest,'other-run',now)).toThrow('target changed');
 const g=fixture(true),s=new AdmissionStore(g.root!,RUNTIME_AUTHORITY);
 expect(()=>g.a.attachRun({},context)).toThrow();const terminal=s.scanCheckpoints().records[0]!;
 expect(()=>s.confirmSteeringTarget(terminal.candidateId,terminal.checkpointDigest,'previous-run',now)).toThrow('unbound live source');
 expect(()=>store.confirmSteeringTarget(enriched.candidateId,enriched.checkpointDigest,'previous-run',new Date('2026-11-02'))).toThrow('unbound live source');
});


test('bounded paginated read collects exact candidates but never authorizes from a partial page',async()=>{
 const f=fixture();let pages=0;
 await reconcileLateSteering(f.a,context,async request=>{
  pages++;expect(request.cursor).toBe(pages===1?undefined:'page-1');
  return {kind:'page',cursor:'page-'+pages,hasMore:pages===1,entries:[{entryId:'entry-'+pages,message:pages===1?f.hostFirst:f.second}]};
 });
 expect(pages).toBe(2);expect(f.a.attachRun({},context).status).toBe('attached');
});

test('exact ingress run identity keeps its existing fast path without requiring a transcript read',()=>{
 const a=new OpenClawObservationRuntimeAdapter({authority:RUNTIME_AUTHORITY,resolveBinding:()=>({workspaceId:'fixture',scopeClass:'self',scopeId:'fixture',requireOwner:true,allowedChannels:['telegram'],admit:()=>({status:'admitted'})})});
 for(const [id,char] of [['1','a'],['2','b']]){
  a.captureMessageReceived({messageId:id,senderId:'100000001',channel:'telegram',...(id==='2'?{runId:'next-run'}:{})},{sessionKey,messageId:id,senderId:'100000001',channelId:'telegram'});
  a.adoptPersistedUser({sessionKey,message:{role:'user',idempotencyKey:'channel-user:v1:'+char!.repeat(64),content:'Synthetic '+id,__openclaw:{senderIsOwner:true,transport:{channel:'telegram',messageId:id}}}},{sessionKey});
 }
 expect(a.steeringSourceSnapshot(context)).toBeNull();expect(a.attachRun({},context).status).toBe('attached');
});

test('bound ordinary checkpoint cannot be enriched and generic writes still cannot add a steering target',()=>{
 const f=fixture(true),store=new AdmissionStore(f.root!,RUNTIME_AUTHORITY),cp=store.scanCheckpoints().records[0]!;
 const {schema,candidateId,createdAt,updatedAt,expiresAt,checkpointDigest,...payload}=cp;
 expect(()=>store.recordCheckpoint({...payload,steerTargetRunId:'previous-run',now})).toThrow('steering identity changed');
 const bound=store.recordCheckpoint({...payload,stage:'run_attached',runId:'ordinary-run',sessionId:'exact-session',now}).checkpoint;
 expect(()=>store.confirmSteeringTarget(bound.candidateId,bound.checkpointDigest,'previous-run',now)).toThrow('unbound live source');
});

test('group non-owner sources retain exact actor and reply identity without owner escalation',async()=>{
 const f=fixture(true); // Change the binding before capture via a fresh adapter.
 const a=new OpenClawObservationRuntimeAdapter({authority:RUNTIME_AUTHORITY,resolveBinding:()=>({workspaceId:'fixture',scopeClass:'project',scopeId:'fixture-topic',requireOwner:false,allowedChannels:['telegram'],admit:()=>({status:'admitted'})})});
 const messages=[f.first,f.second].map(m=>({...m,__openclaw:{...m.__openclaw,senderIsOwner:false,transport:{...m.__openclaw.transport,replyToId:'97'}}}));
 for(const message of messages){
  const id=message.__openclaw.transport.messageId;
  a.captureMessageReceived({messageId:id,senderId:'100000001',channel:'telegram',replyToId:'97'},{sessionKey,messageId:id,senderId:'100000001',channelId:'telegram'});
  a.adoptPersistedUser({sessionKey,message},{sessionKey});
 }
 messages[0]!.__openclaw.steerTargetRunId='previous-run';
 await reconcileLateSteering(a,context,async()=>f.page(messages));expect(a.attachRun({},context).status).toBe('attached');
});

test('late SDK rejection is consumed after the bounded timeout',async()=>{
 const f=fixture();let reject!:(reason:unknown)=>void;const pending=new Promise<CompletionPage>((_,no)=>reject=no);
 await expect(reconcileLateSteering(f.a,context,()=>pending,undefined,{maxPages:1,maxTotalBytes:1024,timeoutMs:1})).rejects.toThrow();
 reject(Error('private late rejection'));await new Promise(resolve=>setTimeout(resolve,1));
 await reconcileLateSteering(f.a,context,async()=>f.page());expect(f.a.attachRun({},context).status).toBe('attached');
});
