import { describe, expect, it } from 'vitest';
import { CLASS_BOOKING_KINDS } from '@hon/contracts';
import { validateClassPassInput } from '../src/classpass.js';
const id='10000000-0000-4000-8000-000000000001';
describe('ClassPass exact nonfinancial domain input',()=>{
 it('accepts the operational product, issuance, admission and reversal shapes',()=>{
  for(const [action,input] of [
   ['CONFIGURE_PRODUCT',{expectedVersion:0,programId:id,name:'Allowance',allowedUses:2,validityDays:30,reason:'Operational grant'}],
   ['ISSUE',{expectedVersion:1,studentProfileId:id,issuanceKind:'MANUAL_NONFINANCIAL',reason:'Staff grant'}],
   ['ADMIT',{expectedVersion:1,passId:id}],
   ['RETIRE_PRODUCT',{expectedVersion:1,reason:'Retire'}],
   ['REVERSE_ISSUANCE',{expectedVersion:1,reason:'Correction'}],
   ['REVERSE_REDEMPTION',{expectedVersion:2,passId:id,reason:'Correction'}],
  ] as const)expect(()=>validateClassPassInput(action,id,input)).not.toThrow();
 });
 it('rejects provider/payment fields, caller-selected booking outcome, bad versions and malformed IDs',()=>{
  const base={expectedVersion:1,passId:id};
  for(const extra of [{amount:1},{currency:'USD'},{paymentProviderOutcome:'SUCCEEDED'},{bookingKind:'REGULAR'},{studentProfileId:id},{status:'BOOKED'}])expect(()=>validateClassPassInput('ADMIT',id,{...base,...extra})).toThrow();
  for(const expectedVersion of [0,-1,1.2,2147483647,'1',null])expect(()=>validateClassPassInput('ADMIT',id,{...base,expectedVersion})).toThrow();
  expect(()=>validateClassPassInput('ADMIT','not-uuid',base)).toThrow();
  expect(()=>validateClassPassInput('ISSUE',id,{expectedVersion:1,studentProfileId:id,issuanceKind:'PAYMENT_BACKED',reason:'Purchase'})).toThrow();
 });
 it('does not enable CLASS_PASS in the generic staff booking command',()=>{
  expect(CLASS_BOOKING_KINDS).not.toContain('CLASS_PASS');
 });
});
