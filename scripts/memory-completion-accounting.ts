#!/usr/bin/env bun
/** Explicit finite administrative reconciliation. Plan-only unless --apply. */
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {reconcileCompletionAccounting} from '../src/memory-observation/completion-accounting.ts';
const args=process.argv.slice(2),i=args.indexOf('--request');
if(i<0||!args[i+1])throw Error('--request required');
const request=JSON.parse(readFileSync(resolve(args[i+1]!),'utf8'));
if(request.schema!=='engram.completion-accounting-request.v1'||!Array.isArray(request.entries)||!request.entries.length||request.entries.length>1000)throw Error('Invalid finite completion request');
const seen=new Set<string>();
const results=request.entries.map((entry:any)=>{
 const identity=entry.workspace+'\0'+entry.receiptFile;if(seen.has(identity))throw Error('Duplicate completion identity');seen.add(identity);
 return {workspace:entry.workspace,receiptFile:entry.receiptFile,...reconcileCompletionAccounting({workspace:entry.workspace,receiptFile:entry.receiptFile,receiptDigest:entry.receiptDigest,
  authorizedBy:request.authorizedBy,authorizedAt:request.authorizedAt,authorizationSource:request.authorizationSource,apply:args.includes('--apply')})};
});
console.log(JSON.stringify({schema:'engram.completion-accounting-report.v1',apply:args.includes('--apply'),results},null,2));
if(results.some((r:any)=>r.status==='blocked'))process.exitCode=2;
