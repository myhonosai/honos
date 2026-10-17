import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlannedAbsenceReviewWorkbench } from '../src/components/planned-absence-review-workbench';
import { createReviewAttempt, decidePlannedAbsence, loadPlannedAbsenceReviewQueue, PlannedAbsenceReviewAccessError } from '../src/components/planned-absence-review-http';
const id='11111111-1111-4111-8111-111111111111',schoolId='22222222-2222-4222-8222-222222222222',studentProfileId='33333333-3333-4333-8333-333333333333';
const item={id,studentProfileId,startsAt:'2026-10-18T09:00:00.000Z',endsAt:'2026-10-18T11:00:00.000Z',reason:'Private reason',version:1,submittedAt:'2026-10-17T00:00:00.000Z'},queue={organizationId:id,schoolId,items:[item]};
const input={decision:'DECLINED' as const,reviewNote:'Private rationale',expectedVersion:1},receipt={id,status:'DECLINED',version:2,reviewedAt:'2026-10-17T01:00:00.000Z'};
const envelope=(data:unknown,command=false)=>Response.json({data,meta:{requestId:id,correlationId:id,...(command?{replayed:false}:{})}});
afterEach(()=>vi.restoreAllMocks());
describe('bounded direct-human review workbench',()=>{
 it('starts empty with no calls, explains no downstream effect and links only attendance/core/signin',()=>{
  const fetcher=vi.spyOn(globalThis,'fetch');const html=renderToStaticMarkup(<PlannedAbsenceReviewWorkbench/>);expect(fetcher).not.toHaveBeenCalled();expect(html).toContain('No verified review queue is loaded');expect(html).toContain('At most 50');expect(html).toContain('Decision record only');expect(html).not.toContain('Private rationale');expect(html).not.toContain('11111111');expect(html).not.toMatch(/type="(?:email|file)"/);
 });
 it('uses fixed same-origin no-store GET and existing exact version/idempotent POST paths without response notes',async()=>{
  const fetcher=vi.spyOn(globalThis,'fetch').mockResolvedValueOnce(envelope(queue)).mockResolvedValueOnce(envelope(receipt,true));expect(await loadPlannedAbsenceReviewQueue()).toEqual(queue);
  const attempt=createReviewAttempt(queue,item,input,'exact-key');expect(await decidePlannedAbsence(attempt)).toEqual(receipt);
  expect(fetcher).toHaveBeenNthCalledWith(1,'/api/v1/staff/attendance/planned-absences',expect.objectContaining({method:'GET',credentials:'same-origin',mode:'same-origin',redirect:'error',cache:'no-store',referrerPolicy:'no-referrer'}));
  expect(fetcher).toHaveBeenNthCalledWith(2,`/api/v1/organizations/${id}/schools/${schoolId}/planned-absence-requests/${id}/decision`,expect.objectContaining({method:'POST',body:JSON.stringify(input),headers:expect.objectContaining({'Idempotency-Key':'exact-key','X-HON-Human-Command':'planned-absence-review','Content-Type':'application/json'})}));
 });
 it('strictly rejects scope, endpoint, note, key, version and closed-envelope/receipt leakage',async()=>{
  const fetcher=vi.spyOn(globalThis,'fetch');const attempt=createReviewAttempt(queue,item,input,'exact-key');
  expect(()=>createReviewAttempt(queue,{...item,version:2},input,'key')).toThrow();expect(()=>createReviewAttempt(queue,item,{...input,reviewNote:'  '},'key')).toThrow();
  await expect(decidePlannedAbsence({...attempt,scope:{...attempt.scope,schoolId:'https://evil.test/'}})).rejects.toThrow();await expect(decidePlannedAbsence({...attempt,key:'key\n'})).rejects.toThrow();expect(fetcher).not.toHaveBeenCalled();
  for(const bad of [{...receipt,id:schoolId},{...receipt,status:'APPROVED'},{...receipt,version:3},{...receipt,reviewNote:'secret'},{...receipt,reviewedByPrincipalId:id}]) {fetcher.mockResolvedValue(envelope(bad,true));await expect(decidePlannedAbsence(attempt)).rejects.toThrow();}
  for(const bad of [{...queue,count:1},{...queue,items:Array(51).fill(item)},{...queue,items:[{...item,reviewNote:'secret'}]}]) {fetcher.mockResolvedValue(envelope(bad));await expect(loadPlannedAbsenceReviewQueue()).rejects.toThrow();}
  fetcher.mockResolvedValue(Response.json({data:queue,meta:{requestId:id,correlationId:id,source:'AI'}}));await expect(loadPlannedAbsenceReviewQueue()).rejects.toThrow();
  fetcher.mockResolvedValue(new Response(JSON.stringify({data:queue}),{headers:{'Content-Type':'text/plain'}}));await expect(loadPlannedAbsenceReviewQueue()).rejects.toThrow();
 });
 it('treats authorization/conflict as terminal cleared state and never retries itself',async()=>{
  const fetcher=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response('',{status:403}));await expect(loadPlannedAbsenceReviewQueue()).rejects.toBeInstanceOf(PlannedAbsenceReviewAccessError);expect(fetcher).toHaveBeenCalledTimes(1);
  fetcher.mockResolvedValue(new Response('',{status:409}));await expect(decidePlannedAbsence(createReviewAttempt(queue,item,input,'key'))).rejects.toBeInstanceOf(PlannedAbsenceReviewAccessError);expect(fetcher).toHaveBeenCalledTimes(2);
 });
 it('route, manifest and attendance link are wired; no storage/polling/autoretry/external calls exist',()=>{
  const route=readFileSync('src/app/staff/attendance/planned-absences/page.tsx','utf8');for(const token of ['cookies','verifySession','HON_SESSION_COOKIE',"redirect('/auth/login')",'force-dynamic','index: false'])expect(route).toContain(token);
  const manifest=JSON.parse(readFileSync('public/manus-routes.json','utf8'));expect(manifest.routes.filter((item:{path:string})=>item.path==='/staff/attendance/planned-absences')).toHaveLength(1);expect(readFileSync('src/components/attendance-workbench.tsx','utf8')).toContain('href="/staff/attendance/planned-absences"');
  const code=readFileSync('src/components/planned-absence-review-workbench.tsx','utf8')+readFileSync('src/components/planned-absence-review-http.ts','utf8');expect(code).not.toMatch(/localStorage|sessionStorage|setInterval|setTimeout|invokeLLM|executeAction|fetch\(['"]https?:/);for(const token of ['generation.current','controller.current?.abort()','retry.current = null','visibilitychange','hon:session-changed','Retry exact retained decision'])expect(code).toContain(token);
 });
});
