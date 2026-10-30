import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileDispatchTransport, NightlyDispatchPendingError } from '../src/oll/deployment-runtime.ts';

test('CLI records a pre-spawn rejection without inventing dispatch or model identities', async () => {
 const root=mkdtempSync(join(tmpdir(),'nightly-ack-cli-'));
 try {
  const transport=new FileDispatchTransport(root);
  try {await transport.spawn({task:'synthetic',label:'test',runtimeLabel:'test-exact',model:'test/model',workspacePath:root,runTimeoutSeconds:30});}
  catch(error){expect(error instanceof NightlyDispatchPendingError).toBe(true);}
  const run=Bun.spawnSync([process.execPath,join(import.meta.dir,'oll-nightly-runtime.ts'),'ack','--state-root',root,'--runtime-label','test-exact','--accepted','false','--dispatch-ref-uri','','--resolved-model-uri','','--error-uri','spawn%20not%20attempted']);
  expect(run.exitCode).toBe(0);
  expect(JSON.parse(run.stdout.toString()).acknowledgement).toMatchObject({accepted:false,dispatchRef:'',resolvedModel:'',error:'spawn not attempted'});
 } finally {rmSync(root,{recursive:true,force:true});}
});

test('CLI still refuses an accepted dispatch without a real reference or an invalid boolean', () => {
 const root=mkdtempSync(join(tmpdir(),'nightly-ack-cli-'));
 try {
  for(const accepted of ['true','typo']){
   const run=Bun.spawnSync([process.execPath,join(import.meta.dir,'oll-nightly-runtime.ts'),'ack','--state-root',root,'--runtime-label','test-exact','--accepted',accepted,'--dispatch-ref-uri','','--resolved-model-uri','test%2Fmodel']);
   expect(run.exitCode).toBe(1);
  }
 } finally {rmSync(root,{recursive:true,force:true});}
});
