import React from 'react';
import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
import {readFileSync} from 'node:fs';
const hooks=vi.hoisted(()=>({cells:[] as unknown[],cursor:0,mounted:false,events:{} as Record<string,()=>void>}));
// Deterministic local hook harness: exercise actual component handlers/state,
// generation cancellation and rendered JSX without DOM or transport dependencies.
vi.mock('react',async()=>{
 const actual=await vi.importActual<typeof import('react')>('react');
 return {...actual,useState:(initial:unknown)=>{const index=hooks.cursor++;if(index>=hooks.cells.length)hooks.cells[index]=initial;return [hooks.cells[index],(value:unknown)=>{hooks.cells[index]=typeof value==='function'?(value as (v:unknown)=>unknown)(hooks.cells[index]):value;}];},useRef:(initial:unknown)=>{const index=hooks.cursor++;if(index>=hooks.cells.length)hooks.cells[index]={current:initial};return hooks.cells[index];},useEffect:(effect:()=>unknown)=>{if(!hooks.mounted){hooks.mounted=true;effect();}}};
});
import {OwnerLaunch} from '../src/components/owner-launch';
import {loadOwnerLaunchMembershipDraft,loadOwnerLaunchWithDraft} from '../src/components/owner-launch-http';
const id=(n:string)=>`${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
const registration={registrationId:id('5'),studentProfileId:id('6'),enrollmentId:id('7'),programId:id('3'),classSessionId:id('4'),status:'REGISTERED_NO_BOOKING',createdAt:'2026-10-16T00:00:00.000Z'};
const context={organizationId:id('1'),schoolId:id('2'),schoolName:'Local school',tier:'ESSENTIAL',program:{id:id('3'),version:1,status:'DRAFT'},classSession:{id:id('4'),programId:id('3'),version:1,status:'SCHEDULED'},registration,guardianChildRegistration:null};
const receipt={registrationId:registration.registrationId,membershipId:id('8'),state:'DRAFT',membershipVersion:1,planCode:'OPAQUE-CONFIRMED',termStartedAt:'2027-01-01T00:00:00.000Z',termEndsAt:'2028-01-01T00:00:00.000Z',currency:'USD',recordedAt:'2026-10-16T00:00:00.000Z'};
const confirmation={state:'RECORDED_DRAFT',receipt};
const response=(data:unknown)=>({ok:true,status:200,json:async()=>({data})}) as Response;
function elements(node:unknown):React.ReactElement<Record<string,unknown>>[]{if(Array.isArray(node))return node.flatMap(elements);if(!React.isValidElement<Record<string,unknown>>(node))return [];return [node,...elements(node.props.children)];}
function text(node:unknown):string{if(Array.isArray(node))return node.map(text).join(' ');if(React.isValidElement<Record<string,unknown>>(node))return text(node.props.children);return typeof node==='string'||typeof node==='number'?String(node):'';}
function render(){hooks.cursor=0;return OwnerLaunch();}
function refresh(){const button=elements(render()).find(e=>e.type==='button'&&text(e).includes('Load / refresh'));expect(button).toBeDefined();(button!.props.onClick as ()=>void)();}
function transport(){return vi.spyOn(globalThis,'fetch').mockImplementation(async path=>response(path==='/api/v1/owner-launch'?context:confirmation));}
beforeEach(()=>{hooks.cells=[];hooks.cursor=0;hooks.mounted=false;hooks.events={};const add=(name:string,fn:()=>void)=>{hooks.events[name]=fn;};vi.stubGlobal('window',{addEventListener:add,removeEventListener:()=>{}});vi.stubGlobal('document',{addEventListener:add,removeEventListener:()=>{}});});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});
describe('owner launch current DRAFT confirmation UI',()=>{
 it('uses one fixed same-origin no-store GET with no IDs/body/command marker and strict redaction',async()=>{
  const fetch=vi.spyOn(globalThis,'fetch').mockResolvedValue(response(confirmation));expect(await loadOwnerLaunchMembershipDraft()).toEqual(confirmation);
  expect(fetch.mock.calls[0]![0]).toBe('/api/v1/owner-launch/membership-draft');expect(fetch.mock.calls[0]![1]).toEqual({method:'GET',headers:{Accept:'application/json'},credentials:'same-origin',cache:'no-store',referrerPolicy:'no-referrer'});
  for(const field of ['billingAccountCreated','billingAccountId','payerPersonId','participantPersonId','schedule','invoice','provider','policy','source']){fetch.mockResolvedValue(response({state:'RECORDED_DRAFT',receipt:{...receipt,[field]:id('9')}}));await expect(loadOwnerLaunchMembershipDraft()).rejects.toThrow('Unverified DRAFT');}
  for(const state of ['ACTIVE','CANCELLED']){fetch.mockResolvedValue(response({state:'RECORDED_DRAFT',receipt:{...receipt,state}}));await expect(loadOwnerLaunchMembershipDraft()).rejects.toThrow();}
 });
 it('joins independent launch reads only by exact saved adult/child receipt and rejects foreign drift',async()=>{
  const fetch=transport();expect(await loadOwnerLaunchWithDraft()).toEqual({context,confirmation});
  const childContext={...context,registration:null,guardianChildRegistration:{...registration,familyId:id('9'),registrationKind:'NEW_CHILD_WITH_NEW_GUARDIAN'}};
  fetch.mockImplementation(async path=>response(path==='/api/v1/owner-launch'?childContext:confirmation));expect((await loadOwnerLaunchWithDraft()).confirmation).toEqual(confirmation);
  fetch.mockImplementation(async path=>response(path==='/api/v1/owner-launch'?context:{...confirmation,receipt:{...receipt,registrationId:id('a')}}));await expect(loadOwnerLaunchWithDraft()).rejects.toThrow('context changed');
 });
 it('renders one DRAFT saved configuration after reload and provides no activation/cancel link or button',async()=>{
  const fetch=transport();expect(text(render())).not.toContain(receipt.membershipId);refresh();await vi.waitFor(()=>expect(text(render())).toContain(receipt.membershipId));
  const tree=render(),copy=text(tree);expect(copy).toContain('DRAFT only — saved membership configuration, NOT active');expect(copy).toContain('not a financial agreement, signature or consent');expect(copy).toContain('No payment, invoice, schedule, communication, attendance or parent login');
  expect(elements(tree).filter(e=>e.type==='button').map(text).join(' ')).not.toMatch(/activate|cancel/i);expect(elements(tree).filter(e=>e.props.href).map(e=>e.props.href)).not.toContain('/staff/billing');expect(copy).not.toContain('Save membership DRAFT only');expect(copy).not.toContain('account created');expect(fetch).toHaveBeenCalledTimes(2);
  refresh();await vi.waitFor(()=>expect(text(render())).toContain(receipt.membershipId));expect(fetch).toHaveBeenCalledTimes(4);
 });
 it('shows truthful NO_RECORDED_DRAFT or bounded unavailable without fake receipt or mutation button on drift',async()=>{
  const fetch=vi.spyOn(globalThis,'fetch').mockImplementation(async path=>response(path==='/api/v1/owner-launch'?context:{state:'NO_RECORDED_DRAFT',receipt:null}));
  refresh();await vi.waitFor(()=>expect(text(render())).toContain('NO_RECORDED_DRAFT'));expect(text(render())).not.toContain(receipt.membershipId);expect(text(render())).toContain('Save membership DRAFT only');
  fetch.mockImplementation(async path=>response(path==='/api/v1/owner-launch'?context:{state:'DRAFT_UNAVAILABLE',receipt:null}));refresh();await vi.waitFor(()=>expect(text(render())).toContain('Current DRAFT confirmation unavailable — needs staff review'));expect(text(render())).not.toContain('Save membership DRAFT only');expect(text(render())).not.toContain(receipt.membershipId);
 });
 it('clears stale content immediately on reload/access denial and ignores late results after focus invalidation',async()=>{
  const fetch=transport();refresh();await vi.waitFor(()=>expect(text(render())).toContain(receipt.membershipId));
  let finish!:(value:Response)=>void;fetch.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));refresh();expect(text(render())).not.toContain(receipt.membershipId);hooks.events.focus!();finish(response(context));await vi.waitFor(()=>expect(text(render())).toContain('School state may have changed'));expect(text(render())).not.toContain(receipt.membershipId);
  fetch.mockImplementation(async path=>path==='/api/v1/owner-launch'?response(context):({ok:false,status:403}) as Response);refresh();await vi.waitFor(()=>expect(text(render())).toContain('Saved DRAFT context was cleared'));expect(text(render())).not.toContain(receipt.membershipId);expect(text(render())).not.toContain('Local school');
  for(const status of [401,403,404,503]){fetch.mockResolvedValue({ok:false,status} as Response);await expect(loadOwnerLaunchMembershipDraft()).rejects.toMatchObject({status});}
 });
 it('retains existing route/manifest and no browser storage or activation transport',()=>{
  const source=readFileSync('src/components/owner-launch.tsx','utf8')+readFileSync('src/components/owner-launch-http.ts','utf8');expect(source).toContain('generation.current');expect(source).toContain('loadOwnerLaunchWithDraft');const dashboard=readFileSync('src/components/staff-dashboard.tsx','utf8');expect(dashboard).toContain('Owner-launch membership confirmation is DRAFT only: saved configuration, NOT active.');expect(dashboard).not.toMatch(/href=[^\n]*(?:activate|cancel)/);expect(source).not.toMatch(/localStorage|sessionStorage|href=[^\n]*(?:activate|cancel|billing)|invokeLLM|providerClient/);
 });
});
