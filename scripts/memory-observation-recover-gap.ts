#!/usr/bin/env bun
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { recoverAdmissionGap, recoverOpenAdmission } from '../src/memory-observation/admission-gap-recovery.ts';
import type { Digest } from '../src/memory-observation/ledger.ts';
const allowed = new Set(['workspace','inventory','inventory-digest','message-id','authorized-by','authorized-at','reason','apply','allow-bounded-source','review-invalid-evidence','review-run-continuation','open-checkpoint']);
const args: Record<string,string | boolean> = {};
for(let i=2;i<process.argv.length;i++) {
  const key=process.argv[i]!.replace(/^--/,'');
  if(!process.argv[i]!.startsWith('--') || !allowed.has(key) || key in args) throw Error('unknown or duplicate option');
  if(key==='apply'||key==='allow-bounded-source'||key==='review-invalid-evidence'||key==='review-run-continuation'||key==='open-checkpoint') args[key]=true;
  else { const next=process.argv[++i]; if(!next || next.startsWith('--')) throw Error('missing value for '+key); args[key]=next; }
}
const required=(key:string):string=>{const v=args[key];if(typeof v!=='string'||!v.trim())throw Error('--'+key+' required');return v;};
const workspace=required('workspace');if(!isAbsolute(workspace))throw Error('workspace must be absolute');
const inventory=JSON.parse(readFileSync(required('inventory'),'utf8'));
if(args['open-checkpoint']&&(args['allow-bounded-source']||args['review-invalid-evidence']||args['review-run-continuation']))throw Error('open-checkpoint requires complete native history evidence');
const recover=args['open-checkpoint']?recoverOpenAdmission:recoverAdmissionGap;
const result=recover({workspace,inventory,inventoryDigest:required('inventory-digest') as Digest,messageId:required('message-id'),
  authorizedBy:required('authorized-by'),authorizedAt:required('authorized-at'),reason:required('reason'),apply:args.apply===true,allowBoundedSource:args['allow-bounded-source']===true,reviewInvalidEvidence:args['review-invalid-evidence']===true,reviewRunContinuation:args['review-run-continuation']===true});
console.log(JSON.stringify(result,null,2));
if(result.status==='blocked_missing_completion')process.exitCode=2;
