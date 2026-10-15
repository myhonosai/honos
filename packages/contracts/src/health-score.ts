import type { TenantScope } from './index.js';

/** Versioned, code-owned operational-indicator formula; never a forecast. */
export const SCHOOL_HEALTH_SCORE_FORMULA_VERSION = 'SCHOOL_HEALTH_SCORE_V1' as const;
export type SchoolHealthScoreTier = 'ESSENTIAL' | 'CORE' | 'COMPLETE';
export type SchoolHealthScoreStatus = 'AVAILABLE' | 'INSUFFICIENT_DATA';

export interface SchoolHealthScoreWeights {
  attendanceEngagement: 35;
  pipelineTrial: 25;
  retention: 25;
  operations: 15;
}

export interface HealthScoreAttendanceEvidence {
  completedSessions: number;
  recordedAttendanceObservations: number;
  engagedAttendanceObservations: number;
}
export interface HealthScorePipelineEvidence {
  leadsCreated: number;
  trialAppointments: number;
  trialOutcomesRecorded: number;
}
export interface HealthScoreRetentionEvidence {
  membershipTermsEnded: number;
  renewalReviewsRecorded: number;
}
export interface HealthScoreOperationsEvidence {
  pendingApprovals: number;
  outstandingWorkItems: number;
}

export type HealthScoreCategoryReason =
  | 'MIN_COMPLETED_SESSIONS'
  | 'MIN_RECORDED_ATTENDANCE_OBSERVATIONS'
  | 'MIN_RECENT_LEADS'
  | 'MIN_RECENT_TRIAL_APPOINTMENTS'
  | 'MIN_MEMBERSHIP_TERMS_ENDED'
  | 'MIN_RENEWAL_REVIEWS_RECORDED'
  | 'NO_RECENT_OPERATIONS_WORKLOAD_SAMPLE';

export interface HealthScoreAvailableCategory<TEvidence> {
  status: 'AVAILABLE';
  windowFrom: string;
  windowTo: string;
  evidence: TEvidence;
  /** Available categories have no insufficiency reason. */
  reasons: [];
  /** Bounded deterministic subscore; no predictive meaning. */
  score: number;
}
export interface HealthScoreInsufficientCategory<TEvidence> {
  status: 'INSUFFICIENT_DATA';
  windowFrom: string;
  windowTo: string;
  evidence: TEvidence;
  /** Code-owned sample-gate reasons, never row text. */
  reasons: HealthScoreCategoryReason[];
}
export type HealthScoreCategory<TEvidence> = HealthScoreAvailableCategory<TEvidence> | HealthScoreInsufficientCategory<TEvidence>;

export interface SchoolHealthScoreCategories {
  attendanceEngagement: HealthScoreCategory<HealthScoreAttendanceEvidence>;
  pipelineTrial: HealthScoreCategory<HealthScorePipelineEvidence>;
  retention: HealthScoreCategory<HealthScoreRetentionEvidence>;
  operations: HealthScoreCategory<HealthScoreOperationsEvidence>;
}
export type SchoolHealthScoreCategoryId = 'ATTENDANCE_ENGAGEMENT' | 'PIPELINE_TRIAL' | 'RETENTION' | 'OPERATIONS';
export interface HealthScoreInsufficiency {
  category: SchoolHealthScoreCategoryId;
  reasons: HealthScoreCategoryReason[];
}
export interface SchoolHealthScoreAvailableOverall {
  status: 'AVAILABLE';
  reasons: [];
  score: number;
}
export interface SchoolHealthScoreInsufficientOverall {
  status: 'INSUFFICIENT_DATA';
  reasons: HealthScoreInsufficiency[];
}
export type SchoolHealthScoreOverall = SchoolHealthScoreAvailableOverall | SchoolHealthScoreInsufficientOverall;

/** Exact fixed SQL projection: aggregates/evidence/status only; no display prose. */
export interface SchoolHealthScoreProjection extends TenantScope {
  entitlementTier: SchoolHealthScoreTier;
  formulaVersion: typeof SCHOOL_HEALTH_SCORE_FORMULA_VERSION;
  generatedAt: string;
  weights: SchoolHealthScoreWeights;
  categories: SchoolHealthScoreCategories;
  overall: SchoolHealthScoreOverall;
}

/** Server-rebuilt display strings only; SQL never supplies human-facing prose. */
export interface SchoolHealthScoreSnapshot extends SchoolHealthScoreProjection {
  indicatorStatement: 'Operational indicator only. It is not a forecast, cancellation/churn certainty, cash-revenue measure, or recommendation for consequential changes.';
}
export interface SchoolHealthScoreResponse {
  healthScore: SchoolHealthScoreSnapshot;
}
