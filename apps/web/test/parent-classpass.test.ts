import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { verifyParentClassPassView } from '@hon/contracts';
import { loadParentClassPass } from '../src/components/parent-classpass-http';
import { ParentClassPass } from '../src/components/parent-classpass';
const id='10000000-0000-4000-8000-000000000001';
const booking={startsAt:'2026-10-01T01:00:00.000Z',bookingStatus:'BOOKED',redemptionOutcome:'REDEEMED',attendanceState:'NOT_RECORDED'};
const pass={productDisplayName:'Operational allowance',remainingUses:1,expiresAt:'2026-11-01T00:00:00.000Z',status:'ACTIVE',bookings:{items:[booking],limited:false}};
const child={displayName:'Authorized child',passes:{items:[pass],limited:false}};
const view={generatedAt:'2026-10-01T00:00:00.000Z',accessLevel:'PRIMARY_GUARDIAN',paymentProviderOutcome:'UNAVAILABLE',children:{items:[child],limited:false}};
const envelope={data:view,meta:{requestId:id,correlationId:id}};
afterEach(()=>vi.unstubAllGlobals());
describe('parent ClassPass safe projection and UI',()=>{
 it('accepts only minimal fields and bounded lists with unknown financial outcome',()=>{
  expect(verifyParentClassPassView(view)).toEqual(view);
  for(const patch of[{familyId:id},{schoolId:id},{paymentProviderOutcome:'SUCCEEDED'},{accessLevel:'VIEWER'}])expect(()=>verifyParentClassPassView({...view,...patch})).toThrow();
  for(const patch of[{id},{staff:[]},{studentProfileId:id}])expect(()=>verifyParentClassPassView({...view,children:{...view.children,items:[{...child,...patch}]}})).toThrow();
  for(const patch of[{productId:id},{amount:1},{ledger:[]},{remainingUses:-1},{status:'ACTIVE',remainingUses:0},{status:'EXHAUSTED',remainingUses:1}])expect(()=>verifyParentClassPassView({...view,children:{...view.children,items:[{...child,passes:{items:[{...pass,...patch}],limited:false}}]}})).toThrow();
  expect(()=>verifyParentClassPassView({...view,children:{items:Array(21).fill(child),limited:true}})).toThrow();
  expect(()=>verifyParentClassPassView({...view,children:{items:[{...child,passes:{items:Array(21).fill(pass),limited:true}}],limited:false}})).toThrow();
  expect(()=>verifyParentClassPassView({...view,children:{items:[{...child,passes:{items:[{...pass,bookings:{items:Array(11).fill(booking),limited:true}}],limited:false}}],limited:false}})).toThrow();
 });
 it('makes one fixed relative same-origin read with no selectors or command headers',async()=>{
  const mock=vi.fn(async()=>new Response(JSON.stringify(envelope),{headers:{'content-type':'application/json'}}));vi.stubGlobal('fetch',mock);
  const abort=new AbortController();expect(await loadParentClassPass(abort.signal)).toEqual(view);
  expect(mock.mock.calls[0]).toEqual(['/api/v1/parent/classpass',{method:'GET',credentials:'same-origin',mode:'same-origin',redirect:'error',cache:'no-store',referrerPolicy:'no-referrer',headers:{Accept:'application/json'},signal:abort.signal}]);
 });
 it('fails closed for auth/ambiguity/error and malformed envelopes',async()=>{
  for(const status of[401,403,409,503]){vi.stubGlobal('fetch',async()=>new Response('',{status}));await expect(loadParentClassPass()).rejects.toThrow();}
  for(const data of[{...envelope,extra:1},{...envelope,meta:{...envelope.meta,schoolId:id}},{...envelope,data:{...view,paymentProviderOutcome:'SUCCEEDED'}}]){vi.stubGlobal('fetch',async()=>new Response(JSON.stringify(data),{headers:{'content-type':'application/json'}}));await expect(loadParentClassPass()).rejects.toThrow();}
 });
 it('renders a read-only parent surface and clears old content on refresh, blur and access loss',()=>{
  const html=renderToStaticMarkup(React.createElement(ParentClassPass));expect(html).toContain('Payment/provider outcome unavailable.');expect(html).toContain('Read-only operational allowances');expect(html).not.toMatch(/<form|<button[^>]*>[^<]*(?:purchase|admit|issue|reverse)/i);
  const source=readFileSync(new URL('../src/components/parent-classpass.tsx',import.meta.url),'utf8');expect(source).toContain('setView(null); setError');expect(source).toContain("window.addEventListener('blur', hide)");expect(source).toContain('generation.current === token');expect(source).not.toMatch(/localStorage|sessionStorage|commandClassPass|studentProfileId|organizationId|schoolId/);
  const page=readFileSync(new URL('../src/app/parent/classpass/page.tsx',import.meta.url),'utf8');expect(page).toContain("redirect('/auth/login')");expect(page).toContain('verifySession');
 });
});
