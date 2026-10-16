import {describe,it,expect} from 'vitest';
import {verifyOwnerLaunchMembershipDraftConfirmation} from '@hon/contracts';
const id=(n:string)=>`${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
const receipt={registrationId:id('1'),membershipId:id('2'),state:'DRAFT',membershipVersion:1,planCode:'OPAQUE',termStartedAt:'2027-01-01T00:00:00.000Z',termEndsAt:'2028-01-01T00:00:00.000Z',currency:'USD',recordedAt:'2026-10-16T00:00:00.000Z'};
describe('owner membership DRAFT confirmation contract',()=>{
 it('allows one exact current DRAFT receipt or truthful empty/unavailable, never an array or fake success',()=>{
  expect(verifyOwnerLaunchMembershipDraftConfirmation({state:'RECORDED_DRAFT',receipt})).toEqual({state:'RECORDED_DRAFT',receipt});
  for(const state of ['NO_RECORDED_DRAFT','DRAFT_UNAVAILABLE'])expect(verifyOwnerLaunchMembershipDraftConfirmation({state,receipt:null})).toEqual({state,receipt:null});
  for(const value of [{state:'RECORDED_DRAFT',receipt:null},{state:'NO_RECORDED_DRAFT',receipt},{state:'DRAFT_UNAVAILABLE',receipt},{state:'ACTIVE',receipt},{state:'RECORDED_DRAFT',receipt:[receipt]},{state:'RECORDED_DRAFT',receipt,schoolId:id('3')}])expect(()=>verifyOwnerLaunchMembershipDraftConfirmation(value)).toThrow();
 });
 it('refuses every private, source or financial field, including command-only historical account metadata',()=>{
  for(const field of ['billingAccountCreated','billingAccountId','payerPersonId','participantPersonId','familyId','schoolId','organizationId','schedule','invoice','provider','payment','audit','action','policy','source','replayed'])expect(()=>verifyOwnerLaunchMembershipDraftConfirmation({state:'RECORDED_DRAFT',receipt:{...receipt,[field]:id('3')}})).toThrow();
  for(const key of Object.keys(receipt)){const value:Record<string,unknown>={...receipt};delete value[key];expect(()=>verifyOwnerLaunchMembershipDraftConfirmation({state:'RECORDED_DRAFT',receipt:value})).toThrow();}
 });
 it('rejects active/cancelled, malformed current versions, terms, currency and unsafe plan text',()=>{
  for(const patch of [{state:'ACTIVE'},{state:'CANCELLED'},{membershipVersion:0},{membershipVersion:'1'},{planCode:'<script>'},{planCode:'x\n'},{currency:'usd'},{termEndsAt:receipt.termStartedAt},{recordedAt:'not a date'}])expect(()=>verifyOwnerLaunchMembershipDraftConfirmation({state:'RECORDED_DRAFT',receipt:{...receipt,...patch}})).toThrow();
 });
});
