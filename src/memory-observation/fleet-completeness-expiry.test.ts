import {afterEach,expect,test} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {sha256} from './ledger.ts';
import {reportFleetCompleteness} from './fleet-completeness.ts';
const dirs:string[]=[];afterEach(()=>dirs.splice(0).forEach(d=>rmSync(d,{recursive:true,force:true})));
function snapshot(now:number,auto=true){const id=sha256('debt'),base={schema:'engram.memory-source-debt-snapshot.v1' as const,workspaceId:'alpha',observed:true,
 debtIds:[id],openIds:[] as any[],closedIds:[] as any[],writtenOffIds:[id],automaticallyStoppedIds:auto?[id]:[],corrupt:false,errors:[],verifiedAt:new Date(now).toISOString()};return {...base,snapshotDigest:sha256(base)};}
test('policy stops are not operator decisions or recovered memory; unchanged history stays quiet',async()=>{
 const stateDir=mkdtempSync(join(tmpdir(),'fleet-expiry-'));dirs.push(stateDir);const messages:string[]=[];
 const config={stateDir,operator:{channel:'telegram',target:'100000001'},cooldownMs:60000};
 const notify=async(m:string)=>{messages.push(m);};
 const results=[{workspaceId:'alpha',snapshot:snapshot(100000)}];
 const r=await reportFleetCompleteness({config,results,notify,now:100000});
 expect(r.automaticallyStopped).toBe(1);expect(messages[0]).toContain('Восстановление прекращено политикой: 1');
 expect(messages[0]).toContain('Списано оператором: 0');expect(messages[0]).not.toContain('источников восстановлена');
 await reportFleetCompleteness({config,results:[{workspaceId:'alpha',snapshot:snapshot(1000000)}],notify,now:1000000});
 expect(messages).toHaveLength(1);
});
test('automatic subset cannot overlap open/recovered or invent identities',async()=>{
 const stateDir=mkdtempSync(join(tmpdir(),'fleet-expiry-'));dirs.push(stateDir);
 const s=snapshot(100000);const {snapshotDigest,...base}=s;base.automaticallyStoppedIds=[sha256('foreign')];
 const r=await reportFleetCompleteness({config:{stateDir,operator:{channel:'telegram',target:'100000001'},cooldownMs:60000},
 results:[{workspaceId:'alpha',snapshot:{...base,snapshotDigest:sha256(base)}}],notify:async()=>{},now:100000});
 expect(r.unverified).toEqual(['alpha']);
});
