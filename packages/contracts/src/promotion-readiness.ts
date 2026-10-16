export const PROMOTION_READINESS_STATUSES = ['NOT_ELIGIBLE', 'APPROACHING', 'ELIGIBLE_INSTRUCTOR_REVIEW', 'APPROVED_FOR_TESTING', 'TESTING_COMPLETED'] as const;
export type PromotionReadinessStatus = typeof PROMOTION_READINESS_STATUSES[number];
export const READINESS_CRITERIA = ['ENROLLMENT', 'POLICY', 'TIME_IN_RANK', 'ATTENDANCE', 'REQUIREMENT', 'INSTRUCTOR_RECOMMENDATION', 'DOCUMENT', 'TESTING_WINDOW', 'EVIDENCE'] as const;
export interface PromotionReadinessV1 {
 minAttendanceCreditMilli: number; minDaysInCurrentRank: number;
 requiredRequirementIds: string[]; instructorRecommendationRequirementIds: string[];
 documentTemplateIds: string[];
 /** This proves only the viewing staff member's acknowledgement, NOT a student's or guardian's. */
 documentAcknowledgementRule: 'CURRENT_CALLER_STAFF_CURRENT_PUBLICATION'; requireOpenTestingWindow: boolean;
}
export interface PromotionReadinessCriterion {
 code: typeof READINESS_CRITERIA[number]; sourceId: string | null;
 outcome: 'MET' | 'MISSING' | 'NOT_MET' | 'CONFIGURATION_BLOCKER' | 'NOT_REQUIRED';
 observed: number | null; required: number | null; recordedAt: string | null;
}
export interface PromotionReadiness {
 organizationId: string; schoolId: string; curriculumId: string; enrollmentId: string;
 currentRankId: string | null; nextRankId: string | null; asOf: string; status: PromotionReadinessStatus;
 policyVersion: 1 | null; policyFingerprint: string | null;
 criteria: PromotionReadinessCriterion[]; blockers: PromotionReadinessCriterion[];
 candidate: { id: string; testingEventId: string; result: 'PENDING' | 'PASSED' | 'DEFERRED' | 'NOT_PASSED' | 'WITHDRAWN'; recordedAt: string } | null;
 attendanceRecordCount: number; evidenceCount: number;
}
export interface PromotionReadinessContext {
 organizationId: string; schoolId: string; principalId: string; principalType: 'HUMAN_USER';
 externalSubject: string; source: 'HUMAN_UI'; requestId: string; correlationId: string;
 actionRequestId?: string; delegatedByPrincipalId?: string;
}
export const readinessUuid = (x: unknown): x is string => typeof x === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(x);
const integer = (x: unknown): x is number => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0;
const instant = (x: unknown): x is string => typeof x === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(x) && Number.isFinite(Date.parse(x));
function fail(): never { throw new Error('Unverified redacted promotion readiness response.'); }
function object(x: unknown): Record<string, unknown> { if (!x || typeof x !== 'object' || Array.isArray(x)) fail(); return x as Record<string, unknown>; }
function keys(x: Record<string, unknown>, allowed: string[]) { if (Object.keys(x).sort().join('|') !== [...allowed].sort().join('|')) fail(); }
export function parsePromotionReadinessPolicy(x: unknown): PromotionReadinessV1 {
 const wrapper = object(x); keys(wrapper, ['promotionReadinessV1']); const p = object(wrapper.promotionReadinessV1);
 keys(p, ['minAttendanceCreditMilli', 'minDaysInCurrentRank', 'requiredRequirementIds', 'instructorRecommendationRequirementIds', 'documentTemplateIds', 'documentAcknowledgementRule', 'requireOpenTestingWindow']);
 if (!integer(p.minAttendanceCreditMilli) || p.minAttendanceCreditMilli > 999999999999 || !integer(p.minDaysInCurrentRank) || p.minDaysInCurrentRank > 99999 || typeof p.requireOpenTestingWindow !== 'boolean' || p.documentAcknowledgementRule !== 'CURRENT_CALLER_STAFF_CURRENT_PUBLICATION') fail();
 for (const key of ['requiredRequirementIds', 'instructorRecommendationRequirementIds', 'documentTemplateIds']) {
  const a = p[key]; if (!Array.isArray(a) || a.length > 100 || !a.every(readinessUuid) || new Set(a).size !== a.length) fail();
 }
 const v = p as unknown as PromotionReadinessV1;
 if (v.requiredRequirementIds.some(id => v.instructorRecommendationRequirementIds.includes(id)) || !(v.minAttendanceCreditMilli || v.minDaysInCurrentRank || v.requiredRequirementIds.length || v.instructorRecommendationRequirementIds.length || v.documentTemplateIds.length || v.requireOpenTestingWindow)) fail();
 return { ...v, requiredRequirementIds: [...v.requiredRequirementIds], instructorRecommendationRequirementIds: [...v.instructorRecommendationRequirementIds], documentTemplateIds: [...v.documentTemplateIds] };
}
function criterion(x: unknown): PromotionReadinessCriterion {
 const r = object(x); keys(r, ['code', 'sourceId', 'outcome', 'observed', 'required', 'recordedAt']);
 if (!READINESS_CRITERIA.includes(r.code as PromotionReadinessCriterion['code']) || !['MET', 'MISSING', 'NOT_MET', 'CONFIGURATION_BLOCKER', 'NOT_REQUIRED'].includes(r.outcome as string) || !(r.sourceId === null || readinessUuid(r.sourceId)) || !(r.observed === null || integer(r.observed)) || !(r.required === null || integer(r.required)) || !(r.recordedAt === null || instant(r.recordedAt))) fail();
 return { ...r } as unknown as PromotionReadinessCriterion;
}
/** Checks the SQL precedence, not an authorizing engine. Never creates a candidate or decision. */
export function verifiedReadinessStatus(v: Pick<PromotionReadiness, 'candidate' | 'policyVersion' | 'criteria' | 'blockers'>): PromotionReadinessStatus {
 if (v.candidate) return v.candidate.result === 'PENDING' ? 'APPROVED_FOR_TESTING' : 'TESTING_COMPLETED';
 if (v.policyVersion !== 1 || v.criteria.some(r => ['NOT_MET', 'CONFIGURATION_BLOCKER'].includes(r.outcome))) return 'NOT_ELIGIBLE';
 return v.blockers.length ? 'APPROACHING' : 'ELIGIBLE_INSTRUCTOR_REVIEW';
}
export function parsePromotionReadiness(x: unknown, expected: Pick<PromotionReadiness, 'organizationId' | 'schoolId' | 'curriculumId' | 'enrollmentId'>): PromotionReadiness {
 const r = object(x); keys(r, ['organizationId', 'schoolId', 'curriculumId', 'enrollmentId', 'currentRankId', 'nextRankId', 'asOf', 'status', 'policyVersion', 'policyFingerprint', 'criteria', 'blockers', 'candidate', 'attendanceRecordCount', 'evidenceCount']);
 for (const key of ['organizationId', 'schoolId', 'curriculumId', 'enrollmentId'] as const) if (!readinessUuid(r[key]) || r[key] !== expected[key]) fail();
 for (const key of ['currentRankId', 'nextRankId']) if (!(r[key] === null || readinessUuid(r[key]))) fail();
 if (!instant(r.asOf) || !PROMOTION_READINESS_STATUSES.includes(r.status as PromotionReadinessStatus) || !integer(r.attendanceRecordCount) || !integer(r.evidenceCount)) fail();
 if (r.policyVersion === null ? r.policyFingerprint !== null : r.policyVersion !== 1 || typeof r.policyFingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(r.policyFingerprint)) fail();
 if (!Array.isArray(r.criteria) || !Array.isArray(r.blockers) || r.criteria.length > 307 || r.blockers.length > 307) fail();
 const criteria = r.criteria.map(criterion), blockers = r.blockers.map(criterion);
 const fixed = r.policyVersion === 1 ? ['ENROLLMENT', 'POLICY', 'TIME_IN_RANK', 'ATTENDANCE', 'TESTING_WINDOW', 'EVIDENCE'] : ['ENROLLMENT', 'POLICY', 'EVIDENCE'];
 for (const code of fixed) if (criteria.filter(c => c.code === code).length !== 1) fail();
 let order = -1, previous = '';
 for (const c of criteria) {
  const index = READINESS_CRITERIA.indexOf(c.code);
  if (index < order || (index === order && (!c.sourceId || c.sourceId <= previous)) || (c.recordedAt && Date.parse(c.recordedAt) > Date.parse(r.asOf))) fail();
  order = index; previous = c.sourceId ?? '';
 }
 if (JSON.stringify(blockers) !== JSON.stringify(criteria.filter(c => !['MET', 'NOT_REQUIRED'].includes(c.outcome)))) fail();
 if (criteria.find(c => c.code === 'EVIDENCE')?.observed !== r.evidenceCount || criteria.find(c => c.code === 'EVIDENCE')?.outcome !== (r.evidenceCount > 0 ? 'MET' : 'NOT_MET') || criteria.find(c => c.code === 'POLICY')?.outcome !== (r.policyVersion === 1 ? 'MET' : 'CONFIGURATION_BLOCKER')) fail();
 let candidate: PromotionReadiness['candidate'] = null;
 if (r.candidate !== null) {
  const c = object(r.candidate); keys(c, ['id', 'testingEventId', 'result', 'recordedAt']);
  if (!readinessUuid(c.id) || !readinessUuid(c.testingEventId) || !['PENDING', 'PASSED', 'DEFERRED', 'NOT_PASSED', 'WITHDRAWN'].includes(c.result as string) || !instant(c.recordedAt) || Date.parse(c.recordedAt) > Date.parse(r.asOf) || !r.nextRankId) fail();
  candidate = { ...c } as unknown as PromotionReadiness['candidate'];
 }
 const result = { ...r, criteria, blockers, candidate } as unknown as PromotionReadiness;
 if (verifiedReadinessStatus(result) !== result.status) fail();
 return result;
}
