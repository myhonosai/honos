import type { CommandContext } from './index.js';
import { CRM_LEAD_REGISTRATION_UUID } from './crm-lead-registration.js';
import { verifyCrmAdultMembershipDraftReceipt, type CrmAdultMembershipDraftReceipt } from './crm-adult-membership-draft.js';
import { membershipPlanFixedTermEnd, verifyMembershipPlanVersionSummary, type MembershipPlanVersionSummary } from './school-membership-plans.js';

/**
 * Guardian/child CRM enrollment (0176): from one verified GUARDIAN_CHILD registration to one plan-bound membership
 * DRAFT per child, under one explicitly designated guardian payer. Nothing here schedules, invoices, charges,
 * records consent or an agreement, or activates a membership.
 */
export const CRM_GUARDIAN_CHILD_ENROLLMENT_READ_COMMAND = 'crm-guardian-child-enrollment-read' as const;
export const CRM_GUARDIAN_CHILD_PAYER_DESIGNATION_COMMAND = 'crm-guardian-child-payer-designation' as const;
export const CRM_GUARDIAN_CHILD_ADDITION_COMMAND = 'crm-guardian-child-addition' as const;
export const CRM_GUARDIAN_CHILD_MEMBERSHIP_DRAFT_FROM_PLAN_COMMAND = 'crm-guardian-child-membership-draft-from-plan' as const;
export const CRM_GUARDIAN_CHILD_PAYER_DESIGNATION_CONFIRMATION = 'I_CONFIRM_DIRECT_HUMAN_GUARDIAN_PAYER_DESIGNATION' as const;
export const CRM_GUARDIAN_CHILD_ADDITION_CONFIRMATION = 'I_CONFIRM_DIRECT_HUMAN_GUARDIAN_CHILD_ADDITION' as const;
export const CRM_GUARDIAN_CHILD_MEMBERSHIP_DRAFT_FROM_PLAN_CONFIRMATION = 'I_CONFIRM_DIRECT_HUMAN_GUARDIAN_CHILD_MEMBERSHIP_DRAFT_FROM_PLAN' as const;
/** At most this many children are enrolled under one guardian/child CRM family by this workflow. */
export const CRM_GUARDIAN_CHILD_MAX_CHILDREN = 10;

export type CrmGuardianChildFamilyState =
  | 'NOT_REGISTERED' | 'NEEDS_STAFF_REVIEW' | 'ADULT_REGISTRATION'
  | 'BILLING_ACCOUNT_REQUIRED' | 'PAYER_DESIGNATION_REQUIRED' | 'PAYER_DESIGNATED';
export type CrmGuardianChildChildState =
  | 'NEEDS_STAFF_REVIEW' | 'AWAITING_PAYER_DESIGNATION' | 'READY_FOR_DRAFT' | 'CURRENT_DRAFT' | 'CURRENT_DRAFT_BY_OTHER_STAFF';
export type CrmGuardianChildRegistrationReceipt = {
  outcome: 'REGISTERED'; leadId: string; sourceContactPersonId: string; registrationPath: 'GUARDIAN_CHILD'; studentProfileId: string; familyId: string; recordedAt: string;
};
export interface CrmGuardianChildPayerDesignationReceipt { state: 'PAYER_DESIGNATED'; guardianDisplayName: string; currency: string; recordedAt: string }
export interface CrmGuardianChildAdditionReceipt { outcome: 'CHILD_ADDED'; leadId: string; studentProfileId: string; childDisplayName: string; recordedAt: string }
export type CrmGuardianChildAdditionResult = { outcome: 'NEEDS_STAFF_REVIEW' } | CrmGuardianChildAdditionReceipt;
/** Same six-key receipt as the adult DRAFT; `plan` is the immutable published version it was created from. */
export interface CrmGuardianChildMembershipDraftFromPlan { receipt: CrmAdultMembershipDraftReceipt; plan: MembershipPlanVersionSummary }
export type CrmGuardianChildCurrentDraft =
  | { state: 'RECORDED_DRAFT'; receipt: CrmAdultMembershipDraftReceipt; plan: MembershipPlanVersionSummary }
  | { state: 'RECORDED_DRAFT' };
/**
 * One enrolled child. `currentMembershipDraft` is present only for CURRENT_DRAFT (creator: receipt and bound plan
 * terms, observed now) and CURRENT_DRAFT_BY_OTHER_STAFF (yes/no only: no receipt, membership id or creator).
 */
export interface CrmGuardianChildEnrolledChild {
  studentProfileId: string;
  displayName: string;
  origin: 'CRM_REGISTRATION' | 'ADDITIONAL_CHILD';
  workflowState: CrmGuardianChildChildState;
  currentMembershipDraft?: CrmGuardianChildCurrentDraft;
}
export type CrmGuardianChildEnrollment =
  | { leadId: string; workflowState: 'NOT_REGISTERED' | 'NEEDS_STAFF_REVIEW' | 'ADULT_REGISTRATION' }
  | {
    leadId: string;
    workflowState: 'BILLING_ACCOUNT_REQUIRED' | 'PAYER_DESIGNATION_REQUIRED' | 'PAYER_DESIGNATED';
    /** Immutable creation response of the registration, never proof of current state. */
    historicalRegistrationReceipt: CrmGuardianChildRegistrationReceipt;
    guardian: { displayName: string };
    /** The guardian's canonical account, when one exists. No id, payer id, balance or history. */
    billingAccount?: { classification: 'CANONICAL'; currency: string };
    /** Present only for PAYER_DESIGNATED: the stored designation receipt, currently verified. */
    payerDesignation?: CrmGuardianChildPayerDesignationReceipt;
    children: CrmGuardianChildEnrolledChild[];
  };
export interface CrmGuardianChildPayerDesignationInput { confirmation: typeof CRM_GUARDIAN_CHILD_PAYER_DESIGNATION_CONFIRMATION }
export interface CrmGuardianChildAdditionInput {
  childGivenName: string;
  childFamilyName: string;
  childBirthDate: string;
  confirmation: typeof CRM_GUARDIAN_CHILD_ADDITION_CONFIRMATION;
}
export interface CrmGuardianChildMembershipDraftFromPlanInput {
  studentProfileId: string;
  membershipPlanId: string;
  membershipPlanVersion: number;
  termStartedAt?: string;
  confirmation: typeof CRM_GUARDIAN_CHILD_MEMBERSHIP_DRAFT_FROM_PLAN_CONFIRMATION;
}
export interface CrmGuardianChildEnrollmentContext extends CommandContext { externalSubject: string }
type Meta<R extends boolean> = { requestId: string; correlationId: string; replayed: R };
export interface CrmGuardianChildEnrollmentApiResponse { data: CrmGuardianChildEnrollment; meta: Meta<false> }
export interface CrmGuardianChildPayerDesignationApiResponse { data: CrmGuardianChildPayerDesignationReceipt; meta: Meta<boolean> }
export interface CrmGuardianChildAdditionApiResponse { data: CrmGuardianChildAdditionResult; meta: Meta<boolean> }
export interface CrmGuardianChildMembershipDraftFromPlanApiResponse { data: CrmGuardianChildMembershipDraftFromPlan; meta: Meta<boolean> }

function invalid(): never { throw new Error('Unverified guardian/child enrollment data.'); }
function record(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const row = value as Record<string, unknown>;
  if (required.some(key => !Object.hasOwn(row, key)) || Object.keys(row).some(key => !required.includes(key) && !optional.includes(key))) invalid();
  return row;
}
function uuid(value: unknown): string { if (typeof value !== 'string' || !CRM_LEAD_REGISTRATION_UUID.test(value)) invalid(); return value.toLowerCase(); }
function name(value: unknown): string {
  if (typeof value !== 'string' || !value || value.trim() !== value || Array.from(value).length > 100 || /[\u0000-\u001f\u007f<>]/u.test(value) || !/[\p{L}\p{N}]/u.test(value)) invalid();
  return value;
}
function label(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 201 || value.trim() !== value || /[\u0000-\u001f\u007f-\u009f<>]/u.test(value)) invalid();
  return value;
}
function date(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value) invalid();
  return value;
}
function instant(value: unknown): string {
  if (typeof value !== 'string' || !/^(?:19|[2-9][0-9])[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) invalid();
  return value;
}
function integer(value: unknown, min: number, max: number): number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) invalid(); return value; }
function currency(value: unknown): string { if (typeof value !== 'string' || !/^[A-Z]{3}$/.test(value)) invalid(); return value; }

/** Reads carry no selector beyond the lead id in the path: the body is always exactly `{}`. */
export function validateCrmGuardianChildEnrollmentReadInput(value: unknown): Record<string, never> { record(value, []); return {}; }
export function validateCrmGuardianChildPayerDesignationInput(value: unknown): CrmGuardianChildPayerDesignationInput {
  const row = record(value, ['confirmation']);
  if (row.confirmation !== CRM_GUARDIAN_CHILD_PAYER_DESIGNATION_CONFIRMATION) invalid();
  return { confirmation: CRM_GUARDIAN_CHILD_PAYER_DESIGNATION_CONFIRMATION };
}
export function validateCrmGuardianChildAdditionInput(value: unknown): CrmGuardianChildAdditionInput {
  const row = record(value, ['childGivenName', 'childFamilyName', 'childBirthDate', 'confirmation']);
  if (row.confirmation !== CRM_GUARDIAN_CHILD_ADDITION_CONFIRMATION) invalid();
  const birth = date(row.childBirthDate);
  if (birth < '1900-01-01' || birth > new Date().toISOString().slice(0, 10)) invalid();
  return { childGivenName: name(row.childGivenName), childFamilyName: name(row.childFamilyName), childBirthDate: birth, confirmation: CRM_GUARDIAN_CHILD_ADDITION_CONFIRMATION };
}
export function validateCrmGuardianChildMembershipDraftFromPlanInput(value: unknown): CrmGuardianChildMembershipDraftFromPlanInput {
  const row = record(value, ['studentProfileId', 'membershipPlanId', 'membershipPlanVersion', 'confirmation'], ['termStartedAt']);
  if (row.confirmation !== CRM_GUARDIAN_CHILD_MEMBERSHIP_DRAFT_FROM_PLAN_CONFIRMATION) invalid();
  const out: CrmGuardianChildMembershipDraftFromPlanInput = { studentProfileId: uuid(row.studentProfileId), membershipPlanId: uuid(row.membershipPlanId),
    membershipPlanVersion: integer(row.membershipPlanVersion, 1, 999_999), confirmation: CRM_GUARDIAN_CHILD_MEMBERSHIP_DRAFT_FROM_PLAN_CONFIRMATION };
  if (Object.hasOwn(row, 'termStartedAt')) out.termStartedAt = instant(row.termStartedAt);
  return out;
}

export function verifyCrmGuardianChildPayerDesignationReceipt(value: unknown): CrmGuardianChildPayerDesignationReceipt {
  const row = record(value, ['state', 'guardianDisplayName', 'currency', 'recordedAt']);
  if (row.state !== 'PAYER_DESIGNATED') invalid();
  return { state: 'PAYER_DESIGNATED', guardianDisplayName: label(row.guardianDisplayName), currency: currency(row.currency), recordedAt: instant(row.recordedAt) };
}
/** The added child must belong to the selected lead and carry exactly the submitted name. */
export function verifyCrmGuardianChildAdditionResult(value: unknown, leadId: string, input?: CrmGuardianChildAdditionInput): CrmGuardianChildAdditionResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  if ((value as Record<string, unknown>).outcome === 'NEEDS_STAFF_REVIEW') { record(value, ['outcome']); return { outcome: 'NEEDS_STAFF_REVIEW' }; }
  const row = record(value, ['outcome', 'leadId', 'studentProfileId', 'childDisplayName', 'recordedAt']);
  if (row.outcome !== 'CHILD_ADDED' || uuid(row.leadId) !== uuid(leadId)) invalid();
  const childDisplayName = label(row.childDisplayName);
  if (input && childDisplayName !== `${input.childGivenName} ${input.childFamilyName}`) invalid();
  return { outcome: 'CHILD_ADDED', leadId: uuid(leadId), studentProfileId: uuid(row.studentProfileId), childDisplayName, recordedAt: instant(row.recordedAt) };
}
/** The receipt carries exactly the plan's code and the term derived from the plan and the requested start. */
export function verifyCrmGuardianChildMembershipDraftFromPlan(value: unknown, input?: CrmGuardianChildMembershipDraftFromPlanInput): CrmGuardianChildMembershipDraftFromPlan {
  const row = record(value, ['receipt', 'plan']);
  const plan = verifyMembershipPlanVersionSummary(row.plan);
  const receipt = verifyCrmAdultMembershipDraftReceipt(row.receipt);
  const end = receipt.termStartedAt && plan.termKind === 'FIXED_MONTHS' ? membershipPlanFixedTermEnd(receipt.termStartedAt, plan.termMonths!) : null;
  if (receipt.planCode !== plan.planCode || receipt.termEndsAt !== end) invalid();
  if (input && (plan.planId !== input.membershipPlanId || plan.version !== input.membershipPlanVersion || receipt.termStartedAt !== (input.termStartedAt ?? null))) invalid();
  return { receipt, plan };
}
function registrationReceipt(value: unknown, leadId: string): CrmGuardianChildRegistrationReceipt {
  const row = record(value, ['outcome', 'leadId', 'sourceContactPersonId', 'registrationPath', 'studentProfileId', 'familyId', 'recordedAt']);
  if (row.outcome !== 'REGISTERED' || row.registrationPath !== 'GUARDIAN_CHILD' || uuid(row.leadId) !== leadId) invalid();
  return { outcome: 'REGISTERED', leadId, sourceContactPersonId: uuid(row.sourceContactPersonId), registrationPath: 'GUARDIAN_CHILD',
    studentProfileId: uuid(row.studentProfileId), familyId: uuid(row.familyId), recordedAt: instant(row.recordedAt) };
}
const CHILD_STATES: readonly CrmGuardianChildChildState[] = ['NEEDS_STAFF_REVIEW', 'AWAITING_PAYER_DESIGNATION', 'READY_FOR_DRAFT', 'CURRENT_DRAFT', 'CURRENT_DRAFT_BY_OTHER_STAFF'];
function enrolledChild(value: unknown, familyState: string): CrmGuardianChildEnrolledChild {
  const row = record(value, ['studentProfileId', 'displayName', 'origin', 'workflowState'], ['currentMembershipDraft']);
  const state = row.workflowState as CrmGuardianChildChildState;
  if (!CHILD_STATES.includes(state) || (row.origin !== 'CRM_REGISTRATION' && row.origin !== 'ADDITIONAL_CHILD')) invalid();
  // Child states follow the family state: no DRAFT readiness without a current payer designation.
  if (familyState === 'PAYER_DESIGNATED' ? state === 'AWAITING_PAYER_DESIGNATION' : !['NEEDS_STAFF_REVIEW', 'AWAITING_PAYER_DESIGNATION'].includes(state)) invalid();
  const child: CrmGuardianChildEnrolledChild = { studentProfileId: uuid(row.studentProfileId), displayName: label(row.displayName), origin: row.origin, workflowState: state };
  if ((state === 'CURRENT_DRAFT' || state === 'CURRENT_DRAFT_BY_OTHER_STAFF') !== Object.hasOwn(row, 'currentMembershipDraft')) invalid();
  if (state === 'CURRENT_DRAFT') {
    const draft = record(row.currentMembershipDraft, ['state', 'receipt', 'plan']);
    if (draft.state !== 'RECORDED_DRAFT') invalid();
    child.currentMembershipDraft = { state: 'RECORDED_DRAFT', ...verifyCrmGuardianChildMembershipDraftFromPlan({ receipt: draft.receipt, plan: draft.plan }) };
  } else if (state === 'CURRENT_DRAFT_BY_OTHER_STAFF') {
    if (record(row.currentMembershipDraft, ['state']).state !== 'RECORDED_DRAFT') invalid();
    child.currentMembershipDraft = { state: 'RECORDED_DRAFT' };
  }
  return child;
}
/** Closed verifier; the returned lead must be exactly the selected lead. */
export function verifyCrmGuardianChildEnrollment(value: unknown, selectedLeadId: string): CrmGuardianChildEnrollment {
  const leadId = uuid(selectedLeadId);
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const state = (value as Record<string, unknown>).workflowState;
  if (state === 'NOT_REGISTERED' || state === 'NEEDS_STAFF_REVIEW' || state === 'ADULT_REGISTRATION') {
    const row = record(value, ['leadId', 'workflowState']);
    if (uuid(row.leadId) !== leadId) invalid();
    return { leadId, workflowState: state };
  }
  if (state !== 'BILLING_ACCOUNT_REQUIRED' && state !== 'PAYER_DESIGNATION_REQUIRED' && state !== 'PAYER_DESIGNATED') invalid();
  const row = record(value, ['leadId', 'workflowState', 'historicalRegistrationReceipt', 'guardian', 'children'], ['billingAccount', 'payerDesignation']);
  if (uuid(row.leadId) !== leadId || (state === 'BILLING_ACCOUNT_REQUIRED') === Object.hasOwn(row, 'billingAccount')
    || (state === 'PAYER_DESIGNATED') !== Object.hasOwn(row, 'payerDesignation')) invalid();
  if (!Array.isArray(row.children) || row.children.length < 1 || row.children.length > CRM_GUARDIAN_CHILD_MAX_CHILDREN) invalid();
  const children = row.children.map(child => enrolledChild(child, state));
  if (new Set(children.map(child => child.studentProfileId)).size !== children.length || children.filter(child => child.origin === 'CRM_REGISTRATION').length !== 1) invalid();
  const historicalRegistrationReceipt = registrationReceipt(row.historicalRegistrationReceipt, leadId);
  if (!children.some(child => child.origin === 'CRM_REGISTRATION' && child.studentProfileId === historicalRegistrationReceipt.studentProfileId)) invalid();
  const out: CrmGuardianChildEnrollment = { leadId, workflowState: state, historicalRegistrationReceipt,
    guardian: { displayName: label(record(row.guardian, ['displayName']).displayName) }, children };
  if (Object.hasOwn(row, 'billingAccount')) {
    const account = record(row.billingAccount, ['classification', 'currency']);
    if (account.classification !== 'CANONICAL') invalid();
    out.billingAccount = { classification: 'CANONICAL', currency: currency(account.currency) };
  }
  if (Object.hasOwn(row, 'payerDesignation')) {
    out.payerDesignation = verifyCrmGuardianChildPayerDesignationReceipt(row.payerDesignation);
    // The receipt keeps the guardian's name as recorded at designation; only the account currency must still match.
    if (out.payerDesignation.currency !== out.billingAccount?.currency) invalid();
  }
  return out;
}
