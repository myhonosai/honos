import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { loadPromotionReadiness, PromotionReadinessAccessError } from '../src/components/promotion-readiness-http';
import { PromotionReadinessWorkbench } from '../src/components/promotion-readiness-workbench';
const ids = ['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','33333333-3333-4333-8333-333333333333','44444444-4444-4444-8444-444444444444'] as const;
const c = (code:string,outcome:string,sourceId:string|null=null,observed:number|null=null,required:number|null=null) => ({code,outcome,sourceId,observed,required,recordedAt:null});
const criteria=[c('ENROLLMENT','MET',ids[3]),c('POLICY','CONFIGURATION_BLOCKER'),c('EVIDENCE','NOT_MET',null,0,1)];
const view={organizationId:ids[0],schoolId:ids[1],curriculumId:ids[2],enrollmentId:ids[3],currentRankId:ids[2],nextRankId:ids[3],asOf:'2026-10-16T01:00:00.000Z',status:'NOT_ELIGIBLE',policyVersion:null,policyFingerprint:null,criteria,blockers:criteria.slice(1),candidate:null,attendanceRecordCount:0,evidenceCount:0};
const response=(data:unknown)=>Response.json({data,meta:{requestId:ids[0],correlationId:ids[0]}});
describe('human-governed readiness UI',()=>{
 it('uses exact UUID path GET with same-origin no-store only; malformed selectors never fetch',async()=>{
  const fetcher=vi.spyOn(globalThis,'fetch').mockResolvedValue(response(view));
  try { await expect(loadPromotionReadiness(...ids)).resolves.toEqual(view);expect(fetcher).toHaveBeenCalledWith(`/api/v1/organizations/${ids[0]}/schools/${ids[1]}/curricula/${ids[2]}/enrollments/${ids[3]}/promotion-readiness`,expect.objectContaining({method:'GET',credentials:'same-origin',mode:'same-origin',cache:'no-store',redirect:'error',referrerPolicy:'no-referrer'}));fetcher.mockClear();await expect(loadPromotionReadiness('https://evil.invalid',...ids.slice(1) as [string,string,string])).rejects.toThrow();expect(fetcher).not.toHaveBeenCalled(); } finally {fetcher.mockRestore();}
 });
 it('rejects unsafe fields, mismatched scope, false eligibility and denied/unavailable responses',async()=>{
  const fetcher=vi.spyOn(globalThis,'fetch');
  try {for(const patch of [{rawDocumentContent:'private'},{organizationId:ids[1]},{status:'ELIGIBLE_INSTRUCTOR_REVIEW'},{candidate:{id:ids[0],testingEventId:ids[0],result:'PENDING',recordedAt:view.asOf,instructorNotes:'private'}}]) {fetcher.mockResolvedValue(response({...view,...patch}));await expect(loadPromotionReadiness(...ids)).rejects.toThrow();}for(const status of [401,403,404,503]) {fetcher.mockResolvedValue({ok:false,status} as Response);const failure=loadPromotionReadiness(...ids);if([401,403].includes(status))await expect(failure).rejects.toBeInstanceOf(PromotionReadinessAccessError);else await expect(failure).rejects.toThrow(/unavailable/);}}finally{fetcher.mockRestore();}
 });
 it('starts unloaded with no network or action controls and uses existing themes',()=>{
  const fetcher=vi.spyOn(globalThis,'fetch');try {const html=renderToStaticMarkup(<PromotionReadinessWorkbench/>);expect(fetcher).not.toHaveBeenCalled();for(const text of ['No readiness loaded','Readiness is not a promotion or testing approval.','not student or guardian compliance','No directory, search, automatic selection, or action controls.'])expect(html).toContain(text);expect(html).not.toMatch(/<button[^>]*>Approve|<button[^>]*>Promote|<button[^>]*>Register|<button[^>]*>Issue/i);}finally{fetcher.mockRestore();}
 });
 it('registers authenticated private page and rejects stale read generations',()=>{
  const page=readFileSync('src/app/staff/testing/readiness/page.tsx','utf8');for(const token of ['verifySession',"redirect('/auth/login')",'force-dynamic','index: false'])expect(page).toContain(token);
  const source=readFileSync('src/components/promotion-readiness-workbench.tsx','utf8');expect(source).toContain('generation.current === attempt');expect(source).toContain("from './testing-registration.module.css'");
  expect(JSON.parse(readFileSync('public/manus-routes.json','utf8')).routes.filter((r:{path:string})=>r.path==='/staff/testing/readiness')).toHaveLength(1);
 });
});
