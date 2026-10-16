import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect, vi } from 'vitest';
import { RetentionReviewSignalsWorkbench } from '../src/components/retention-review-signals';
import { acknowledgeRetentionReviewEvidence, loadRetentionReviewAcknowledgementEvidence } from '../src/components/retention-review-signals-http';
const school='11111111-1111-4111-8111-111111111111',membership='22222222-2222-4222-8222-222222222222',request='33333333-3333-4333-8333-333333333333';
const observedAt='2026-10-16T00:00:00.000Z';
const signals={schemaVersion:'RETENTION_REVIEW_SIGNALS_V1',membershipId:membership,observedAt,humanOnly:true,readOnly:true,evidenceOnly:true,predictionOrAutomaticAction:false,membershipTerm:{status:'AVAILABLE',membershipState:'ACTIVE',termStartedAt:'2026-01-01T00:00:00.000Z',termEndsAt:'2027-01-01T00:00:00.000Z',endingObservation:'ENDING_AFTER_30_DAYS',reason:null},renewalReview:{status:'UNAVAILABLE',latestReviewState:null,recordedAt:null,reason:'NO_EXPLICIT_RENEWAL_REVIEW_RECORDED'},followUp:{status:'UNAVAILABLE',reason:'NO_UNAMBIGUOUS_MEMBERSHIP_TO_FOLLOW_UP_RELATION'},attendance:{status:'INSUFFICIENT_DATA',windowFrom:'2026-09-18T00:00:00.000Z',windowTo:observedAt,recordedAttendanceCount:0,presentCount:0,lateCount:0,makeupCount:0,excusedAbsenceCount:0,unexcusedAbsenceCount:0,reason:'NO_RECORDED_ATTENDANCE_IN_WINDOW'},progression:{status:'UNAVAILABLE',curriculumEnrollmentCount:0,progressObservationCount:0,testingRecordCount:0,progressObservationAvailability:'UNAVAILABLE',testingObservationAvailability:'UNAVAILABLE',reason:'NO_CURRICULUM_ENROLLMENT_RECORDED'}};
const evidence={signals,evidenceVersion:'RETENTION_REVIEW_SIGNALS_V1' as const,evidenceFingerprint:'a'.repeat(64)};
const input={evidenceVersion:evidence.evidenceVersion,evidenceFingerprint:evidence.evidenceFingerprint,observedAt,idempotencyKey:request};
const result={schemaVersion:'RETENTION_REVIEW_ACKNOWLEDGEMENT_V1',membershipId:membership,acknowledgementId:request,evidenceVersion:evidence.evidenceVersion,evidenceFingerprint:evidence.evidenceFingerprint,observedAt,recordedAt:'2026-10-16T00:00:01.000Z',state:'EVIDENCE_REVIEWED',humanOnly:true,evidenceOnly:true,noDownstreamEffect:true};
const response=(key:string,value:unknown)=>({ok:true,status:200,json:async()=>({data:{[key]:value},meta:{requestId:request,correlationId:request}})}) as Response;
describe('direct human retention acknowledgement UI',()=>{
 it('only uses same-origin no-store exact evidence GET and direct-human JSON POST',async()=>{
  const fetch=vi.spyOn(globalThis,'fetch').mockResolvedValueOnce(response('retentionReviewAcknowledgementEvidence',evidence)).mockResolvedValueOnce(response('retentionReviewAcknowledgement',result));
  try{
   expect(await loadRetentionReviewAcknowledgementEvidence(school,membership)).toEqual(evidence);expect(await acknowledgeRetentionReviewEvidence(school,membership,input)).toEqual(result);
   expect(fetch.mock.calls[0]![0]).toContain('/staff/retention/review/acknowledgement-evidence?');expect(fetch.mock.calls[0]![1]).toMatchObject({method:'GET',credentials:'same-origin',cache:'no-store'});
   expect(fetch.mock.calls[1]![0]).toContain('/staff/retention/review/acknowledgement?');expect(fetch.mock.calls[1]![1]).toMatchObject({method:'POST',credentials:'same-origin',cache:'no-store',referrerPolicy:'no-referrer',headers:{'X-HON-Human-Command':'retention-review-acknowledgement'}});expect(JSON.parse(fetch.mock.calls[1]![1]!.body as string)).toEqual(input);
  }finally{fetch.mockRestore();}
 });
 it('never displays unverified, private, resolved, stale or cross-membership output',async()=>{
  for(const patch of [{state:'RESOLVED'},{contact:'private'},{noDownstreamEffect:false},{membershipId:school},{evidenceFingerprint:'b'.repeat(64)},{observedAt:'2026-10-15T00:00:00.000Z'}]){
   const fetch=vi.spyOn(globalThis,'fetch').mockResolvedValue(response('retentionReviewAcknowledgement',{...result,...patch}));try{await expect(acknowledgeRetentionReviewEvidence(school,membership,input)).rejects.toThrow();}finally{fetch.mockRestore();}
  }
  for(const status of [401,403,404,409,503]){
   const fetch=vi.spyOn(globalThis,'fetch').mockResolvedValue({ok:false,status} as Response);try{await expect(acknowledgeRetentionReviewEvidence(school,membership,input)).rejects.toMatchObject({status});expect(fetch).toHaveBeenCalledTimes(1);}finally{fetch.mockRestore();}
  }
 });
 it('clears selector/context/error state and rejects late generations; no acknowledgement control before verified read',()=>{
  const fetch=vi.spyOn(globalThis,'fetch');try{const html=renderToStaticMarkup(<RetentionReviewSignalsWorkbench/>);expect(fetch).not.toHaveBeenCalled();expect(html).not.toContain('Acknowledge evidence reviewed');expect(html).not.toContain('Evidence reviewed');}finally{fetch.mockRestore();}
  const component=readFileSync('src/components/retention-review-signals.tsx','utf8');
  for(const text of ['generation.current++','current === generation.current','setEvidence(null)','setAcknowledgement(null)','retryKey.current = null',"window.addEventListener('focus'","document.addEventListener('visibilitychange'",'evidence && !acknowledgement','No downstream effect.'])expect(component).toContain(text);
  expect(component).not.toMatch(/resolved successfully|contact successful|renewal successful|payment successful|invokeLLM|executeAction|sendMessage/);
 });
 it('rejects unexpected authority in the input before any request',async()=>{
  const fetch=vi.spyOn(globalThis,'fetch');try{await expect(acknowledgeRetentionReviewEvidence(school,membership,{...input,note:'private'} as typeof input)).rejects.toThrow();expect(fetch).not.toHaveBeenCalled();}finally{fetch.mockRestore();}
 });
});
