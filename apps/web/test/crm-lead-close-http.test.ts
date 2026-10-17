import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LeadListItem } from '@hon/contracts';
import { crmLeadClosePath, CrmLeadCloseRejectedError, CrmLeadCloseUncertainError, parseCrmLeadCloseResult, prepareCrmLeadClose, submitCrmLeadClose } from '../src/components/crm-lead-close-http';
const org='11111111-1111-4111-8111-111111111111',school='22222222-2222-4222-8222-222222222222',id='33333333-3333-4333-8333-333333333333',key='44444444-4444-4444-8444-444444444444';
const row: LeadListItem={id,status:'OPEN',pipelineStageId:org,primaryPersonId:key,version:4,createdAt:'2026-10-16T00:00:00.000Z',givenName:'Ari',familyName:'Stone'};
const input={status:'LOST' as const,expectedVersion:4,closeNote:'Human CRM only'};
const prepared=()=>prepareCrmLeadClose(org,school,row,input,key);
const envelope=()=>({data:{organizationId:org,schoolId:school,leadId:id,status:'LOST',priorVersion:4,version:5,closedAt:'2026-10-17T01:02:03.000Z',closeNote:input.closeNote,crmOnly:true},meta:{requestId:org,correlationId:org,replayed:false}});
const response=(value:unknown,status=200,type='application/json')=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':type}});
afterEach(()=>vi.restoreAllMocks());
describe('CRM-only close transport',()=>{
 it('prepares only a current OPEN row version with closed bounded human input and a frozen exact body/key',()=>{
  const p=prepared();expect(Object.isFrozen(p)).toBe(true);expect(p.body).toBe(JSON.stringify(input));
  expect(p.path).toBe(`/api/v1/organizations/${org}/schools/${school}/crm/leads/${id}/close`);
  for(const patch of [{status:'WON'},{status:'LOST'},{status:'ARCHIVED'}])expect(()=>prepareCrmLeadClose(org,school,{...row,...patch} as LeadListItem,input,key)).toThrow();
  for(const patch of [{expectedVersion:5},{expectedVersion:'4'},{status:'OPEN'},{closeNote:null},{closeNote:' x'},{closeNote:'x'.repeat(2001)},{closeNote:'x\u202e'},{source:'HUMAN_UI'},{leadId:id}])expect(()=>prepareCrmLeadClose(org,school,row,{...input,...patch} as typeof input,key)).toThrow();
  for(const bad of ['bad','https://evil.test','../x'])expect(()=>crmLeadClosePath(bad,school,id)).toThrow();
 });
 it('parses only exact linked closed scope/status/version/note/UTC/meta receipts, not conversion facts',()=>{
  const p=prepared(),v=envelope();expect(parseCrmLeadCloseResult(v,p)).toEqual({receipt:v.data,replayed:false});
  for(const patch of [{organizationId:key},{schoolId:key},{leadId:key},{status:'WON'},{status:'OPEN'},{priorVersion:5},{version:6},{version:'5'},{closeNote:'different'},{closeNote:null},{crmOnly:false},{enrollmentId:key},{paymentReceived:true},{closedAt:'2026-02-30T01:02:03.000Z'},{closedAt:'2026-10-17T01:02:03Z'}])expect(()=>parseCrmLeadCloseResult({...v,data:{...v.data,...patch}},p)).toThrow();
  for(const meta of [{},{...v.meta,source:'HUMAN_UI'},{...v.meta,replayed:'true'},{...v.meta,requestId:'bad'},{...v.meta,correlationId:key}])expect(()=>parseCrmLeadCloseResult({...v,meta},p)).toThrow();
  expect(()=>parseCrmLeadCloseResult({...v,extra:'x'},p)).toThrow();
 });
 it('uses fixed same-origin no-store JSON marker and exact retained retries only after uncertain responses',async()=>{
  const p=prepared(),f=vi.spyOn(globalThis,'fetch').mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce(response({...envelope(),meta:{...envelope().meta,replayed:true}}));
  await expect(submitCrmLeadClose(p)).rejects.toBeInstanceOf(CrmLeadCloseUncertainError);
  const r=await submitCrmLeadClose(p);expect(r.replayed).toBe(true);expect(f.mock.calls[0]).toEqual(f.mock.calls[1]);
  expect(f).toHaveBeenCalledWith(p.path,expect.objectContaining({method:'POST',mode:'same-origin',credentials:'same-origin',cache:'no-store',redirect:'error',referrerPolicy:'no-referrer',body:p.body,headers:expect.objectContaining({'X-HON-Human-Command':'crm-lead-close','Idempotency-Key':key,'Content-Type':'application/json'})}));
 });
 it('distinguishes definite rejections from server/unverified uncertain outcomes and performs no automatic retry',async()=>{
  const f=vi.spyOn(globalThis,'fetch');
  for(const status of [400,401,403,404,409,413,415,422]){f.mockResolvedValueOnce(response({},status));await expect(submitCrmLeadClose(prepared())).rejects.toBeInstanceOf(CrmLeadCloseRejectedError);}
  for(const r of [response({},500),response({},503),response(envelope(),201),response({...envelope(),data:{...envelope().data,version:9}}),response(envelope(),200,'text/html'),new Response('not-json',{status:200,headers:{'Content-Type':'application/json'}})]){f.mockResolvedValueOnce(r);await expect(submitCrmLeadClose(prepared())).rejects.toBeInstanceOf(CrmLeadCloseUncertainError);}
  expect(f).toHaveBeenCalledTimes(14);
 });
});
