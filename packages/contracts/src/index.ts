export * from './human-work-items.js';
export * from './marketing-campaigns.js';
export * from './revenue-planning.js';
export * from './search.js';
export * from './staff-roles.js';
export * from './command-center.js';
export * from './health-score.js';
export * from './ai-invocation-plan.js';
export * from './curriculum-progress.js';
export * from './lead-import.js';
export * from './ai-provider.js';
export * from './parent-billing-view.js';
export * from './parent-testing-status.js';
export * from './parent-planned-absence-history.js';

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
  campaignId?: string;
  campaignCode?: string;
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

/** The only final states a human may record for an already scheduled trial. */
export const CRM_TRIAL_OUTCOME_STATUSES = ['COMPLETED', 'NO_SHOW', 'CANCELLED'] as const;
export type CrmTrialOutcomeStatus = (typeof CRM_TRIAL_OUTCOME_STATUSES)[number];

/**
 * A human staff outcome record. Appointment identity, tenant, actor, source,
 * and appointment type remain server-derived and cannot be supplied by callers.
 */
export interface RecordTrialAppointmentOutcomeInput {
  status: CrmTrialOutcomeStatus;
  outcomeNotes?: string | undefined;
  expectedVersion: number;
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

/** Human activation accepts only the version observed by the operator. */
export interface ActivateMembershipInput {
  expectedVersion: number;
}

/** Activation can return only the schema-supported ACTIVE membership state. */
export interface ActivatedMembershipSummary {
  id: string;
  billingAccountId: string;
  participantPersonId: string;
  planCode: string;
  state: 'ACTIVE';
  version: number;
  createdAt: string;
}

/** A direct human cancellation is an optimistic ACTIVE-to-CANCELLED transition. */
export interface CancelMembershipInput {
  expectedVersion: number;
  cancellationReason: string;
  /** Optional timezone-qualified effective timestamp evidenced with the cancellation. */
  effectiveAt?: string | undefined;
}

/** Direct cancellation returns only the schema-supported terminal CANCELLED state. */
export interface CancelledMembershipSummary {
  id: string;
  billingAccountId: string;
  participantPersonId: string;
  planCode: string;
  state: 'CANCELLED';
  version: number;
  cancellationReason: string;
  effectiveAt?: string | undefined;
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

/** Active ISO 4217 alphabetic codes accepted by conventional billing commands. */
export const ISO_4217_CURRENCIES = [
  'AED', 'AFN', 'ALL', 'AMD', 'ANG', 'AOA', 'ARS', 'AUD', 'AWG', 'AZN',
  'BAM', 'BBD', 'BDT', 'BGN', 'BHD', 'BIF', 'BMD', 'BND', 'BOB', 'BOV', 'BRL', 'BSD', 'BTN', 'BWP', 'BYN', 'BZD',
  'CAD', 'CDF', 'CHE', 'CHF', 'CHW', 'CLF', 'CLP', 'CNY', 'COP', 'COU', 'CRC', 'CUP', 'CVE', 'CZK',
  'DJF', 'DKK', 'DOP', 'DZD',
  'EGP', 'ERN', 'ETB', 'EUR',
  'FJD', 'FKP',
  'GBP', 'GEL', 'GHS', 'GIP', 'GMD', 'GNF', 'GTQ', 'GYD',
  'HKD', 'HNL', 'HRK', 'HTG', 'HUF',
  'IDR', 'ILS', 'INR', 'IQD', 'IRR', 'ISK',
  'JMD', 'JOD', 'JPY',
  'KES', 'KGS', 'KHR', 'KMF', 'KPW', 'KRW', 'KWD', 'KYD', 'KZT',
  'LAK', 'LBP', 'LKR', 'LRD', 'LSL', 'LYD',
  'MAD', 'MDL', 'MGA', 'MKD', 'MMK', 'MNT', 'MOP', 'MRU', 'MUR', 'MVR', 'MWK', 'MXN', 'MXV', 'MYR', 'MZN',
  'NAD', 'NGN', 'NIO', 'NOK', 'NPR', 'NZD',
  'OMR',
  'PAB', 'PEN', 'PGK', 'PHP', 'PKR', 'PLN', 'PYG',
  'QAR',
  'RON', 'RSD', 'RUB', 'RWF',
  'SAR', 'SBD', 'SCR', 'SDG', 'SEK', 'SGD', 'SHP', 'SLE', 'SOS', 'SRD', 'SSP', 'STN', 'SVC', 'SYP', 'SZL',
  'THB', 'TJS', 'TMT', 'TND', 'TOP', 'TRY', 'TTD', 'TWD', 'TZS',
  'UAH', 'UGX', 'USD', 'USN', 'UYI', 'UYU', 'UYW', 'UZS',
  'VED', 'VES', 'VND', 'VUV',
  'WST',
  'XAF', 'XAG', 'XAU', 'XBA', 'XBB', 'XBC', 'XBD', 'XCD', 'XDR', 'XOF', 'XPD', 'XPF', 'XPT', 'XSU', 'XTS', 'XUA', 'XXX',
  'YER',
  'ZAR', 'ZMW', 'ZWG', 'ZWL',
] as const;
export type Iso4217Currency = (typeof ISO_4217_CURRENCIES)[number];

/** Tenant, initial state, total, and discount are derived by the server. */
export interface CreateInvoiceDraftInput {
  billingAccountId: string;
  membershipId?: string | undefined;
  dueAt: string;
  currency: Iso4217Currency;
  subtotalMinor: number;
}

/** The create command can return only a non-issued DRAFT invoice. */
export interface InvoiceDraftSummary {
  id: string;
  billingAccountId: string;
  membershipId?: string | undefined;
  status: 'DRAFT';
  currency: string;
  subtotalMinor: number;
  discountMinor: 0;
  totalMinor: number;
  dueAt: string;
  version: number;
  createdAt: string;
}

/** Issuance is a human-only optimistic-concurrency transition from DRAFT. */
export interface IssueInvoiceInput {
  expectedVersion: number;
}

/** The issue command returns only the schema-supported ISSUED invoice state. */
export interface InvoiceIssuedSummary {
  id: string;
  billingAccountId: string;
  membershipId?: string | undefined;
  status: 'ISSUED';
  currency: string;
  subtotalMinor: number;
  discountMinor: number;
  totalMinor: number;
  dueAt?: string | undefined;
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
  /** Current explicit human observations only; empty without a supported secure projection. */
  requirementProgress?: import('./curriculum-progress.js').ParentCurriculumRequirementProgress[];
}

/**
 * An instructor decision is intentionally redacted to recorded decision data. It never
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
export * from './operations-summary.js';
export * from './ai-team.js';

/** Communication channels whose consent may be evidenced for a person. */
export const COMMUNICATION_CONSENT_CHANNELS = ['SMS', 'EMAIL', 'PUSH'] as const;
export type CommunicationConsentChannel = (typeof COMMUNICATION_CONSENT_CHANNELS)[number];

export const COMMUNICATION_CONSENT_STATUSES = ['OPTED_IN', 'OPTED_OUT'] as const;
export type CommunicationConsentStatus = (typeof COMMUNICATION_CONSENT_STATUSES)[number];

/** Provenance is evidence metadata, distinct from CommandContext.source. */
export const COMMUNICATION_CONSENT_SOURCES = ['STAFF', 'PARENT', 'IMPORT'] as const;
export type CommunicationConsentSource = (typeof COMMUNICATION_CONSENT_SOURCES)[number];

/**
 * Staff may record only STAFF evidence through this endpoint. Tenant, person,
 * channel, actor, and command source are established by the route/server.
 */
export interface RecordCommunicationConsentInput {
  status: CommunicationConsentStatus;
  source: 'STAFF';
  capturedAt: string;
  /** Required only when replacing an existing person/channel consent record. */
  expectedVersion?: number | undefined;
}

/** Narrow representation: no contact address, tenant metadata, or staff identity. */
export interface CommunicationConsentSummary {
  channel: CommunicationConsentChannel;
  status: CommunicationConsentStatus;
  source: CommunicationConsentSource;
  capturedAt: string;
  version: number;
  updatedAt: string;
}

/** Provider-neutral channels for a consent-gated outbound message queue. */
export const COMMUNICATION_MESSAGE_CHANNELS = ['SMS', 'EMAIL', 'PUSH'] as const;
export type CommunicationMessageChannel = (typeof COMMUNICATION_MESSAGE_CHANNELS)[number];

/** Delivery is deliberately outside this queue foundation. */
export const COMMUNICATION_MESSAGE_LIFECYCLES = ['DRAFT', 'QUEUED', 'CANCELLED'] as const;
export type CommunicationMessageLifecycle = (typeof COMMUNICATION_MESSAGE_LIFECYCLES)[number];

/** Tenant, actor, initial lifecycle, and all provider data are server-established. */
export interface CreateCommunicationMessageInput {
  recipientPersonId: string;
  channel: CommunicationMessageChannel;
  content: string;
  scheduledAt?: string | undefined;
}

/** Queueing is a separate human confirmation against the current consent record. */
export interface QueueCommunicationMessageInput {
  expectedVersion: number;
}

/** Narrow queue representation: it has no contact address or provider/delivery data. */
export interface CommunicationMessageSummary {
  id: string;
  recipientPersonId: string;
  channel: CommunicationMessageChannel;
  content: string;
  lifecycle: CommunicationMessageLifecycle;
  scheduledAt?: string | undefined;
  createdByPrincipalId: string;
  queuedByPrincipalId?: string | undefined;
  version: number;
  createdAt: string;
  updatedAt: string;
}

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
export * from './documents.js';

export * from './public-lead-forms.js';

export * from './staff-availability.js';

export * from './automation-rules.js';

export * from './crm-follow-ups.js';

export * from './billing-renewals.js';

export * from './community.js';

export * from './action-approvals.js';

export * from './voice.js';
export * from './marketplace.js';
export * from './achievements.js';
export * from './testing-registration.js';

export * from './parent-journey-view.js';

export * from './marketing-assistant.js';

export * from './teaching-assistant.js';

export * from './teaching-studio.js';

export * from './retention-review-signals.js';
