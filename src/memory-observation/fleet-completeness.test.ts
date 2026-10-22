import {afterEach,expect,test} from 'bun:test';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {sha256} from './ledger.ts';
import {reportFleetCompleteness} from './fleet-completeness.ts';
const dirs:string[]=[];afterEach(()=>{for(const p of dirs.splice(0))rmSync(p,{recursive:true,force:true});});
const id=sha256('synthetic-source-debt');
function snapshot(open=true,now=100000,extra:any={}){const base={schema:'engram.memory-source-debt-snapshot.v1',workspaceId:'alpha',observed:true,verifiedAt:new Date(now).toISOString(),debtIds:[id],openIds:open?[id]:[],closedIds:open?[]:[id],corrupt:false,errors:[],...extra};return {...base,snapshotDigest:sha256(base)};}
function fixture(){const stateDir=mkdtempSync(join(tmpdir(),'fleet-completeness-'));dirs.push(stateDir);const messages:string[]=[];const config:any={stateDir,operator:{channel:'telegram',target:'100000001',accountId:'default'},cooldownMs:60000};return {config,messages,notify:async(m:string)=>{messages.push(m);},now:100000};}
test('idle success cannot close persisted source incident; exact proof emits one recovery',async()=>{const f=fixture();await reportFleetCompleteness({...f,results:[{workspaceId:'alpha',snapshot:snapshot()}]});expect(f.messages).toHaveLength(1);await reportFleetCompleteness({...f,results:[{workspaceId:'alpha',snapshot:snapshot()}]});expect(f.messages).toHaveLength(1);await reportFleetCompleteness({...f,results:[{workspaceId:'alpha'}]});expect(f.messages.at(-1)).not.toContain('восстановлена.');await reportFleetCompleteness({...f,results:[{workspaceId:'alpha',snapshot:snapshot(false)}]});expect(f.messages.at(-1)).toContain('источников восстановлена');const before=f.messages.length;await reportFleetCompleteness({...f,results:[{workspaceId:'alpha',snapshot:snapshot(false)}]});expect(f.messages).toHaveLength(before);});
test('requeue/open debt and stale/corrupt proof never emit green',async()=>{const f=fixture();await reportFleetCompleteness({...f,results:[{workspaceId:'alpha',snapshot:snapshot()}]});for(const s of [snapshot(false,0),snapshot(false,100000,{corrupt:1}),{...snapshot(false),snapshotDigest:sha256('wrong')}])await reportFleetCompleteness({...f,now:1000000,results:[{workspaceId:'alpha',snapshot:s}]});expect(f.messages.join('\n')).not.toContain('источников восстановлена');const state=JSON.parse(readFileSync(join(f.config.stateDir,'memory-incidents.json'),'utf8'));expect(state.incidents[0].closedIds).toEqual([]);});
test('partial source closure is explicit and cannot clear remaining debt',async()=>{const f=fixture(),id2=sha256('second-source');await reportFleetCompleteness({...f,results:[{workspaceId:'alpha',snapshot:snapshot(true,100000,{debtIds:[id,id2],openIds:[id,id2]})}]});await reportFleetCompleteness({...f,results:[{workspaceId:'alpha',snapshot:snapshot(true,100000,{debtIds:[id,id2],openIds:[id2],closedIds:[id]})}]});expect(f.messages.at(-1)).toContain('частичное восстановление');expect(f.messages.at(-1)).toContain('alpha: 1');});
test('failed notification does not acknowledge closure and next pass retries',async()=>{const f=fixture();await reportFleetCompleteness({...f,results:[{workspaceId:'alpha',snapshot:snapshot()}]});await expect(reportFleetCompleteness({...f,notify:async()=>{throw Error('send_failed');},results:[{workspaceId:'alpha',snapshot:snapshot(false)}]})).rejects.toThrow('send_failed');await reportFleetCompleteness({...f,results:[{workspaceId:'alpha',snapshot:snapshot(false)}]});expect(f.messages.at(-1)).toContain('источников восстановлена');});
test('malformed persisted incident fails closed before delivery',async()=>{const f=fixture();writeFileSync(join(f.config.stateDir,'memory-incidents.json'),'broken');await expect(reportFleetCompleteness({...f,results:[{workspaceId:'alpha',snapshot:snapshot(false)}]})).rejects.toThrow();expect(f.messages).toHaveLength(0);});
test('write-off stops reminders for exact set without recovery claim; new error still alerts',async()=>{
 const f=fixture();await reportFleetCompleteness({...f,results:[{workspaceId:'alpha',snapshot:snapshot()}]});
 const waived=snapshot(true,100000,{openIds:[],closedIds:[],writtenOffIds:[id]});
 const r=await reportFleetCompleteness({...f,results:[{workspaceId:'alpha',snapshot:waived}]});
 expect(r.status).toBe('written_off');expect(f.messages.at(-1)).toContain('Списано оператором: 1');expect(f.messages.at(-1)).not.toContain('источников восстановлена');
 const count=f.messages.length;
 await reportFleetCompleteness({...f,now:10000000,results:[{workspaceId:'alpha',snapshot:snapshot(true,10000000,{openIds:[],closedIds:[],writtenOffIds:[id]})}]});
 expect(f.messages).toHaveLength(count);
 const id2=sha256('new-error');await reportFleetCompleteness({...f,now:10000001,results:[{workspaceId:'alpha',snapshot:snapshot(true,10000001,{debtIds:[id,id2],openIds:[id2],closedIds:[],writtenOffIds:[id]})}]});
 expect(f.messages).toHaveLength(count+1);expect(f.messages.at(-1)).toContain('alpha: 1');
});
test('overlap and forged write-off snapshot never clear incident',async()=>{
 const f=fixture();await reportFleetCompleteness({...f,results:[{workspaceId:'alpha',snapshot:snapshot()}]});
 const r=await reportFleetCompleteness({...f,results:[{workspaceId:'alpha',snapshot:snapshot(true,100000,{writtenOffIds:[id]})}]});
 expect(r.remaining).toBe(1);expect(r.unverified).toEqual(['alpha']);
});
test('same identity reopens after invalidated write-off; proof closure remains separate',async()=>{
 const f=fixture();await reportFleetCompleteness({...f,results:[{workspaceId:'alpha',snapshot:snapshot(true,100000,{openIds:[],writtenOffIds:[id]})}]});
 const r=await reportFleetCompleteness({...f,results:[{workspaceId:'alpha',snapshot:snapshot()}]});
 expect(r.remaining).toBe(1);expect(r.writtenOff).toBe(0);expect(f.messages.at(-1)).toContain('alpha: 1');
});
test('workspace lines distinguish historical debt from the current pass and its blocker',async()=>{
 const f=fixture();
 await reportFleetCompleteness({...f,results:[
  {workspaceId:'alpha',snapshot:snapshot(),execution:{workspaceId:'alpha',exitCode:0,semanticStatus:'ok'}},
  {workspaceId:'beta',snapshot:snapshot(true,100000,{workspaceId:'beta'}),execution:{workspaceId:'beta',exitCode:1,semanticStatus:'blocked',blockedReasons:['MODEL_TRANSITION_IDENTITY_CHANGED']}},
 ]});
 const m=f.messages[0]!;
 expect(m).toContain('WS alpha: 1 незакрытых; текущий запуск: успешен');
 expect(m).toContain('\nWS beta: 1 незакрытых; текущий запуск: блокировка (MODEL_TRANSITION_IDENTITY_CHANGED)');
 expect(m).not.toContain('источников восстановлена');
});
test('changed execution reason alerts within cooldown without closing historical debt',async()=>{
 const f=fixture(),base={workspaceId:'alpha',snapshot:snapshot()};
 await reportFleetCompleteness({...f,results:[{...base,execution:{workspaceId:'alpha',exitCode:0,semanticStatus:'ok'}}]});
 const failed={...base,execution:{workspaceId:'alpha',exitCode:1,semanticStatus:'error' as const,executionErrors:['daily_note:qmd_pending'],error:'PRIVATE SOURCE'}};
 const r=await reportFleetCompleteness({...f,results:[failed]});
 expect(r.remaining).toBe(1);expect(f.messages).toHaveLength(2);
 expect(f.messages[1]).toContain('WS alpha: 1 незакрытых; текущий запуск: ошибка (daily_note:qmd_pending)');
 expect(f.messages[1]).not.toContain('PRIVATE SOURCE');
 await reportFleetCompleteness({...f,results:[failed]});expect(f.messages).toHaveLength(2);
});
test('missing or foreign execution is never labelled successful',async()=>{
 const f=fixture();
 await reportFleetCompleteness({...f,results:[{workspaceId:'alpha',snapshot:snapshot()}]});
 expect(f.messages[0]).toContain('текущий запуск: не проверен');
 await expect(reportFleetCompleteness({...f,results:[{workspaceId:'alpha',snapshot:snapshot(),execution:{workspaceId:'foreign',exitCode:0,semanticStatus:'ok'}}]})).rejects.toThrow('FLEET_COMPLETENESS_EXECUTION_OWNER_INVALID');
});
test('unverified workspace remains named with timeout and does not clear its incident',async()=>{
 const f=fixture();await reportFleetCompleteness({...f,results:[{workspaceId:'alpha',snapshot:snapshot()}]});
 const r=await reportFleetCompleteness({...f,results:[{workspaceId:'alpha',execution:{workspaceId:'alpha',timedOut:true}}]});
 expect(r.remaining).toBe(1);
 expect(f.messages.at(-1)).toContain('WS alpha: 1 незакрытых; текущий запуск: тайм-аут; состояние памяти не подтверждено');
 expect(f.messages.at(-1)).toContain('WS alpha: снимок состояния недоступен или не прошёл проверку');
});
test('format upgrade never resurrects an already acknowledged, fully closed incident',async()=>{
 const f=fixture();
 writeFileSync(join(f.config.stateDir,'memory-incidents.json'),JSON.stringify({schema:'engram.fleet-completeness-incidents.v1',
  incidents:[{workspaceId:'alpha',sourceIds:[id],closedIds:[id],notifiedClosedIds:[id],openedAt:new Date(f.now).toISOString()}],
  notifiedFingerprint:'legacy-format-fingerprint',notifiedAt:f.now}));
 const r=await reportFleetCompleteness({...f,results:[{workspaceId:'alpha',snapshot:snapshot(false)}]});
 expect(r.status).toBe('closed');expect(f.messages).toHaveLength(0);
});
