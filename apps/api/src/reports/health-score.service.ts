import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import type {
  HealthScoreCategory,
  HealthScoreCategoryReason,
  SchoolHealthScoreCategoryId,
  SchoolHealthScoreCategories,
  SchoolHealthScoreProjection,
  SchoolHealthScoreSnapshot,
} from '@hon/contracts';
import { SCHOOL_HEALTH_SCORE_FORMULA_VERSION } from '@hon/contracts';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const UNSAFE = /[\x00-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/;
const INDICATOR_STATEMENT = 'Operational indicator only. It is not a forecast, cancellation/churn certainty, cash-revenue measure, or recommendation for consequential changes.' as const;
const CATEGORY_ORDER: Array<[SchoolHealthScoreCategoryId, keyof SchoolHealthScoreCategories]> = [
  ['ATTENDANCE_ENGAGEMENT', 'attendanceEngagement'],
  ['OPERATIONS', 'operations'],
  ['PIPELINE_TRIAL', 'pipelineTrial'],
  ['RETENTION', 'retention'],
];

type Row = Record<string, unknown>;
function invalid(message = 'Invalid HON School Health Score projection.'): never { throw new Error(message); }
function row(value: unknown, keys: readonly string[]): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const source = value as Row;
  if (Object.keys(source).length !== keys.length || keys.some((key) => !Object.hasOwn(source, key))) invalid();
  return source;
}
function text(value: unknown, max = 240): string {
  if (typeof value !== 'string' || !value || value.length > max || UNSAFE.test(value)) invalid();
  return value;
}
function timestamp(value: unknown): string {
  const source = text(value, 80);
  if (!UTC.test(source)) invalid();
  const parsed = new Date(source);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== source) invalid();
  return source;
}
function safeCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) invalid();
  return value;
}
function score(value: unknown): number {
  const result = safeCount(value);
  if (result > 100) invalid();
  return result;
}
function scopedId(value: unknown, expected: string): string {
  const id = text(value, 36).toLowerCase();
  if (!UUID.test(id) || id !== expected) invalid();
  return id;
}
function reasons(value: unknown, expected: HealthScoreCategoryReason[]): HealthScoreCategoryReason[] {
  if (!Array.isArray(value) || value.length !== expected.length || value.some((item, index) => item !== expected[index])) invalid();
  return expected;
}
function categoryBase(value: unknown, duration: number, generatedAt: string, evidenceKeys: readonly string[]) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const source = value as Row;
  const allowed = source.status === 'AVAILABLE' ? ['status', 'windowFrom', 'windowTo', 'evidence', 'reasons', 'score'] : ['status', 'windowFrom', 'windowTo', 'evidence', 'reasons'];
  if (Object.keys(source).length !== allowed.length || allowed.some((key) => !Object.hasOwn(source, key))) invalid();
  if (source.status !== 'AVAILABLE' && source.status !== 'INSUFFICIENT_DATA') invalid();
  const windowFrom = timestamp(source.windowFrom); const windowTo = timestamp(source.windowTo);
  if (windowTo !== generatedAt || Date.parse(windowTo) - Date.parse(windowFrom) !== duration) invalid();
  return { source, windowFrom, windowTo, evidence: row(source.evidence, evidenceKeys) };
}
function attendance(value: unknown, generatedAt: string): HealthScoreCategory<{ completedSessions: number; recordedAttendanceObservations: number; engagedAttendanceObservations: number }> {
  const base = categoryBase(value, 28 * 86_400_000, generatedAt, ['completedSessions', 'recordedAttendanceObservations', 'engagedAttendanceObservations']);
  const completedSessions = safeCount(base.evidence.completedSessions);
  const recordedAttendanceObservations = safeCount(base.evidence.recordedAttendanceObservations);
  const engagedAttendanceObservations = safeCount(base.evidence.engagedAttendanceObservations);
  if (engagedAttendanceObservations > recordedAttendanceObservations) invalid();
  const sufficient = completedSessions >= 4 && recordedAttendanceObservations >= 20;
  const expectedReasons: HealthScoreCategoryReason[] = [
    ...(completedSessions < 4 ? ['MIN_COMPLETED_SESSIONS' as const] : []),
    ...(recordedAttendanceObservations < 20 ? ['MIN_RECORDED_ATTENDANCE_OBSERVATIONS' as const] : []),
  ];
  reasons(base.source.reasons, expectedReasons);
  const evidence = { completedSessions, recordedAttendanceObservations, engagedAttendanceObservations };
  if (!sufficient || base.source.status !== 'AVAILABLE') {
    if (sufficient || base.source.status !== 'INSUFFICIENT_DATA') invalid();
    return { status: 'INSUFFICIENT_DATA', windowFrom: base.windowFrom, windowTo: base.windowTo, evidence, reasons: expectedReasons };
  }
  const expected = Math.min(100, Math.max(0, Math.round(100 * engagedAttendanceObservations / recordedAttendanceObservations)));
  if (score(base.source.score) !== expected) invalid();
  return { status: 'AVAILABLE', windowFrom: base.windowFrom, windowTo: base.windowTo, evidence, reasons: [], score: expected };
}
function pipeline(value: unknown, generatedAt: string): HealthScoreCategory<{ leadsCreated: number; trialAppointments: number; trialOutcomesRecorded: number }> {
  const base = categoryBase(value, 56 * 86_400_000, generatedAt, ['leadsCreated', 'trialAppointments', 'trialOutcomesRecorded']);
  const leadsCreated = safeCount(base.evidence.leadsCreated); const trialAppointments = safeCount(base.evidence.trialAppointments); const trialOutcomesRecorded = safeCount(base.evidence.trialOutcomesRecorded);
  if (trialOutcomesRecorded > trialAppointments) invalid();
  const sufficient = leadsCreated >= 5 && trialAppointments >= 3;
  const expectedReasons: HealthScoreCategoryReason[] = [...(leadsCreated < 5 ? ['MIN_RECENT_LEADS' as const] : []), ...(trialAppointments < 3 ? ['MIN_RECENT_TRIAL_APPOINTMENTS' as const] : [])];
  reasons(base.source.reasons, expectedReasons);
  const evidence = { leadsCreated, trialAppointments, trialOutcomesRecorded };
  if (!sufficient || base.source.status !== 'AVAILABLE') {
    if (sufficient || base.source.status !== 'INSUFFICIENT_DATA') invalid();
    return { status: 'INSUFFICIENT_DATA', windowFrom: base.windowFrom, windowTo: base.windowTo, evidence, reasons: expectedReasons };
  }
  const expected = Math.min(100, Math.max(0, Math.round(100 * trialOutcomesRecorded / trialAppointments)));
  if (score(base.source.score) !== expected) invalid();
  return { status: 'AVAILABLE', windowFrom: base.windowFrom, windowTo: base.windowTo, evidence, reasons: [], score: expected };
}
function retention(value: unknown, generatedAt: string): HealthScoreCategory<{ membershipTermsEnded: number; renewalReviewsRecorded: number }> {
  const base = categoryBase(value, 90 * 86_400_000, generatedAt, ['membershipTermsEnded', 'renewalReviewsRecorded']);
  const membershipTermsEnded = safeCount(base.evidence.membershipTermsEnded); const renewalReviewsRecorded = safeCount(base.evidence.renewalReviewsRecorded);
  const sufficient = membershipTermsEnded >= 5 && renewalReviewsRecorded >= 3;
  const expectedReasons: HealthScoreCategoryReason[] = [...(membershipTermsEnded < 5 ? ['MIN_MEMBERSHIP_TERMS_ENDED' as const] : []), ...(renewalReviewsRecorded < 3 ? ['MIN_RENEWAL_REVIEWS_RECORDED' as const] : [])];
  reasons(base.source.reasons, expectedReasons);
  const evidence = { membershipTermsEnded, renewalReviewsRecorded };
  if (!sufficient || base.source.status !== 'AVAILABLE') {
    if (sufficient || base.source.status !== 'INSUFFICIENT_DATA') invalid();
    return { status: 'INSUFFICIENT_DATA', windowFrom: base.windowFrom, windowTo: base.windowTo, evidence, reasons: expectedReasons };
  }
  const expected = Math.min(100, Math.max(0, Math.round(100 * renewalReviewsRecorded / membershipTermsEnded)));
  if (score(base.source.score) !== expected) invalid();
  return { status: 'AVAILABLE', windowFrom: base.windowFrom, windowTo: base.windowTo, evidence, reasons: [], score: expected };
}
function operations(value: unknown, generatedAt: string): HealthScoreCategory<{ pendingApprovals: number; outstandingWorkItems: number }> {
  const base = categoryBase(value, 28 * 86_400_000, generatedAt, ['pendingApprovals', 'outstandingWorkItems']);
  const pendingApprovals = safeCount(base.evidence.pendingApprovals); const outstandingWorkItems = safeCount(base.evidence.outstandingWorkItems);
  const sufficient = pendingApprovals + outstandingWorkItems >= 1;
  const expectedReasons: HealthScoreCategoryReason[] = sufficient ? [] : ['NO_RECENT_OPERATIONS_WORKLOAD_SAMPLE'];
  reasons(base.source.reasons, expectedReasons);
  const evidence = { pendingApprovals, outstandingWorkItems };
  if (!sufficient || base.source.status !== 'AVAILABLE') {
    if (sufficient || base.source.status !== 'INSUFFICIENT_DATA') invalid();
    return { status: 'INSUFFICIENT_DATA', windowFrom: base.windowFrom, windowTo: base.windowTo, evidence, reasons: expectedReasons };
  }
  const expected = Math.min(100, Math.max(0, 100 - pendingApprovals * 10 - outstandingWorkItems * 5));
  if (score(base.source.score) !== expected) invalid();
  return { status: 'AVAILABLE', windowFrom: base.windowFrom, windowTo: base.windowTo, evidence, reasons: [], score: expected };
}
function overall(value: unknown, categories: SchoolHealthScoreCategories) {
  const allAvailable = Object.values(categories).every((category) => category.status === 'AVAILABLE');
  const expectedReasons = CATEGORY_ORDER.flatMap(([categoryId, key]) => categories[key].status === 'INSUFFICIENT_DATA' ? [{ category: categoryId, reasons: categories[key].reasons }] : []);
  const source = row(value, allAvailable ? ['status', 'reasons', 'score'] : ['status', 'reasons']);
  if (!Array.isArray(source.reasons) || JSON.stringify(source.reasons) !== JSON.stringify(expectedReasons)) invalid();
  if (allAvailable) {
    if (source.status !== 'AVAILABLE') invalid();
    const attendance = categories.attendanceEngagement;
    const pipeline = categories.pipelineTrial;
    const retention = categories.retention;
    const operations = categories.operations;
    if (attendance.status !== 'AVAILABLE' || pipeline.status !== 'AVAILABLE' || retention.status !== 'AVAILABLE' || operations.status !== 'AVAILABLE') invalid();
    const expected = Math.min(100, Math.max(0, Math.round((attendance.score * 35 + pipeline.score * 25 + retention.score * 25 + operations.score * 15) / 100)));
    if (score(source.score) !== expected) invalid();
    return { status: 'AVAILABLE' as const, reasons: [] as [], score: expected };
  }
  if (source.status !== 'INSUFFICIENT_DATA') invalid();
  return { status: 'INSUFFICIENT_DATA' as const, reasons: expectedReasons };
}

@Injectable()
export class HealthScoreService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  async read(externalSubject: string, organizationId: string, schoolId: string): Promise<SchoolHealthScoreSnapshot> {
    organizationId = organizationId.toLowerCase(); schoolId = schoolId.toLowerCase();
    if (!UUID.test(organizationId) || !UUID.test(schoolId)) throw new BadRequestException({ code: 'VALIDATION_FAILED', detail: 'A known organization and school UUID are required.' });
    let source: SchoolHealthScoreProjection;
    try {
      source = await this.database.readSchoolHealthScore(externalSubject, organizationId, schoolId);
    } catch (error) {
      const failure = error as { code?: string; message?: string } | undefined;
      if (failure?.code === '42501') {
        const tier = failure.message === 'TIER_ENTITLEMENT_REQUIRED';
        throw new ForbiddenException({ code: tier ? 'TIER_ENTITLEMENT_REQUIRED' : 'SCHOOL_HEALTH_SCORE_FORBIDDEN', detail: tier ? 'An active Essential, Core, or Complete entitlement is required.' : 'School Health Score is not authorized for this school.' });
      }
      if (failure?.code === '22023') throw new BadRequestException({ code: 'VALIDATION_FAILED', detail: 'A known organization and school UUID are required.' });
      throw error;
    }
    const root = row(source, ['organizationId', 'schoolId', 'entitlementTier', 'formulaVersion', 'generatedAt', 'weights', 'categories', 'overall']);
    const entitlementTier = text(root.entitlementTier, 10);
    if (!['ESSENTIAL', 'CORE', 'COMPLETE'].includes(entitlementTier)) invalid();
    if (text(root.formulaVersion, 64) !== SCHOOL_HEALTH_SCORE_FORMULA_VERSION) invalid();
    const generatedAt = timestamp(root.generatedAt);
    const weights = row(root.weights, ['attendanceEngagement', 'pipelineTrial', 'retention', 'operations']);
    if (weights.attendanceEngagement !== 35 || weights.pipelineTrial !== 25 || weights.retention !== 25 || weights.operations !== 15) invalid();
    const sourceCategories = row(root.categories, ['attendanceEngagement', 'pipelineTrial', 'retention', 'operations']);
    const categories: SchoolHealthScoreCategories = {
      attendanceEngagement: attendance(sourceCategories.attendanceEngagement, generatedAt),
      pipelineTrial: pipeline(sourceCategories.pipelineTrial, generatedAt),
      retention: retention(sourceCategories.retention, generatedAt),
      operations: operations(sourceCategories.operations, generatedAt),
    };
    return {
      organizationId: scopedId(root.organizationId, organizationId), schoolId: scopedId(root.schoolId, schoolId),
      entitlementTier: entitlementTier as SchoolHealthScoreSnapshot['entitlementTier'], formulaVersion: SCHOOL_HEALTH_SCORE_FORMULA_VERSION,
      generatedAt, weights: { attendanceEngagement: 35, pipelineTrial: 25, retention: 25, operations: 15 }, categories,
      overall: overall(root.overall, categories), indicatorStatement: INDICATOR_STATEMENT,
    };
  }
}
