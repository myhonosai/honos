import { describe,it,expect } from 'vitest';
import { verifyDraftOwnerLaunchMembershipInput,verifyOwnerLaunchMembershipDraftReceipt } from '@hon/contracts';
import { assertOwnerLaunchHuman } from './owner-launch.js';
const id=(n:string)=>`${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
const input={registrationId:id('1'),expectedReceiptVersion:1 as const,planCode:'OPAQUE-code 1',termStartedAt:'2027-01-01T00:00:00.000Z',termEndsAt:'2028-01-01T00:00:00.000Z',currency:'USD'};
const receipt={registrationId:input.registrationId,membershipId:id('2'),state:'DRAFT',membershipVersion:1,planCode:input.planCode,termStartedAt:input.termStartedAt,termEndsAt:input.termEndsAt,currency:'USD',billingAccountCreated:true,recordedAt:'2026-10-16T00:00:00.000Z'};
describe('owner receipt membership draft contract',()=>{
 it('preserves opaque exact code/currency and requires both valid fixed terms without defaults',()=>{
  expect(verifyDraftOwnerLaunchMembershipInput(input)).toEqual(input);
  expect(verifyDraftOwnerLaunchMembershipInput({...input,termStartedAt:'2027-01-01T01:00:00+01:00'}).termStartedAt).toBe('2027-01-01T01:00:00+01:00');
  for(const patch of [{planCode:' x'},{planCode:''},{planCode:'x'.repeat(81)},{planCode:'x\n'},{currency:'usd'},{currency:'ZZZ'},{termStartedAt:'2027-01-01T00:00:00+23:59'},{termStartedAt:'0000-01-01T00:00:00Z'},{termEndsAt:'9999-12-31T23:59:59-14:00'},{currency:''},{termEndsAt:input.termStartedAt},{termStartedAt:'2027-02-30T00:00:00.000Z'},{termStartedAt:'2027-01-01'},{termEndsAt:'infinity'},{expectedReceiptVersion:2}])expect(()=>verifyDraftOwnerLaunchMembershipInput({...input,...patch})).toThrow();
  for(const key of Object.keys(input)){const value:Record<string,unknown>={...input};delete value[key];expect(()=>verifyDraftOwnerLaunchMembershipInput(value)).toThrow();}
 });
 it('rejects every authority, financial, scheduling and identity selector',()=>{
  for(const key of ['personId','payerPersonId','participantPersonId','billingAccountId','familyId','programId','classSessionId','schoolId','price','discount','paymentSchedule','paymentMethod','processor','activation','invoice','autoRenew','tier'])expect(()=>verifyDraftOwnerLaunchMembershipInput({...input,[key]:id('3')})).toThrow();
 });
 it('accepts only the exact redacted DRAFT declaration receipt, never payment or activation success',()=>{
  expect(verifyOwnerLaunchMembershipDraftReceipt(receipt,input)).toEqual(receipt);
  for(const patch of [{payerPersonId:id('3')},{participantPersonId:id('3')},{billingAccountId:id('3')},{state:'ACTIVE'},{currency:'CAD'},{planCode:'OTHER'},{registrationId:id('3')},{termEndsAt:'2029-01-01T00:00:00.000Z'},{billingAccountCreated:'true'},{paymentScheduleId:id('3')},{paymentOutcome:'SUCCEEDED'},{invoiceId:id('3')}])expect(()=>verifyOwnerLaunchMembershipDraftReceipt({...receipt,...patch},input)).toThrow();
 });
 it('retains direct-human, nondelegated and no-action domain authority',()=>{
  const c={organizationId:id('1'),schoolId:id('2'),principalId:id('3'),externalSubject:'verified',principalType:'HUMAN_USER' as const,source:'HUMAN_UI' as const,requestId:id('4'),correlationId:id('4'),idempotencyKey:id('5')};expect(()=>assertOwnerLaunchHuman(c)).not.toThrow();
  for(const patch of [{principalType:'AI_EMPLOYEE' as const},{source:'AI' as const},{delegatedByPrincipalId:id('6')},{actionRequestId:id('6')},{externalSubject:''}])expect(()=>assertOwnerLaunchHuman({...c,...patch})).toThrow();
 });
});
