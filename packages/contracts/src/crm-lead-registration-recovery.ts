import type { CommandContext } from './index.js';
import { CRM_LEAD_REGISTRATION_UUID, type CrmLeadRegistrationResult } from './crm-lead-registration.js';
import { verifyCrmAdultMembershipDraftConfirmation, type CrmAdultMembershipDraftConfirmation } from './crm-adult-membership-draft.js';

/** Read-only selector: the lead id travels in the path; the body is always exactly `{}`. */
export const CRM_LEAD_REGISTRATION_RECOVERY_COMMAND = 'crm-lead-registration-recovery' as const;
export type CrmLeadRegistrationRecoveryState = 'NOT_REGISTERED' | 'NEEDS_STAFF_REVIEW' | 'BILLING_ACCOUNT_REQUIRED' | 'READY_FOR_DRAFT' | 'CURRENT_DRAFT' | 'CURRENT_DRAFT_BY_OTHER_STAFF';
export type CrmAdultRegistrationReceipt = Extract<CrmLeadRegistrationResult, { outcome: 'REGISTERED' }> & { registrationPath: 'ADULT'; familyId: null };
/** No account id, payer id, version or balance: only what the existing DRAFT preparation already discloses. */
export interface CrmLeadRegistrationRecoveryAccount { classification: 'CANONICAL'; currency: string }
/**
 * `historicalRegistrationReceipt` is the immutable creation response, never proof of current state.
 * `currentMembershipDraft` is present only when the creator-owned current-DRAFT confirmation succeeded now.
 * `CURRENT_DRAFT_BY_OTHER_STAFF` says only that another staff member's DRAFT is exactly current now: no receipt,
 * membership id or creator, and no confirmation, change or activation right for the current staff member.
 */
export type CrmLeadRegistrationRecovery =
  | { leadId: string; workflowState: 'NOT_REGISTERED' | 'NEEDS_STAFF_REVIEW' }
  | { leadId: string; workflowState: 'BILLING_ACCOUNT_REQUIRED'; historicalRegistrationReceipt: CrmAdultRegistrationReceipt }
  | { leadId: string; workflowState: 'READY_FOR_DRAFT'; historicalRegistrationReceipt: CrmAdultRegistrationReceipt; billingAccount: CrmLeadRegistrationRecoveryAccount }
  | { leadId: string; workflowState: 'CURRENT_DRAFT'; historicalRegistrationReceipt: CrmAdultRegistrationReceipt; billingAccount: CrmLeadRegistrationRecoveryAccount; currentMembershipDraft: CrmAdultMembershipDraftConfirmation }
  | { leadId: string; workflowState: 'CURRENT_DRAFT_BY_OTHER_STAFF'; historicalRegistrationReceipt: CrmAdultRegistrationReceipt; billingAccount: CrmLeadRegistrationRecoveryAccount; currentMembershipDraft: { state: 'RECORDED_DRAFT' } };
export interface CrmLeadRegistrationRecoveryContext extends CommandContext { externalSubject: string }
export interface CrmLeadRegistrationRecoveryApiResponse { data: CrmLeadRegistrationRecovery; meta: { requestId: string; correlationId: string; replayed: false } }

function invalid(): never { throw new Error('Unverified CRM registration recovery data.'); }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row, key))) invalid();
  return row;
}
function uuid(value: unknown): string { if (typeof value !== 'string' || !CRM_LEAD_REGISTRATION_UUID.test(value)) invalid(); return value.toLowerCase(); }
function instant(value: unknown): string {
  if (typeof value !== 'string' || !/^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) invalid();
  return value;
}
export function validateCrmLeadRegistrationRecoveryInput(value: unknown): Record<string, never> {
  record(value, []);
  return {};
}
function receipt(value: unknown, leadId: string): CrmAdultRegistrationReceipt {
  const row = record(value, ['outcome', 'leadId', 'sourceContactPersonId', 'registrationPath', 'studentProfileId', 'familyId', 'recordedAt']);
  if (row.outcome !== 'REGISTERED' || row.registrationPath !== 'ADULT' || row.familyId !== null || uuid(row.leadId) !== leadId) invalid();
  return { outcome: 'REGISTERED', leadId, sourceContactPersonId: uuid(row.sourceContactPersonId), registrationPath: 'ADULT', studentProfileId: uuid(row.studentProfileId), familyId: null, recordedAt: instant(row.recordedAt) };
}
function account(value: unknown): CrmLeadRegistrationRecoveryAccount {
  const row = record(value, ['classification', 'currency']);
  if (row.classification !== 'CANONICAL' || typeof row.currency !== 'string' || !/^[A-Z]{3}$/.test(row.currency)) invalid();
  return { classification: 'CANONICAL', currency: row.currency };
}
/** Closed verifier; the returned lead must be exactly the selected lead. */
export function verifyCrmLeadRegistrationRecovery(value: unknown, selectedLeadId: string): CrmLeadRegistrationRecovery {
  const leadId = uuid(selectedLeadId);
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const state = (value as Record<string, unknown>).workflowState;
  if (state === 'NOT_REGISTERED' || state === 'NEEDS_STAFF_REVIEW') {
    const row = record(value, ['leadId', 'workflowState']);
    if (uuid(row.leadId) !== leadId) invalid();
    return { leadId, workflowState: state };
  }
  if (state === 'BILLING_ACCOUNT_REQUIRED') {
    const row = record(value, ['leadId', 'workflowState', 'historicalRegistrationReceipt']);
    if (uuid(row.leadId) !== leadId) invalid();
    return { leadId, workflowState: state, historicalRegistrationReceipt: receipt(row.historicalRegistrationReceipt, leadId) };
  }
  if (state === 'READY_FOR_DRAFT') {
    const row = record(value, ['leadId', 'workflowState', 'historicalRegistrationReceipt', 'billingAccount']);
    if (uuid(row.leadId) !== leadId) invalid();
    return { leadId, workflowState: state, historicalRegistrationReceipt: receipt(row.historicalRegistrationReceipt, leadId), billingAccount: account(row.billingAccount) };
  }
  if (state === 'CURRENT_DRAFT') {
    const row = record(value, ['leadId', 'workflowState', 'historicalRegistrationReceipt', 'billingAccount', 'currentMembershipDraft']);
    if (uuid(row.leadId) !== leadId) invalid();
    return { leadId, workflowState: state, historicalRegistrationReceipt: receipt(row.historicalRegistrationReceipt, leadId), billingAccount: account(row.billingAccount),
      currentMembershipDraft: verifyCrmAdultMembershipDraftConfirmation(row.currentMembershipDraft) };
  }
  if (state === 'CURRENT_DRAFT_BY_OTHER_STAFF') {
    const row = record(value, ['leadId', 'workflowState', 'historicalRegistrationReceipt', 'billingAccount', 'currentMembershipDraft']);
    if (uuid(row.leadId) !== leadId || record(row.currentMembershipDraft, ['state']).state !== 'RECORDED_DRAFT') invalid();
    return { leadId, workflowState: state, historicalRegistrationReceipt: receipt(row.historicalRegistrationReceipt, leadId), billingAccount: account(row.billingAccount),
      currentMembershipDraft: { state: 'RECORDED_DRAFT' } };
  }
  return invalid();
}
