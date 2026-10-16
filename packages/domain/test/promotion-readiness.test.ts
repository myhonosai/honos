import { describe, expect, it } from 'vitest';
import { parsePromotionReadinessPolicy, verifiedReadinessStatus } from '@hon/contracts';
const id = '11111111-1111-4111-8111-111111111111';
const policy = { minAttendanceCreditMilli: 1000, minDaysInCurrentRank: 30, requiredRequirementIds: [id], instructorRecommendationRequirementIds: [], documentTemplateIds: [], documentAcknowledgementRule: 'CURRENT_CALLER_STAFF_CURRENT_PUBLICATION', requireOpenTestingWindow: true };
describe('promotion readiness closed contract (not an authorizing model)', () => {
 it('accepts only explicitly configured exact v1, never arbitrary historical JSON', () => {
  expect(parsePromotionReadinessPolicy({ promotionReadinessV1: policy })).toEqual(policy);
  for (const p of [null, [], {}, policy, { promotionReadinessV1: { ...policy, minDaysInCurrentRank: undefined } }, { promotionReadinessV1: { ...policy, minAttendanceCreditMilli: '1000' } }, { promotionReadinessV1: { ...policy, requireOpenTestingWindow: null } }, { promotionReadinessV1: { ...policy, requiredRequirementIds: [id,id] } }, { promotionReadinessV1: { ...policy, instructorRecommendationRequirementIds: [id] } }, { promotionReadinessV1: { ...policy, rawContent: 'private' } }, { promotionReadinessV1: policy, arbitrary: {} }, { promotionReadinessV1: { ...policy, documentAcknowledgementRule: 'ANY_PARENT' } }]) expect(() => parsePromotionReadinessPolicy(p)).toThrow();
 });
 it('checks final/pending candidate precedence independently of policy, and fatal versus remaining blockers', () => {
  const r = { policyVersion: null, criteria: [{ code: 'POLICY', outcome: 'CONFIGURATION_BLOCKER' }], blockers: [{}], candidate: null } as any;
  expect(verifiedReadinessStatus(r)).toBe('NOT_ELIGIBLE');
  expect(verifiedReadinessStatus({ ...r, candidate: { result: 'PENDING' } })).toBe('APPROVED_FOR_TESTING');
  for (const result of ['PASSED', 'NOT_PASSED', 'DEFERRED', 'WITHDRAWN']) expect(verifiedReadinessStatus({ ...r, candidate: { result } })).toBe('TESTING_COMPLETED');
  expect(verifiedReadinessStatus({ ...r, policyVersion: 1, criteria: [{ outcome: 'MISSING' }] })).toBe('APPROACHING');
  expect(verifiedReadinessStatus({ ...r, policyVersion: 1, criteria: [{ outcome: 'NOT_MET' }] })).toBe('NOT_ELIGIBLE');
  expect(verifiedReadinessStatus({ ...r, policyVersion: 1, criteria: [], blockers: [] })).toBe('ELIGIBLE_INSTRUCTOR_REVIEW');
 });
});
