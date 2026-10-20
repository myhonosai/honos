import {
  CRM_LEAD_REGISTRATION_CONFIRMATION, CRM_ADULT_MEMBERSHIP_DRAFT_CONFIRMATION,
  CRM_LEAD_REGISTRATION_UUID, validateRegisterCrmLeadInput, verifyCrmLeadRegistrationResult,
  validateCreateBillingAccountInput, validateCrmAdultMembershipDraftInput,
  verifyCrmAdultMembershipPreparation, verifyCrmAdultMembershipDraftReceipt,
  verifyCrmAdultMembershipDraftConfirmation,
  type CrmLeadRegistrationResult, type CrmAdultMembershipDraftReceipt,
} from '@hon/contracts';

export type AdultScope = Readonly<{ organizationId: string; schoolId: string }>;
export type AdultStep = 'register' | 'account' | 'prepare' | 'draft' | 'confirm';
export type AdultRequest = Readonly<{ step: AdultStep; path: string; body: string; key?: string }>;
export type AdultAccount = { id: string; responsiblePersonId: string; currency: string; classification?: 'CANONICAL'; reused?: boolean };
export type AdultResult =
  | { step: 'register'; registration: CrmLeadRegistrationResult; replayed: boolean }
  | { step: 'account'; account: AdultAccount; replayed: boolean }
  | { step: 'prepare'; preparation: ReturnType<typeof verifyCrmAdultMembershipPreparation> }
  | { step: 'draft'; receipt: CrmAdultMembershipDraftReceipt; replayed: boolean }
  | { step: 'confirm'; confirmation: ReturnType<typeof verifyCrmAdultMembershipDraftConfirmation> };
export class AdultAccessError extends Error {}
export class AdultUncertainError extends Error {}
export class AdultRejectedError extends Error {}
const markers = { register: 'crm-lead-register', account: 'billing.account.create', prepare: 'crm-adult-membership-prepare', draft: 'crm-adult-membership-draft', confirm: 'crm-adult-membership-draft-confirmation' } as const;
function invalid(): never { throw new Error('The response could not be verified. No completed action is assumed.'); }
function uuid(v: unknown): string { if (typeof v !== 'string' || !CRM_LEAD_REGISTRATION_UUID.test(v)) invalid(); return v.toLowerCase(); }
function closed(v: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) invalid(); const r = v as Record<string, unknown>;
  if (required.some(k => !Object.hasOwn(r, k)) || Object.keys(r).some(k => !required.includes(k) && !optional.includes(k))) invalid(); return r;
}
const root = (s: AdultScope) => `/api/v1/organizations/${uuid(s.organizationId)}/schools/${uuid(s.schoolId)}`;
export function adultRequest(s: AdultScope, step: AdultStep, selection: string, value: string, key?: string): AdultRequest {
  let path: string, input: object;
  const base = root(s), selected = uuid(selection);
  if (step === 'register') { path = `${base}/crm/leads/${selected}/register`; input = { registrationPath: 'ADULT', birthDate: value, confirmation: CRM_LEAD_REGISTRATION_CONFIRMATION }; validateRegisterCrmLeadInput(input); }
  else if (step === 'account') { path = `${base}/billing/accounts`; input = { responsiblePersonId: selected, currency: value }; validateCreateBillingAccountInput(input); }
  else {
    path = `${base}/billing/crm-adult-membership-drafts${step === 'prepare' ? '/preparation' : step === 'confirm' ? '/confirmation' : ''}`;
    input = step === 'draft' ? validateCrmAdultMembershipDraftInput({ studentProfileId: selected, planCode: value, confirmation: CRM_ADULT_MEMBERSHIP_DRAFT_CONFIRMATION }) : { studentProfileId: selected };
  }
  const command = ['register', 'account', 'draft'].includes(step);
  if (command ? key === undefined : key !== undefined) invalid();
  return Object.freeze({ step, path, body: JSON.stringify(input), ...(command ? { key: uuid(key) } : {}) });
}
function verifyRequest(r: AdultRequest): void {
  closed(r, ['step', 'path', 'body'], ['key']);
  if (!Object.hasOwn(markers, r.step)) invalid();
  const m = r.path.match(/^\/api\/v1\/organizations\/([^/]+)\/schools\/([^/]+)\/(.+)$/); if (!m) invalid();
  const input = JSON.parse(r.body), s = { organizationId: m[1]!, schoolId: m[2]! };
  const selected = r.step === 'register' ? m[3]!.match(/^crm\/leads\/([^/]+)\/register$/)?.[1] : input.responsiblePersonId ?? input.studentProfileId;
  const expected = adultRequest(s, r.step, selected, input.birthDate ?? input.currency ?? input.planCode ?? '', r.key);
  if (r.path !== expected.path || r.body !== expected.body) invalid();
}
function parse(raw: unknown, r: AdultRequest): AdultResult {
  const e = closed(raw, ['data', 'meta']), meta = closed(e.meta, ['requestId', 'correlationId', 'replayed']);
  if (uuid(meta.requestId) !== uuid(meta.correlationId) || typeof meta.replayed !== 'boolean') invalid();
  const input = JSON.parse(r.body);
  if (r.step === 'register') {
    validateRegisterCrmLeadInput(input); const lead = r.path.split('/').at(-2)!;
    return { step: r.step, registration: verifyCrmLeadRegistrationResult(e.data, lead, input), replayed: meta.replayed };
  }
  if (r.step === 'account') {
    const a = closed(e.data, ['id', 'responsiblePersonId', 'currency', 'version', 'createdAt'], ['classification', 'reused']);
    if (uuid(a.responsiblePersonId) !== input.responsiblePersonId || a.currency !== input.currency || !Number.isSafeInteger(a.version) || Number(a.version) < 1
      || typeof a.createdAt !== 'string' || !Number.isFinite(Date.parse(a.createdAt))) invalid();
    const legacy = !Object.hasOwn(a, 'classification') && !Object.hasOwn(a, 'reused');
    if (legacy ? !meta.replayed : a.classification !== 'CANONICAL' || typeof a.reused !== 'boolean') invalid();
    return { step: r.step, account: { id: uuid(a.id), responsiblePersonId: uuid(a.responsiblePersonId), currency: a.currency as string,
      ...(!legacy ? { classification: 'CANONICAL' as const, reused: a.reused as boolean } : {}) }, replayed: meta.replayed };
  }
  if (r.step === 'draft') return { step: r.step, receipt: verifyCrmAdultMembershipDraftReceipt(e.data, validateCrmAdultMembershipDraftInput(input)), replayed: meta.replayed };
  if (meta.replayed) invalid();
  if (r.step === 'prepare') return { step: r.step, preparation: verifyCrmAdultMembershipPreparation(e.data) };
  return { step: 'confirm', confirmation: verifyCrmAdultMembershipDraftConfirmation(e.data) };
}
/** Commands are explicit and immutable. Only uncertain command responses retain the same body/key for a human retry. */
export async function sendAdultRequest(r: AdultRequest): Promise<AdultResult> {
  verifyRequest(r); const command = r.key !== undefined;
  try {
    const response = await fetch(r.path, { method: 'POST', mode: 'same-origin', credentials: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-HON-Human-Command': markers[r.step], ...(r.key ? { 'Idempotency-Key': r.key } : {}) }, body: r.body });
    if (response.status === 401 || response.status === 403) throw new AdultAccessError('Your session, school permission or active entitlement is unavailable. Reload the authorized lead list.');
    if ([400, 404, 405, 409, 413, 415, 422].includes(response.status)) throw new AdultRejectedError(response.status === 409
      ? 'The request conflicts with current records or another command. No new result was assumed. Review the current state before starting again.'
      : 'This step is unavailable. Registration may require staff review, a completed trial or a Won lead; billing requires the correct account currency and an unambiguous adult record.');
    if (![200, ...(r.step === 'account' ? [201] : [])].includes(response.status) || response.redirected
      || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '') || !/^private,\s*no-store$/i.test(response.headers.get('cache-control') ?? '')) invalid();
    const text = await response.text(); if (text.length > 12000) invalid(); return parse(JSON.parse(text), r);
  } catch (e) {
    if (e instanceof AdultAccessError || e instanceof AdultRejectedError) throw e;
    if (command) throw new AdultUncertainError('Outcome unverified. Retry the exact retained request; do not assume failure or submit a new copy.');
    throw new AdultRejectedError('The current state could not be verified. Try this read again.');
  }
}
