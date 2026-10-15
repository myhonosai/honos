export const HON_TIERS = ['ESSENTIAL', 'CORE', 'COMPLETE'] as const;
export type HonTier = (typeof HON_TIERS)[number];

export const HON_INTERFACE_THEME_IDS = ['big-button', 'modern', 'classic'] as const;
export type HonInterfaceTheme = (typeof HON_INTERFACE_THEME_IDS)[number];

export const PRINCIPAL_TYPES = [
  'HUMAN_USER',
  'AI_EMPLOYEE',
  'AUTOMATION',
  'INTEGRATION',
  'SYSTEM_SERVICE',
] as const;
export type PrincipalType = (typeof PRINCIPAL_TYPES)[number];

export const ACTION_AUTHORITY_MODES = ['AUTO', 'CONFIRM', 'RESTRICTED'] as const;
export type ActionAuthorityMode = (typeof ACTION_AUTHORITY_MODES)[number];

export type RequestSource =
  | 'HUMAN_UI'
  | 'PUBLIC_API'
  | 'AI'
  | 'AUTOMATION'
  | 'INTEGRATION'
  | 'MIGRATION'
  | 'HQ_SUPPORT';

export interface TenantScope {
  organizationId: string;
  schoolId: string;
}

export interface CommandContext extends TenantScope {
  principalId: string;
  principalType: PrincipalType;
  requestId: string;
  correlationId: string;
  idempotencyKey: string;
  source: RequestSource;
  delegatedByPrincipalId?: string;
  actionRequestId?: string;
}

export interface ApiEnvelope<T> {
  data: T;
  meta: {
    requestId: string;
    correlationId: string;
  };
}

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  code:
    | 'TENANT_SCOPE_DENIED'
    | 'PERMISSION_DENIED'
    | 'TIER_ENTITLEMENT_REQUIRED'
    | 'POLICY_BLOCKED'
    | 'ACTION_RESTRICTED'
    | 'APPROVAL_REQUIRED'
    | 'VERSION_CONFLICT'
    | 'IDEMPOTENCY_IN_PROGRESS'
    | 'PROVIDER_DEGRADED'
    | 'PROVIDER_OUTCOME_UNKNOWN'
    | 'VALIDATION_FAILED'
    | 'PERSISTENCE_NOT_CONFIGURED';
  detail: string;
  requestId: string;
  correlationId: string;
  actionRequestId?: string;
}

export interface DomainEvent<TPayload extends Record<string, unknown> = Record<string, unknown>> {
  id: string;
  type: string;
  schemaVersion: number;
  occurredAt: string;
  tenant: TenantScope;
  aggregate: {
    type: string;
    id: string;
    version: number;
  };
  actor: {
    principalId: string;
    source: RequestSource;
    delegatedByPrincipalId?: string;
  };
  correlationId: string;
  causationId?: string;
  payload: TPayload;
}

export interface CreateLeadInput {
  pipelineId: string;
  pipelineStageId: string;
  primaryContact: {
    givenName: string;
    familyName: string;
    email?: string;
    phoneE164?: string;
  };
  sourceId?: string;
  programInterestCode?: string;
  nextFollowUpAt?: string;
  attribution?: Record<string, string>;
}

export interface LeadSummary {
  id: string;
  status: 'OPEN' | 'WON' | 'LOST' | 'ARCHIVED';
  pipelineStageId: string;
  primaryPersonId: string;
  version: number;
  createdAt: string;
}

export interface LeadListItem extends LeadSummary {
  givenName: string;
  familyName: string;
  email?: string | undefined;
  phoneE164?: string | undefined;
  nextFollowUpAt?: string | undefined;
}

export const CRM_APPOINTMENT_TYPES = ['TRIAL', 'CONSULTATION'] as const;
export type CrmAppointmentType = (typeof CRM_APPOINTMENT_TYPES)[number];

export const CRM_APPOINTMENT_STATUSES = ['SCHEDULED', 'CANCELLED', 'COMPLETED', 'NO_SHOW'] as const;
export type CrmAppointmentStatus = (typeof CRM_APPOINTMENT_STATUSES)[number];

/**
 * Public trial scheduling input. Tenant, lead, type, status, actor, and source
 * are resolved at the server boundary and are intentionally not caller inputs.
 */
export interface CreateTrialAppointmentInput {
  startsAt: string;
  endsAt: string;
  location?: string | undefined;
  notes?: string | undefined;
}

export interface CrmAppointmentSummary {
  id: string;
  crmLeadId: string;
  appointmentType: CrmAppointmentType;
  status: CrmAppointmentStatus;
  startsAt: string;
  endsAt: string;
  location?: string | undefined;
  notes?: string | undefined;
  createdByPrincipalId: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreatePersonInput {
  givenName: string;
  familyName: string;
  email?: string | undefined;
  phoneE164?: string | undefined;
}

export interface PersonSummary {
  id: string;
  givenName: string;
  familyName: string;
  email?: string | undefined;
  phoneE164?: string | undefined;
  version: number;
  createdAt: string;
}

export interface CreateFamilyInput {
  displayName: string;
}

export interface FamilySummary {
  id: string;
  displayName: string;
  status: 'ACTIVE' | 'SUSPENDED' | 'ARCHIVED';
  version: number;
  memberCount: number;
  createdAt: string;
}

export interface AddFamilyMemberInput {
  personId: string;
  memberRole: 'GUARDIAN' | 'STUDENT' | 'DEPENDENT' | 'OTHER';
  isBillingContact?: boolean | undefined;
}

export interface FamilyMemberSummary {
  id: string;
  familyId: string;
  personId: string;
  memberRole: 'GUARDIAN' | 'STUDENT' | 'DEPENDENT' | 'OTHER';
  isBillingContact: boolean;
  studentProfileId?: string | undefined;
  createdAt: string;
}

export interface CreateMembershipInput {
  billingAccountId: string;
  participantPersonId: string;
  planCode: string;
  termStartedAt?: string;
  termEndsAt?: string;
  paymentSchedule?: {
    frequency: 'WEEKLY' | 'MONTHLY' | 'ANNUAL' | 'CUSTOM';
    amountMinor: number;
    nextChargeAt?: string;
    autoRenew: boolean;
  };
}

export interface MembershipSummary {
  id: string;
  billingAccountId: string;
  participantPersonId: string;
  planCode: string;
  state: 'DRAFT' | 'ACTIVE' | 'FROZEN' | 'CANCELLATION_PENDING' | 'CANCELLED' | 'EXPIRED';
  version: number;
  paymentScheduleId?: string | undefined;
  createdAt: string;
}

export interface CreateBillingAccountInput {
  responsiblePersonId: string;
  currency?: string;
}

export interface BillingAccountSummary {
  id: string;
  responsiblePersonId: string;
  currency: string;
  version: number;
  createdAt: string;
}

export interface CreateCurriculumInput {
  name: string;
  description?: string;
  modelCode: 'LINEAR' | 'ROTATIONAL' | 'HYBRID' | 'SKILL_BASED' | 'MODULE_BASED' | 'ATTENDANCE_PLUS_APPROVAL' | 'CUSTOM';
}

export interface CurriculumSummary {
  id: string;
  name: string;
  description?: string | undefined;
  lifecycle: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
  modelCode: CreateCurriculumInput['modelCode'];
  version: number;
  createdAt: string;
}

export interface CreateCurriculumRankInput {
  name: string;
  progressionOrder: number;
  displayColor?: string;
  exposureRequirement?: Record<string, unknown>;
  masteryRequirement?: Record<string, unknown>;
  promotionRequirement?: Record<string, unknown>;
}

export interface CurriculumRankSummary {
  id: string;
  curriculumId: string;
  name: string;
  progressionOrder: number;
  displayColor?: string | undefined;
  version: number;
  createdAt: string;
}

export const SCHEDULE_ITEM_STATUSES = ['DRAFT', 'SCHEDULED', 'CANCELLED', 'COMPLETED'] as const;
export type ScheduleItemStatus = (typeof SCHEDULE_ITEM_STATUSES)[number];

export interface CreateProgramInput {
  name: string;
  description?: string | undefined;
  minimumAgeMonths?: number | undefined;
  maximumAgeMonths?: number | undefined;
}

export interface ProgramSummary {
  id: string;
  name: string;
  description?: string | undefined;
  minimumAgeMonths?: number | undefined;
  maximumAgeMonths?: number | undefined;
  status: ScheduleItemStatus;
  version: number;
  createdAt: string;
}

export const CLASS_SESSION_BOOKING_POLICIES = [
  'WALK_IN',
  'OPTIONAL_BOOKING',
  'REQUIRED_BOOKING',
] as const;
export type ClassSessionBookingPolicy = (typeof CLASS_SESSION_BOOKING_POLICIES)[number];

export interface CreateClassSessionInput {
  programId: string;
  name: string;
  startsAt: string;
  endsAt: string;
  capacity: number;
  bookingPolicy: ClassSessionBookingPolicy;
  roomName?: string | undefined;
}

export interface ClassSessionSummary {
  id: string;
  programId: string;
  name: string;
  roomName?: string | undefined;
  startsAt: string;
  endsAt: string;
  capacity: number;
  bookingPolicy: ClassSessionBookingPolicy;
  status: ScheduleItemStatus;
  version: number;
  createdAt: string;
}

/** The only staff-selectable booking intents. Source and actor are server-derived. */
export const CLASS_BOOKING_KINDS = [
  'REGULAR',
  'TRIAL',
  'MAKEUP',
  'PRIVATE_LESSON',
  'EVENT',
] as const;
export type ClassBookingKind = (typeof CLASS_BOOKING_KINDS)[number];

export const CLASS_BOOKING_STATUSES = [
  'BOOKED',
  'WAITLISTED',
  'CANCELLED',
  'CHECKED_IN',
  'NO_SHOW',
] as const;
export type ClassBookingStatus = (typeof CLASS_BOOKING_STATUSES)[number];

export type ClassBookingSource = 'STAFF' | 'PARENT_APP' | 'AUTOMATION' | 'INTEGRATION';

export interface CreateClassBookingInput {
  studentProfileId: string;
  bookingKind: ClassBookingKind;
}

/**
 * Capacity metadata is a snapshot of the session decision made atomically
 * with this command. WALK_IN may have activeSeatCount above sessionCapacity.
 */
export interface ClassBookingSummary {
  id: string;
  classSessionId: string;
  studentProfileId: string;
  bookingKind: ClassBookingKind;
  status: ClassBookingStatus;
  source: ClassBookingSource;
  bookedAt: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  sessionCapacity: number;
  bookingPolicy: ClassSessionBookingPolicy;
  activeSeatCount: number;
}

/** Parent/Eian planned absence requests are reviewable records, not attendance or booking mutations. */
export const PLANNED_ABSENCE_REQUEST_STATUSES = [
  'SUBMITTED',
  'APPROVED',
  'DECLINED',
  'CANCELLED',
] as const;
export type PlannedAbsenceRequestStatus = (typeof PLANNED_ABSENCE_REQUEST_STATUSES)[number];

export interface CreatePlannedAbsenceRequestInput {
  studentProfileId: string;
  startsAt: string;
  endsAt: string;
  reason?: string | undefined;
}

/** The parent command response deliberately omits reviewer and other-family data. */
export interface PlannedAbsenceRequestSummary {
  id: string;
  studentProfileId: string;
  startsAt: string;
  endsAt: string;
  reason?: string | undefined;
  status: PlannedAbsenceRequestStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
}

/** The only final decisions a human staff reviewer can record. */
export const PLANNED_ABSENCE_REVIEW_DECISIONS = ['APPROVED', 'DECLINED'] as const;
export type PlannedAbsenceReviewDecision = (typeof PLANNED_ABSENCE_REVIEW_DECISIONS)[number];

/**
 * This staff-only command intentionally accepts no reviewer, tenant, source,
 * booking, attendance, makeup, payment, or communication data.
 */
export interface DecidePlannedAbsenceRequestInput {
  decision: PlannedAbsenceReviewDecision;
  reviewNote: string;
  expectedVersion: number;
}

/** Staff review result; parent request responses remain separately redacted. */
export interface PlannedAbsenceReviewSummary {
  id: string;
  studentProfileId: string;
  startsAt: string;
  endsAt: string;
  reason?: string | undefined;
  status: PlannedAbsenceReviewDecision;
  reviewedByPrincipalId: string;
  reviewedAt: string;
  reviewNote: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export const ATTENDANCE_STATUSES = [
  'PRESENT',
  'LATE',
  'EXCUSED_ABSENCE',
  'UNEXCUSED_ABSENCE',
  'MAKEUP',
] as const;
export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number];

export interface RecordAttendanceInput {
  studentProfileId: string;
  status: AttendanceStatus;
  note?: string | undefined;
  /** Required when changing an attendance record already present for the session/student pair. */
  expectedVersion?: number | undefined;
}

export interface AttendanceRecordSummary {
  id: string;
  classSessionId: string;
  studentProfileId: string;
  classBookingId?: string | undefined;
  status: AttendanceStatus;
  recordedByPrincipalId?: string | undefined;
  recordedAt: string;
  note?: string | undefined;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export const TESTING_CANDIDATE_RESULTS = [
  'PENDING',
  'PASSED',
  'DEFERRED',
  'NOT_PASSED',
  'WITHDRAWN',
] as const;
export type TestingCandidateResult = (typeof TESTING_CANDIDATE_RESULTS)[number];

/** Results an instructor may record for an already registered candidate. */
export const TESTING_CANDIDATE_GRADE_RESULTS = [
  'PASSED',
  'DEFERRED',
  'NOT_PASSED',
  'WITHDRAWN',
] as const;
export type TestingCandidateGradeResult = (typeof TESTING_CANDIDATE_GRADE_RESULTS)[number];

export interface RegisterTestingCandidateInput {
  studentCurriculumEnrollmentId: string;
  targetRankId: string;
  instructorNotes?: string | undefined;
}

/**
 * A human instructor's version-checked assessment of a testing candidate.
 * This records the assessment only; promotion remains a separate workflow.
 */
export interface GradeTestingCandidateInput {
  result: TestingCandidateGradeResult;
  instructorNotes?: string | undefined;
  expectedVersion: number;
}

export interface TestingCandidateSummary {
  id: string;
  testingEventId: string;
  studentCurriculumEnrollmentId: string;
  targetRankId: string;
  result: TestingCandidateResult;
  instructorNotes?: string | undefined;
  version: number;
  createdAt: string;
}

/** Final outcomes a human instructor may record for a final testing candidate. */
export const PROMOTION_DECISION_STATUSES = [
  'PROMOTED',
  'DEFERRED',
  'NOT_PROMOTED',
] as const;
export type PromotionDecisionStatus = (typeof PROMOTION_DECISION_STATUSES)[number];

/** This human-only command intentionally has no actor, AI, or source fields. */
export interface DecidePromotionInput {
  status: PromotionDecisionStatus;
  rationale: string;
}

export interface PromotionDecisionSummary {
  id: string;
  testingCandidateId: string;
  studentCurriculumEnrollmentId: string;
  priorRankId?: string | undefined;
  targetRankId: string;
  status: PromotionDecisionStatus;
  instructorPrincipalId: string;
  rationale: string;
  decidedAt: string;
  version: number;
  createdAt: string;
}

/** The access level was resolved from a live, explicit family grant. */
export type ParentFamilyAccessLevel = 'PRIMARY_GUARDIAN' | 'SECONDARY_GUARDIAN' | 'VIEWER';

/** A deliberately minimal rank representation suitable for a parent progress view. */
export interface ParentStudentJourneyRank {
  id: string;
  name: string;
  progressionOrder: number;
}

/** A selected student's own active or historical curriculum enrollment. */
export interface ParentStudentJourneyEnrollment {
  id: string;
  status: 'ACTIVE' | 'SUSPENDED' | 'ARCHIVED';
  enrolledAt: string;
  curriculum: {
    id: string;
    name: string;
  };
  currentRank?: ParentStudentJourneyRank | undefined;
  testingCandidates: ParentStudentJourneyTestingCandidate[];
}

/**
 * An instructor decision is intentionally redacted to readiness data. It never
 * exposes the instructor identity, rationale, notes, or school-wide results.
 */
export interface ParentStudentJourneyPromotionDecision {
  id: string;
  status: PromotionDecisionStatus | 'PENDING_INSTRUCTOR_DECISION';
  decidedAt?: string | undefined;
}

/** A candidate for this student's own enrollment, not a testing-event roster. */
export interface ParentStudentJourneyTestingCandidate {
  id: string;
  result: TestingCandidateResult;
  createdAt: string;
  testingEvent: {
    id: string;
    name: string;
    startsAt: string;
    status: 'DRAFT' | 'OPEN' | 'CLOSED' | 'COMPLETED' | 'CANCELLED';
  };
  targetRank: ParentStudentJourneyRank;
  promotionDecision?: ParentStudentJourneyPromotionDecision | undefined;
}

/**
 * Parent/Eian read model. It deliberately omits contact details, birth dates,
 * billing, staff, instructor notes, and every record outside the selected family.
 */
export interface ParentStudentJourneyStudent {
  familyMemberId: string;
  person: {
    id: string;
    givenName: string;
    familyName: string;
  };
  studentProfile?: {
    id: string;
    status: 'ACTIVE' | 'SUSPENDED' | 'ARCHIVED';
  } | undefined;
  curriculumEnrollments: ParentStudentJourneyEnrollment[];
}

export interface ParentStudentJourney {
  familyId: string;
  accessLevel: ParentFamilyAccessLevel;
  students: ParentStudentJourneyStudent[];
}

export type {
  ParentFamilySchedule,
  ParentFamilyScheduleBooking,
} from './parent-family-schedule.js';

export type {
  ParentFamilyKnowledge,
  ParentFamilyKnowledgeArticle,
} from './parent-family-knowledge.js';

export * from './knowledge-articles.js';
export * from './work-items.js';
export * from './ai-usage.js';
export * from './operations-report.js';

export interface RegisteredAction {
  code: string;
  requiredPermission: string;
  minimumTier: HonTier;
  platformAuthorityFloor: ActionAuthorityMode;
  riskClass: 'LOW' | 'MODERATE' | 'FINANCIAL' | 'PUBLICATION' | 'SENSITIVE';
}

export type AiUsageModality = 'TEXT' | 'VOICE_INPUT' | 'VOICE_OUTPUT' | 'IMAGE' | 'VIDEO' | 'EMBEDDING' | 'TOOL_EXECUTION';

export interface AiUsageRecord extends TenantScope {
  id: string;
  initiatorPrincipalId?: string;
  agentPrincipalId?: string;
  workItemId?: string;
  actionRequestId?: string;
  providerCode: string;
  modelCode: string;
  modality: AiUsageModality;
  inputUnits: number;
  outputUnits: number;
  providerCostMicrounits: number;
  customerCredits: number;
  correlationId: string;
  occurredAt: string;
}
