import { describe, it, expect } from 'vitest';
import { verifyRetentionReviewAcknowledgementInput, verifyRetentionReviewAcknowledgement } from '@hon/contracts';
const id='11111111-1111-4111-8111-111111111111';
const input={evidenceVersion:'RETENTION_REVIEW_SIGNALS_V1' as const,evidenceFingerprint:'a'.repeat(64),observedAt:'2026-10-16T00:00:00.000Z',idempotencyKey:id};
const response={schemaVersion:'RETENTION_REVIEW_ACKNOWLEDGEMENT_V1',membershipId:id,acknowledgementId:id,evidenceVersion:input.evidenceVersion,evidenceFingerprint:input.evidenceFingerprint,observedAt:input.observedAt,recordedAt:'2026-10-16T00:00:01.000Z',state:'EVIDENCE_REVIEWED',humanOnly:true,evidenceOnly:true,noDownstreamEffect:true};
describe('pure retention review acknowledgement contract',()=>{
 it('records review only; validates exact evidence without mutation or downstream authority',()=>{
  const before=JSON.stringify(input);expect(verifyRetentionReviewAcknowledgementInput(input)).toEqual(input);expect(JSON.stringify(input)).toBe(before);
  expect(verifyRetentionReviewAcknowledgement(response,id,input)).toMatchObject({state:'EVIDENCE_REVIEWED',noDownstreamEffect:true});
  for(const state of ['RESOLVED','CONTACTED','RENEWED','RETAINED','PAID','RISK','ASSIGNED'])expect(()=>verifyRetentionReviewAcknowledgement({...response,state},id,input)).toThrow();
 });
 it('rejects private or authority-bearing fields, evidence mismatch, unknown versions and unbounded clocks',()=>{
  for(const patch of [{note:'private'},{studentId:id},{schoolId:id},{provider:'test'},{idempotencyKey:'note'},{evidenceVersion:'V2'},{evidenceFingerprint:'b'},{observedAt:'2026-10-16'}])expect(()=>verifyRetentionReviewAcknowledgementInput({...input,...patch})).toThrow();
  for(const patch of [{email:'private'},{actorId:id},{noDownstreamEffect:false},{recordedAt:'2026-10-16T00:10:00.000Z'},{evidenceFingerprint:'b'.repeat(64)}])expect(()=>verifyRetentionReviewAcknowledgement({...response,...patch},id,input)).toThrow();
 });
});
