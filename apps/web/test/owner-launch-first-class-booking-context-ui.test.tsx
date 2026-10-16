import React from 'react';
import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
import {readFileSync} from 'node:fs';
const hooks=vi.hoisted(()=>({cells:[] as unknown[],cursor:0,mounted:false,events:{} as Record<string,()=>void>}));
vi.mock('react',async()=>{
 const actual=await vi.importActual<typeof import('react')>('react');
 return {...actual,useState:(initial:unknown)=>{const index=hooks.cursor++;if(index>=hooks.cells.length)hooks.cells[index]=initial;return [hooks.cells[index],(value:unknown)=>{hooks.cells[index]=typeof value==='function'?(value as (v:unknown)=>unknown)(hooks.cells[index]):value;}];},useRef:(initial:unknown)=>{const index=hooks.cursor++;if(index>=hooks.cells.length)hooks.cells[index]={current:initial};return hooks.cells[index];},useEffect:(effect:()=>unknown)=>{if(!hooks.mounted){hooks.mounted=true;effect();}}};
});
import {OwnerLaunch} from '../src/components/owner-launch';
import {loadOwnerLaunchFirstClassBookingContext,loadOwnerLaunchWithConfirmations} from '../src/components/owner-launch-http';
const id=(n:string)=>`${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
const registration={registrationId:id('5'),studentProfileId:id('6'),enrollmentId:id('7'),programId:id('3'),classSessionId:id('4'),status:'REGISTERED_NO_BOOKING',createdAt:'2026-10-16T00:00:00.000Z'};
const launch={organizationId:id('1'),schoolId:id('2'),schoolName:'Local school',tier:'ESSENTIAL',program:{id:id('3'),version:1,status:'DRAFT'},classSession:{id:id('4'),programId:id('3'),version:1,status:'SCHEDULED'},registration,guardianChildRegistration:null};
const context={registrationId:registration.registrationId,student:{studentProfileId:registration.studentProfileId,displayName:'Readable Saved Student'},classSession:{id:registration.classSessionId,name:'Actual First Class',startsAt:'2027-01-01T10:00:00.000Z',endsAt:'2027-01-01T11:00:00.000Z',status:'SCHEDULED',capacity:1,bookingPolicy:'OPTIONAL_BOOKING'},booking:{id:id('8'),bookingKind:'REGULAR',status:'BOOKED',version:1,recordedAt:'2026-10-16T00:00:00.000Z'}};
const confirmation={state:'RECORDED_BOOKING',context},empty={state:'NO_RECORDED_BOOKING',context:null};
const draft={state:'NO_RECORDED_DRAFT',receipt:null};
const receipt={registrationId:registration.registrationId,bookingId:context.booking.id,classSessionId:context.classSession.id,status:'BOOKED',bookingVersion:1,recordedAt:context.booking.recordedAt};
const response=(data:unknown)=>({ok:true,status:200,json:async()=>({data})}) as Response;
function elements(node:unknown):React.ReactElement<Record<string,unknown>>[]{if(Array.isArray(node))return node.flatMap(elements);if(!React.isValidElement<Record<string,unknown>>(node))return [];return [node,...elements(node.props.children)];}
function text(node:unknown):string{if(Array.isArray(node))return node.map(text).join(' ');if(React.isValidElement<Record<string,unknown>>(node))return text(node.props.children);return typeof node==='string'||typeof node==='number'?String(node):'';}
function render(){hooks.cursor=0;return OwnerLaunch();}
function click(label:string){const button=elements(render()).find(e=>e.type==='button'&&text(e).includes(label));expect(button).toBeDefined();(button!.props.onClick as ()=>void)();}
function transport(value:unknown=confirmation,owner:unknown=launch){return vi.spyOn(globalThis,'fetch').mockImplementation(async path=>response(path==='/api/v1/owner-launch'?owner:path==='/api/v1/owner-launch/membership-draft'?draft:value));}
beforeEach(()=>{hooks.cells=[];hooks.cursor=0;hooks.mounted=false;hooks.events={};const add=(name:string,fn:()=>void)=>{hooks.events[name]=fn;};vi.stubGlobal('window',{addEventListener:add,removeEventListener:()=>{}});vi.stubGlobal('document',{addEventListener:add,removeEventListener:()=>{}});});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});
describe('owner receipt-linked first-class booking confirmation',()=>{
 it('uses one exact same-origin no-store GET with no input or marker and strict envelope/PII redaction',async()=>{
  const fetch=vi.spyOn(globalThis,'fetch').mockResolvedValue(response(confirmation));expect(await loadOwnerLaunchFirstClassBookingContext()).toEqual(confirmation);
  expect(fetch.mock.calls[0]).toEqual(['/api/v1/owner-launch/first-class-booking-context',{method:'GET',headers:{Accept:'application/json'},credentials:'same-origin',cache:'no-store',referrerPolicy:'no-referrer'}]);
  for(const field of ['guardian','familyId','birthDate','phone','email','roster','attendance','membership','billing','payment','provider','eligibility','parentAccess','communication']){fetch.mockResolvedValue(response({state:'RECORDED_BOOKING',context:{...context,[field]:id('9')}}));await expect(loadOwnerLaunchFirstClassBookingContext()).rejects.toThrow('Unverified booking');}
  fetch.mockResolvedValue({ok:true,status:200,json:async()=>({data:confirmation,meta:{}})} as Response);await expect(loadOwnerLaunchFirstClassBookingContext()).rejects.toThrow();
 });
 it('binds adult/child confirmations to saved registration, student and exact class; foreign/mismatched context is rejected',async()=>{
  const fetch=transport();expect((await loadOwnerLaunchWithConfirmations()).bookingConfirmation).toEqual(confirmation);
  fetch.mockImplementation(async path=>response(path==='/api/v1/owner-launch'?{...launch,registration:null,guardianChildRegistration:{...registration,familyId:id('9'),registrationKind:'NEW_CHILD_WITH_NEW_GUARDIAN'}}:path==='/api/v1/owner-launch/membership-draft'?draft:confirmation));expect((await loadOwnerLaunchWithConfirmations()).bookingConfirmation).toEqual(confirmation);
  for(const patch of [{registrationId:id('a')},{student:{...context.student,studentProfileId:id('a')}},{classSession:{...context.classSession,id:id('a')}}]){fetch.mockImplementation(async path=>response(path==='/api/v1/owner-launch'?launch:path==='/api/v1/owner-launch/membership-draft'?draft:{state:'RECORDED_BOOKING',context:{...context,...patch}}));await expect(loadOwnerLaunchWithConfirmations()).rejects.toThrow('context changed');}
 });
 it('renders the actual saved student and class/booking card after reload, not a roster or status inferred from registration',async()=>{
  const fetch=transport();expect(text(render())).not.toContain(context.student.displayName);click('Load / refresh');await vi.waitFor(()=>expect(text(render())).toContain(context.student.displayName));
  const tree=render(),copy=text(tree);for(const value of [context.classSession.name,context.classSession.startsAt,context.classSession.endsAt,'SCHEDULED','BOOKED','REGULAR','Capacity:','OPTIONAL_BOOKING',context.booking.id,context.booking.recordedAt])expect(copy).toContain(value);
  expect(copy).toContain('Booking is not attendance, membership, payment, eligibility, parent access or communication.');expect(elements(tree).filter(e=>e.type==='button').map(text)).not.toContain('Book first class');expect(elements(tree).filter(e=>e.type==='input').map(e=>e.props.placeholder)).not.toContain('Search');expect(fetch).toHaveBeenCalledTimes(3);
  click('Load / refresh');expect(text(render())).not.toContain(context.student.displayName);await vi.waitFor(()=>expect(text(render())).toContain(context.student.displayName));
 });
 it('shows WAITLISTED for a child and the actual CANCELLED class without implying a seat, parent access or attendance',async()=>{
  const child={...launch,registration:null,guardianChildRegistration:{...registration,familyId:id('9'),registrationKind:'NEW_CHILD_WITH_NEW_GUARDIAN'}};
  transport({state:'RECORDED_BOOKING',context:{...context,student:{...context.student,displayName:'Readable Child'},booking:{...context.booking,status:'WAITLISTED'},classSession:{...context.classSession,status:'CANCELLED'}}},child);
  click('Load / refresh');await vi.waitFor(()=>expect(text(render())).toContain('Readable Child'));const copy=text(render());expect(copy).toContain('WAITLISTED');expect(copy).toContain('class status:  CANCELLED');expect(copy).toContain('Class cancelled. The saved booking is not a seat or attendance claim.');expect(copy).not.toContain('PII_CANARY_GUARDIAN');
 });
 it('after booking/replay displays only fresh GET confirmation, never the POST or local entered name',async()=>{
  let current:unknown=empty;const fetch=vi.spyOn(globalThis,'fetch').mockImplementation(async path=>{
   if(path==='/api/v1/owner-launch/first-class-booking'){current=confirmation;return response(receipt);}
   return response(path==='/api/v1/owner-launch'?launch:path==='/api/v1/owner-launch/membership-draft'?draft:current);
  });
  click('Load / refresh');await vi.waitFor(()=>expect(text(render())).toContain('NO_RECORDED_BOOKING'));click('Book first class');await vi.waitFor(()=>expect(text(render())).toContain(context.student.displayName));
  expect(fetch.mock.calls.map(c=>c[0])).toEqual(['/api/v1/owner-launch','/api/v1/owner-launch/membership-draft','/api/v1/owner-launch/first-class-booking-context','/api/v1/owner-launch/first-class-booking','/api/v1/owner-launch','/api/v1/owner-launch/membership-draft','/api/v1/owner-launch/first-class-booking-context']);
  const post=fetch.mock.calls.find(c=>c[0]==='/api/v1/owner-launch/first-class-booking')!;expect(JSON.parse(post[1]!.body as string)).toEqual({registrationId:registration.registrationId,expectedReceiptVersion:1,expectedClassSessionVersion:1});
 });
 it('clears on error/reload/context mismatch and discards late reads after focus or visibility invalidation',async()=>{
  const fetch=transport();click('Load / refresh');await vi.waitFor(()=>expect(text(render())).toContain(context.student.displayName));
  let finish!:(value:Response)=>void;fetch.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));click('Load / refresh');expect(text(render())).not.toContain(context.student.displayName);hooks.events.focus!();finish(response(launch));await vi.waitFor(()=>expect(text(render())).toContain('School state may have changed'));expect(text(render())).not.toContain(context.student.displayName);
  for(const status of [401,403,404,503]){fetch.mockImplementation(async path=>path==='/api/v1/owner-launch'?response(launch):path==='/api/v1/owner-launch/membership-draft'?response(draft):({ok:false,status}) as Response);click('Load / refresh');await vi.waitFor(()=>expect(text(render())).not.toContain('Verifying…'));expect(text(render())).not.toContain(context.student.displayName);expect(text(render())).not.toContain('Actual First Class');}
  fetch.mockImplementation(async path=>response(path==='/api/v1/owner-launch'?launch:path==='/api/v1/owner-launch/membership-draft'?draft:{state:'RECORDED_BOOKING',context:{...context,registrationId:id('a')}}));click('Load / refresh');await vi.waitFor(()=>expect(text(render())).toContain('context changed'));expect(text(render())).not.toContain(context.student.displayName);
 });
 it('shows bounded unavailable without booking action; no storage/search/selector/provider/attendance transport is added',async()=>{
  transport({state:'BOOKING_UNAVAILABLE',context:null});click('Load / refresh');await vi.waitFor(()=>expect(text(render())).toContain('BOOKING_UNAVAILABLE'));expect(text(render())).not.toContain(context.student.displayName);expect(elements(render()).filter(e=>e.type==='button').map(text)).not.toContain('Book first class');
  const source=readFileSync('src/components/owner-launch.tsx','utf8')+readFileSync('src/components/owner-launch-http.ts','utf8');expect(source).toContain('only the selector-free current GET');expect(source).not.toMatch(/localStorage|sessionStorage|invokeLLM|executeAction|providerClient|sendMessage/);
 });
});
