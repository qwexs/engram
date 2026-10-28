/** Bun worker/operator closure scanner. Host plugins import only the separate
 * Node-safe source-debt-capture module, never this effect-verification wrapper. */
import { captureSourceDebt, sourceDebtSnapshot as rawSourceDebtSnapshot, captureLegacyRecoveryOrigins, assertSourceDebtPurgeSafe as assertHostSourceDebtPurgeSafe, type SourceDebtCaptureOptions } from "./source-debt-capture.ts";
import { applySourceDebtWriteOffs, stopExpiredSourceDebt, type SourceDebtSnapshot, type SourceDebtClasses } from './source-debt-writeoff.ts';
import {readFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {sha256} from './ledger.ts';
export type { SourceDebtSnapshot } from './source-debt-writeoff.ts';
import { verifySourceEffectClosure } from "./source-effect-proof.ts";
export * from "./source-debt-capture.ts";
/** Presentation only; never changes source identities, closure or write-off policy. */
function classifyOpen(workspace:string,snapshot:SourceDebtSnapshot):SourceDebtSnapshot {
 if(snapshot.corrupt||!snapshot.observed)return snapshot;
 try{
  const classifications=new Map<string,Set<string>>();
  const dir=join(workspace,'memory-state/memory-observation/source-debt/v1/failures');
  for(const file of readdirSync(dir).filter(f=>f.endsWith('.json'))){
   const r=JSON.parse(readFileSync(join(dir,file),'utf8')), {recordId,...body}=r;
   if(recordId!==sha256(body)||r.scope?.workspaceId!==snapshot.workspaceId)throw Error('UNVERIFIED_CLASSIFICATION');
   if(snapshot.openIds.includes(r.debtId)){
    const classes=classifications.get(r.debtId)??new Set<string>();classes.add(r.classification);classifications.set(r.debtId,classes);
   }
  }
  const counts:SourceDebtClasses={confirmedCompleted:0,failedRuns:0,completionUnverified:0,identityUnverified:0,unclassified:0};
  const keys:Record<string,keyof SourceDebtClasses>={confirmed_completed_source:'confirmedCompleted',failed_run:'failedRuns',completion_unverified_gap:'completionUnverified',identity_unverified:'identityUnverified'};
  for(const id of snapshot.openIds){const c=classifications.get(id);counts[c?.size===1?keys[[...c][0]!]??'unclassified':'unclassified']++;}
  const {snapshotDigest:_old,...base}=snapshot;const result={...base,openClassifications:counts};
  return {...result,snapshotDigest:sha256(result)};
 }catch{return snapshot;}
}
export function scanSourceDebt(workspace: string, now = new Date(), options: Omit<SourceDebtCaptureOptions,"verifyClosure"> & { stopExpiredRecovery?: boolean } = {}) {
  const { stopExpiredRecovery, ...captureOptions } = options;
  const snapshot = captureSourceDebt(workspace, now, { ...captureOptions, verifyClosure: verifySourceEffectClosure });
  if (stopExpiredRecovery) stopExpiredSourceDebt(workspace, now, { apply: true });
  return classifyOpen(workspace,applySourceDebtWriteOffs(workspace, snapshot, now));
}
export function sourceDebtSnapshot(workspace: string, now = new Date(), options: { workspaceId?: string } = {}) {
  return classifyOpen(workspace,applySourceDebtWriteOffs(workspace, rawSourceDebtSnapshot(workspace, now, options), now));
}

/** Worker-only legacy-origin upgrade; the host plugin keeps the same guard. */
export function assertSourceDebtPurgeSafe(workspace:string,now=new Date(),options:{workspaceId?:string}={}){
  captureLegacyRecoveryOrigins(workspace);
  return assertHostSourceDebtPurgeSafe(workspace,now,options);
}
