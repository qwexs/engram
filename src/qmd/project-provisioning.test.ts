import { test, expect, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planProjectProvisioning, applyProjectPlan, planProjectFleetEnrollment, type ProjectRequest } from './project-provisioning.ts';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })));
function fixture(group = false) {
 const root = mkdtempSync(join(tmpdir(), 'engram-provision-')); roots.push(root);
 const w = join(root, 'alpha'), upper = join(root, 'company');
 const put = (p: string, v: unknown) => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, JSON.stringify(v, null, 2) + '\n'); };
 for (const path of [join(w, 'memory/domains/alpha-general'), join(w, 'life'), join(w, 'ops'), join(upper, 'memory/domains/company-general')]) mkdirSync(path, {recursive:true});
 put(join(w,'engram.json'), { workspace:{id:'alpha'},agent:'agent-alpha',qmd:{index:'global',localIndex:false,maintenance:{mode:'coordinated'},collections:[]} });
 put(join(w,'memory/domains/registry.json'), {domains:{'alpha-general': group ? {type:'group-direct',group:{chatId:'-123'}} : {type:'meta-domain',topic:{chatId:'-123',topicId:1}}}});
 put(join(upper,'engram.json'), {domains:{'company-general':{type:'meta-domain',qmdCollections:[]}}});
 put(join(upper,'memory/domains/registry.json'), {domains:{'company-general':{type:'meta-domain',qmdCollections:[]}}});
 const globalManifest=join(root,'global.json'),fleetManifest=join(root,'fleet.json');
 put(globalManifest,{schema:'engram.qmd.global-migration.v1',indexPath:join(root,'qmd.sqlite'),workspaces:[],registry:{schema:'engram.qmd.global-registry.v1',index:{name:'global'},workspaces:[{id:'company',path:upper,kind:'business',parents:[],readableCollections:[]}],collections:[]}});
 put(fleetManifest,{schema:'engram.memory-topic-fleet.v1',schedulerId:'fleet',workspaces:[]});
 const host = {agents:{entries:[{id:'alpha',workspace:w}]},channels:{telegram:{groups:{'-123':group?{enabled:true}:{enabled:true,topics:{'1':{enabled:true,agentId:'alpha'}}}}}},bindings:group?[{type:'route',agentId:'alpha',match:{channel:'telegram',peer:{kind:'group',id:'-123'}}}]:[]};
 const request:ProjectRequest={workspace:w,id:'alpha',parentId:'company',domains:['alpha-general'],globalManifest,fleetManifest,workerManifest:join(w,'ops/worker/qmd-manifest.json'),upperDomains:[{workspaceId:'company',domain:'company-general'}]};
 return {root,w,host,request,put};
}
for (const group of [false,true]) test(`prepare/apply/read-back/idempotence; group=${group}`,()=>{
 const f=fixture(group), plan=planProjectProvisioning(f.request,f.host);
 expect(plan.bindings[0].runtimeSessionKey).toBe('agent:alpha:telegram:group:-123'+(group?'':':topic:1'));
 const manifest=JSON.parse(plan.changes.find(c=>c.path===f.request.globalManifest)!.after);
 const exact=manifest.registry.collections.find((c:any)=>c.name.startsWith(group?'group-memory-':'topic-memory-'));
 expect(exact.mask).toBe('*.md'); expect(exact.path).toContain('telegram-group--123');
 expect(applyProjectPlan(plan,join(f.root,'journal.json')).ownershipChanged).toBe(false);
 expect(planProjectProvisioning(f.request,f.host).changes).toEqual([]);
 expect(JSON.parse(readFileSync(f.request.fleetManifest,'utf8')).workspaces).toEqual([]);
});
test('rejects host-route mismatch before mutations',()=>{const f=fixture(); f.host.agents.entries[0]!.workspace=f.root; expect(()=>planProjectProvisioning(f.request,f.host)).toThrow();});
test('requires explicit complete upper visibility and rejects horizontal mapping',()=>{const f=fixture(); f.request.upperDomains=[]; expect(()=>planProjectProvisioning(f.request,f.host)).toThrow('ancestors'); f.request.upperDomains=[{workspaceId:'sibling',domain:'x'}];expect(()=>planProjectProvisioning(f.request,f.host)).toThrow('ancestor');});
test('CAS rejects concurrent modifications before writing anything',()=>{const f=fixture(); const plan=planProjectProvisioning(f.request,f.host); const before=readFileSync(f.request.globalManifest,'utf8'); f.put(join(f.w,'engram.json'),{changed:true});expect(()=>applyProjectPlan(plan,join(f.root,'journal.json'))).toThrow('concurrent drift');expect(readFileSync(f.request.globalManifest,'utf8')).toBe(before);});
test('active worker snapshot is not silently replaced',()=>{const f=fixture(); const plan=planProjectProvisioning(f.request,f.host);applyProjectPlan(plan,join(f.root,'journal.json'));f.put(join(f.w,'memory-state/memory-observation/projection.json'),{enabled:true});f.put(f.request.workerManifest,{registry:{collections:[]}});expect(()=>planProjectProvisioning(f.request,f.host)).toThrow('separate reviewed rollout');});

function enrollmentFixture() {
 const f=fixture();const plan=planProjectProvisioning(f.request,f.host);applyProjectPlan(plan,join(f.root,'foundation-journal.json'));
 const digest='sha256:'+'a'.repeat(64);
 const projection={schema:'engram.memory-observation-rollout.v4',workspaceId:'alpha',enabled:true,mode:'canary',captureOwnership:{owner:'observer'},evaluation:{batch:{schedulerId:'fleet'}},bindings:plan.bindings,pluginDigest:digest};
 f.put(join(f.w,'memory-state/memory-observation/projection.json'),projection);
 const job={id:'job',declarationKey:'fleet',enabled:true,schedule:{kind:'cron',tz:'UTC',staggerMs:0},payload:{kind:'command',argv:['bun','/engram/memory-observation-group-fleet.ts','--manifest',f.request.fleetManifest],timeoutSeconds:1000}};
 const runtime={config:f.host,plugin:{enabled:true,status:'loaded',diagnosticCount:0,installedDigest:digest,loadedDigest:null},cron:{available:true,complete:true,jobs:[job]}};
 return {...f,projection,runtime,job};
}
test('fleet enrollment preserves other fields and is repeatable without changing ownership',()=>{
 const f=enrollmentFixture();const plan=planProjectFleetEnrollment(f.request,f.projection,f.runtime);
 expect(plan.changes.length).toBe(1);expect(plan.pending.some(p=>p.includes('resident'))).toBe(true);
 applyProjectPlan(plan,join(f.root,'fleet-journal.json'));
 expect(planProjectFleetEnrollment(f.request,f.projection,f.runtime).changes).toEqual([]);
 expect(JSON.parse(readFileSync(f.request.fleetManifest,'utf8')).workspaces).toEqual([{id:'alpha',path:f.w}]);
});
test('fleet enrollment refuses incomplete visibility, disabled jobs and inadequate timeout',()=>{
 const f=enrollmentFixture();f.runtime.cron.complete=false;expect(()=>planProjectFleetEnrollment(f.request,f.projection,f.runtime)).toThrow('observation');
 f.runtime.cron.complete=true;f.job.enabled=false;expect(()=>planProjectFleetEnrollment(f.request,f.projection,f.runtime)).toThrow('profile');
 f.job.enabled=true;f.job.payload.timeoutSeconds=300;expect(()=>planProjectFleetEnrollment(f.request,f.projection,f.runtime)).toThrow('timeout');
});
test('fleet enrollment requires active plugin identity and official exact rollout',()=>{
 const f=enrollmentFixture();f.runtime.plugin.installedDigest='wrong';expect(()=>planProjectFleetEnrollment(f.request,f.projection,f.runtime)).toThrow('plugin');
 f.runtime.plugin.installedDigest=f.projection.pluginDigest;f.projection.bindings=[];expect(()=>planProjectFleetEnrollment(f.request,f.projection,f.runtime)).toThrow('rollout');
});
