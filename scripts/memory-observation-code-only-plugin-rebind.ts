#!/usr/bin/env bun
/** Explicit release-only operator: does not install packages, restart Gateway,
 * edit schedulers, evaluate sources or repair unrelated invalid lineage. */
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {planCodeOnlyPluginRebind,applyCodeOnlyPluginRebind,type CodeOnlyRebindPlan,type CodeOnlyReleaseAttestation} from '../src/memory-observation/code-only-plugin-rebind.ts';
import {sha256} from '../src/memory-observation/ledger.ts';
const args=process.argv.slice(2),command=args.shift();
const value=(name:string)=>{const i=args.indexOf('--'+name);if(i<0||!args[i+1]||args[i+1]!.startsWith('--'))throw Error('required --'+name);return args[i+1]!;};
const flag=(name:string)=>args.includes('--'+name);
const read=(p:string)=>JSON.parse(readFileSync(p,'utf8'));
const repository=resolve(import.meta.dir,'..');
async function sourceDigest(){
 const previous=process.cwd();
 let result:Awaited<ReturnType<typeof Bun.build>>;
 try{
  // Bun emits source-path comments relative to cwd. Release identity must use
  // the same canonical repository root as the Worker, not the caller's cwd.
  process.chdir(repository);
  result=await Bun.build({entrypoints:['./integrations/openclaw-memory-observation/index.ts'],target:'node',format:'esm',
   external:['openclaw/plugin-sdk/core','openclaw/plugin-sdk/session-transcript-runtime'],minify:false,sourcemap:'none',write:false});
 }finally{process.chdir(previous);}
 if(!result.success||result.outputs.length!==1)throw Error('CODE_REBIND_SOURCE_BUILD_FAILED');
 return `sha256:${createHash('sha256').update(Buffer.from(await result.outputs[0]!.arrayBuffer())).digest('hex')}` as const;
}
if(command!=='plan'&&command!=='apply')throw Error('usage: plan --attestation <json> --workspace-manifest <json> --config <active-config> --plan-out <path> | apply --plan <json> --journal-root <path> --maintenance-barrier-id <id> --ack-workers-paused');
const sourcePluginDigest=await sourceDigest();
if(command==='plan'){
 const attestation=read(resolve(value('attestation'))) as CodeOnlyReleaseAttestation;
 const manifest=read(resolve(value('workspace-manifest')));
 const rows=manifest.registry?.workspaces??manifest.workspaces;
 if(!Array.isArray(rows))throw Error('CODE_REBIND_MANIFEST_INVALID');
 const workspaces=rows.map((w:any)=>({workspaceId:w.id??w.workspaceId,workspace:resolve(w.path??w.workspace)}));
 const config=read(resolve(value('config'))),entries=config.agents?.entries;
 if(!entries||Array.isArray(entries)||typeof entries!=='object')throw Error('CODE_REBIND_CONFIG_ENTRIES_REQUIRED');
 const configuredWorkspaces=Object.entries(entries).map(([workspaceId,e]:[string,any])=>({workspaceId,workspace:resolve(e.workspace)}));
 const state=process.env.OPENCLAW_STATE_DIR;if(!state)throw Error('CODE_REBIND_MANAGED_STATE_DIR_REQUIRED');
 const plan=planCodeOnlyPluginRebind({attestation,workspaces,configuredWorkspaces,installedPluginPath:join(resolve(state),'extensions/engram-memory-observation/index.js'),sourcePluginDigest});
 const out=resolve(value('plan-out'));writeFileSync(out,JSON.stringify(plan,null,2)+'\n',{mode:0o600,flag:'wx'});
 console.log(JSON.stringify({status:'planned',planId:plan.planId,planDigest:sha256(plan as any),planPath:out,workspaceCount:plan.workspaces.length,fromPluginDigest:attestation.fromPluginDigest,toPluginDigest:attestation.toPluginDigest,
  blockedWorkspacesPreserved:plan.workspaces.filter(w=>w.transitionStatus==='invalid-preserved').map(w=>w.workspaceId),mutatesRuntime:false,requiresWorkersPaused:true,requiresInstalledTargetAtApply:true}));
}else{
 if(!flag('ack-workers-paused'))throw Error('CODE_REBIND_MAINTENANCE_BARRIER_REQUIRED');
 const plan=read(resolve(value('plan'))) as CodeOnlyRebindPlan;
 const result=applyCodeOnlyPluginRebind({plan,journalRoot:resolve(value('journal-root')),sourcePluginDigest,workersPaused:true,maintenanceBarrierId:value('maintenance-barrier-id')});
 console.log(JSON.stringify(result));
}
