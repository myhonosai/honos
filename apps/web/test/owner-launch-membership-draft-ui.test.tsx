import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { describe,it,expect,vi } from 'vitest';
import { OwnerLaunch } from '../src/components/owner-launch';
import { postOwnerLaunchMembershipDraft } from '../src/components/owner-launch-http';
import type { OwnerLaunchProjection } from '@hon/contracts';
const id=(n:string)=>`${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
const registration={registrationId:id('5'),studentProfileId:id('6'),enrollmentId:id('7'),programId:id('3'),classSessionId:id('4'),status:'REGISTERED_NO_BOOKING' as const,createdAt:'2026-10-16T00:00:00.000Z'};
const projection:OwnerLaunchProjection={organizationId:id('1'),schoolId:id('2'),schoolName:'Local',tier:'ESSENTIAL',program:{id:id('3'),version:1,status:'DRAFT'},classSession:{id:id('4'),programId:id('3'),version:1,status:'SCHEDULED'},registration,guardianChildRegistration:null};
const input={registrationId:registration.registrationId,expectedReceiptVersion:1 as const,planCode:'OPAQUE',termStartedAt:'2027-01-01T00:00:00.000Z',termEndsAt:'2028-01-01T00:00:00.000Z',currency:'USD'};
const receipt={registrationId:input.registrationId,membershipId:id('8'),state:'DRAFT',membershipVersion:1,planCode:input.planCode,termStartedAt:input.termStartedAt,termEndsAt:input.termEndsAt,currency:'USD',billingAccountCreated:true,recordedAt:'2026-10-16T00:00:00.000Z'};
const response=(data:unknown)=>({ok:true,status:201,json:async()=>({data})}) as Response;
describe('receipt-bound owner membership DRAFT UI',()=>{
 it('posts exact explicit input only to fixed same-origin human route after adult or child receipt',async()=>{
  const fetch=vi.spyOn(globalThis,'fetch').mockResolvedValue(response(receipt));
  try{
   for(const context of [projection,{...projection,registration:null,guardianChildRegistration:{...registration,familyId:id('9'),registrationKind:'NEW_CHILD_WITH_NEW_GUARDIAN' as const}}])expect(await postOwnerLaunchMembershipDraft(context,input,id('a'))).toEqual(receipt);
   expect(fetch.mock.calls[0]![0]).toBe('/api/v1/owner-launch/membership-draft');expect(fetch.mock.calls[0]![1]).toMatchObject({method:'POST',credentials:'same-origin',cache:'no-store',referrerPolicy:'no-referrer',headers:{'Idempotency-Key':id('a'),'X-HON-Human-Command':'owner-launch-membership-draft'}});expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string)).toEqual(input);
  }finally{fetch.mockRestore();}
 });
 it('refuses unsaved/foreign receipts, selectors, invalid currency/term and absent explicit values before transport',async()=>{
  const fetch=vi.spyOn(globalThis,'fetch');try{
   await expect(postOwnerLaunchMembershipDraft({...projection,registration:null},input,id('a'))).rejects.toThrow();
   for(const patch of [{registrationId:id('b')},{expectedReceiptVersion:2},{payerPersonId:id('b')},{participantPersonId:id('b')},{billingAccountId:id('b')},{familyId:id('b')},{schoolId:id('b')},{price:1},{paymentSchedule:{}},{activation:true},{invoice:true},{planCode:''},{currency:'usd'},{currency:'ZZZ'},{termStartedAt:'2027-01-01T00:00:00+23:59'},{termStartedAt:'0000-01-01T00:00:00Z'},{termEndsAt:'9999-12-31T23:59:59-14:00'},{termEndsAt:input.termStartedAt}])await expect(postOwnerLaunchMembershipDraft(projection,{...input,...patch},id('a'))).rejects.toThrow();expect(fetch).not.toHaveBeenCalled();
  }finally{fetch.mockRestore();}
 });
 it('rejects nonredacted or mismatched result and reports denied/needs-staff/unknown without financial success',async()=>{
  for(const patch of [{payerPersonId:id('b')},{participantPersonId:id('b')},{billingAccountId:id('b')},{state:'ACTIVE'},{currency:'CAD'},{planCode:'OTHER'},{paymentOutcome:'SUCCEEDED'},{invoiceId:id('b')}]){const fetch=vi.spyOn(globalThis,'fetch').mockResolvedValue(response({...receipt,...patch}));try{await expect(postOwnerLaunchMembershipDraft(projection,input,id('a'))).rejects.toThrow();}finally{fetch.mockRestore();}}
  for(const status of [400,401,403,404,409,503]){const fetch=vi.spyOn(globalThis,'fetch').mockResolvedValue({ok:false,status} as Response);try{await expect(postOwnerLaunchMembershipDraft(projection,input,id('a'))).rejects.toMatchObject({status});}finally{fetch.mockRestore();}}
 });
 it('shows no draft command before saved registration and retains explicit no-effect labels with no activation link',()=>{
  const html=renderToStaticMarkup(<OwnerLaunch/>);expect(html).not.toContain('Save membership DRAFT only');
  const source=readFileSync('src/components/owner-launch.tsx','utf8');expect(source).toContain('{saved&&<section aria-label="Receipt-bound membership draft">');expect(source).toContain('DRAFT only. No payment schedule, payment method, processor, payment, activation, invoice or communication.');expect(source).toContain('Activation remains a separate conventional human workflow and is not available here.');expect(source).toContain("[currency,setCurrency]=useState('')");expect(source).toContain("[planCode,setPlanCode]=useState('')");expect(source).not.toMatch(/href=[^\n]*(activate|billing)|localStorage|sessionStorage|invokeLLM|providerClient/);
 });
});
