import {
  validateMembershipDateRevisionPreviewInput, validateConfirmMembershipDateRevisionInput, validateMembershipDateConfirmationQueueInput,
  verifyMembershipDateRevisionPreview, verifyMembershipDateRevisionReceipt, verifyMembershipDateHistory,
  verifyMembershipDateConfirmationQueue, verifySchoolMembershipStatusSummary,
  type MembershipDateRevisionPreviewInput, type ConfirmMembershipDateRevisionInput, type MembershipDateConfirmationQueueInput,
} from '@hon/contracts';
import { membershipActivationPath, type KnownMembership } from './membership-activation-http';
import { reportConfirmedSessionInvalidation } from './session-invalidation';

export type DateScope = Pick<KnownMembership, 'organizationId' | 'schoolId'>;
export type DateRequest = Readonly<{ scope: Readonly<KnownMembership>; body: string; key: string }>;
export type DateResult = { receipt: ReturnType<typeof verifyMembershipDateRevisionReceipt>; replayed: boolean };
export class MembershipDatesError extends Error {
  constructor(message: string, readonly status: number, readonly code = '', readonly uncertain = false) { super(message); }
}
const messages: Record<string, string> = {
  DATE_REVISION_PREVIEW_STALE: 'The reviewed facts changed. Request a new preview and review every warning again.',
  VERSION_CONFLICT: 'The membership changed. Load current history and request a new preview.',
  PERIOD_VERSION_CONFLICT: 'The confirmed dates changed. Load current history and request a new preview.',
  MEMBERSHIP_NOT_ACTIVE: 'Only confirmed ACTIVE memberships support date revisions. No dates were changed by this refused request.',
  IDEMPOTENCY_KEY_REUSED: 'This key belongs to a different request. Verify current history before starting another review.',
  IDEMPOTENCY_IN_PROGRESS: 'The original request is still processing. Only an explicit retry of the retained exact request is available.',
  DATE_REVISION_BLOCKED: 'The server blocked this revision. Review the current blockers in a new preview.',
  DATE_SOURCE_MISMATCH: 'The date source changed. Request a new preview.',
  DATE_REVISION_ACKNOWLEDGEMENT_REQUIRED: 'Acknowledge exactly the warnings in a fresh preview.',
  MEMBERSHIP_RETROACTIVE_DATE_REVISION_FORBIDDEN: 'An authorized staff member with retroactive date permission must review this change.',
  MEMBERSHIP_DATE_REVISION_FORBIDDEN: 'Date revision permission is unavailable in this school.',
  MEMBERSHIP_DATE_HISTORY_FORBIDDEN: 'Membership date history is not authorized in this school.',
  MEMBERSHIP_STATUS_SUMMARY_FORBIDDEN: 'Membership reporting is not authorized in this school.',
  BILLING_MEMBERSHIP_NOT_FOUND: 'This membership is unavailable in the selected school.',
  SCHOOL_TIMEZONE_INVALID: 'The school timezone must be corrected by an authorized administrator.',
  VALIDATION_FAILED: 'Check the school-local dates, reasons and confirmations.',
  IDEMPOTENCY_KEY_REQUIRED: 'A new confirmation requires a unique request key.',
  IDEMPOTENCY_KEY_NOT_ACCEPTED: 'This read does not accept a command key.',
  MEMBERSHIP_LIFECYCLE_CONFLICT: 'Another membership operation conflicted. Review current history before proceeding.',
  MEMBERSHIP_LIFECYCLE_UNAVAILABLE: 'The service outcome is unavailable. No successful revision is assumed.',
};
const unknown = 'The result is unknown. No date change is assumed. Retry only the exact retained request, or deliberately abandon local recovery.';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const options = { mode: 'same-origin', credentials: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer' } as const;
function invalid(): never { throw new Error('Unverified membership date response.'); }
function school(scope: DateScope): string {
  if (Object.keys(scope).sort().join() !== 'organizationId,schoolId' || !UUID.test(scope.organizationId) || !UUID.test(scope.schoolId)) invalid();
  return `/api/v1/organizations/${scope.organizationId.toLowerCase()}/schools/${scope.schoolId.toLowerCase()}`;
}
async function result(response: Response, commandMeta: boolean): Promise<{ data: unknown; replayed: boolean }> {
  if (!response.ok) {
    // Conceal all mounted protected surfaces before consuming an asynchronous error body.
    // A school permission refusal is local; it is not evidence that the session expired.
    if (response.status === 401) reportConfirmedSessionInvalidation();
    let code = '';
    try { const raw = await response.text(); if (raw.length < 4000) { const e = JSON.parse(raw); if (typeof e?.code === 'string' && Object.hasOwn(messages, e.code)) code = e.code; } } catch { /* Never render raw error details. */ }
    const uncertain = ![400, 401, 403, 404, 405, 409, 413, 415, 422].includes(response.status) || code === 'IDEMPOTENCY_IN_PROGRESS';
    throw new MembershipDatesError(response.status === 401 ? 'Session expired. Sign in again before verifying access.'
      : response.status === 403 ? (messages[code] ?? 'Current school permission or active entitlement is unavailable.')
      : uncertain ? unknown : messages[code] ?? 'The request was refused. Verify current school access and membership facts.', response.status, code, uncertain);
  }
  if (response.status !== 200 || response.redirected || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')
    || !/^private,\s*no-store$/i.test(response.headers.get('cache-control') ?? '')) invalid();
  const raw = await response.text(); if (raw.length > 1_000_000) invalid();
  const envelope = JSON.parse(raw), meta = envelope?.meta;
  if (!envelope || Object.keys(envelope).sort().join() !== 'data,meta' || !meta || Object.keys(meta).sort().join() !== (commandMeta ? 'correlationId,replayed,requestId' : 'correlationId,requestId')
    || !UUID.test(meta.requestId) || meta.correlationId !== meta.requestId || commandMeta && typeof meta.replayed !== 'boolean') invalid();
  return { data: envelope.data, replayed: commandMeta ? meta.replayed : false };
}
async function read(path: string, marker: string | null, body: unknown, signal?: AbortSignal, commandMeta = false) {
  const saved = await result(await fetch(path, { ...options, method: marker ? 'POST' : 'GET', headers: {
    Accept: 'application/json', ...(marker ? { 'Content-Type': 'application/json', 'X-HON-Human-Command': marker } : {}),
  }, ...(marker ? { body: JSON.stringify(body) } : {}), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000) }), commandMeta);
  if (saved.replayed) invalid();
  return saved.data;
}
export async function previewMembershipDates(scope: KnownMembership, input: MembershipDateRevisionPreviewInput, signal?: AbortSignal) {
  const normalized = validateMembershipDateRevisionPreviewInput(input);
  const preview = verifyMembershipDateRevisionPreview(await read(`${membershipActivationPath(scope)}/effective-period/preview`, 'billing.membership.dates.preview', normalized, signal, true));
  if (preview.membershipId !== scope.membershipId.toLowerCase() || preview.changeKind !== normalized.changeKind
    || 'startDate' in normalized && (preview.proposedDates.startDate !== normalized.startDate || preview.proposedDates.endDate !== normalized.endDate)) invalid();
  return preview;
}
export async function loadMembershipDateHistory(scope: KnownMembership, signal?: AbortSignal) {
  return verifyMembershipDateHistory(await read(`${membershipActivationPath(scope)}/effective-period/history`, 'billing.membership.dates.history', {}, signal), scope.membershipId);
}
export async function loadMembershipDateQueue(scope: DateScope, input: MembershipDateConfirmationQueueInput = {}, signal?: AbortSignal) {
  return verifyMembershipDateConfirmationQueue(await read(`${school(scope)}/billing/memberships/date-confirmation-queue`, 'billing.membership.dates.queue', validateMembershipDateConfirmationQueueInput(input), signal));
}
export async function loadMembershipStatusSummary(scope: DateScope, signal?: AbortSignal) {
  const data = verifySchoolMembershipStatusSummary(await read(`${school(scope)}/reports/membership-status`, null, undefined, signal));
  if (data.organizationId !== scope.organizationId.toLowerCase() || data.schoolId !== scope.schoolId.toLowerCase()) invalid();
  return data;
}
export function prepareMembershipDateRevision(scope: KnownMembership, input: ConfirmMembershipDateRevisionInput, key: string): DateRequest {
  membershipActivationPath(scope);
  if (!UUID.test(key)) invalid();
  return Object.freeze({ scope: Object.freeze({ ...scope }), body: JSON.stringify(validateConfirmMembershipDateRevisionInput(input)), key: key.toLowerCase() });
}
export async function reviseMembershipDates(request: DateRequest): Promise<DateResult> {
  if (Object.keys(request).sort().join() !== 'body,key,scope' || !UUID.test(request.key)) invalid();
  const input = validateConfirmMembershipDateRevisionInput(JSON.parse(request.body));
  if (JSON.stringify(input) !== request.body) invalid();
  const path = `${membershipActivationPath(request.scope)}/effective-period/revisions`;
  try {
    const saved = await result(await fetch(path, { ...options, method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json',
      'X-HON-Human-Command': 'billing.membership.dates.revise', 'Idempotency-Key': request.key }, body: request.body, signal: AbortSignal.timeout(15_000) }), true);
    const receipt = verifyMembershipDateRevisionReceipt(saved.data, request.scope.membershipId), period = receipt.effectivePeriod;
    if (receipt.previousVersion !== input.expectedVersion || receipt.previousPeriod.periodVersion !== input.expectedPeriodVersion || receipt.changeKind !== input.changeKind
      || period.startDate !== input.startDate || period.endDate !== input.endDate || period.dateSource !== input.dateSource || receipt.reasonCode !== input.reasonCode
      || JSON.stringify([...receipt.acknowledgedWarnings].sort()) !== JSON.stringify([...input.acknowledgedWarnings].sort())) invalid();
    return { receipt, replayed: saved.replayed };
  } catch (e) {
    if (e instanceof MembershipDatesError) throw e;
    throw new MembershipDatesError(unknown, 0, '', true);
  }
}
