import {afterEach,expect,test} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {OpenClawObservationRuntimeAdapter} from './runtime-adapter.ts';
import {AdmissionStore} from './admission-store.ts';
import {RUNTIME_AUTHORITY} from './runtime-authority.ts';
const roots:string[]=[];afterEach(()=>roots.splice(0).forEach(p=>rmSync(p,{recursive:true,force:true})));
const sessionKey='agent:fixture:telegram:direct:100000001',at=new Date('2026-11-04T07:00:00.000Z');
function fixture(){
 const workspace=mkdtempSync(join(tmpdir(),'mw-current-source-'));roots.push(workspace);let now=at;
 let binding:any={workspaceId:'fixture',scopeClass:'self',scopeId:'fixture',requireOwner:true,allowedChannels:['telegram'],admit:()=>({status:'admitted'})};
 const make=()=>new OpenClawObservationRuntimeAdapter({authority:RUNTIME_AUTHORITY,workspace,resolveBinding:key=>key===sessionKey?binding:null,now:()=>now});
 const a=make();const store=new AdmissionStore(workspace,RUNTIME_AUTHORITY);
 const sources=Array.from({length:40},(_,i)=>({role:'user',idempotencyKey:'channel-user:v1:'+i.toString(16).padStart(64,'0'),content:'Synthetic source '+i,__openclaw:{senderId:'100000001',senderIsOwner:true,transport:{channel:'telegram',messageId:String(i)}}}));
 for(const m of sources){const messageId=m.__openclaw.transport.messageId;a.captureMessageReceived({messageId,senderId:'100000001',channel:'telegram'},{sessionKey,messageId,senderId:'100000001',channelId:'telegram'});a.adoptPersistedUser({sessionKey,message:m},{sessionKey});}
 const source=sources[39]!,event={currentUserMessageId:source.idempotencyKey,currentUserMessage:source.content},context={sessionKey,sessionId:'branch-a',runId:'new-run',trigger:'user'};
 return{a,make,store,sources,source,event,context,setBinding:(b:any)=>binding=b,setNow:(d:Date)=>now=d};
}
test('exact host current source attaches through forty competitors and restart without touching their identities or deadlines',()=>{
 const f=fixture(),before=f.store.scanCheckpoints().records;
 const a=f.make();expect(a.attachRun(f.event,f.context).status).toBe('attached');
 expect(a.attachRun(f.event,f.context).status).toBe('duplicate');
 const after=f.store.scanCheckpoints().records;
 for(const old of before.filter(c=>c.inboundMessageId!=='39'))expect(after.find(c=>c.candidateId===old.candidateId)).toEqual(old);
 expect(after.find(c=>c.inboundMessageId==='39')).toMatchObject({stage:'run_attached',runId:'new-run',sessionId:'branch-a',expiresAt:before.find(c=>c.inboundMessageId==='39')!.expiresAt});
 expect(a.completeAgentEnd({success:true,runId:'new-run',messages:[f.source,{role:'assistant',phase:'final',content:'Synthetic result'}]},f.context).status).toBe('admitted');
 expect(f.store.scanGapReceipts().records).toHaveLength(0);
});
for(const scenario of ['unknown','invalid','text','another-run','session','scope','expired','steering'] as const)test(`exact current source rejects ${scenario} without changing competitors`,()=>{
 const f=fixture();let event:any={...f.event},context={...f.context};
 if(scenario==='unknown')event.currentUserMessageId='channel-user:v1:'+'f'.repeat(64);
 if(scenario==='invalid')event.currentUserMessageId='prompt says source 39';
 if(scenario==='text')event.currentUserMessage='changed text';
 if(scenario==='another-run'||scenario==='session'){
  f.a.attachRun(f.event,f.context);
  if(scenario==='another-run')context.runId='another-run';else context.sessionId='branch-b';
 }
 if(scenario==='scope')f.setBinding(null);
 if(scenario==='expired')f.setNow(new Date(at.getTime()+73*3600000));
 if(scenario==='steering'){
  const cp=f.store.scanCheckpoints().records.find(c=>c.inboundMessageId==='39')!;
  f.store.confirmSteeringTarget(cp.candidateId,cp.checkpointDigest,'old-run',at);
 }
 const before=f.store.scanCheckpoints().records;
 expect(()=>f.make().attachRun(event,context)).toThrow();
 if(scenario!=='expired')expect(f.store.scanCheckpoints().records).toEqual(before);
});
test('duplicate attachment cannot substitute another source, even in the same session',()=>{
 const f=fixture();f.a.attachRun(f.event,f.context);const before=f.store.scanCheckpoints().records;
 expect(()=>f.a.attachRun({currentUserMessageId:f.sources[0]!.idempotencyKey,currentUserMessage:f.sources[0]!.content},f.context)).toThrow('bound run identity');
 expect(()=>f.make().attachRun({currentUserMessageId:f.sources[0]!.idempotencyKey},f.context)).toThrow('bound run identity');
 expect(f.store.scanCheckpoints().records).toEqual(before);
});
test('IDs embedded in prompt text do not constitute current source attestation',()=>{
 const f=fixture();expect(()=>f.a.attachRun({prompt:JSON.stringify(f.event)},f.context)).toThrow('multiple persisted turns');
});
