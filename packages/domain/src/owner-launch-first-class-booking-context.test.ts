import {describe,it,expect} from 'vitest';
import {verifyOwnerLaunchFirstClassBookingContext} from '@hon/contracts';
const id=(n:string)=>`${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
const context={registrationId:id('1'),student:{studentProfileId:id('2'),displayName:'Saved Student'},classSession:{id:id('3'),name:'First class',startsAt:'2027-01-01T10:00:00.000Z',endsAt:'2027-01-01T11:00:00.000Z',status:'SCHEDULED',capacity:10,bookingPolicy:'OPTIONAL_BOOKING'},booking:{id:id('4'),bookingKind:'REGULAR',status:'BOOKED',version:1,recordedAt:'2026-10-16T00:00:00.000Z'}};
const parse=(c:unknown=context)=>verifyOwnerLaunchFirstClassBookingContext({state:'RECORDED_BOOKING',context:c});
describe('receipt-linked first-class confirmation strict union',()=>{
 it('accepts only one bounded recorded context or null truthful no-booking/unavailable',()=>{
  expect(parse()).toEqual({state:'RECORDED_BOOKING',context});
  for(const status of ['BOOKED','WAITLISTED'])for(const sessionStatus of ['DRAFT','SCHEDULED','CANCELLED','COMPLETED'])expect(parse({...context,booking:{...context.booking,status},classSession:{...context.classSession,status:sessionStatus}})).toMatchObject({state:'RECORDED_BOOKING'});
  for(const state of ['NO_RECORDED_BOOKING','BOOKING_UNAVAILABLE']){expect(verifyOwnerLaunchFirstClassBookingContext({state,context:null})).toEqual({state,context:null});expect(()=>verifyOwnerLaunchFirstClassBookingContext({state,context})).toThrow();}
  for(const value of [{state:'RECORDED_BOOKING',context:null},{state:'BOOKED',context},{state:'RECORDED_BOOKING',context:[context]},{state:'RECORDED_BOOKING',context,schoolId:id('5')}])expect(()=>verifyOwnerLaunchFirstClassBookingContext(value)).toThrow();
 });
 it('rejects every extra or missing field at each level, including PII and unrelated authority',()=>{
  for(const field of ['organizationId','schoolId','guardian','familyId','birthDate','email','phone','attendance','membership','billing','payment','provider','eligibility','parentAccess','communication','roster','policy','action','audit','outbox']){
   expect(()=>parse({...context,[field]:id('5')})).toThrow();
   for(const part of ['student','classSession','booking'] as const)expect(()=>parse({...context,[part]:{...context[part],[field]:id('5')}})).toThrow();
  }
  for(const part of [null,'student','classSession','booking'] as const){const original=part?context[part]:context;for(const key of Object.keys(original)){const clone:Record<string,unknown>={...original};delete clone[key];expect(()=>parse(part?{...context,[part]:clone}:clone)).toThrow();}}
 });
 it('rejects unsafe names, IDs, times, capacities, kind/version and false booking/attendance success',()=>{
  for(const displayName of ['', ' ', ' Student','Student\n','<script>', 'x'.repeat(161)])expect(()=>parse({...context,student:{...context.student,displayName}})).toThrow();
  for(const patch of [{name:'<class>'},{name:''},{id:'foreign'},{capacity:0},{capacity:1.5},{capacity:'10'},{capacity:1001},{bookingPolicy:'UNKNOWN'},{status:'ACTIVE'},{endsAt:context.classSession.startsAt},{startsAt:'2027-02-30T10:00:00.000Z'},{startsAt:'2027-01-01T10:00:00+00:00'}])expect(()=>parse({...context,classSession:{...context.classSession,...patch}})).toThrow();
  for(const patch of [{id:'invalid'},{bookingKind:'CLASS_PASS'},{bookingKind:'TRIAL'},{status:'CHECKED_IN'},{status:'NO_SHOW'},{status:'PAID'},{status:'CANCELLED'},{version:0},{version:'1'},{recordedAt:'invalid'}])expect(()=>parse({...context,booking:{...context.booking,...patch}})).toThrow();
 });
});
