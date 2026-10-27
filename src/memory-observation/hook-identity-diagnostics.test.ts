import {expect,test} from 'bun:test';
import {resolveObservationPersistedUserIdentity,ObservationHookIdentityError} from './hook-identity.ts';
import {observationRuntimeAdapterError} from './runtime-adapter.ts';
test('known hook identity failures remain distinct and unknown exceptions stay private',()=>{
 const key='agent:alpha:telegram:direct:100000001';
 const valid={sessionKey:key,message:{role:'user',idempotencyKey:'channel-user:v1:'+'a'.repeat(64),__openclaw:{senderIsOwner:true,transport:{channel:'telegram',messageId:'1'}}}};
 const codes=new Set<string>();
 for(const kind of ['transport','ownership','source','session']){
  const event:any=structuredClone(valid),context={sessionKey:key};
  if(kind==='transport')delete event.message.__openclaw.transport;
  if(kind==='ownership')delete event.message.__openclaw.senderIsOwner;
  if(kind==='source')event.message.idempotencyKey='not-native';
  if(kind==='session')context.sessionKey='agent:alpha:telegram:direct:100000002';
  try{resolveObservationPersistedUserIdentity(event,context);throw Error('must reject');}
  catch(error){const d=observationRuntimeAdapterError(error);expect(d.code).not.toBe('RUNTIME_ADAPTER_FAILED');codes.add(d.code);}
 }
 expect(codes.size).toBe(4);
 expect(observationRuntimeAdapterError(new ObservationHookIdentityError('PRIVATE RAW CONTENT'))).toEqual({code:'HOOK_IDENTITY_INVALID',message:'hook identity validation failed'});
 expect(observationRuntimeAdapterError(new Error('PRIVATE RAW CONTENT')).message).not.toContain('PRIVATE');
});
