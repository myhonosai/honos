import {
  validateMembershipActivationPreviewInput, validateConfirmMembershipActivationInput,
  verifyMembershipActivationPreview, verifyMembershipActivationReceipt,
  type MembershipActivationContext, type MembershipActivationPreviewInput, type ConfirmMembershipActivationInput,
  type MembershipActivationPreview, type MembershipActivationReceipt,
} from '@hon/contracts';
import { reportConfirmedSessionInvalidation } from './session-invalidation';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export type KnownMembership = Pick<MembershipActivationContext, 'organizationId' | 'schoolId' | 'membershipId'>;
/** Strings and frozen scope retain the exact request independently of mutable form state. */
export type ActivationRequest = Readonly<{ scope: Readonly<KnownMembership>; body: string; key: string }>;
export type ActivationResult = { receipt: MembershipActivationReceipt; replayed: boolean };
export class MembershipActivationError extends Error {
  constructor(message: string, readonly status: number, readonly code = '', readonly uncertain = false) { super(message); }
}
const messages: Readonly<Record<string, string>> = {
  ACTIVATION_PREVIEW_STALE: 'The reviewed facts changed. Review activation again and acknowledge the fresh preview before confirming.',
  ACTIVATION_TWO_STEP_CONFIRMATION_REQUIRED: 'This request requires the two-step activation interface. Reload the current application.',
  ACTIVATION_ACKNOWLEDGEMENT_REQUIRED: 'Acknowledge every warning in a fresh preview.',
  ACTIVATION_OVERRIDE_REQUIRED: 'This review requires an authorized identity override, a documented reason and secondary confirmation.',
  ACTIVATION_OVERRIDE_FORBIDDEN: 'Your current school permissions do not allow this override. Ask an appropriately authorized staff member to review.',
  ACTIVATION_BLOCKED: 'Activation is blocked. Review the server-provided blockers; no activation is assumed.',
  VERSION_CONFLICT: 'The membership version changed. Review the current membership again.',
  MEMBERSHIP_NOT_DRAFT: 'Only a current DRAFT can be activated. Review the current membership state.',
  IDEMPOTENCY_KEY_REUSED: 'The request key conflicts with another request. Verify current state before starting a new confirmation.',
  IDEMPOTENCY_IN_PROGRESS: 'The original request is still being processed. Retry only the exact retained request when ready.',
  DATE_SOURCE_MISMATCH: 'The date source changed. Request a new preview before confirming.',
  ACTIVATION_REASON_TEXT_REQUIRED: 'Provide the required activation reason, then review again.',
  ADULT_VERIFICATION_NOT_APPLICABLE: 'An adult attestation is only supported when the birth date is missing. Review again.',
  SCHOOL_TIMEZONE_INVALID: 'The school timezone is unavailable. An authorized administrator must correct it before activation.',
  VALIDATION_FAILED: 'Review the dates, required reasons and confirmations. The request was not accepted.',
  BILLING_MEMBERSHIP_NOT_FOUND: 'This membership is unavailable in the selected school.',
  MEMBERSHIP_ACTIVATION_FORBIDDEN: 'Current staff activation permission or school access is unavailable.',
};
function invalid(): never { throw new Error('Unverified membership activation data.'); }
function uuid(value: unknown): string { if (typeof value !== 'string' || !UUID.test(value)) invalid(); return value.toLowerCase(); }
function closed(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(k => !Object.hasOwn(value, k))) invalid();
  return value as Record<string, unknown>;
}
function known(value: KnownMembership): KnownMembership {
  closed(value, ['organizationId', 'schoolId', 'membershipId']);
  return { organizationId: uuid(value.organizationId), schoolId: uuid(value.schoolId), membershipId: uuid(value.membershipId) };
}
export function membershipActivationPath(value: KnownMembership): string {
  const s = known(value);
  return `/api/v1/organizations/${s.organizationId}/schools/${s.schoolId}/billing/memberships/${s.membershipId}`;
}
async function result(response: Response, contextRead = false): Promise<{ data: unknown; replayed: boolean }> {
  if (response.status === 401) {
    reportConfirmedSessionInvalidation();
    throw new MembershipActivationError('Your session has expired. Sign in again before verifying access.', 401);
  }
  if (!response.ok) {
    let code = '';
    try { const raw = await response.text(); if (raw.length < 4000) { const e = JSON.parse(raw); if (typeof e?.code === 'string' && Object.hasOwn(messages, e.code)) code = e.code; } } catch { /* Never show raw backend text. */ }
    const uncertain = ![400, 401, 403, 404, 405, 409, 413, 415, 422].includes(response.status) || code === 'IDEMPOTENCY_IN_PROGRESS';
    const message = response.status === 401 ? 'Your session has expired. Sign in again before verifying access.'
      : Object.hasOwn(messages, code) ? messages[code]!
      : response.status === 403 ? 'Your current school access, activation permission or billing entitlement is unavailable.'
      : uncertain ? 'The outcome is unknown. No activation is assumed. Retry only the exact retained request.'
      : 'The request was refused. Review current school access and membership facts before trying again.';
    throw new MembershipActivationError(message, response.status, code, uncertain);
  }
  if (response.status !== 200 || response.redirected || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')
    || !/^private,\s*no-store$/i.test(response.headers.get('cache-control') ?? '')) invalid();
  const raw = await response.text(); if (raw.length > 100_000) invalid();
  const envelope = closed(JSON.parse(raw), ['data', 'meta']);
  const meta = closed(envelope.meta, contextRead ? ['requestId', 'correlationId'] : ['requestId', 'correlationId', 'replayed']);
  if (uuid(meta.requestId) !== uuid(meta.correlationId) || !contextRead && typeof meta.replayed !== 'boolean') invalid();
  return { data: envelope.data, replayed: contextRead ? false : meta.replayed as boolean };
}
const options = { mode: 'same-origin', credentials: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer' } as const;
export async function loadMembershipActivationContext(input: KnownMembership, signal?: AbortSignal): Promise<MembershipActivationContext> {
  const scope = known(input);
  const data = (await result(await fetch(`${membershipActivationPath(scope)}/activation-context`, {
    ...options, method: 'GET', headers: { Accept: 'application/json' }, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
  }), true)).data;
  const row = closed(data, ['organizationId', 'schoolId', 'membershipId', 'state', 'version']);
  if (row.organizationId !== scope.organizationId || row.schoolId !== scope.schoolId || row.membershipId !== scope.membershipId
    || !['DRAFT', 'ACTIVE', 'FROZEN', 'CANCELLATION_PENDING', 'CANCELLED', 'EXPIRED'].includes(String(row.state))
    || !Number.isSafeInteger(row.version) || Number(row.version) < 1) invalid();
  return { ...scope, state: row.state as MembershipActivationContext['state'], version: row.version as number };
}
export async function previewMembershipActivation(scope: KnownMembership, input: MembershipActivationPreviewInput, signal?: AbortSignal): Promise<MembershipActivationPreview> {
  const saved = await result(await fetch(`${membershipActivationPath(scope)}/activation-preview`, {
    ...options, method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-HON-Human-Command': 'billing.membership.activation.preview' },
    body: JSON.stringify(validateMembershipActivationPreviewInput(input)), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
  }));
  const preview = verifyMembershipActivationPreview(saved.data);
  if (preview.membershipId !== known(scope).membershipId || saved.replayed) invalid();
  return preview;
}
export function prepareMembershipActivation(scope: KnownMembership, input: ConfirmMembershipActivationInput, key: string): ActivationRequest {
  return Object.freeze({ scope: Object.freeze(known(scope)), body: JSON.stringify(validateConfirmMembershipActivationInput(input)), key: uuid(key) });
}
export async function activateKnownMembership(request: ActivationRequest): Promise<ActivationResult> {
  closed(request, ['scope', 'body', 'key']);
  const input = validateConfirmMembershipActivationInput(JSON.parse(request.body));
  if (JSON.stringify(input) !== request.body || uuid(request.key) !== request.key) invalid();
  try {
    const saved = await result(await fetch(`${membershipActivationPath(request.scope)}/activate`, {
      ...options, method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-HON-Human-Command': 'billing.membership.activate', 'Idempotency-Key': request.key },
      body: request.body, signal: AbortSignal.timeout(15_000),
    }));
    const receipt = verifyMembershipActivationReceipt(saved.data, request.scope.membershipId), period = receipt.effectivePeriod;
    if (receipt.previousVersion !== input.expectedVersion || period.startDate !== input.startDate || period.endDate !== input.endDate || period.dateSource !== input.dateSource
      || receipt.reasonCode !== input.reasonCode
      || JSON.stringify([...receipt.acknowledgedWarnings].sort()) !== JSON.stringify([...input.acknowledgedWarnings].sort())
      || JSON.stringify(receipt.overridesUsed.map(o => o.code).sort()) !== JSON.stringify(input.overrides.map(o => o.code).sort())
      || (receipt.adultVerification?.method ?? null) !== (input.adultVerification?.method ?? null)) invalid();
    return { receipt, replayed: saved.replayed };
  } catch (e) {
    if (e instanceof MembershipActivationError) throw e;
    throw new MembershipActivationError('The outcome is unknown. No activation is assumed. Retry only the exact retained request.', 0, '', true);
  }
}
