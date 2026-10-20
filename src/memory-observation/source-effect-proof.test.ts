import {afterEach,expect,test} from 'bun:test';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,unlinkSync,symlinkSync} from 'node:fs';
import {Database} from 'bun:sqlite';
import {readIndexHandoff,storeIndexHandoff,recordCanonicalIndexed,QMD_INDEXER} from '../qmd/index-provenance.ts';
import {qmdMaintenancePaths} from '../qmd/maintenance.ts';
import {resolveQmdContext,resolveNamedQmdIndexPath} from '../qmd/context.ts';
import {defineCanaryQmdRuntimeResolver,resolveCanaryQmdRuntimeBinding} from './qmd-binding-preflight.ts';
import {resolveQmdMaintenanceStateRoot} from '../qmd/maintenance-integration.ts';
import {splitCanonicalSessionKey} from '../session-key.ts';
import {buildContextualObservation} from './contextual-observation.ts';
import {contextualBatchObservations} from './contextual-batch-observation.ts';
import {contextualEvaluationDigest,readableContextualDigests} from './quality-rollout.ts';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {verifySourceEffectClosure} from './source-effect-proof.ts';
import {deriveSourceDigest,deriveTraceId,sha256,type ObservationScope,type JsonValue} from './ledger.ts';
import {BATCH_EVALUATOR_AUTHORITY,deriveBatchObservationId} from './batch-observation.ts';
import {DAILY_NOTE_APPLICATOR,buildDailyNoteCanaryPolicy,renderDailyNoteEntry} from './daily-note-applicator.ts';
const roots:string[]=[];afterEach(()=>roots.splice(0).forEach(p=>rmSync(p,{recursive:true,force:true})));
const h=(v:any)=>sha256(v as JsonValue);
const put=(path:string,value:any)=>{mkdirSync(dirname(path),{recursive:true});writeFileSync(path,typeof value==='string'?value:JSON.stringify(value));};
function fixture(decision:'skip'|'write'='skip',topic=false){
 const workspace=mkdtempSync(join(tmpdir(),'source-effect-proof-'));roots.push(workspace);
 const root=join(workspace,'memory-state/memory-observation/v1'),store=join(workspace,'memory-state/memory-observation/batch-live-store'),base=join(store,'memory-batch-live/v1');
 const scope:ObservationScope={workspaceId:'main',runtimeSessionKey:topic?'agent:main:telegram:group:-100123:topic:2':'agent:main:telegram:direct:100000001',scopeClass:topic?'project':'self',scopeId:topic?'domain:main:fixture':'telegram:100000001'};
 const sourceTurnId='channel-user:v1:'+'1'.repeat(64),traceId=deriveTraceId(scope.workspaceId,scope.runtimeSessionKey,sourceTurnId);
 const at='2026-10-01T12:00:00.000Z',completedAt='2026-10-01T12:01:00.000Z',policyDigest=h('source-policy'),evaluationPolicyDigest=h('evaluation-policy');
 const evidence={source:{role:'user',text:'Set the deadline to Friday.',actorId:'100000001',attribution:'speaker-only'},outcome:{role:'assistant',text:'Recorded.',status:'reported_not_verified'}};
 const evidenceDigest=h({schema:'engram.memory-evidence-envelope.v1',traceId,scope,payload:evidence});
 const sourceDigest=deriveSourceDigest(sourceTurnId,scope,at),evidenceRef={kind:'source-turn',ref:sourceTurnId,digest:h('evidence-ref')};
 const envelope={schema:'engram.memory-observation-job.v1',traceId,sourceTurnId,scope,sourceCompletedAt:at,sourceDigest,evidenceDigest,policyVersion:'v1',policyDigest,evidenceRefs:[evidenceRef],authority:{id:'openclaw-runtime',version:'v1',digest:h('runtime')},admittedAt:at};
 const source={traceId,sourceTurnId,sourceDigest,evidenceDigest,sourceCompletedAt:at};
 const partition={...scope,producerEpoch:'v1',policyDigest};
 const bundleId=h({schema:'engram.memory-batch-bundle.v1',partition,policyDigest,sourceRefs:[source]});
 const bundle={schema:'engram.memory-batch-bundle.v1',bundleId,partition,policyDigest,sourceRefs:[source],inputs:[{traceId,evidenceRefs:[evidenceRef],evidence,expiresAt:'2026-10-04T12:00:00.000Z'}],evidenceBytes:Buffer.byteLength(JSON.stringify(evidence))};
 const jobId=h({schema:'engram.memory-batch-live-job.v1',partition,evaluationPolicyDigest,bundleId}),job={schema:'engram.memory-batch-live-job.v1',jobId,partition,evaluationPolicyDigest,bundle,createdAt:at};
 const assertion={section:'decisions',text:'Set the deadline to Friday.',actorRef:'user',outcomeStatus:'decided',confidence:1,reasonCodes:['explicit_decision'],citations:[{traceId,evidenceRef}]};
 const group=decision==='skip'?{groupId:'g1',decision:'skip',sourceRefs:[traceId],reason:'status_acknowledgement'}:{groupId:'g1',decision:'write',sourceRefs:[traceId],assertions:[assertion]};
 const requestDigest=h('request'),resultKey=sha256('engram.memory-batch-shadow-result-key.v1\0'+requestDigest);
 const result={schema:'engram.memory-batch-shadow-result.v1',resultKey,requestDigest,bundleId,partition,sourceRefs:[source],groups:[group],outputDigest:h({schema:'engram.memory-batch-shadow-output.v1',groups:[group]}),completedAt};
 const identity={bundleId,groupId:'g1',assertionIndex:0,observationClass:'episodic.decision' as const,evaluationPolicyDigest};
 const obase={schema:'engram.memory-batch-observation.v1' as const,...identity,observationId:deriveBatchObservationId(identity),scope,sourceRefs:[source],producer:BATCH_EVALUATOR_AUTHORITY,targetConsumer:'daily-note' as const,
   payload:{section:'decisions' as const,text:(topic?'Участник Telegram 100000001 (собственное высказывание): ':'')+assertion.text,actorRef:'user' as const,outcomeStatus:'decided' as const},citations:assertion.citations,sourceCompletedAt:at,confidence:1,reasonCodes:assertion.reasonCodes,completedAt};
 const observation:any={...obase,observationDigest:h(obase)};
 const terminalBody={schema:'engram.memory-batch-live-terminal.v1',jobId,bundleId,resultKey,resultDigest:h(result),dispositions:[{traceId,decision,reasonCode:decision==='skip'?'semantic_batch_skip':'semantic_batch_write',observationRefs:decision==='skip'?[]:[observation.observationId]}],completedAt};
 const terminal={...terminalBody,terminalId:h(terminalBody)};
 const envelopePath=join(root,'envelopes',traceId.slice(7)+'.json'),jobPath=join(base,'jobs',jobId.slice(7)+'.json'),donePath=join(base,'done',jobId.slice(7)+'.json'),terminalPath=join(base,'terminals',jobId.slice(7)+'.json'),resultPath=join(store,'memory-batch-shadow/v1/results',resultKey.slice(7)+'.json');
 put(envelopePath,envelope);put(jobPath,job);put(donePath,terminal);put(terminalPath,terminal);put(resultPath,result);
 const projection:any={schema:topic?'engram.memory-observation-rollout.v4':'engram.memory-observation-rollout.v3',workspaceId:'main',enabled:true,mode:'canary',bindings:[{runtimeSessionKey:scope.runtimeSessionKey,scopeClass:scope.scopeClass,scopeId:scope.scopeId,requireOwner:!topic,allowedChannels:['telegram'],...(topic?{topicDomain:{domain:'fixture',chatId:'-100123',topicId:'2'}}:{})}],pluginDigest:h('plugin'),inference:{provider:'openai',model:'openai/fixture',evaluateAfter:at},evaluation:{mode:'batch-cron',policyDigest:evaluationPolicyDigest,batch:{sourcePolicyDigest:policyDigest,inactivityGapSeconds:300,maxTurns:8,maxEvidenceBytes:262144,maxAgeSeconds:900,maxInferenceCallsPerRun:1,schedulerId:'fixture'}},limits:{evidenceTtlHours:72,maxJobs:1000,maxBytes:67108864,maxQueueAgeHours:168,maxAttempts:2,claimTtlSeconds:300,maxInferenceCalls:1},consumers:{dailyNote:{mode:'canary',applyAfter:at,timezone:'UTC',allowedObservationClasses:['episodic.event','episodic.decision'],maxAppliesPerWake:1}},captureOwnership:{owner:'observer',effectiveAfter:at,foregroundDailyNoteCapture:'disabled'},approvedBy:'operator',approvedAt:at};
 const projectionPath=join(workspace,'memory-state/memory-observation/projection.json');put(projectionPath,projection);put(join(workspace,'engram.json'),{workspace:{id:'main'}});
 const entryId=sha256('engram.daily-note-entry.v1\0'+observation.observationId),operationId=sha256('engram.memory-apply.v1\0daily-note\0'+observation.observationId+'\0'+entryId);
 const noteRelative='memory/agent-main/'+splitCanonicalSessionKey(scope.runtimeSessionKey)!.sessionKey+'/2026-10-01.md';
 const notePath=join(workspace,noteRelative),rendered=renderDailyNoteEntry(observation,entryId);
 const daily=projection.consumers.dailyNote,consumer=buildDailyNoteCanaryPolicy({workspaceId:'main',exactScope:scope,applyAfter:at,timezone:'UTC',allowedObservationClasses:daily.allowedObservationClasses,maxAppliesPerWake:1,allowedBatchEvaluationPolicyDigest:evaluationPolicyDigest});
 const receipt:any={schema:'engram.memory-apply-receipt.v1',receiptId:sha256('engram.memory-apply-receipt.v1\0'+operationId),traceId,sourceObservationRef:observation.observationId,sourceCompletedAt:at,scope,producer:DAILY_NOTE_APPLICATOR,sourceProvenance:{sourceTurnId,producer:observation.producer,observationClass:observation.observationClass,evidenceRefs:[evidenceRef],observationDigest:observation.observationDigest,batchSourceRefs:observation.sourceRefs,batchCitations:observation.citations,batchEvaluationPolicyDigest:evaluationPolicyDigest},consumer:'daily-note',operationId,destinationDate:'2026-10-01',destinationRef:noteRelative+'#engram-entry:'+entryId,destinationEntryId:entryId,status:'applied',canonicalMutation:true,readBackDigest:sha256(rendered),policyDigest:consumer.policyDigest,completedAt:'2026-10-01T12:02:00.000Z'};
 const observationPath=join(root,'observations/batch',observation.observationId.slice(7)+'.json'),receiptPath=join(root,'receipts/by-operation',operationId.slice(7)+'.json'),aliasPath=join(root,'receipts/by-entry',entryId.slice(7)+'.json');
 if(decision==='write'){put(observationPath,observation);put(notePath,'# Note\n\n## Decisions\n\n'+rendered+'\n');put(receiptPath,receipt);put(aliasPath,receipt);}
 const identityInput={traceId,sourceTurnId,scope},now=new Date('2026-10-01T12:05:00.000Z');
 return {workspace,root,base,identityInput,now,envelope,envelopePath,job,jobPath,terminal,donePath,terminalPath,result,resultPath,observation,observationPath,notePath,rendered,receipt,receiptPath,aliasPath,projection,projectionPath};
}
test('exact validated skip closes processing and produces metadata only',()=>{const f=fixture();const r=verifySourceEffectClosure(f.workspace,f.identityInput,f.now);expect(r).toMatchObject({closed:true,proof:{disposition:'evaluated_skip',envelopeDigest:h(f.envelope),observationIds:[],applicableEffects:[]}});expect(JSON.stringify(r)).not.toContain('deadline');});
test('complete exact assertion and both receipt aliases verify canonical note',()=>{const f=fixture('write');expect(verifySourceEffectClosure(f.workspace,f.identityInput,f.now)).toMatchObject({closed:true,proof:{disposition:'materialized_verified',observationIds:[f.observation.observationId],applicableEffects:[{kind:'daily-note',receiptDigest:h(f.receipt)}]}});});
test('signed pre-quality receipt stays verifiable after exact quality opt-in',()=>{
 const f=fixture('write'),previous=structuredClone(f.projection),oldPolicy=h('previous-evaluation');
 previous.inference.model='openai/previous';previous.evaluation.policyDigest=oldPolicy;
 const transition={schema:'engram.memory-model-transition.v1',targetProjectionDigest:h(f.projection),previousProjection:previous,previousQuality:null,approvedBy:'operator',approvedAt:'2026-10-01T12:00:00.000Z'};
 put(join(f.workspace,'memory-state/memory-observation/model-transition.json'),{...transition,digest:h(transition)});
 const daily=f.projection.consumers.dailyNote;
 const sealed=buildDailyNoteCanaryPolicy({workspaceId:'main',exactScope:f.identityInput.scope,applyAfter:daily.applyAfter,timezone:daily.timezone,
  allowedObservationClasses:daily.allowedObservationClasses,maxAppliesPerWake:daily.maxAppliesPerWake,
  allowedBatchEvaluationPolicyDigest:f.projection.evaluation.policyDigest,allowContextualObservations:false,
  allowedPreviousBatchEvaluationPolicyDigests:[oldPolicy]});
 f.receipt.policyDigest=sealed.policyDigest;put(f.receiptPath,f.receipt);put(f.aliasPath,f.receipt);
 const quality={schema:'engram.memory-quality-rollout.v1',mode:'drain',workspaceId:'main',pluginDigest:f.projection.pluginDigest,
  baseEvaluationPolicyDigest:f.projection.evaluation.policyDigest,sourcePolicyDigest:f.projection.evaluation.batch.sourcePolicyDigest,
  applyAfter:daily.applyAfter,exactScopes:[f.identityInput.scope],preparedAt:'2026-10-01T12:00:00.000Z',inventoryDigest:h('inventory')};
 put(join(f.workspace,'memory-state/memory-observation/quality-rollout.json'),{...quality,digest:h(quality)});
 expect(verifySourceEffectClosure(f.workspace,f.identityInput,f.now)).toMatchObject({closed:true,proof:{disposition:'materialized_verified'}});
});
for(const change of ['result','terminal','envelope','foreign-source','foreign-scope','missing-apply-alias','duplicate-marker','changed-note','appended-note-text','observation','consumer-policy','qmd-applicability'] as const)
test('missing/corrupt effects stay open: '+change,()=>{const f=fixture('write');
 if(change==='result')put(f.resultPath,{...f.result,groups:[]});
 if(change==='terminal')put(f.donePath,{...f.terminal,terminalId:h('forged')});
 if(change==='envelope')put(f.envelopePath,{...f.envelope,evidenceDigest:h('changed')});
 if(change==='foreign-source')f.identityInput.sourceTurnId='channel-user:v1:'+'f'.repeat(64);
 if(change==='foreign-scope')f.identityInput.scope={...f.identityInput.scope,scopeId:'foreign'};
 if(change==='missing-apply-alias')unlinkSync(f.aliasPath);
 if(change==='duplicate-marker')put(f.notePath,f.rendered+'\n'+f.rendered);
 if(change==='changed-note')put(f.notePath,f.rendered.replace('Friday','Monday'));
 if(change==='appended-note-text')put(f.notePath,f.rendered+' EXTRA');
 if(change==='observation')put(f.observationPath,{...f.observation,payload:{...f.observation.payload,text:'Invented'}});
 if(change==='consumer-policy'){f.receipt.policyDigest=h('foreign');put(f.receiptPath,f.receipt);put(f.aliasPath,f.receipt);}
 if(change==='qmd-applicability'){f.projection.consumers.dailyNote.qmdBinding={collection:'fixture-memory'};put(f.projectionPath,f.projection);}
 const result=verifySourceEffectClosure(f.workspace,f.identityInput,f.now);expect(result.closed).toBe(false);expect(result.proof).toBeUndefined();expect(JSON.stringify(result)).not.toContain('deadline');
});
test('queue success, requeue or historical accounting without exact completed disposition cannot close',()=>{const f=fixture();unlinkSync(f.donePath);put(join(f.root,'queues/evaluator',f.identityInput.traceId.slice(7)+'.json'),{status:'terminal',reasonCode:'semantic_batch_skip'});expect(verifySourceEffectClosure(f.workspace,f.identityInput,f.now).closed).toBe(false);});
test('grouped-no-assertion is not a semantic skip',()=>{const f=fixture();f.terminal.dispositions[0]!.reasonCode='semantic_batch_grouped_no_assertion';const{terminalId,...body}=f.terminal;f.terminal.terminalId=h(body);put(f.donePath,f.terminal);put(f.terminalPath,f.terminal);expect(verifySourceEffectClosure(f.workspace,f.identityInput,f.now).closed).toBe(false);});
test('source effects never follow a symlink outside canonical workspace',()=>{const f=fixture('write');const target=join(tmpdir(),'source-effect-outside-'+crypto.randomUUID());roots.push(target);put(target,f.rendered);unlinkSync(f.notePath);symlinkSync(target,f.notePath);expect(verifySourceEffectClosure(f.workspace,f.identityInput,f.now).closed).toBe(false);});

function contextualFixture(kind:'skip'|'asserted'|'supports'|'duplicate'='asserted'){
 const f=fixture(kind==='skip'?'skip':'write'),traceId=f.identityInput.traceId,bundle=f.job.bundle as any;
 const output:any={schema:'engram.memory-contextual-output.v2',assertions:kind==='skip'?[]:[{id:'a1',section:'decisions',text:'The deadline was set to Friday.',subject:'deadline',resolution:'explicit',actorRef:'user',status:'decided',spans:[{traceId,role:'user',quote:'Set the deadline to Friday.'}]}],dispositions:[{traceId,kind,assertionIds:kind==='skip'?[]:['a1'],reason:'Exact source disposition.'}]};
 if(kind==='supports'||kind==='duplicate'){
  const secondId='channel-user:v1:'+'2'.repeat(64),secondTrace=deriveTraceId('main',f.identityInput.scope.runtimeSessionKey,secondId),secondAt='2026-10-01T12:00:30.000Z';
  const evidence={source:{role:'user',text:'Approved exact deadline.',actorId:'100000001',attribution:'speaker-only'},outcome:{role:'assistant',text:'Recorded.'}};
  const evidenceRef={kind:'source-turn',ref:secondId,digest:h('second-ref')};
  bundle.sourceRefs.push({traceId:secondTrace,sourceTurnId:secondId,sourceDigest:deriveSourceDigest(secondId,f.identityInput.scope,secondAt),evidenceDigest:h({schema:'engram.memory-evidence-envelope.v1',traceId:secondTrace,scope:f.identityInput.scope,payload:evidence}),sourceCompletedAt:secondAt});
  bundle.inputs.push({traceId:secondTrace,evidenceRefs:[evidenceRef],evidence,expiresAt:'2026-10-04T12:00:00.000Z'});
  bundle.evidenceBytes+=Buffer.byteLength(JSON.stringify(evidence));bundle.bundleId=h({schema:bundle.schema,partition:bundle.partition,policyDigest:bundle.policyDigest,sourceRefs:bundle.sourceRefs});
  output.assertions[0].spans.push({traceId:secondTrace,role:'user',quote:'Approved exact deadline.'});
  output.dispositions.push({traceId:secondTrace,kind:'asserted',assertionIds:['a1'],reason:'Explicit deadline approval.'});
 }
 const evaluatedObservation=buildContextualObservation(output,bundle,h('contextual-policy'),new Date(f.terminal.completedAt));
 const evalDigest=contextualEvaluationDigest(f.projection.evaluation.policyDigest);
 const observations=contextualBatchObservations(output,bundle,evalDigest,new Date(f.terminal.completedAt));
 for(const path of [f.jobPath,f.donePath,f.terminalPath,f.resultPath,...(kind==='skip'?[]:[f.observationPath,f.receiptPath,f.aliasPath])])unlinkSync(path);
 const jobId=h({schema:f.job.schema,partition:f.job.partition,evaluationPolicyDigest:evalDigest,bundleId:bundle.bundleId});
 const job={...f.job,jobId,evaluationPolicyDigest:evalDigest};
 const evaluated={observation:evaluatedObservation,requestDigest:h('contextual-request'),usage:null,latencyMs:0};
 const body={schema:'engram.memory-contextual-result.v2',jobId,policyDigest:evalDigest,evaluated};
 put(join(f.base,'contextual-results',jobId.slice(7)+'.json'),{...body,digest:h(body)});
 const terminalBody={schema:'engram.memory-batch-live-terminal.v2',jobId,bundleId:bundle.bundleId,resultKey:h({schema:'engram.memory-contextual-result-key.v2',requestDigest:evaluated.requestDigest}),resultDigest:h(evaluated),dispositions:evaluatedObservation.dispositions.map(d=>({traceId:d.traceId,decision:d.assertionIds.length?'write':'skip',reasonCode:'semantic_contextual_'+d.kind,observationRefs:observations.filter(o=>d.assertionIds.includes(o.groupId)).map(o=>o.observationId)})),sourceDispositions:evaluatedObservation.dispositions,completedAt:f.terminal.completedAt};
 const terminal={...terminalBody,terminalId:h(terminalBody)};
 put(join(f.base,'jobs',jobId.slice(7)+'.json'),job);put(join(f.base,'done',jobId.slice(7)+'.json'),terminal);put(join(f.base,'terminals',jobId.slice(7)+'.json'),terminal);
 const quality={schema:'engram.memory-quality-rollout.v1',mode:'active',workspaceId:'main',pluginDigest:f.projection.pluginDigest,baseEvaluationPolicyDigest:f.projection.evaluation.policyDigest,sourcePolicyDigest:f.projection.evaluation.batch.sourcePolicyDigest,applyAfter:f.projection.consumers.dailyNote.applyAfter,exactScopes:[f.identityInput.scope],preparedAt:f.job.createdAt,inventoryDigest:h('inventory')};
 put(join(f.workspace,'memory-state/memory-observation/quality-rollout.json'),{...quality,digest:h(quality)});
 if(kind!=='skip'){
  const o=observations[0]!,entry=sha256('engram.daily-note-entry.v1\0'+o.observationId),operation=sha256('engram.memory-apply.v1\0daily-note\0'+o.observationId+'\0'+entry);
  const consumer=buildDailyNoteCanaryPolicy({workspaceId:'main',exactScope:f.identityInput.scope,applyAfter:f.projection.consumers.dailyNote.applyAfter,timezone:'UTC',allowedObservationClasses:['episodic.event','episodic.decision'],maxAppliesPerWake:1,allowedBatchEvaluationPolicyDigest:f.projection.evaluation.policyDigest,allowContextualObservations:true,allowedPreviousBatchEvaluationPolicyDigests:readableContextualDigests(f.projection.evaluation.policyDigest)});
  const receipt={...f.receipt,sourceCompletedAt:o.sourceCompletedAt,sourceObservationRef:o.observationId,operationId:operation,receiptId:sha256('engram.memory-apply-receipt.v1\0'+operation),destinationEntryId:entry,destinationRef:f.receipt.destinationRef.split('#')[0]+'#engram-entry:'+entry,readBackDigest:sha256(renderDailyNoteEntry(o,entry)),policyDigest:consumer.policyDigest,sourceProvenance:{...f.receipt.sourceProvenance,producer:o.producer,observationDigest:o.observationDigest,batchSourceRefs:o.sourceRefs,batchCitations:o.citations,evidenceRefs:o.citations.map(c=>c.evidenceRef).slice(0,8),batchEvaluationPolicyDigest:evalDigest}};
  put(join(f.root,'observations/batch',o.observationId.slice(7)+'.json'),o);put(f.notePath,renderDailyNoteEntry(o,entry)+'\n');put(join(f.root,'receipts/by-operation',operation.slice(7)+'.json'),receipt);put(join(f.root,'receipts/by-entry',entry.slice(7)+'.json'),receipt);
 }
 return {...f,terminal,job};
}
for(const kind of ['skip','asserted','supports','duplicate'] as const)
test('v2 exact disposition and covering canonical assertions: '+kind,()=>{const f=contextualFixture(kind);expect(verifySourceEffectClosure(f.workspace,f.identityInput,f.now)).toMatchObject({closed:true,proof:{disposition:kind==='skip'?'evaluated_skip':'materialized_verified'}});});
test('v2 duplicate without an actual covering observation never closes as skip',()=>{const f=contextualFixture('duplicate');const d=f.terminal.dispositions[0]!;d.observationRefs=[];const{terminalId,...body}=f.terminal;const t={...body,terminalId:h(body)};put(join(f.base,'done',f.job.jobId.slice(7)+'.json'),t);put(join(f.base,'terminals',f.job.jobId.slice(7)+'.json'),t);expect(verifySourceEffectClosure(f.workspace,f.identityInput,f.now).closed).toBe(false);});

function indexedFixture(topic=false){
 const f=fixture('write',topic),index='proof-'+crypto.randomUUID(),indexPath=resolveNamedQmdIndexPath(index);
 roots.push(indexPath);mkdirSync(dirname(indexPath),{recursive:true});
 const db=new Database(indexPath);db.exec('CREATE TABLE store_collections(name TEXT,path TEXT,pattern TEXT); CREATE TABLE documents(collection TEXT,path TEXT,hash TEXT,active INTEGER,modified_at TEXT); CREATE TABLE content(hash TEXT,doc TEXT);');
 const noteRoot=dirname(f.notePath),domainRoot=join(f.workspace,'memory/domains/fixture');
 if(topic){put(join(domainRoot,'status.md'),'# Fixture');put(join(domainRoot,'changelog.md'),'# History');put(join(f.workspace,'memory/domains/registry.json'),{domains:{fixture:{type:'topic-thread',topic:{chatId:'-100123',topicId:'2'}}}});}
 const collections=[{name:'fixture-notes',owner:'main',path:noteRoot,mask:'*.md'},...(topic?[{name:'fixture-domain',owner:'main',path:domainRoot,mask:'**/*.md'}]:[])];
 const config={workspace:{id:'main'},qmd:{index,localIndex:false,collection:'fixture-notes',collections:collections.map(c=>c.name),verticalAccess:{enabled:false},maintenance:{mode:'coordinated'}}};put(join(f.workspace,'engram.json'),config);
 const context=resolveQmdContext({value:f.workspace,source:'explicit'}),manifestPath=join(f.workspace,'manifest.json');
 put(manifestPath,{schema:'engram.qmd.global-registry.v1',index:{name:index},collections,workspaces:[{id:'main',path:f.workspace,kind:'technical',parents:[],readableCollections:collections.map(c=>c.name)}]});
 const resolver=defineCanaryQmdRuntimeResolver({workspace:f.workspace,workspaceId:'main',manifestPath,context});
 f.projection.consumers.dailyNote.qmdBinding=resolver;put(f.projectionPath,f.projection);
 const resolved=resolveCanaryQmdRuntimeBinding({workspace:f.workspace,runtimeSessionKey:f.identityInput.scope.runtimeSessionKey,timezone:'UTC',destinationAt:f.observation.sourceCompletedAt,resolver,context});
 const policy=buildDailyNoteCanaryPolicy({workspaceId:'main',exactScope:f.identityInput.scope,applyAfter:f.projection.consumers.dailyNote.applyAfter,timezone:'UTC',allowedObservationClasses:['episodic.event','episodic.decision'],maxAppliesPerWake:1,allowedBatchEvaluationPolicyDigest:f.projection.evaluation.policyDigest,qmdBinding:resolved});
 f.receipt.qmdBinding=resolved;f.receipt.policyDigest=policy.policyDigest;put(f.receiptPath,f.receipt);put(f.aliasPath,f.receipt);
 for(const c of collections)db.query('INSERT INTO store_collections VALUES(?,?,?)').run(c.name,c.path,c.mask);
 const doc=readFileSync(f.notePath,'utf8'),documentHash=h(doc);db.query('INSERT INTO documents VALUES(?,?,?,?,?)').run('fixture-notes','2026-10-01.md',documentHash,1,f.receipt.completedAt);db.query('INSERT INTO content VALUES(?,?)').run(documentHash,doc);db.close();
 const stateRoot=join(f.workspace,'maintenance'),markedAt='2026-10-01T12:02:30.000Z',reason='memory-observation:index-handoff:'+f.receipt.receiptId;
 const state={schema:'engram.qmd.maintenance-state.v1',indexKey:context.physicalIndex.key,generation:1,updateCompletedGeneration:0,embedCompletedGeneration:0,dirty:{bm25:true,vectors:true,collections:['fixture-notes'],reasons:[{generation:1,reason,markedAt}]},lastUpdateAt:null,lastEmbedAt:null,lastError:null};
 put(qmdMaintenancePaths(stateRoot,state.indexKey).state,state);
 const handoff=storeIndexHandoff({workspace:f.workspace,applyReceipt:f.receipt,dirtyMark:{schema:'engram.qmd.dirty-mark.v1',status:'marked',mode:'coordinated',workspace:f.workspace,indexKey:state.indexKey,generation:1,collections:['fixture-notes'],stateRoot,reason,markedAt},recordedAt:markedAt});
 const indexed=recordCanonicalIndexed({workspace:f.workspace,handoff,context,completedMaintenanceGeneration:1,allowedCollections:['fixture-notes'],completedAt:'2026-10-01T12:03:00.000Z'});
 expect(indexed.status).toBe('indexed');
 return {...f,context,indexPath,domainRoot};
}
test('pinned QMD consumer requires its actual verified index generation',()=>{const f=indexedFixture();expect(verifySourceEffectClosure(f.workspace,f.identityInput,f.now)).toMatchObject({closed:true,proof:{applicableEffects:[{indexGenerationId:expect.any(String)}]}});const handoff=readIndexHandoff(f.workspace,f.receipt.receiptId)!;const generation=sha256('qmd.index-generation.v1\0'+handoff.handoffId);unlinkSync(join(f.root,'qmd/index-generations',generation.slice(7)+'.json'));expect(verifySourceEffectClosure(f.workspace,f.identityInput,f.now).closed).toBe(false);});
test('topic daily success stays open until exact domain and indexed-generation effects verify',()=>{
 const f=indexedFixture(true),operation=f.receipt.operationId;
 expect(verifySourceEffectClosure(f.workspace,f.identityInput,f.now).closed).toBe(false);
 const marker='<!-- engram-domain-entry:'+operation+' -->',block=marker+'\n- '+f.observation.sourceCompletedAt+' ['+f.observation.payload.section+'] '+f.observation.payload.text+'\n  Источник: '+f.receipt.destinationRef+'\n';
 const domain={schema:'engram.domain-apply-receipt.v1',operationId:operation,sourceReceiptId:f.receipt.receiptId,sourceObservationId:f.observation.observationId,sourceObservationDigest:f.observation.observationDigest,scope:f.identityInput.scope,domain:'fixture',destination:'memory/domains/fixture/changelog.md#'+marker,entryDigest:sha256(block),sourceCompletedAt:f.observation.sourceCompletedAt,canonicalApplied:true};
 const state=join(f.workspace,'memory-state/domain-effects/v1'),log='# History\n\n'+block;put(join(f.domainRoot,'changelog.md'),log);put(join(state,'receipts',operation.slice(7)+'.json'),domain);
 const dirty={schema:'engram.domain-dirty-receipt.v1',operationId:operation,domainApplyReceiptDigest:h(domain),canonicalApplied:true,qmdDirtyMarked:true,indexKey:f.context.physicalIndex.key,generation:2,collections:['fixture-domain']};put(join(state,'dirty',operation.slice(7)+'.json'),dirty);
 const prev=process.env.OPENCLAW_STATE_DIR;
 try{
  process.env.OPENCLAW_STATE_DIR=join(f.workspace,'synthetic-state');
  const statePath=qmdMaintenancePaths(resolveQmdMaintenanceStateRoot(),dirty.indexKey).state;
  const maintenance={schema:'engram.qmd.maintenance-state.v1',indexKey:dirty.indexKey,generation:2,updateCompletedGeneration:2,embedCompletedGeneration:1,dirty:{bm25:false,vectors:true,collections:['fixture-domain'],reasons:[]},lastUpdateAt:'2026-10-01T12:03:00.000Z',lastEmbedAt:'2026-10-01T12:03:00.000Z',lastError:null};put(statePath,maintenance);
  expect(verifySourceEffectClosure(f.workspace,f.identityInput,f.now)).toMatchObject({closed:false,reason:'domain_index_generation_pending'});
  maintenance.embedCompletedGeneration=2;put(statePath,maintenance);
  const db=new Database(f.indexPath),documentHash=h(log);db.query('INSERT INTO documents VALUES(?,?,?,?,?)').run('fixture-domain','changelog.md',documentHash,1,'2026-10-01T12:04:00.000Z');db.query('INSERT INTO content VALUES(?,?)').run(documentHash,log);db.close();
  expect(verifySourceEffectClosure(f.workspace,f.identityInput,f.now)).toMatchObject({closed:true,proof:{applicableEffects:[{domainEntryDigest:sha256(block),domainIndexGeneration:2}]}});
  put(join(f.domainRoot,'changelog.md'),log+'\n'+block);expect(verifySourceEffectClosure(f.workspace,f.identityInput,f.now).closed).toBe(false);
 }finally{if(prev===undefined)delete process.env.OPENCLAW_STATE_DIR;else process.env.OPENCLAW_STATE_DIR=prev;}
});
