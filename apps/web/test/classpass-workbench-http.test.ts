import { describe, expect, it } from 'vitest';
import { assertClassPassEndpoint, classPassPath, parseClassPassEnvelope } from '../src/components/classpass-workbench-http';
const org='10000000-0000-4000-8000-000000000001',school='10000000-0000-4000-8000-000000000002',target='10000000-0000-4000-8000-000000000003',pass='10000000-0000-4000-8000-000000000004',booking='10000000-0000-4000-8000-000000000005';
const meta={requestId:org,correlationId:org};
const read={id:pass,version:1,status:'ACTIVE',paymentProviderOutcome:'UNAVAILABLE',attendanceOutcome:'NOT_RECORDED_BY_CLASSPASS',parentProjection:'UNAVAILABLE'};
const receipt={id:pass,passId:pass,version:1,status:'ACTIVE',remainingUses:2,decision:'WAITLISTED_NOT_REDEEMED',paymentProviderOutcome:'UNAVAILABLE',attendanceOutcome:'NOT_RECORDED_BY_CLASSPASS',externalEffects:'NONE',replayed:false,booking:{id:booking,passId:pass,classSessionId:target,bookingKind:'CLASS_PASS',version:1,status:'WAITLISTED'}};
describe('ClassPass workbench exact HTTP contract',()=>{
 it('accepts only exact tenant IDs and ClassPass operation paths',()=>{
  const path=classPassPath({organizationId:org,schoolId:school},'ADMIT',target);
  expect(path).toBe(`/api/v1/organizations/${org}/schools/${school}/classpass/commands/ADMIT/${target}`);
  expect(()=>assertClassPassEndpoint(path,true)).not.toThrow();
  for(const unsafe of [path+'?principalId='+org,'https://provider.example'+path,path.replace('/classpass/','/payments/'),path.replace('/ADMIT/','/PURCHASE/')])expect(()=>assertClassPassEndpoint(unsafe,true)).toThrow();
  expect(()=>classPassPath({organizationId:'invalid',schoolId:school},'PASS',pass)).toThrow();
 });
 it('preserves read outcomes as unavailable, never assuming attendance or payment success',()=>{
  expect(parseClassPassEnvelope({data:read,meta},'PASS',pass)).toEqual(read);
  for(const patch of [{paymentProviderOutcome:'SUCCEEDED'},{attendanceOutcome:'PRESENT'},{parentProjection:'AVAILABLE'},{amount:1},{id:target}])expect(()=>parseClassPassEnvelope({data:{...read,...patch},meta},'PASS',pass)).toThrow();
 });
 it('keeps waitlisted non-redemption distinct from admitted booked outcomes and checks exact target/pass',()=>{
  const envelope={data:receipt,meta:{...meta,replayed:false}},input={expectedVersion:1,passId:pass};
  expect(parseClassPassEnvelope(envelope,'ADMIT',target,input)).toEqual(receipt);
  expect(()=>parseClassPassEnvelope({...envelope,data:{...receipt,booking:{...receipt.booking,status:'BOOKED'}}},'ADMIT',target,input)).toThrow();
  expect(()=>parseClassPassEnvelope(envelope,'ADMIT',target,{...input,passId:org})).toThrow();
  expect(()=>parseClassPassEnvelope(envelope,'ADMIT',org,input)).toThrow();
 });
});

it('staff transport uses only exact relative routes and same-origin direct-human JSON commands',async()=>{
 const {vi}=await import('vitest');const {readClassPass,commandClassPass}=await import('../src/components/classpass-workbench-http');
 const calls:Array<[unknown,RequestInit|undefined]>=[];
 vi.stubGlobal('fetch',async(path:unknown,options:RequestInit)=>{calls.push([path,options]);return new Response(JSON.stringify(options.method==='POST'?{data:receipt,meta:{...meta,replayed:false}}:{data:read,meta}),{headers:{'content-type':'application/json'}});});
 try{
  await readClassPass({organizationId:org,schoolId:school},'PASS',pass);
  await commandClassPass({organizationId:org,schoolId:school},'ADMIT',target,{expectedVersion:1,passId:pass},'human-key');
  expect(calls[0]![0]).toBe(`/api/v1/organizations/${org}/schools/${school}/classpass/PASS/${pass}`);
  expect(calls[1]![0]).toBe(`/api/v1/organizations/${org}/schools/${school}/classpass/commands/ADMIT/${target}`);
  for(const [,options]of calls)expect(options).toMatchObject({credentials:'same-origin',mode:'same-origin',referrerPolicy:'no-referrer',cache:'no-store',redirect:'error'});
  expect(calls[1]![1]).toMatchObject({method:'POST',headers:{'Content-Type':'application/json','X-HON-Human-Command':'classpass','Idempotency-Key':'human-key'},body:JSON.stringify({expectedVersion:1,passId:pass})});
  await expect(commandClassPass({organizationId:'https://evil.test',schoolId:school},'ADMIT',target,{expectedVersion:1,passId:pass},'human-key')).rejects.toThrow();expect(calls).toHaveLength(2);
 }finally{vi.unstubAllGlobals();}
});
