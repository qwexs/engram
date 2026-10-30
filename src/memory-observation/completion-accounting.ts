/** Operator-only, additive completion accounting. Never a semantic writer,
 * recovery stop, queue mutation or permission to reconstruct missing evidence. */
import {closeSync,existsSync,fsyncSync,linkSync,lstatSync,mkdirSync,openSync,readFileSync,readdirSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {sha256,deriveTraceId,type Digest,type ObservationScope} from './ledger.ts';
import {sourceDebtSnapshot} from './source-debt.ts';
import {verifySourceEffectClosure,type SourceEffectProof} from './source-effect-proof.ts';
import {isAdmissionGapRecovered} from './admission-gap-recovery.ts';
import {acquireProcessLease} from './process-lease.ts';

type Row=Record<string,any>;
const HASH=/^sha256:[a-f0-9]{64}$/,SOURCE=/^channel-user:v1:[a-f0-9]{64}$/;
const schema='engram.completion-accounting.v1';
const hash=(v:any):Digest=>sha256(v);
const op=(w:string)=>join(w,'memory-state/memory-observation');
const certRoot=(w:string)=>join(op(w),'completion-accounting/v1');
function fail(reason:string):never{throw Error(reason);}
function read(p:string):Row{
 if(realpathSync(p)!==resolve(p)||!lstatSync(p).isFile()||lstatSync(p).size>1024*1024)fail('COMPLETION_UNSAFE_ARTIFACT');
 const x=JSON.parse(readFileSync(p,'utf8'));if(!x||typeof x!=='object'||Array.isArray(x))fail('COMPLETION_INVALID_ARTIFACT');return x;
}
function rows(p:string):Row[]{
 if(!existsSync(p))return [];
 if(realpathSync(p)!==resolve(p)||!lstatSync(p).isDirectory())fail('COMPLETION_UNSAFE_ARTIFACT');
 const names=readdirSync(p).filter(n=>n.endsWith('.json')).sort();if(names.length>10000)fail('COMPLETION_CAPACITY');
 if(names.reduce((n,file)=>n+lstatSync(join(p,file)).size,0)>64*1024*1024)fail('COMPLETION_CAPACITY');
 return names.map(n=>read(join(p,n)));
}
function owner(w:string){if(!w.startsWith('/')||realpathSync(w)!==w)fail('COMPLETION_UNSAFE_WORKSPACE');const id=read(join(w,'engram.json')).workspace?.id;if(!/^[a-zA-Z0-9_-]+$/.test(id??''))fail('COMPLETION_INVALID_OWNER');return id as string;}
function warning(w:string,file:string,expected?:Digest){
 const p=resolve(file);if(dirname(p)!==join(op(w),'v1/completion-mirrors')||!/^unresolved-[a-f0-9]{64}\.json$/.test(p.slice(p.lastIndexOf('/')+1)))fail('COMPLETION_INVALID_WARNING');
 const x=read(p),r=x.request;
 if(dirname(p)!==join(op(w),'v1/completion-mirrors')||x.schema!=='engram.completion-unresolved.v1'||!r
  ||!HASH.test(r.candidateId??'')||!SOURCE.test(r.sourceTurnId??'')||r.agentId!==owner(w)
  ||!r.sessionKey?.startsWith(`agent:${r.agentId}:`)||!/^agent:[^\s]{1,2042}$/.test(r.sessionKey)||p!==join(dirname(p),'unresolved-'+hash(r).slice(7)+'.json')
  ||!Number.isFinite(Date.parse(x.closedAt)))fail('COMPLETION_INVALID_WARNING');
 if(expected&&hash(x)!==expected)fail('COMPLETION_WARNING_CHANGED');
 return {value:x,request:r,digest:hash(x),traceId:deriveTraceId(r.agentId,r.sessionKey,r.sourceTurnId)};
}
function active(w:string,traceId:string){
 if(rows(join(op(w),'v1/queues/evaluator')).some(q=>q.traceId===traceId&&q.status!=='terminal')
  ||rows(join(op(w),'v1/consumers/daily-note/queue')).some(q=>q.traceId===traceId&&q.status!=='terminal'))return true;
 const base=join(op(w),'batch-live-store/memory-batch-live/v1');
 return rows(join(base,'jobs')).some(j=>j.bundle?.sourceRefs?.some((s:Row)=>s.traceId===traceId)&&!existsSync(join(base,'done',j.jobId.slice(7)+'.json')));
}
function matchingStop(w:string,r:Row,traceId:string,now:Date,snapshot=sourceDebtSnapshot(w,now)){
 if(snapshot.corrupt)fail('COMPLETION_DEBT_CORRUPT');
 const failures=rows(join(op(w),'source-debt/v1/failures'));
 const candidates=failures.filter(f=>snapshot.writtenOffIds?.includes(f.debtId)&&f.scope?.workspaceId===r.agentId&&f.scope?.runtimeSessionKey===r.sessionKey
  &&(f.traceId===traceId||f.sourceTurnId===r.sourceTurnId||f.candidateId===r.candidateId)
  &&(!f.traceId||f.traceId===traceId)&&(!f.sourceTurnId||f.sourceTurnId===r.sourceTurnId));
 for(const f of candidates){
  const origins=failures.filter(x=>x.debtId===f.debtId);
  if(origins.some(x=>x.scope?.workspaceId!==r.agentId||x.scope?.runtimeSessionKey!==r.sessionKey||x.traceId&&x.traceId!==traceId||x.sourceTurnId&&x.sourceTurnId!==r.sourceTurnId))continue;
  // A candidate-only origin needs the exact candidate/source checkpoint join.
  if(!f.traceId&&!f.sourceTurnId){const p=join(op(w),'v1/pre-admission/checkpoints',r.candidateId.slice(7)+'.json');if(!existsSync(p))continue;const c=read(p);if(c.candidateId!==r.candidateId||c.sourceTurnId!==r.sourceTurnId||c.scope?.runtimeSessionKey!==r.sessionKey)continue;}
  const ids=origins.map(x=>x.recordId).sort();
  const receipts=rows(join(op(w),'source-debt-writeoffs/v1')).filter(x=>x.debtId===f.debtId&&hash(x.recordIds)===hash(ids));
  if(receipts.length)return {kind:'recovery_stopped',debtId:f.debtId,recordIds:ids,writeOffReceipts:receipts.map(x=>({receiptId:x.receiptId,digest:hash(x)})).sort((a,b)=>a.receiptId.localeCompare(b.receiptId))};
 }
 return null;
}
function validEffect(p:SourceEffectProof,r:Row,traceId:string,at:string){
 const s=p?.scope;
 if(p?.schema!=='engram.source-effect-proof.v1'||p.traceId!==traceId||p.sourceTurnId!==r.sourceTurnId||s?.workspaceId!==r.agentId||s?.runtimeSessionKey!==r.sessionKey
  ||![p.envelopeDigest,p.jobId,p.jobDigest,p.terminalId,p.terminalDigest].every(x=>HASH.test(x))||p.verifiedAt!==at
  ||!['self','managers','company','project'].includes(s.scopeClass)||typeof s.scopeId!=='string'||!s.scopeId||Object.keys(s).sort().join()!=='runtimeSessionKey,scopeClass,scopeId,workspaceId'
  ||!Array.isArray(p.observationIds)||new Set(p.observationIds).size!==p.observationIds.length||p.observationIds.some(x=>!HASH.test(x))||!Array.isArray(p.applicableEffects))return false;
 return p.disposition==='evaluated_skip'?p.observationIds.length===0&&p.applicableEffects.length===0
  :p.disposition==='materialized_verified'&&p.observationIds.length>0&&p.applicableEffects.length>0;
}
function validCertificate(c:Row,r:Row,traceId:string,digest:Digest,now:Date){
 const {certificateId,...body}=c;
 if(Object.keys(c).sort().join()!=='authorization,candidateId,certificateId,disposition,proof,schema,sourceTurnId,traceId,verifiedAt,warningDigest,workspaceId'
  ||c.schema!==schema||certificateId!==hash(body)||c.warningDigest!==digest||c.workspaceId!==r.agentId||c.candidateId!==r.candidateId||c.sourceTurnId!==r.sourceTurnId||c.traceId!==traceId
  ||!Number.isFinite(Date.parse(c.verifiedAt))||Date.parse(c.verifiedAt)>now.getTime()||!c.authorization?.actor||!Number.isFinite(Date.parse(c.authorization.at))
  ||Date.parse(c.authorization.at)>Date.parse(c.verifiedAt)||!c.authorization.source) return false;
 if(c.disposition==='recovery_stopped')return c.proof?.kind==='recovery_stopped'&&HASH.test(c.proof.debtId)&&Array.isArray(c.proof.recordIds)&&c.proof.recordIds.length>0&&c.proof.recordIds.every((x:string)=>HASH.test(x))
  &&Array.isArray(c.proof.writeOffReceipts)&&c.proof.writeOffReceipts.length>0&&c.proof.writeOffReceipts.every((x:Row)=>HASH.test(x.receiptId)&&HASH.test(x.digest));
 return ['evaluated_skip','materialized_verified'].includes(c.disposition)&&c.proof?.kind==='source_effect'&&HASH.test(c.proof.checkpointDigest)
  &&c.proof.effect?.disposition===c.disposition&&validEffect(c.proof.effect,r,traceId,c.verifiedAt);
}
function ensureDirectory(p:string){if(existsSync(p)){if(realpathSync(p)!==resolve(p)||!lstatSync(p).isDirectory())fail('COMPLETION_UNSAFE_ARTIFACT');return;}ensureDirectory(dirname(p));mkdirSync(p,{mode:0o700});}
function immutable(p:string,value:Row){
 ensureDirectory(dirname(p));const temp=p+'.tmp-'+randomUUID();const fd=openSync(temp,'wx',0o600);
 try{writeFileSync(fd,JSON.stringify(value)+'\n');fsyncSync(fd);}finally{closeSync(fd);}
 try{linkSync(temp,p);const d=openSync(dirname(p),'r');try{fsyncSync(d);}finally{closeSync(d);}}finally{rmSync(temp,{force:true});}
}

/** Reads only. Sealed effects survive ordinary envelope TTL; reactivated work,
 * changed live envelope bytes or an invalidated cessation make the link inactive. */
export function completionAccountingSnapshot(workspace:string,now=new Date()){
 const effects=new Set<Digest>(),stopped=new Set<Digest>(),errors:Array<{path:string,error:string}>=[];
 if(!existsSync(certRoot(workspace)))return {effects,stopped,errors};
 try{
  const id=owner(workspace),snapshot=sourceDebtSnapshot(workspace,now),certificates=rows(certRoot(workspace));
  if(readdirSync(certRoot(workspace)).filter(n=>n.endsWith('.json')).some(n=>!HASH.test(read(join(certRoot(workspace),n)).warningDigest??'')||n!==read(join(certRoot(workspace),n)).warningDigest.slice(7)+'.json'))fail('COMPLETION_CERTIFICATE_FILENAME');
  for(const c of certificates){
   const path=join(certRoot(workspace),String(c.warningDigest).slice(7)+'.json');
   try{
    const {certificateId,...body}=c;
    if(c.schema!==schema||certificateId!==hash(body)||c.workspaceId!==id||!HASH.test(c.warningDigest??'')||!existsSync(path)||hash(read(path))!==hash(c))fail('COMPLETION_CERTIFICATE_INVALID');
    const mirrors=rows(join(op(workspace),'v1/completion-mirrors')).filter(x=>x.schema==='engram.completion-unresolved.v1'&&hash(x)===c.warningDigest);
    if(mirrors.length!==1)continue; // Old receipt changed/retired: never hide a new warning.
    const raw=mirrors[0]!,r=raw.request,traceId=deriveTraceId(r.agentId,r.sessionKey,r.sourceTurnId);
    warning(workspace,join(op(workspace),'v1/completion-mirrors','unresolved-'+hash(r).slice(7)+'.json'),c.warningDigest);
    if(!validCertificate(c,r,traceId,c.warningDigest,now))fail('COMPLETION_CERTIFICATE_INVALID');
    if(active(workspace,traceId))continue;
    if(c.disposition==='recovery_stopped'){
     const proof=matchingStop(workspace,r,traceId,now,snapshot);if(proof&&hash(proof)===hash(c.proof))stopped.add(c.warningDigest);
    }else{
     const p=join(op(workspace),'v1/envelopes',traceId.slice(7)+'.json');if(existsSync(p)&&hash(read(p))!==c.proof.effect.envelopeDigest)continue;
     effects.add(c.warningDigest);
    }
   }catch{errors.push({path,error:'completion_accounting_invalid'});}
  }
 }catch{errors.push({path:certRoot(workspace),error:'completion_accounting_unreadable'});}
 return {effects,stopped,errors};
}

export function reconcileCompletionAccounting(options:{workspace:string;receiptFile:string;receiptDigest:Digest;authorizedBy:string;authorizedAt:string;authorizationSource:string;apply?:boolean;now?:Date}){
 const w=resolve(options.workspace),now=options.now??new Date();owner(w);
 if(!options.workspace.startsWith('/')||!HASH.test(options.receiptDigest)||!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,299}$/.test(options.authorizedBy)
  ||!options.authorizationSource?.trim()||options.authorizationSource.length>300||!Number.isFinite(Date.parse(options.authorizedAt))||Date.parse(options.authorizedAt)>now.getTime())fail('COMPLETION_AUTHORIZATION_INVALID');
 const act=()=>{
  const a=warning(w,options.receiptFile,options.receiptDigest),path=join(certRoot(w),a.digest.slice(7)+'.json');
  if(Date.parse(a.value.closedAt)>now.getTime())fail('COMPLETION_WARNING_FUTURE');
  if(existsSync(path)){
   const s=completionAccountingSnapshot(w,now);if(s.errors.length)fail('COMPLETION_CERTIFICATE_INVALID');
   if(s.effects.has(a.digest)||s.stopped.has(a.digest))return {status:'already_accounted',warningDigest:a.digest,disposition:read(path).disposition,path};
   fail('COMPLETION_EXISTING_CERTIFICATE_INACTIVE');
  }
  if(active(w,a.traceId))return {status:'blocked',warningDigest:a.digest,reason:'active_source_work'};
  const cpPath=join(op(w),'v1/pre-admission/checkpoints',a.request.candidateId.slice(7)+'.json');
  const cp=existsSync(cpPath)?read(cpPath):null;
  let proof:Row|null=null,disposition:string|null=null;
  if(cp&&cp.candidateId===a.request.candidateId&&cp.sourceTurnId===a.request.sourceTurnId&&cp.scope?.runtimeSessionKey===a.request.sessionKey&&cp.scope?.workspaceId===a.request.agentId
   &&(cp.stage==='ledger_admitted'||cp.stage==='terminal_gap'&&isAdmissionGapRecovered(w,cp as any))){
   const effect=verifySourceEffectClosure(w,{traceId:a.traceId,sourceTurnId:a.request.sourceTurnId,scope:cp.scope as ObservationScope},now);
   if(effect.closed&&effect.proof){proof={kind:'source_effect',checkpointDigest:hash(cp),effect:effect.proof};disposition=effect.proof.disposition;}
  }
  if(!proof){proof=matchingStop(w,a.request,a.traceId,now);if(proof)disposition='recovery_stopped';}
  if(!proof)return {status:'blocked',warningDigest:a.digest,reason:'exact_effect_or_cessation_unverified'};
  const body={schema,workspaceId:a.request.agentId,warningDigest:a.digest,candidateId:a.request.candidateId,sourceTurnId:a.request.sourceTurnId,traceId:a.traceId,disposition,proof,
   authorization:{actor:options.authorizedBy,at:options.authorizedAt,source:options.authorizationSource},verifiedAt:now.toISOString()};
  const certificate={...body,certificateId:hash(body)};if(!validCertificate(certificate,a.request,a.traceId,a.digest,now))fail('COMPLETION_CERTIFICATE_INVALID');
  if(options.apply){immutable(path,certificate);const s=completionAccountingSnapshot(w,now);if(s.errors.length||!s.effects.has(a.digest)&&!s.stopped.has(a.digest))fail('COMPLETION_READBACK_FAILED');}
  return {status:options.apply?'applied':'planned',warningDigest:a.digest,disposition,certificateId:certificate.certificateId,path};
 };
 if(!options.apply)return act();
 ensureDirectory(certRoot(w));const release=acquireProcessLease(join(certRoot(w),'writer.lock'));if(!release)fail('COMPLETION_ACCOUNTING_BUSY');
 try{return act();}finally{release();}
}
