import type { HealthScoreCategoryReason, SchoolHealthScoreCategories, SchoolHealthScoreSnapshot } from '@hon/contracts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const UNSAFE = /[\x00-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/;
const INDICATOR = 'Operational indicator only. It is not a forecast, cancellation/churn certainty, cash-revenue measure, or recommendation for consequential changes.';
type Row = Record<string, unknown>;

export class HealthScoreAccessError extends Error { constructor(message: string, readonly status: number) { super(message); } }
function invalid(): never { throw new Error('School Health Score data was not a verified aggregate-only snapshot.'); }
function record(value: unknown, keys: readonly string[]): Row { if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(); const row = value as Row; if (Object.keys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row, key))) invalid(); return row; }
function string(value: unknown, max = 240): string { if (typeof value !== 'string' || !value || value.length > max || UNSAFE.test(value)) invalid(); return value; }
function time(value: unknown): string { const source = string(value, 80); if (!UTC.test(source) || new Date(source).toISOString() !== source) invalid(); return source; }
function count(value: unknown): number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) invalid(); return value; }
function boundedScore(value: unknown): number { const result = count(value); if (result > 100) invalid(); return result; }
function id(value: unknown, expected: string): string { const source = string(value, 36).toLowerCase(); if (!UUID.test(source) || source !== expected) invalid(); return source; }
function sameReasons(value: unknown, expected: HealthScoreCategoryReason[]) { if (!Array.isArray(value) || value.length !== expected.length || value.some((item, i) => item !== expected[i])) invalid(); return expected; }
function category(value: unknown, generatedAt: string, duration: number, evidenceKeys: readonly string[], expectedReasons: (evidence: Row) => HealthScoreCategoryReason[], expectedScore: (evidence: Row) => number) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(); const source = value as Row;
  const keys = source.status === 'AVAILABLE' ? ['status', 'windowFrom', 'windowTo', 'evidence', 'reasons', 'score'] : ['status', 'windowFrom', 'windowTo', 'evidence', 'reasons'];
  if (Object.keys(source).length !== keys.length || keys.some(key => !Object.hasOwn(source, key))) invalid();
  const windowFrom = time(source.windowFrom); const windowTo = time(source.windowTo); const evidence = record(source.evidence, evidenceKeys);
  if (windowTo !== generatedAt || Date.parse(windowTo) - Date.parse(windowFrom) !== duration || (source.status !== 'AVAILABLE' && source.status !== 'INSUFFICIENT_DATA')) invalid();
  const reasons = expectedReasons(evidence); sameReasons(source.reasons, reasons);
  const sufficient = reasons.length === 0;
  if (!sufficient) { if (source.status !== 'INSUFFICIENT_DATA') invalid(); return { status: 'INSUFFICIENT_DATA' as const, windowFrom, windowTo, evidence, reasons }; }
  if (source.status !== 'AVAILABLE' || boundedScore(source.score) !== expectedScore(evidence)) invalid();
  return { status: 'AVAILABLE' as const, windowFrom, windowTo, evidence, reasons: [] as [], score: expectedScore(evidence) };
}

/** Selector IDs only; SQL independently resolves human, school, permission, and entitlement. */
export function healthScorePath(organizationId: string, schoolId: string): string {
  const organization = organizationId.trim().toLowerCase(); const school = schoolId.trim().toLowerCase();
  if (!UUID.test(organization) || !UUID.test(school)) throw new Error('Enter the exact organization and school UUIDs from your staff context.');
  return `/api/v1/organizations/${organization}/schools/${school}/health-score`;
}
export function verifySchoolHealthScoreSnapshot(value: unknown, organizationId: string, schoolId: string): SchoolHealthScoreSnapshot {
  const organization = organizationId.trim().toLowerCase(); const school = schoolId.trim().toLowerCase();
  const root = record(value, ['organizationId', 'schoolId', 'entitlementTier', 'formulaVersion', 'generatedAt', 'weights', 'categories', 'overall', 'indicatorStatement']);
  const generatedAt = time(root.generatedAt); if (string(root.formulaVersion, 64) !== 'SCHOOL_HEALTH_SCORE_V1' || string(root.indicatorStatement, 300) !== INDICATOR) invalid();
  if (!['ESSENTIAL', 'CORE', 'COMPLETE'].includes(string(root.entitlementTier, 10))) invalid();
  const weights = record(root.weights, ['attendanceEngagement', 'pipelineTrial', 'retention', 'operations']);
  if (weights.attendanceEngagement !== 35 || weights.pipelineTrial !== 25 || weights.retention !== 25 || weights.operations !== 15) invalid();
  const rawCategories = record(root.categories, ['attendanceEngagement', 'pipelineTrial', 'retention', 'operations']);
  const attendance = category(rawCategories.attendanceEngagement, generatedAt, 28 * 86_400_000, ['completedSessions', 'recordedAttendanceObservations', 'engagedAttendanceObservations'], evidence => { const sessions = count(evidence.completedSessions); const observations = count(evidence.recordedAttendanceObservations); const engaged = count(evidence.engagedAttendanceObservations); if (engaged > observations) invalid(); return [...(sessions < 4 ? ['MIN_COMPLETED_SESSIONS' as const] : []), ...(observations < 20 ? ['MIN_RECORDED_ATTENDANCE_OBSERVATIONS' as const] : [])]; }, evidence => { const observations = count(evidence.recordedAttendanceObservations); return Math.min(100, Math.max(0, Math.round(100 * count(evidence.engagedAttendanceObservations) / observations))); });
  const pipeline = category(rawCategories.pipelineTrial, generatedAt, 56 * 86_400_000, ['leadsCreated', 'trialAppointments', 'trialOutcomesRecorded'], evidence => { const leads = count(evidence.leadsCreated); const trials = count(evidence.trialAppointments); if (count(evidence.trialOutcomesRecorded) > trials) invalid(); return [...(leads < 5 ? ['MIN_RECENT_LEADS' as const] : []), ...(trials < 3 ? ['MIN_RECENT_TRIAL_APPOINTMENTS' as const] : [])]; }, evidence => {
    const trialAppointments = count(evidence.trialAppointments);
    return Math.min(100, Math.max(0, Math.round(100 * count(evidence.trialOutcomesRecorded) / trialAppointments)));
  });
  const retention = category(rawCategories.retention, generatedAt, 90 * 86_400_000, ['membershipTermsEnded', 'renewalReviewsRecorded'], evidence => { const terms = count(evidence.membershipTermsEnded); const reviews = count(evidence.renewalReviewsRecorded); return [...(terms < 5 ? ['MIN_MEMBERSHIP_TERMS_ENDED' as const] : []), ...(reviews < 3 ? ['MIN_RENEWAL_REVIEWS_RECORDED' as const] : [])]; }, evidence => {
    const membershipTermsEnded = count(evidence.membershipTermsEnded);
    return Math.min(100, Math.max(0, Math.round(100 * count(evidence.renewalReviewsRecorded) / membershipTermsEnded)));
  });
  const operations = category(rawCategories.operations, generatedAt, 28 * 86_400_000, ['pendingApprovals', 'outstandingWorkItems'], evidence => count(evidence.pendingApprovals) + count(evidence.outstandingWorkItems) >= 1 ? [] : ['NO_RECENT_OPERATIONS_WORKLOAD_SAMPLE'], evidence => Math.min(100, Math.max(0, 100 - count(evidence.pendingApprovals) * 10 - count(evidence.outstandingWorkItems) * 5)));
  const categories = { attendanceEngagement: attendance, pipelineTrial: pipeline, retention, operations } as unknown as SchoolHealthScoreCategories;
  const allAvailable = Object.values(categories).every(item => item.status === 'AVAILABLE');
  const expectedReasons = ([['ATTENDANCE_ENGAGEMENT', attendance], ['OPERATIONS', operations], ['PIPELINE_TRIAL', pipeline], ['RETENTION', retention]] as const).flatMap(([category, item]) => item.status === 'INSUFFICIENT_DATA' ? [{ category, reasons: item.reasons }] : []);
  const rawOverall = record(root.overall, allAvailable ? ['status', 'reasons', 'score'] : ['status', 'reasons']);
  if (!Array.isArray(rawOverall.reasons) || JSON.stringify(rawOverall.reasons) !== JSON.stringify(expectedReasons)) invalid();
  const overall = allAvailable ? (() => {
    if (rawOverall.status !== 'AVAILABLE') invalid();
    const attendanceCategory = categories.attendanceEngagement; const pipelineCategory = categories.pipelineTrial;
    const retentionCategory = categories.retention; const operationsCategory = categories.operations;
    if (attendanceCategory.status !== 'AVAILABLE' || pipelineCategory.status !== 'AVAILABLE' || retentionCategory.status !== 'AVAILABLE' || operationsCategory.status !== 'AVAILABLE') invalid();
    const expected = Math.round((attendanceCategory.score * 35 + pipelineCategory.score * 25 + retentionCategory.score * 25 + operationsCategory.score * 15) / 100);
    if (boundedScore(rawOverall.score) !== expected) invalid();
    return { status: 'AVAILABLE' as const, reasons: [] as [], score: expected };
  })() : (() => { if (rawOverall.status !== 'INSUFFICIENT_DATA') invalid(); return { status: 'INSUFFICIENT_DATA' as const, reasons: expectedReasons }; })();
  return { organizationId: id(root.organizationId, organization), schoolId: id(root.schoolId, school), entitlementTier: string(root.entitlementTier, 10) as SchoolHealthScoreSnapshot['entitlementTier'], formulaVersion: 'SCHOOL_HEALTH_SCORE_V1', generatedAt, weights: { attendanceEngagement: 35, pipelineTrial: 25, retention: 25, operations: 15 }, categories, overall, indicatorStatement: INDICATOR };
}
export async function loadSchoolHealthScore(organizationId: string, schoolId: string): Promise<SchoolHealthScoreSnapshot> {
  const response = await fetch(healthScorePath(organizationId, schoolId), { method: 'GET', credentials: 'same-origin', cache: 'no-store', referrerPolicy: 'no-referrer', headers: { Accept: 'application/json' } });
  if (!response.ok) { const message = response.status === 401 ? 'Sign in with a verified human staff session, then load the Health Score.' : response.status === 403 ? 'Health Score access is not authorized for this current school. Content was cleared.' : 'The Health Score snapshot is unavailable. No result is shown.'; throw new (response.status === 401 || response.status === 403 ? HealthScoreAccessError : Error)(message, response.status); }
  let envelope: unknown; try { envelope = await response.json(); } catch { throw new Error('The Health Score response could not be verified.'); }
  const root = record(envelope, ['data', 'meta']); const data = record(root.data, ['healthScore']); return verifySchoolHealthScoreSnapshot(data.healthScore, organizationId, schoolId);
}
