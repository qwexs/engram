import {compileBatchFrame,type CompiledBatchBundleV1} from "../../../../src/memory-observation/batch-compiler.ts";
import {deriveSourceDigest,sha256,type JsonValue} from "../../../../src/memory-observation/ledger.ts";
export const now=new Date("2026-09-01T12:10:00.000Z");
export function fixture(texts=['I can commit the timer fix.','Yes, do that.'],actors=['actor-a','actor-a'],outcomes?:string[],contexts?:any[]):CompiledBatchBundleV1 {
 const scope={workspaceId:'alpha',runtimeSessionKey:'agent:alpha:telegram:direct:100000001',scopeClass:'self',scopeId:'workspace:alpha'};
 const policyDigest=sha256('fixture-policy');
 const sources=texts.map((text,i)=>{
  const traceId=sha256('trace-'+i),sourceTurnId='channel-user:v1:'+String(i+1).repeat(64),sourceCompletedAt=`2026-09-01T12:0${i}:00.000Z`;
  const payload={...(contexts?.[i]?{replyContext:contexts[i]}:{}),source:{role:'user',text,actorId:actors[i]},outcome:{role:'assistant',text:outcomes?.[i]??(i===0?'I can commit the timer fix.':'Timer fix committed.')}};
  const evidence={schema:'engram.memory-evidence-envelope.v1',traceId,scope,payload,createdAt:sourceCompletedAt,expiresAt:'2026-09-02T12:00:00.000Z'};
  return {envelope:{schema:'engram.memory-observation-job.v1',traceId,sourceTurnId,scope,sourceCompletedAt,sourceDigest:deriveSourceDigest(sourceTurnId,scope as any,sourceCompletedAt),evidenceDigest:sha256({schema:evidence.schema,traceId,scope,payload} as JsonValue),policyVersion:'fixture-v1',policyDigest,evidenceRefs:[{kind:'source-turn',ref:sourceTurnId,digest:sha256(text)},...(contexts?.[i]?.pairs??[]).map((p:any)=>({kind:'message',ref:scope.runtimeSessionKey+'#'+p.transportMessageId,digest:p.evidenceDigest}))],authority:{id:'openclaw-runtime',version:'v1',digest:sha256('runtime')},admittedAt:sourceCompletedAt},evidence};
 });
 return compileBatchFrame({schema:'engram.memory-batch-source-frame.v1',partition:{...scope,producerEpoch:'v1',policyDigest},sealedAt:now.toISOString(),sources},
 {schema:'engram.memory-batch-compiler-config.v1',inactivityGapMs:300000,maxTurns:10,maxEvidenceBytes:100000,maxAgeMs:3600000}).bundles[0]!;
}
