import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { BillingRenewalsWorkbench } from '../src/components/billing-renewals-workbench';
import { mutateRenewal, loadRenewals, readRenewal, readRenewalMembership, loadRenewalHistory } from '../src/components/billing-renewals-http';
const id='11111111-1111-4111-8111-111111111111',school='22222222-2222-4222-8222-222222222222',principal='33333333-3333-4333-8333-333333333333',membership='44444444-4444-4444-8444-444444444444',schedule='55555555-5555-4555-8555-555555555555';
const body={expectedVersion:0,membershipId:membership,reviewFrom:'2027-01-01T00:00:00.000Z',reviewTo:'2027-02-01T00:00:00.000Z',status:'OPEN' as const,note:'Private human review note',reason:'Explicit human review reason',reminderNeeded:null};
const facts={membershipId:membership,membershipVersion:2,state:'ACTIVE',termStartedAt:'2026-01-01T00:00:00.000Z',termEndsAt:'2027-01-01T00:00:00.000Z',scheduleCount:1,schedulesTruncated:false,schedules:[{scheduleId:schedule,frequency:'MONTHLY',status:'ACTIVE',amountMinor:12000,currency:'USD',nextChargeAt:'2027-01-01T00:00:00.000Z',autoRenew:true}]};
const saved={renewalId:id,schoolId:school,membershipId:membership,reviewFrom:body.reviewFrom,reviewTo:body.reviewTo,status:'OPEN',note:body.note,reason:body.reason,reminderNeeded:null,version:1,recordedAt:'2026-10-15T00:00:00.000Z',membershipFacts:facts,humanOnly:true,executionAllowed:false};
const item={renewalId:id,membershipId:membership,reviewFrom:body.reviewFrom,reviewTo:body.reviewTo,reminderNeeded:null,version:1,status:'OPEN'};
const queue={schoolId:school,principalId:principal,humanOnly:true,executionAllowed:false,status:'OPEN',items:[item],nextAfter:null};
const response=(data:unknown)=>({ok:true,json:async()=>({data})}) as Response;
describe('human membership renewal review workbench',()=>{
 it('starts honest and empty with no fetches, fake writes or billing execution UI',()=>{
  const f=vi.spyOn(globalThis,'fetch');try{const html=renderToStaticMarkup(<BillingRenewalsWorkbench/>);expect(f).not.toHaveBeenCalled();for(const text of ['Membership renewal reviews','No collection','No notices','No automatic renewal','Essential','billing.renewal.manage','billing.membership.read','No payer directory','Load / refresh reviews'])expect(html.toLowerCase()).toContain(text.toLowerCase());expect(html).not.toContain('Private human review note');expect(html).not.toContain('Create renewal review record');expect(html).not.toContain('type="email"');}finally{f.mockRestore();}
 });
 it('uses closed same-origin human requests and verifies exact saved fields/version/state',async()=>{
  const f=vi.spyOn(globalThis,'fetch').mockResolvedValue(response(saved));try{
   expect(await mutateRenewal('CREATE',null,body,'retained-key')).toEqual(saved);expect(f).toHaveBeenCalledWith('/api/v1/staff/billing/renewals',expect.objectContaining({credentials:'same-origin',cache:'no-store',headers:expect.objectContaining({'X-HON-Human-Command':'billing-renewals','Idempotency-Key':'retained-key'})}));
   for(const bad of ['https://evil.test','../renewals',id+'?schoolId='+school]){const n=f.mock.calls.length;await expect(readRenewal(bad)).rejects.toThrow();await expect(readRenewalMembership(bad)).rejects.toThrow();await expect(mutateRenewal('REVISE',bad,{...body,expectedVersion:1},'key')).rejects.toThrow();expect(f.mock.calls.length).toBe(n);}
   for(const patch of [{version:2},{humanOnly:false},{executionAllowed:true},{note:'Other'},{reason:'Other'},{membershipId:id},{status:'REVIEWED'},{reviewTo:'2027-03-01T00:00:00.000Z'},{payerId:id},{providerToken:'secret'},{membershipFacts:{...facts,billingAccountId:id}}]){f.mockResolvedValue(response({...saved,...patch}));await expect(mutateRenewal('CREATE',null,body,'key')).rejects.toThrow();}
   f.mockResolvedValue(response({...saved,version:2,status:'DEFERRED'}));expect((await mutateRenewal('REVISE',id,{...body,expectedVersion:1,status:'DEFERRED'},'retained-key')).status).toBe('DEFERRED');expect(f).toHaveBeenLastCalledWith(`/api/v1/staff/billing/renewals/${id}/revisions`,expect.objectContaining({headers:expect.objectContaining({'Idempotency-Key':'retained-key'})}));
  }finally{f.mockRestore();}
 });
 it('rejects private queue projections, duplicates, unbounded pages, unsafe status and pagination',async()=>{
  const f=vi.spyOn(globalThis,'fetch').mockResolvedValue(response(queue));try{
   expect((await loadRenewals('OPEN')).items).toEqual([item]);
   for(const patch of [{items:[{...item,note:'PRIVATE_NOTE'}]},{items:[{...item,email:'PRIVATE_CONTACT'}]},{items:[{...item,reason:'PRIVATE_REASON'}]},{items:[item,item]},{items:Array.from({length:51},()=>item)},{nextAfter:id},{status:'CLOSED'},{schoolId:'bad'},{executionAllowed:true},{items:[{...item,reviewTo:item.reviewFrom}]},{items:[{...item,reminderNeeded:'yes'}]}]){f.mockResolvedValue(response({...queue,...patch}));await expect(loadRenewals('OPEN')).rejects.toThrow();}
   f.mockResolvedValue({ok:false,status:403,json:async()=>({detail:'PRIVATE_DIRECTORY'})}as Response);await expect(loadRenewals('OPEN')).rejects.toThrow('Current exact school');
  }finally{f.mockRestore();}
 });
 it('reads known memberships only and rejects raw provider/payment-method/payer fields and forged facts',async()=>{
  const f=vi.spyOn(globalThis,'fetch').mockResolvedValue(response(facts));try{
   expect(await readRenewalMembership(membership)).toEqual(facts);expect(f).toHaveBeenLastCalledWith(`/api/v1/staff/billing/renewals/memberships/${membership}`,expect.objectContaining({method:'GET',credentials:'same-origin'}));
   for(const patch of [{membershipId:id},{providerToken:'secret'},{paymentMethod:'secret'},{payerId:id},{scheduleCount:2},{schedulesTruncated:true},{schedules:[{...facts.schedules[0],providerToken:'secret'}]},{schedules:[{...facts.schedules[0],amountMinor:-1}]},{schedules:[{...facts.schedules[0],autoRenew:'yes'}]},{schedules:[{...facts.schedules[0],currency:'US$'}]},{termEndsAt:'infinity'},{state:'RENEWED'}]){f.mockResolvedValue(response({...facts,...patch}));await expect(readRenewalMembership(membership)).rejects.toThrow();}
  }finally{f.mockRestore();}
 });
 it('separates saved vs current facts, exact historical detail and bounded metadata history',async()=>{
  const f=vi.spyOn(globalThis,'fetch').mockResolvedValue(response({record:saved,currentMembershipFacts:{...facts,membershipVersion:3}}));try{
   expect((await readRenewal(id,1)).record).toEqual(saved);expect(f).toHaveBeenLastCalledWith(`/api/v1/staff/billing/renewals/${id}?version=1`,expect.anything());
   f.mockResolvedValue(response({record:{...saved,version:2},currentMembershipFacts:facts}));await expect(readRenewal(id,1)).rejects.toThrow();
   f.mockResolvedValue(response({record:saved,currentMembershipFacts:{...facts,membershipId:id}}));await expect(readRenewal(id)).rejects.toThrow();
   const h={schoolId:school,renewalId:id,humanOnly:true,executionAllowed:false,items:[{...item,recordedAt:saved.recordedAt}],nextBefore:null};f.mockResolvedValue(response(h));expect((await loadRenewalHistory(id)).items).toHaveLength(1);
   for(const patch of [{items:[{...h.items[0],note:'PRIVATE_NOTE'}]},{items:[h.items[0],h.items[0]]},{nextBefore:1},{items:[{...h.items[0],renewalId:membership}]},{items:Array.from({length:51},()=>h.items[0])}]){f.mockResolvedValue(response({...h,...patch}));await expect(loadRenewalHistory(id)).rejects.toThrow();}
   for(const bad of [0,-1,1.5,1000000000]){const n=f.mock.calls.length;await expect(readRenewal(id,bad)).rejects.toThrow();await expect(loadRenewalHistory(id,bad)).rejects.toThrow();expect(f.mock.calls.length).toBe(n);}
  }finally{f.mockRestore();}
 });
 it('retains uncertain requests in memory, clears sensitive state and requires reload before another mutation',()=>{
  const source=readFileSync('src/components/billing-renewals-workbench.tsx','utf8');for(const text of ['Retry exact retained request','retry.current','No save is assumed','needsRefresh','Reload current detail','setContext(null)','New renewal review','No reviews on this page','readOnly','Read known membership summary','Historical saved revision','Manual reminder-needed fact'])expect(source.toLowerCase()).toContain(text.toLowerCase());expect(source).not.toMatch(/localStorage|sessionStorage|setInterval|setTimeout|invokeLLM|sendMessage|executeAction|type="email"/);
  const manifest=JSON.parse(readFileSync('public/manus-routes.json','utf8'));expect(manifest.routes.filter((r:{path:string})=>r.path==='/staff/billing/renewals')).toHaveLength(1);
 });
});
