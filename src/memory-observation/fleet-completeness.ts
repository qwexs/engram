import {closeSync,existsSync,fsyncSync,mkdirSync,openSync,readFileSync,renameSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {sha256,type Digest} from './ledger.ts';
import type {FleetIsolation} from './fleet-isolation.ts';
import type {SourceDebtSnapshot} from './source-debt.ts';

type Snapshot=SourceDebtSnapshot;
type Incident={workspaceId:string;sourceIds:Digest[];closedIds:Digest[];writtenOffIds?:Digest[];notifiedClosedIds?:Digest[];openedAt:string};
type State={schema:'engram.fleet-completeness-incidents.v1';incidents:Incident[];notifiedFingerprint:string;notifiedAt:number};
const HASH=/^sha256:[a-f0-9]{64}$/;
const WORKSPACE=/^[a-zA-Z0-9_-]+$/;
function atomic(path:string,value:unknown){const tmp=path+'.'+randomUUID()+'.tmp',fd=openSync(tmp,'wx',0o600);try{writeFileSync(fd,JSON.stringify(value)+'\n');fsyncSync(fd);}finally{closeSync(fd);}renameSync(tmp,path);const dir=openSync(dirname(path),'r');try{fsyncSync(dir);}finally{closeSync(dir);}}
function validateSnapshot(s:Snapshot,workspaceId:string,now:number){
 const {snapshotDigest,...base}=s;
 if(s.schema!=='engram.memory-source-debt-snapshot.v1'||s.workspaceId!==workspaceId||snapshotDigest!==sha256(base as any)
  ||!Number.isFinite(Date.parse(s.verifiedAt))||Date.parse(s.verifiedAt)>now+5000||now-Date.parse(s.verifiedAt)>900000
  ||s.observed!==true||s.corrupt!==false||!Array.isArray(s.errors)||s.errors.length)throw Error('FLEET_COMPLETENESS_UNVERIFIED');
 const writtenOff=s.writtenOffIds??[];
 for(const list of [s.debtIds,s.openIds,s.closedIds,writtenOff])if(!Array.isArray(list)||list.some(x=>!HASH.test(x))||new Set(list).size!==list.length)throw Error('FLEET_COMPLETENESS_IDENTITIES');
 const partition=[...s.openIds,...s.closedIds,...writtenOff],all=new Set(s.debtIds);
 if(partition.some(x=>!all.has(x))||new Set(partition).size!==partition.length||partition.length!==all.size)throw Error('FLEET_COMPLETENESS_COVERAGE');
}
/** Caller holds the existing fleet lease. Never infer recovery from exit code.
 * Missing/unverified snapshots preserve incident state and cannot emit green. */
export async function reportFleetCompleteness(args:{config:FleetIsolation;results:Array<{workspaceId:string;snapshot?:Snapshot}>;now?:number;notify:(message:string,route:FleetIsolation['operator'])=>Promise<void>}){
 const now=args.now??Date.now(),file=join(args.config.stateDir,'memory-incidents.json');
 mkdirSync(args.config.stateDir,{recursive:true,mode:0o700});
 let state:State=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):{schema:'engram.fleet-completeness-incidents.v1',incidents:[],notifiedFingerprint:'',notifiedAt:0};
 if(state.schema!=='engram.fleet-completeness-incidents.v1'||!Array.isArray(state.incidents)||typeof state.notifiedFingerprint!=='string'||!Number.isFinite(state.notifiedAt))throw Error('FLEET_COMPLETENESS_STATE_INVALID');
 for(const i of state.incidents)if(!WORKSPACE.test(i.workspaceId)||!Array.isArray(i.sourceIds)||!Array.isArray(i.closedIds)||i.sourceIds.some(x=>!HASH.test(x))||i.closedIds.some(x=>!i.sourceIds.includes(x))||new Set(i.sourceIds).size!==i.sourceIds.length||new Set(i.closedIds).size!==i.closedIds.length
 ||i.notifiedClosedIds!==undefined&&(!Array.isArray(i.notifiedClosedIds)||i.notifiedClosedIds.some(x=>!i.sourceIds.includes(x)))
 ||i.writtenOffIds!==undefined&&(!Array.isArray(i.writtenOffIds)||i.writtenOffIds.some(x=>!i.sourceIds.includes(x)||i.closedIds.includes(x))||new Set(i.writtenOffIds).size!==i.writtenOffIds.length))throw Error('FLEET_COMPLETENESS_INCIDENT_INVALID');
 if(args.results.some(r=>!WORKSPACE.test(r.workspaceId)))throw Error('FLEET_COMPLETENESS_WORKSPACE_INVALID');
 if(new Set(args.results.map(x=>x.workspaceId)).size!==args.results.length)throw Error('FLEET_COMPLETENESS_DUPLICATE_WORKSPACE');
 const unverified:string[]=[],newlyClosed:Array<{workspaceId:string;count:number}>=[];
 for(const r of args.results){
  if(!r.snapshot){unverified.push(r.workspaceId);continue;}
  try{validateSnapshot(r.snapshot,r.workspaceId,now);}catch{unverified.push(r.workspaceId);continue;}
  const s=r.snapshot;let incident=state.incidents.find(i=>i.workspaceId===r.workspaceId);
  if(!incident&&(s.openIds.length||s.writtenOffIds?.length)){incident={workspaceId:r.workspaceId,sourceIds:[],closedIds:[],openedAt:new Date(now).toISOString()};state.incidents.push(incident);}
  if(!incident)continue;
  // New failures reopen their identity; only the fresh proof snapshot may close.
  incident.sourceIds=[...new Set([...incident.sourceIds,...s.openIds,...s.writtenOffIds??[]])].sort();
  const before=new Set(incident.notifiedClosedIds??[]);
  incident.closedIds=incident.sourceIds.filter(id=>s.closedIds.includes(id));
  if(s.writtenOffIds!==undefined||incident.writtenOffIds!==undefined)incident.writtenOffIds=incident.sourceIds.filter(id=>s.writtenOffIds?.includes(id));
  const count=incident.closedIds.filter(id=>!before.has(id)).length;
  if(count)newlyClosed.push({workspaceId:r.workspaceId,count});
 }
 state.incidents.sort((a,b)=>a.workspaceId.localeCompare(b.workspaceId));
 atomic(file,state); // Keep incident evidence even if required delivery fails.
 const remaining=state.incidents.map(i=>({workspaceId:i.workspaceId,open:i.sourceIds.length-i.closedIds.length-(i.writtenOffIds?.length??0)})).filter(i=>i.open);
 const writtenOff=state.incidents.reduce((n,i)=>n+(i.writtenOffIds?.length??0),0);
 const resolvedStatus=writtenOff?'written_off':'closed';
 const fingerprint=sha256({incidents:state.incidents.map(({notifiedClosedIds:_ack,...incident})=>incident),unverified:[...unverified].sort()});
 const changed=fingerprint!==state.notifiedFingerprint;
 const notificationDue=changed||now-state.notifiedAt>=args.config.cooldownMs;
 const hasHistory=state.incidents.length>0;
 if(!hasHistory)return {status:unverified.length?'unverified':'not_observed',notification:'not_needed',remaining:0,unverified};
 if(!notificationDue||(!remaining.length&&!newlyClosed.length&&fingerprint===state.notifiedFingerprint))return {status:remaining.length?'incomplete':unverified.length?'unverified':resolvedStatus,notification:'cooldown',remaining:remaining.reduce((n,x)=>n+x.open,0),writtenOff,unverified};
 let message:string;
 if(!remaining.length&&!unverified.length&&writtenOff){
  message='Memory Worker: активный долг этого набора снят. Списано оператором: '+writtenOff+'. Это прекращение восстановления, не подтверждение сохранения памяти.';
 }else if(!remaining.length&&!unverified.length&&newlyClosed.length){
  message='Memory Worker: обработка ранее незакрытых источников восстановлена.\n'+newlyClosed.map(x=>x.workspaceId+': '+x.count).join('; ')+'.\nДля этих источников проверены решения об обработке и все применимые эффекты памяти.';
 }else if(newlyClosed.length){
  message='Memory Worker: частичное восстановление обработки.\nПроверено закрытие: '+newlyClosed.map(x=>x.workspaceId+': '+x.count).join('; ')+'.\nОстались незакрытые источники: '+(remaining.map(x=>x.workspaceId+': '+x.open).join('; ')||'нет подтверждённых по доступному срезу')+'.';
 }else{
  message='Memory Worker: память требует восстановления.\nНезакрытые источники: '+(remaining.map(x=>x.workspaceId+': '+x.open).join('; ')||'проверка закрытия недоступна')+'.\nУспешный или пустой запуск не закрывает эти пропуски.';
 }
 if(writtenOff&&remaining.length)message+='\nСписано оператором и исключено из повторных напоминаний: '+writtenOff+'. Эти источники не объявлены восстановленными.';
 if(unverified.length)message+='\nЗакрытие не подтверждено: '+unverified.join(', ')+'.';
 await args.notify(message,args.config.operator);
 state={...state,incidents:state.incidents.map(i=>({...i,notifiedClosedIds:[...i.closedIds]})),notifiedFingerprint:fingerprint,notifiedAt:now};atomic(file,state);
 return {status:remaining.length?'incomplete':unverified.length?'unverified':resolvedStatus,notification:'sent',remaining:remaining.reduce((n,x)=>n+x.open,0),writtenOff,unverified};
}
