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
