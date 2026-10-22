import {
  CRM_LEAD_REGISTRATION_UUID, validateRegisterCrmLeadInput, verifyCrmLeadRegistrationResult,
  CRM_GUARDIAN_CHILD_ENROLLMENT_READ_COMMAND, CRM_GUARDIAN_CHILD_PAYER_DESIGNATION_COMMAND,
  CRM_GUARDIAN_CHILD_ADDITION_COMMAND, CRM_GUARDIAN_CHILD_MEMBERSHIP_DRAFT_FROM_PLAN_COMMAND,
  validateCrmGuardianChildEnrollmentReadInput, validateCrmGuardianChildPayerDesignationInput,
  validateCrmGuardianChildAdditionInput, validateCrmGuardianChildMembershipDraftFromPlanInput,
  verifyCrmGuardianChildEnrollment, verifyCrmGuardianChildPayerDesignationReceipt,
  verifyCrmGuardianChildAdditionResult, verifyCrmGuardianChildMembershipDraftFromPlan,
  type CrmGuardianChildEnrollment, type CrmGuardianChildPayerDesignationReceipt,
  type CrmGuardianChildAdditionResult, type CrmGuardianChildMembershipDraftFromPlan, type CrmLeadRegistrationResult,
} from '@hon/contracts';
import { adultRequest, sendAdultRequest, AdultAccessError, AdultRejectedError, type AdultAccount } from './crm-adult-flow-http';
import { PlanAccessError, PlanRejectedError, PlanUnknownError, PlanReadError, type PlanScope } from './membership-plans/http';

export type FamilyStep = 'read' | 'register' | 'account' | 'payer' | 'child' | 'childDraft';
export type FamilyRequest = Readonly<{ step: FamilyStep; path: string; body: string; key?: string }>;
export type FamilyResult =
  | { step: 'read'; family: CrmGuardianChildEnrollment; replayed: false }
  | { step: 'register'; registration: CrmLeadRegistrationResult; replayed: boolean }
  | { step: 'account'; account: AdultAccount; replayed: boolean }
  | { step: 'payer'; receipt: CrmGuardianChildPayerDesignationReceipt; replayed: boolean }
  | { step: 'child'; child: CrmGuardianChildAdditionResult; replayed: boolean }
  | { step: 'childDraft'; draft: CrmGuardianChildMembershipDraftFromPlan; replayed: boolean };
const markers = { read: CRM_GUARDIAN_CHILD_ENROLLMENT_READ_COMMAND, register: 'crm-lead-register', account: 'billing.account.create',
  payer: CRM_GUARDIAN_CHILD_PAYER_DESIGNATION_COMMAND, child: CRM_GUARDIAN_CHILD_ADDITION_COMMAND, childDraft: CRM_GUARDIAN_CHILD_MEMBERSHIP_DRAFT_FROM_PLAN_COMMAND };
function invalid(): never { throw new Error('Unverified family enrollment response.'); }
function uuid(value: unknown): string { if (typeof value !== 'string' || !CRM_LEAD_REGISTRATION_UUID.test(value)) invalid(); return value.toLowerCase(); }
function closed(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const row = value as Record<string, unknown>;
  if (required.some(k => !Object.hasOwn(row, k)) || Object.keys(row).some(k => !required.includes(k) && !optional.includes(k))) invalid();
  return row;
}
/** Immutable exact request; selectors never establish family, payer, child or school authority. */
export function familyRequest(scope: PlanScope, step: FamilyStep, selection: string, value: unknown, key?: string): FamilyRequest {
  const base = `/api/v1/organizations/${uuid(scope.organizationId)}/schools/${uuid(scope.schoolId)}`;
  let path: string, input: object;
  if (step === 'account') {
    const account = closed(value, ['currency']);
    if (typeof account.currency !== 'string') invalid();
    const request = adultRequest(scope, 'account', selection, account.currency, key);
    return Object.freeze({ ...request, step: 'account' });
  }
  if (step === 'childDraft') { input = validateCrmGuardianChildMembershipDraftFromPlanInput(value); if (uuid(selection) !== (input as { studentProfileId: string }).studentProfileId) invalid(); path = `${base}/billing/crm-guardian-child-membership-drafts/from-plan`; }
  else {
    const root = `${base}/crm/leads/${uuid(selection)}`;
    if (step === 'register') { validateRegisterCrmLeadInput(value); if (value.registrationPath !== 'GUARDIAN_CHILD') invalid(); input = value; path = `${root}/register`; }
    else if (step === 'read') { input = validateCrmGuardianChildEnrollmentReadInput(value); path = `${root}/guardian-child-enrollment`; }
    else if (step === 'payer') { input = validateCrmGuardianChildPayerDesignationInput(value); path = `${root}/guardian-child-enrollment/payer-designation`; }
    else if (step === 'child') { input = validateCrmGuardianChildAdditionInput(value); path = `${root}/guardian-child-enrollment/children`; }
    else invalid();
  }
  if (step === 'read' ? key !== undefined : key === undefined) invalid();
  return Object.freeze({ step, path, body: JSON.stringify(input), ...(key ? { key: uuid(key) } : {}) });
}
function verifyRequest(request: FamilyRequest): void {
  closed(request, ['step', 'path', 'body'], ['key']);
  const match = request.path.match(/^\/api\/v1\/organizations\/([^/]+)\/schools\/([^/]+)\/(.+)$/); if (!match) invalid();
  const input = JSON.parse(request.body), selection = request.step === 'account' ? input.responsiblePersonId : request.step === 'childDraft' ? input.studentProfileId : match[3]!.match(/^crm\/leads\/([^/]+)\//)?.[1];
  const expected = familyRequest({ organizationId: match[1]!, schoolId: match[2]! }, request.step, selection, request.step === 'account' ? { currency: input.currency } : input, request.key);
  if (request.path !== expected.path || request.body !== expected.body || request.key !== expected.key) invalid();
}
const messages: Record<string, string> = {
  CRM_GUARDIAN_CHILD_BILLING_ACCOUNT_REQUIRED: 'The guardian needs a canonical billing account. Refresh family setup before continuing.',
  CRM_GUARDIAN_CHILD_PAYER_DESIGNATION_REQUIRED: 'Guardian payer designation is required. Refresh family setup before continuing.',
  CRM_GUARDIAN_CHILD_LIMIT: 'This family has reached the maximum of 10 children, including the first registered child.',
  CRM_GUARDIAN_CHILD_ENROLLMENT_UNAVAILABLE: 'Family setup changed or is unavailable. Refresh saved setup; do not create a replacement record.',
  MEMBERSHIP_PLAN_VERSION_STALE: 'This plan changed. Reload available plans and review the new version before submitting again.',
  MEMBERSHIP_PLAN_CURRENCY_MISMATCH: 'The plan currency does not match the guardian’s canonical account. Refresh setup and choose a matching plan.',
  MEMBERSHIP_PLAN_UNAVAILABLE: 'This plan is no longer available. Reload available plans.',
  IDEMPOTENCY_KEY_REUSED: 'This request key was used for another action. Refresh saved setup before reviewing a new command.',
};
export async function sendFamilyRequest(request: FamilyRequest, signal?: AbortSignal): Promise<FamilyResult> {
  verifyRequest(request);
  try {
    if (request.step === 'account') {
      const result = await sendAdultRequest({ ...request, step: 'account' });
      if (result.step !== 'account') invalid();
      return result;
    }
    const response = await fetch(request.path, { method: 'POST', mode: 'same-origin', credentials: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-HON-Human-Command': markers[request.step], ...(request.key ? { 'Idempotency-Key': request.key } : {}) }, body: request.body,
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000) });
    if ([401, 403].includes(response.status)) throw new PlanAccessError('Your session, school permissions or active entitlement is unavailable. Sign in and reload the authorized lead list.');
    if ([400, 404, 405, 409, 413, 415, 422].includes(response.status)) {
      let code = ''; try { const text = await response.text(); if (text.length < 4000) { const error = JSON.parse(text); if (typeof error?.code === 'string') code = error.code; } } catch { /* Never show arbitrary server text. */ }
      throw new PlanRejectedError(code, response.status, messages[code] ?? 'This step could not be completed against current records. Refresh family setup before reviewing another action.');
    }
    if (response.status !== 200 || response.redirected || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '') || !/^private,\s*no-store$/i.test(response.headers.get('cache-control') ?? '')) invalid();
    const text = await response.text(); if (text.length > 100_000) invalid();
    const envelope = closed(JSON.parse(text), ['data', 'meta']), meta = closed(envelope.meta, ['requestId', 'correlationId', 'replayed']);
    if (uuid(meta.requestId) !== uuid(meta.correlationId) || typeof meta.replayed !== 'boolean' || request.step === 'read' && meta.replayed) invalid();
    const input = JSON.parse(request.body), leadId = request.path.split('/')[9]!;
    if (request.step === 'read') return { step: 'read', family: verifyCrmGuardianChildEnrollment(envelope.data, leadId), replayed: false };
    if (request.step === 'register') { validateRegisterCrmLeadInput(input); return { step: 'register', registration: verifyCrmLeadRegistrationResult(envelope.data, leadId, input), replayed: meta.replayed }; }
    if (request.step === 'payer') return { step: 'payer', receipt: verifyCrmGuardianChildPayerDesignationReceipt(envelope.data), replayed: meta.replayed };
    if (request.step === 'child') return { step: 'child', child: verifyCrmGuardianChildAdditionResult(envelope.data, leadId, input), replayed: meta.replayed };
    return { step: 'childDraft', draft: verifyCrmGuardianChildMembershipDraftFromPlan(envelope.data, input), replayed: meta.replayed };
  } catch (error) {
    if (error instanceof PlanAccessError || error instanceof PlanRejectedError) throw error;
    if (error instanceof AdultAccessError) throw new PlanAccessError(error.message);
    if (error instanceof AdultRejectedError) throw new PlanRejectedError('', 409, 'The guardian’s canonical billing account could not be created or reused. Verify the family’s current records and account currency with authorized staff, then refresh family setup. No payer designation or completed account action is assumed.');
    if (!request.key) throw new PlanReadError('Current family setup could not be verified. Retry the read; no records have been assumed.');
    throw new PlanUnknownError('The action may already have completed. Retry only the exact retained request, or discard it explicitly and refresh saved setup.');
  }
}
export async function readFamilyEnrollment(scope: PlanScope, leadId: string, contactId: string, signal?: AbortSignal): Promise<CrmGuardianChildEnrollment> {
  const result = await sendFamilyRequest(familyRequest(scope, 'read', leadId, {}), signal);
  if (result.step !== 'read' || 'historicalRegistrationReceipt' in result.family && result.family.historicalRegistrationReceipt.sourceContactPersonId !== uuid(contactId)) throw new PlanReadError('The family could not be matched to the selected lead. Reload the authorized list.');
  return result.family;
}
