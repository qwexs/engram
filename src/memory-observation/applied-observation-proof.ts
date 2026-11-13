/** Read-only daily/index effect proof after an operational queue was retained
 * for less time than its immutable observation. Not source admission, current
 * policy readability, domain completion, debt closure or permission to replay. */
import {lstatSync,readFileSync,realpathSync} from 'node:fs';
import {dirname,join,relative,resolve} from 'node:path';
import {sha256} from './ledger.ts';
import {validateReadableBatchObservation,type ReadableBatchObservation} from './contextual-batch-observation.ts';
import {DAILY_NOTE_APPLICATOR,renderDailyNoteEntry} from './daily-note-applicator.ts';
import {splitCanonicalSessionKey} from '../session-key.ts';
import {readIndexHandoff,readIndexGeneration} from '../qmd/index-provenance.ts';

type Row=Record<string,any>;
const equal=(a:unknown,b:unknown)=>sha256(a as any)===sha256(b as any);
function text(workspace:string,path:string){
 const p=resolve(path);if(!p.startsWith(workspace+'/')||realpathSync(p)!==p||!lstatSync(p).isFile()||lstatSync(p).size>8*1024*1024)throw Error('unsafe_effect');
 return readFileSync(p,'utf8');
}
function json(w:string,p:string):Row{return JSON.parse(text(w,p));}
function requireProof(value:unknown):asserts value{if(!value)throw Error('effect_unverified');}
export function persistedDailyEffectProof(workspace:string,observation:unknown,now=new Date()):{verified:boolean;receiptId?:string}{
 try{
  const w=resolve(workspace);requireProof(realpathSync(w)===w);
  const o=validateReadableBatchObservation(observation as ReadableBatchObservation);
  requireProof(json(w,join(w,'engram.json')).workspace?.id===o.scope.workspaceId);
  const entry=sha256(`engram.daily-note-entry.v1\0${o.observationId}`),operation=sha256(`engram.memory-apply.v1\0daily-note\0${o.observationId}\0${entry}`);
  const root=join(w,'memory-state/memory-observation/v1');
  const r=json(w,join(root,'receipts/by-operation',operation.slice(7)+'.json'));
  const alias=json(w,join(root,'receipts/by-entry',entry.slice(7)+'.json'));
  const session=splitCanonicalSessionKey(o.scope.runtimeSessionKey);
  requireProof(session&&session.agentId===o.scope.workspaceId&&/^\d{4}-\d{2}-\d{2}$/.test(r.destinationDate));
  const path=join(w,'memory','agent-'+session.agentId,session.sessionKey,r.destinationDate+'.md');
  const rendered=renderDailyNoteEntry(o,entry),marker=`<!-- engram-entry:${entry} -->`;
  requireProof(equal(r,alias)&&r.schema==='engram.memory-apply-receipt.v1'&&r.consumer==='daily-note'&&r.status==='applied'&&r.canonicalMutation===true
   &&equal(r.producer,DAILY_NOTE_APPLICATOR)&&r.operationId===operation&&r.destinationEntryId===entry
   &&r.receiptId===sha256(`engram.memory-apply-receipt.v1\0${operation}`)&&r.sourceObservationRef===o.observationId
   &&r.traceId===o.sourceRefs[0]!.traceId&&r.sourceCompletedAt===o.sourceCompletedAt&&equal(r.scope,o.scope)
   &&r.sourceProvenance?.observationDigest===o.observationDigest&&equal(r.sourceProvenance.producer,o.producer)
   &&r.sourceProvenance.sourceTurnId===o.sourceRefs[0]!.sourceTurnId&&equal(r.sourceProvenance.batchSourceRefs,o.sourceRefs)
   &&equal(r.sourceProvenance.batchCitations,o.citations)&&r.sourceProvenance.batchEvaluationPolicyDigest===o.evaluationPolicyDigest
   &&r.sourceProvenance.observationClass===o.observationClass&&equal(r.sourceProvenance.evidenceRefs,o.citations.map(c=>c.evidenceRef).slice(0,8))
   &&r.destinationRef===relative(w,path).replaceAll('\\','/')+`#engram-entry:${entry}`&&r.readBackDigest===sha256(rendered)
   &&Number.isFinite(Date.parse(r.completedAt))&&Date.parse(r.completedAt)>=Date.parse(o.completedAt)&&Date.parse(r.completedAt)<=now.getTime());
  const doc=text(w,path);requireProof(doc.split(marker).length===2);
  const lines=doc.split(/\r?\n/),start=lines.indexOf(marker);requireProof(start>=0&&lines[start+1]?.startsWith('- '));
  let end=start+2;while(end<lines.length&&lines[end]!.startsWith('  '))end++;
  requireProof(lines.slice(start,end).join('\n')===rendered);
  if(r.qmdBinding){
   const b=r.qmdBinding,h=readIndexHandoff(w,r.receiptId),g=readIndexGeneration(w,r.receiptId);
   requireProof(b.bindingDigest===sha256(['engram.memory-observation-qmd-binding.v1',b.workspaceRegistryDigest,b.indexName,b.indexKey,b.collection,b.canonicalRoot,o.scope.runtimeSessionKey].join('\0'))
    &&b.canonicalRoot===dirname(path)&&b.destinationFile===path&&b.destinationDir===dirname(path)&&b.date===r.destinationDate);
   requireProof(h&&g&&h.applyReceiptId===r.receiptId&&g.applyReceiptId===r.receiptId&&g.handoffId===h.handoffId
    &&h.traceId===r.traceId&&g.traceId===r.traceId&&equal(h.scope,r.scope)&&equal(g.scope,r.scope)
    &&h.canonicalRef===r.destinationRef&&g.canonicalRef===r.destinationRef&&h.canonicalDigest===r.readBackDigest&&g.canonicalDigest===r.readBackDigest
    &&h.index.bindingDigest===b.bindingDigest&&h.index.collection===b.collection&&h.index.indexKey===b.indexKey&&h.index.canonicalRoot===b.canonicalRoot
    &&g.index.canonicalRoot===b.canonicalRoot&&g.index.indexKey===b.indexKey&&g.index.collection===b.collection
    &&h.policyDigest===r.policyDigest&&g.policyDigest===r.policyDigest&&Date.parse(g.completedAt)>=Date.parse(r.completedAt)&&Date.parse(g.completedAt)<=now.getTime()
    &&g.index.generation>=h.index.generation);
  }
  return {verified:true,receiptId:r.receiptId};
 }catch{return {verified:false};}
}
