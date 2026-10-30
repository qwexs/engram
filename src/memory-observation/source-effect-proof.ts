/** Read-only exact source closure verification. Missing/unsupported proof leaves
 * administrative debt open; no queue reason or process exit can close it. */
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { Database } from 'bun:sqlite';
import { deriveSourceDigest, deriveTraceId, sha256, type Digest, type JsonValue, type ObservationScope } from './ledger.ts';
import { parseBatchShadowOutput, validateCompiledBatchBundle } from './batch-shadow-runner.ts';
import { validateReadableBatchObservation, contextualBatchObservations, renderContextualBatch, CONTEXTUAL_BATCH_SCHEMA, type ReadableBatchObservation } from './contextual-batch-observation.ts';
import { DAILY_NOTE_APPLICATOR, buildDailyNoteCanaryPolicy, renderDailyNoteEntry, type MemoryApplyReceiptV1 } from './daily-note-applicator.ts';
import { resolveMemoryObservationProjection, memoryObservationBinding } from './projection.ts';
import { groupDomainOf } from './group-bindings.ts';
import { readableEvaluationPolicies, evaluationQuality, readModelTransition } from './model-transition.ts';
import { readIndexHandoff, readIndexGeneration } from '../qmd/index-provenance.ts';
import { resolveQmdContext } from '../qmd/context.ts';
import { resolveQmdMaintenanceStateRoot } from '../qmd/maintenance-integration.ts';
import { readQmdMaintenanceState } from '../qmd/maintenance.ts';
import { qualityScopeEnabled, readableContextualDigests } from './quality-rollout.ts';
import { buildContextualObservation } from './contextual-observation.ts';
import { groupAssertionAttribution } from './group-attribution.ts';
import { deriveBatchObservationId } from './batch-observation.ts';
import { resolveCanaryQmdRuntimeBinding } from './qmd-binding-preflight.ts';
import { splitCanonicalSessionKey } from '../session-key.ts';
import {readHistoricalConsumerProof,type HistoricalConsumerProof} from './historical-consumer-proof.ts';

type Row = Record<string, any>;
export type SourceEffectProof = {
  schema: 'engram.source-effect-proof.v1';
  disposition: 'evaluated_skip' | 'materialized_verified';
  traceId: Digest; sourceTurnId: string; scope: ObservationScope; envelopeDigest: Digest;
  jobId: Digest; jobDigest: Digest; terminalId: Digest; terminalDigest: Digest;
  observationIds: Digest[]; applicableEffects: Array<Record<string, string | number | boolean | string[]>>;
  verifiedAt: string;
};
export type SourceEffectClosure = { closed: boolean; reason: string; proof?: SourceEffectProof };
export type SourceEffectIdentity = { traceId: Digest; sourceTurnId?: string; scope?: ObservationScope };
const hash = (v: unknown): Digest => sha256(v as JsonValue);
const equal = (a: unknown, b: unknown) => hash(a) === hash(b);
const key = (v: unknown): string => { if (typeof v !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(v)) throw Error('invalid_digest'); return v.slice(7); };
function requireProof(ok: unknown, reason: string): asserts ok { if (!ok) throw Error(reason); }
function safe(workspace: string, path: string): string {
  const abs=resolve(path), root=realpathSync(workspace);
  requireProof(abs.startsWith(root+'/') && realpathSync(abs)===abs && lstatSync(abs).isFile() && !lstatSync(abs).isSymbolicLink(), 'noncanonical_artifact');
  return readFileSync(abs,'utf8');
}
function json(workspace: string,path: string): Row { const v=JSON.parse(safe(workspace,path)); requireProof(v && typeof v==='object'&&!Array.isArray(v),'invalid_artifact');return v; }
function time(v: unknown, now: Date): boolean { return typeof v==='string'&&Number.isFinite(Date.parse(v))&&Date.parse(v)<=now.getTime(); }
function single(content: string, marker: string): boolean { return content.split(marker).length===2; }
function renderedEntry(content:string,marker:string,trailingNewline=false):string|null {
  const lines=content.split(/\r?\n/),start=lines.indexOf(marker);
  if(start<0||!lines[start+1]?.startsWith('- '))return null;
  let end=start+2;while(end<lines.length&&lines[end]!.startsWith('  '))end++;
  return lines.slice(start,end).join('\n')+(trailingNewline?'\n':'');
}
function jsonFiles(workspace: string,dir: string): Array<{path:string,value:Row}> {
  if(!existsSync(dir)) return [];
  requireProof(realpathSync(dir)===resolve(dir),'noncanonical_artifact');
  return readdirSync(dir).filter(n=>n.endsWith('.json')).sort().map(n=>({path:join(dir,n),value:json(workspace,join(dir,n))}));
}
function exactScope(partition: Row): ObservationScope { return {workspaceId:partition.workspaceId,runtimeSessionKey:partition.runtimeSessionKey,scopeClass:partition.scopeClass,scopeId:partition.scopeId}; }

function verifiedDaily(workspace: string,root: string,o: ReadableBatchObservation,now: Date,historicalOverride?:HistoricalConsumerProof[]): {receipt:MemoryApplyReceiptV1,effect:Record<string,string|number|boolean|string[]>} {
  const entry=sha256(`engram.daily-note-entry.v1\0${o.observationId}`);
  const operation=sha256(`engram.memory-apply.v1\0daily-note\0${o.observationId}\0${entry}`);
  const r=json(workspace,join(root,'receipts/by-operation',key(operation)+'.json')) as MemoryApplyReceiptV1;
  const alias=json(workspace,join(root,'receipts/by-entry',key(entry)+'.json'));
  const split=splitCanonicalSessionKey(o.scope.runtimeSessionKey);
  requireProof(split && /^\d{4}-\d{2}-\d{2}$/.test(r.destinationDate),'invalid_note_destination');
  const notePath=join(workspace,'memory','agent-'+split.agentId,split.sessionKey,r.destinationDate+'.md');
  const marker=`<!-- engram-entry:${entry} -->`,rendered=renderDailyNoteEntry(o,entry);
  requireProof(equal(r,alias)&&r.schema==='engram.memory-apply-receipt.v1'&&r.consumer==='daily-note'&&r.status==='applied'&&r.canonicalMutation===true
    &&equal(r.producer,DAILY_NOTE_APPLICATOR)&&r.operationId===operation&&r.destinationEntryId===entry&&r.receiptId===sha256(`engram.memory-apply-receipt.v1\0${operation}`)
    &&r.sourceObservationRef===o.observationId&&r.traceId===o.sourceRefs[0]!.traceId&&r.sourceCompletedAt===o.sourceCompletedAt&&equal(r.scope,o.scope)
    &&r.sourceProvenance?.observationDigest===o.observationDigest&&equal(r.sourceProvenance.producer,o.producer)
    &&r.sourceProvenance.sourceTurnId===o.sourceRefs[0]!.sourceTurnId&&equal(r.sourceProvenance.batchSourceRefs,o.sourceRefs)
    &&equal(r.sourceProvenance.batchCitations,o.citations)&&r.sourceProvenance.batchEvaluationPolicyDigest===o.evaluationPolicyDigest
    &&r.sourceProvenance.observationClass===o.observationClass&&equal(r.sourceProvenance.evidenceRefs,o.citations.map(c=>c.evidenceRef).slice(0,8))&&time(r.completedAt,now)&&Date.parse(r.completedAt)>=Date.parse(o.completedAt)
    &&r.destinationRef===relative(workspace,notePath).replaceAll('\\','/')+`#engram-entry:${entry}`&&r.readBackDigest===sha256(rendered),'invalid_apply_receipt_join');
  const doc=safe(workspace,notePath);
  requireProof(single(doc,marker)&&renderedEntry(doc,marker)===rendered,'note_readback_failed');
  const live=resolveMemoryObservationProjection({workspace,workspaceId:o.scope.workspaceId});
  const historical=readHistoricalConsumerProof(workspace,r,live,o.scope,now,historicalOverride);
  const projection=historical?.projection??live;
  const readable=historical?.readable??readableEvaluationPolicies(workspace,projection,o.scope);
  const binding=memoryObservationBinding(projection,o.scope.runtimeSessionKey),daily=projection.consumers?.dailyNote;
  requireProof(projection.enabled&&projection.mode==='canary'&&binding&&binding.scopeId===o.scope.scopeId&&binding.scopeClass===o.scope.scopeClass&&daily
    &&Date.parse(r.completedAt)>=Date.parse(daily.applyAfter)&&daily.allowedObservationClasses.includes(o.observationClass as 'episodic.event')
    &&r.destinationDate===new Intl.DateTimeFormat('sv-SE',{timeZone:daily.timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(o.sourceCompletedAt))
    &&readable.includes(o.evaluationPolicyDigest),'consumer_applicability_unverified');
  let effectiveQmd=daily.qmdBinding;
  if(effectiveQmd && 'resolver' in effectiveQmd){
    const resolved=resolveCanaryQmdRuntimeBinding({workspace,runtimeSessionKey:o.scope.runtimeSessionKey,timezone:daily.timezone,
      destinationAt:o.sourceCompletedAt,resolver:effectiveQmd,context:resolveQmdContext({value:workspace,source:'explicit'})});
    requireProof(equal(resolved,r.qmdBinding),'current_qmd_applicability_changed');
  }
  const common={workspaceId:o.scope.workspaceId,exactScope:o.scope,applyAfter:daily.applyAfter,timezone:daily.timezone,
    allowedObservationClasses:daily.allowedObservationClasses,maxAppliesPerWake:daily.maxAppliesPerWake,
    allowedBatchEvaluationPolicyDigest:projection.evaluation!.policyDigest,...(daily.qmdBinding?{qmdBinding:r.qmdBinding??daily.qmdBinding}:{})};
  const transition=historical?historical.transition:readModelTransition(workspace,projection);
  const previousBase=transition?.previousProjection.evaluation!.policyDigest;
  const preQualityPrevious=previousBase?[previousBase,...(qualityScopeEnabled(transition!.previousQuality,o.scope)?readableContextualDigests(previousBase):[])]:[];
  const policyDigests=[buildDailyNoteCanaryPolicy(common).policyDigest,buildDailyNoteCanaryPolicy({...common,
    allowContextualObservations:qualityScopeEnabled(historical?historical.quality:evaluationQuality(workspace,projection),o.scope),
    allowedPreviousBatchEvaluationPolicyDigests:readable.filter(v=>v!==projection.evaluation!.policyDigest)}).policyDigest,
    // A later exact quality sidecar must not invalidate receipts sealed under
    // the same signed model lineage before contextual producer opt-in.
    ...(transition?[buildDailyNoteCanaryPolicy({...common,allowContextualObservations:false,
      allowedPreviousBatchEvaluationPolicyDigests:preQualityPrevious}).policyDigest]:[])];
  requireProof(policyDigests.includes(r.policyDigest),'sealed_consumer_policy_unverified');
  const effect: Record<string,string|number|boolean|string[]>={kind:'daily-note',observationId:o.observationId,observationDigest:o.observationDigest,
    operationId:r.operationId,receiptId:r.receiptId,receiptDigest:hash(r),entryId:entry,renderedDigest:r.readBackDigest,consumerApplicabilityDigest:hash({binding,daily,evaluation:projection.evaluation})};
  if(historical)effect.historicalConsumerProofId=historical.certificateId;
  if(daily.qmdBinding||r.qmdBinding){
    const h=readIndexHandoff(workspace,r.receiptId),g=readIndexGeneration(workspace,r.receiptId);
    let b:Row|undefined=r.qmdBinding;
    if(b){
      requireProof(b.bindingDigest===sha256(['engram.memory-observation-qmd-binding.v1',b.workspaceRegistryDigest,b.indexName,b.indexKey,b.collection,b.canonicalRoot,o.scope.runtimeSessionKey].join('\0'))
        &&resolve(b.canonicalRoot)===dirname(notePath),'index_binding_unverified');
    }else{
      // The canonical index writer supports a collection-only static policy.
      // Such a receipt deliberately has no resolved qmdBinding. Verify its
      // ORIGINAL static handoff digest instead of requiring a newer field.
      const staticPolicy=daily.qmdBinding,context=resolveQmdContext({value:workspace,source:'explicit'});
      requireProof(staticPolicy&&!('resolver' in staticPolicy)&&typeof staticPolicy.collection==='string'
        &&h&&h.index.collection===staticPolicy.collection&&h.index.canonicalRoot===dirname(notePath)
        &&h.index.indexKey===context.physicalIndex.key&&context.physicalIndex.exists
        &&context.policy.ownedCollections.includes(staticPolicy.collection)&&context.policy.readableCollections.includes(staticPolicy.collection)
        &&h.index.bindingDigest===sha256(['engram.memory-observation-qmd-static-binding.v1',h.index.indexKey,staticPolicy.collection,dirname(notePath),o.scope.runtimeSessionKey].join('\0')),'index_binding_unverified');
      b={bindingDigest:h.index.bindingDigest,indexKey:h.index.indexKey,collection:h.index.collection,canonicalRoot:h.index.canonicalRoot};
    }
    requireProof(h&&g&&h.applyReceiptId===r.receiptId&&g.applyReceiptId===r.receiptId&&g.handoffId===h.handoffId
      &&h.traceId===r.traceId&&g.traceId===r.traceId&&equal(h.scope,r.scope)&&equal(g.scope,r.scope)
      &&h.canonicalRef===r.destinationRef&&g.canonicalRef===r.destinationRef&&h.canonicalDigest===r.readBackDigest&&g.canonicalDigest===r.readBackDigest
      &&h.index.bindingDigest===b.bindingDigest&&h.index.collection===b.collection&&h.index.indexKey===b.indexKey
      &&h.index.canonicalRoot===b.canonicalRoot&&g.index.canonicalRoot===b.canonicalRoot&&g.index.indexKey===b.indexKey&&g.index.collection===b.collection
      &&h.policyDigest===r.policyDigest&&g.policyDigest===r.policyDigest&&time(h.createdAt,now)&&time(g.completedAt,now)&&Date.parse(g.completedAt)>=Date.parse(r.completedAt)
      &&(g.index.indexKey!==h.index.indexKey||g.index.generation>=h.index.generation),'index_generation_unverified');
    effect.indexGenerationId=g.generationId;effect.indexGenerationDigest=g.generationDigest;
  }
  const domain=groupDomainOf(binding)?.domain;
  if(domain) Object.assign(effect,verifiedDomain(workspace,root,o,r,domain,now));
  return {receipt:r,effect};
}

function verifiedDomain(workspace:string,root:string,o:ReadableBatchObservation,r:MemoryApplyReceiptV1,domain:string,now:Date):Record<string,string|number|boolean|string[]> {
  requireProof(/^[a-z0-9][a-z0-9-]*$/.test(domain),'domain_identity_invalid');
  const state=join(workspace,'memory-state/domain-effects/v1'),d=json(workspace,join(state,'receipts',key(r.operationId)+'.json'));
  const dirty=json(workspace,join(state,'dirty',key(r.operationId)+'.json'));
  const content=o.schema===CONTEXTUAL_BATCH_SCHEMA?renderContextualBatch(o).replace(/^- /,''):o.payload.text;
  const text=content.replace(/<!--/g,'&lt;!--').split(/\r?\n/).join('\n  ');
  const marker=`<!-- engram-domain-entry:${r.operationId} -->`;
  const block=marker+'\n- '+o.sourceCompletedAt+' ['+o.payload.section+'] '+text+'\n  Источник: '+r.destinationRef+'\n';
  const domainRoot=join(workspace,'memory/domains',domain),log=safe(workspace,join(domainRoot,'changelog.md'));
  requireProof(d.schema==='engram.domain-apply-receipt.v1'&&d.operationId===r.operationId&&d.sourceReceiptId===r.receiptId&&d.sourceObservationId===o.observationId
    &&d.sourceObservationDigest===o.observationDigest&&equal(d.scope,r.scope)&&d.domain===domain&&d.canonicalApplied===true&&d.sourceCompletedAt===o.sourceCompletedAt
    &&d.destination===`memory/domains/${domain}/changelog.md#${marker}`&&d.entryDigest===sha256(block)&&single(log,marker)&&renderedEntry(log,marker,true)===block,'domain_readback_failed');
  requireProof(dirty.schema==='engram.domain-dirty-receipt.v1'&&dirty.operationId===r.operationId&&dirty.domainApplyReceiptDigest===hash(d)
    &&dirty.canonicalApplied===true&&dirty.qmdDirtyMarked===true&&Number.isSafeInteger(dirty.generation)&&dirty.generation>=1&&Array.isArray(dirty.collections)&&dirty.collections.length,'domain_dirty_unverified');
  const context=resolveQmdContext({value:workspace,source:'explicit'});
  requireProof(context.physicalIndex.key===dirty.indexKey&&context.physicalIndex.exists,'domain_index_unavailable');
  const active=resolveMemoryObservationProjection({workspace,workspaceId:o.scope.workspaceId}),resolver=active.consumers?.dailyNote.qmdBinding;
  requireProof(resolver&&'resolver' in resolver,'domain_applicability_unverified');
  // Daily proof already validated the pinned registry digest. This checks the
  // full applicable domain collection set, including authorized aggregates.
  requireProof(lstatSync(resolver.manifestPath).isFile()&&!lstatSync(resolver.manifestPath).isSymbolicLink(),'domain_applicability_unverified');
  const manifest=JSON.parse(readFileSync(resolver.manifestPath,'utf8')),registry=manifest.registry??manifest;
  const ownedPolicy=new Set(context.policy.ownedCollections),readablePolicy=new Set(context.policy.readableCollections);
  const authorized=(c:Row)=>c.owner===o.scope.workspaceId&&ownedPolicy.has(c.name)&&readablePolicy.has(c.name);
  const exact=registry.collections.filter((c:Row)=>authorized(c)&&resolve(c.path)===domainRoot);
  const aggregate=registry.collections.filter((c:Row)=>authorized(c)&&resolve(c.path)===join(workspace,'memory/domains'));
  requireProof(exact.length===1&&equal([...exact,...aggregate].map((c:Row)=>c.name).sort(),[...dirty.collections].sort()),'domain_applicable_collections_unverified');
  const maintenance=readQmdMaintenanceState(resolveQmdMaintenanceStateRoot(),dirty.indexKey);
  requireProof(maintenance.updateCompletedGeneration>=dirty.generation&&maintenance.embedCompletedGeneration>=dirty.generation,'domain_index_generation_pending');
  let db:Database|undefined;
  try{
    db=new Database(context.physicalIndex.path,{readonly:true,strict:true});
    const rows=db.query('SELECT name,path FROM store_collections').all() as Array<{name:string,path:string}>;
    const owned=new Set(context.policy.ownedCollections),readable=new Set(context.policy.readableCollections);
    requireProof(new Set(dirty.collections).size===dirty.collections.length,'domain_index_collection_unverified');
    const expected=dirty.collections.map((name:string)=>{
      const matches=rows.filter(c=>c.name===name);
      requireProof(matches.length===1&&owned.has(name)&&readable.has(name),'domain_index_collection_unverified');
      const collection=matches[0]!,canonicalRoot=realpathSync(collection.path);
      requireProof(canonicalRoot===realpathSync(domainRoot)||canonicalRoot===realpathSync(join(workspace,'memory/domains')),'domain_index_collection_unverified');
      return {...collection,canonicalRoot};
    });
    requireProof(expected.filter((c:Row)=>c.canonicalRoot===realpathSync(domainRoot)).length===1,'domain_index_collection_unverified');
    const documentProofs=expected.map((c:Row)=>{
      const indexedPath=relative(c.canonicalRoot,join(domainRoot,'changelog.md')).replaceAll('\\','/');
      const document=db!.query('SELECT d.hash,c.doc FROM documents d JOIN content c ON c.hash=d.hash WHERE d.collection=? AND d.path=? AND d.active=1').get(c.name,indexedPath) as {hash:string,doc:string}|null;
      requireProof(document&&single(document.doc,marker)&&renderedEntry(document.doc,marker,true)===block,'domain_index_entry_stale');
      return {collection:c.name,documentHash:document.hash,entryDigest:d.entryDigest};
    });
    return {domainReceiptDigest:hash(d),domainDirtyDigest:hash(dirty),domainEntryDigest:d.entryDigest,
      domainIndexGeneration:dirty.generation,domainIndexProofDigest:hash({indexKey:dirty.indexKey,documents:documentProofs,maintenanceGeneration:maintenance.embedCompletedGeneration})};
  }finally{db?.close();}
}

export function verifySourceEffectClosure(workspaceValue:string,identity:SourceEffectIdentity,now=new Date(),operatorOptions?:{historicalConsumerProofs?:HistoricalConsumerProof[]}):SourceEffectClosure {
  try{
    const workspace=realpathSync(resolve(workspaceValue)),root=join(workspace,'memory-state/memory-observation/v1');key(identity.traceId);
    requireProof(Number.isFinite(now.getTime()),'invalid_verification_time');
    const e=json(workspace,join(root,'envelopes',key(identity.traceId)+'.json'));
    const config=json(workspace,join(workspace,'engram.json'));
    requireProof(e.scope?.workspaceId===config.workspace?.id&&e.scope?.runtimeSessionKey?.startsWith(`agent:${config.workspace.id}:`),'workspace_identity_unverified');
    requireProof(e.schema==='engram.memory-observation-job.v1'&&e.traceId===identity.traceId&&/^channel-user:v1:[a-f0-9]{64}$/.test(e.sourceTurnId)
      &&deriveTraceId(e.scope.workspaceId,e.scope.runtimeSessionKey,e.sourceTurnId)===e.traceId&&e.sourceDigest===deriveSourceDigest(e.sourceTurnId,e.scope,e.sourceCompletedAt)
      &&(!identity.sourceTurnId||e.sourceTurnId===identity.sourceTurnId)&&(!identity.scope||equal(e.scope,identity.scope))&&time(e.sourceCompletedAt,now)&&time(e.admittedAt,now),'source_identity_unverified');
    const base=join(workspace,'memory-state/memory-observation/batch-live-store/memory-batch-live/v1');
    const completed=jsonFiles(workspace,join(base,'done')).filter(({value:t})=>['engram.memory-batch-live-terminal.v1','engram.memory-batch-live-terminal.v2'].includes(t.schema)
      &&Array.isArray(t.dispositions)&&t.dispositions.some((d:Row)=>d.traceId===identity.traceId&&['write','skip'].includes(d.decision)));
    requireProof(completed.length===1,'completed_source_disposition_unavailable_or_ambiguous');
    const t=completed[0]!.value,j=json(workspace,join(base,'jobs',key(t.jobId)+'.json'));
    const terminal=json(workspace,join(base,'terminals',key(t.jobId)+'.json'));
    const {terminalId,...terminalBody}=t;
    requireProof(equal(t,terminal)&&terminalId===hash(terminalBody)&&time(t.completedAt,now)&&j.schema==='engram.memory-batch-live-job.v1'
      &&j.jobId===sha256({schema:j.schema,partition:j.partition,evaluationPolicyDigest:j.evaluationPolicyDigest,bundleId:j.bundle?.bundleId})
      &&t.jobId===j.jobId&&t.bundleId===j.bundle.bundleId&&equal(j.partition,j.bundle.partition)&&equal(e.scope,exactScope(j.partition))
      &&e.policyDigest===j.partition.policyDigest&&time(j.createdAt,now),'completed_job_join_unverified');
    validateCompiledBatchBundle(j.bundle,new Date(j.createdAt));
    const sources=j.bundle.sourceRefs as Row[];
    requireProof(sources.length===t.dispositions.length&&new Set(t.dispositions.map((d:Row)=>d.traceId)).size===sources.length
      &&sources.every(s=>t.dispositions.some((d:Row)=>d.traceId===s.traceId)),'source_coverage_unverified');
    const source=sources.find(s=>s.traceId===identity.traceId);
    requireProof(source&&source.sourceTurnId===e.sourceTurnId&&source.sourceDigest===e.sourceDigest&&source.evidenceDigest===e.evidenceDigest&&source.sourceCompletedAt===e.sourceCompletedAt,'source_proof_changed_without_verified_lineage');
    const d=t.dispositions.find((d:Row)=>d.traceId===identity.traceId);
    requireProof(['write','skip'].includes(d.decision)&&Array.isArray(d.observationRefs)&&new Set(d.observationRefs).size===d.observationRefs.length,'unsupported_disposition');
    let expectedObservationIds: string[]=[];
    const expectedV1=new Map<string,{assertion:Row,groupId:string,index:number,completedAt:string}>();
    let expectedContextual: ReadableBatchObservation[]|null=null;
    // Validate evaluator result and semantic disposition, not just a queue reason.
    if(t.schema==='engram.memory-batch-live-terminal.v1'){
      const result=json(workspace,join(workspace,'memory-state/memory-observation/batch-live-store/memory-batch-shadow/v1/results',key(t.resultKey)+'.json'));
      requireProof(result.schema==='engram.memory-batch-shadow-result.v1'&&hash(result)===t.resultDigest&&result.resultKey===t.resultKey
        &&result.resultKey===sha256(`engram.memory-batch-shadow-result-key.v1\0${result.requestDigest}`)
        &&result.outputDigest===hash({schema:'engram.memory-batch-shadow-output.v1',groups:result.groups})
        &&result.bundleId===j.bundle.bundleId&&equal(result.partition,j.partition)&&equal(result.sourceRefs,sources),'evaluation_result_unverified');
      const output=parseBatchShadowOutput({schema:'engram.memory-batch-shadow-output.v1',groups:result.groups},j.bundle,new Date(t.completedAt));
      const group=output.groups.find(g=>g.sourceRefs.includes(identity.traceId));
      requireProof(group&&group.decision!=='defer','semantic_disposition_unverified');
      if(d.reasonCode==='semantic_batch_skip') requireProof(group.decision==='skip'&&d.decision==='skip'&&d.observationRefs.length===0,'semantic_skip_unverified');
      else {
        requireProof(group.decision==='write'&&d.decision==='write'&&d.reasonCode==='semantic_batch_write'&&d.observationRefs.length>0,'covering_assertions_unverified');
        expectedObservationIds=group.assertions.flatMap((a,index)=>a.citations.some(c=>c.traceId===identity.traceId)?[deriveBatchObservationId({bundleId:j.bundle.bundleId,groupId:group.groupId,assertionIndex:index,observationClass:a.section==='events'?'episodic.event':'episodic.decision',evaluationPolicyDigest:j.evaluationPolicyDigest})]:[]);
        requireProof(equal(expectedObservationIds,d.observationRefs),'expected_assertion_coverage_unverified');
        group.assertions.forEach((assertion,index)=>{const id=deriveBatchObservationId({bundleId:j.bundle.bundleId,groupId:group.groupId,assertionIndex:index,observationClass:assertion.section==='events'?'episodic.event':'episodic.decision',evaluationPolicyDigest:j.evaluationPolicyDigest});expectedV1.set(id,{assertion,groupId:group.groupId,index,completedAt:result.completedAt});});
      }
    }else{
      const result=json(workspace,join(base,'contextual-results',key(j.jobId)+'.json')), {digest,...body}=result;
      requireProof(result.schema==='engram.memory-contextual-result.v2'&&digest===hash(body)&&result.jobId===j.jobId&&result.policyDigest===j.evaluationPolicyDigest
        &&hash(result.evaluated)===t.resultDigest&&equal(t.sourceDispositions,result.evaluated?.observation?.dispositions),'contextual_result_unverified');
      const observed=result.evaluated.observation;
      const output={schema:'engram.memory-contextual-output.v2',assertions:observed.assertions,dispositions:observed.dispositions};
      requireProof(equal(buildContextualObservation(output,j.bundle,observed.evaluationPolicyDigest,new Date(observed.recordedAt)),observed),'contextual_evidence_rebuild_failed');
      expectedContextual=contextualBatchObservations(output,j.bundle,j.evaluationPolicyDigest,new Date(observed.recordedAt));
      const sd=t.sourceDispositions.filter((s:Row)=>s.traceId===identity.traceId);
      requireProof(sd.length===1&&d.reasonCode===`semantic_contextual_${sd[0].kind}`&&Array.isArray(sd[0].assertionIds),'contextual_source_disposition_unverified');
      if(sd[0].kind==='skip') requireProof(d.decision==='skip'&&d.observationRefs.length===0&&sd[0].assertionIds.length===0,'semantic_skip_unverified');
      else requireProof(['asserted','supports','duplicate'].includes(sd[0].kind)&&sd[0].assertionIds.length===d.observationRefs.length&&d.observationRefs.length>0,'covering_assertions_unverified');
    }
    const effects:SourceEffectProof['applicableEffects']=[];
    for(const id of d.observationRefs){
      const o=json(workspace,join(root,'observations/batch',key(id)+'.json')) as ReadableBatchObservation;
      validateReadableBatchObservation(o);
      requireProof(o.observationId===id&&o.bundleId===j.bundle.bundleId&&o.evaluationPolicyDigest===j.evaluationPolicyDigest&&equal(o.scope,e.scope)
        &&o.sourceRefs.some(s=>equal(s,source)),'observation_source_join_unverified');
      if(t.schema==='engram.memory-batch-live-terminal.v1'){
        const expected=expectedV1.get(id);requireProof(expected,'expected_assertion_unavailable');
        const a=expected.assertion,cited=new Set(a.citations.map((c:Row)=>c.traceId));
        const refs=j.bundle.sourceRefs.filter((s:Row)=>cited.has(s.traceId));
        const quoted=a.reasonCodes.includes('source_quote')||a.reasonCodes.includes('source_excerpt');
        const replyIds=[...new Set(j.bundle.inputs.filter((i:Row)=>cited.has(i.traceId)).map((i:Row)=>i.evidence?.source?.replyToMessageId).filter((v:unknown)=>typeof v==='string'&&/^[0-9]+$/.test(v)))];
        const label=a.reasonCodes.includes('source_excerpt')?'Фрагмент слов пользователя: «':'Слова пользователя: «';
        const rendered=quoted?label+a.text+'»'+(replyIds.length?' (ответ на №'+replyIds.join(', №')+')':''):a.text;
        const text=groupAssertionAttribution(j.bundle,a.actorRef,a.citations)+rendered;
        requireProof(o.groupId===expected.groupId&&o.assertionIndex===expected.index&&equal(o.sourceRefs,refs)&&equal(o.citations,a.citations)
          &&equal(o.payload,{section:a.section,text,actorRef:a.actorRef,outcomeStatus:a.outcomeStatus})&&o.confidence===a.confidence
          &&equal(o.reasonCodes,a.reasonCodes)&&o.completedAt===expected.completedAt,'observation_evaluator_payload_mismatch');
      }
      if(t.schema==='engram.memory-batch-live-terminal.v2'){
        const sd=t.sourceDispositions.find((s:Row)=>s.traceId===identity.traceId);
        requireProof(sd.assertionIds.includes(o.groupId)&&equal(o,expectedContextual!.find(a=>a.observationId===id)),'covering_assertion_identity_unverified');
      }
      effects.push(verifiedDaily(workspace,root,o,now,operatorOptions?.historicalConsumerProofs).effect);
    }
    const skip=['semantic_batch_skip','semantic_contextual_skip'].includes(d.reasonCode)&&d.observationRefs.length===0;
    requireProof(skip||effects.length>0,'covering_assertions_unverified');
    return {closed:true,reason:skip?'evaluated_skip':'materialized_verified',proof:{schema:'engram.source-effect-proof.v1',disposition:skip?'evaluated_skip':'materialized_verified',
      traceId:identity.traceId,sourceTurnId:e.sourceTurnId,scope:e.scope,envelopeDigest:hash(e),jobId:j.jobId,jobDigest:hash(j),terminalId:t.terminalId,terminalDigest:hash(t),
      observationIds:d.observationRefs,applicableEffects:effects,verifiedAt:now.toISOString()}};
  }catch(error){
    // Never return filesystem/provider/business messages to administrative callers.
    const reason=error instanceof Error&&/^[a-z][a-z0-9_]{0,100}$/.test(error.message)?error.message:'effect_proof_unavailable_or_invalid';
    return {closed:false,reason};
  }
}
