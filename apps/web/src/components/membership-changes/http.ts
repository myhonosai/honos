import {
  validatePauseMembershipInput, validateRecordMembershipRefundInput, validateResumeMembershipInput, validateSetSchoolMembershipPausePolicyInput,
  verifyMembershipPauseReceipt, verifyMembershipPausesAndRefunds, verifyMembershipRefundRecord, verifySchoolMembershipPausePolicy, verifySchoolMembershipPausePolicyRead,
  type MembershipPauseReceipt, type MembershipPausesAndRefunds, type MembershipRefundRecord, type PauseMembershipInput, type RecordMembershipRefundInput,
  type ResumeMembershipInput, type SchoolMembershipPausePolicy, type SchoolMembershipPausePolicyRead, type SetSchoolMembershipPausePolicyInput,
} from '@hon/contracts';
import { reportConfirmedSessionInvalidation } from '../session-invalidation';

/**
 * Membership pause, resume, cancellation and refund records (0224). Reads send no Idempotency-Key and no query string; each
 * command sends its own X-HON-Human-Command and an Idempotency-Key, so no call can be replayed as another. The server decides
 * every permission, state and date again. Nothing here charges, refunds or moves money: a refund is a record of money the
 * school returned outside HON, and the hold fee is recorded policy only.
 */
export type ChangeErrorKind =
  /** Session ended. */ 'SESSION'
  /** Not allowed for this staff member at this school. Nothing changed. */ | 'DENIED'
  /** The membership is not available at this school. */ | 'GONE'
  /** The membership or the pause rules changed since they were read. Nothing changed. */ | 'CHANGED'
  /** The membership is no longer in a state this action applies to. Nothing changed. */ | 'STATE'
  /** The school does not offer pauses. */ | 'NOT_OFFERED'
  /** The resume date is not after today or is past the longest pause. */ | 'TOO_LONG'
  /** The pause would pass the paused days allowed per year. */ | 'YEARLY'
  /** The membership has an active payment schedule. */ | 'SCHEDULE'
  /** Paused before HON kept pause records, so there is no pause to close. */ | 'LEGACY'
  /** The school's time zone is not usable. */ | 'TIMEZONE'
  /** The request was not accepted as sent. Nothing changed. */ | 'INVALID'
  /** Too many requests. Nothing changed; the same request may be sent again later. */ | 'RATE'
  /** Busy, or the outcome is not known. Only the identical request (same key) may be sent again. */ | 'UNKNOWN';
export class ChangeError extends Error { constructor(readonly kind: ChangeErrorKind, readonly code: string | null = null) { super(kind); } }
export type Owned = () => boolean;
export type ChangeScope = Readonly<{ organizationId: string; schoolId: string }>;
export type CancelledMembership = Readonly<{ id: string; state: 'CANCELLED'; version: number }>;

const RESPONSE_MAX = 1_000_000;
const JSON_TYPE = /^application\/json(?:\s*;|$)/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTROL = /[\u0000-\u001f\u007f]/;
const CANCEL_KEYS = ['id', 'billingAccountId', 'participantPersonId', 'planCode', 'state', 'version', 'cancellationReason', 'effectiveAt', 'createdAt'];

const codeOf = (v: unknown): string | null => v && typeof v === 'object' && !Array.isArray(v) && typeof (v as { code?: unknown }).code === 'string' ? (v as { code: string }).code : null;
function data(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, 'data') || !Object.hasOwn(value, 'meta')) throw new Error('shape');
  return (value as { data: unknown }).data;
}
function base(scope: ChangeScope): string {
  if (!UUID.test(scope.organizationId) || !UUID.test(scope.schoolId)) throw new ChangeError('INVALID');
  return `/api/v1/organizations/${scope.organizationId.toLowerCase()}/schools/${scope.schoolId.toLowerCase()}/billing`;
}
function membershipPath(scope: ChangeScope, membershipId: string): string {
  if (!UUID.test(membershipId)) throw new ChangeError('INVALID');
  return `${base(scope)}/memberships/${membershipId.toLowerCase()}`;
}

async function exchange(path: string, signal: AbortSignal, owned: Owned, command?: Readonly<{ name: string; body: string; key: string }>): Promise<{ status: number; value: unknown }> {
  const r = await fetch(path, { method: command ? 'POST' : 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error',
    referrerPolicy: 'no-referrer', signal,
    headers: { Accept: 'application/json', ...(command ? { 'Content-Type': 'application/json', 'X-HON-Human-Command': command.name, 'Idempotency-Key': command.key } : {}) },
    ...(command ? { body: command.body } : {}) });
  // A retired request (aborted, or no longer the one shown) never ends a newer session.
  signal.throwIfAborted();
  if (r.status === 401) { if (owned()) reportConfirmedSessionInvalidation(); throw new ChangeError('SESSION'); }
  if (r.redirected || !JSON_TYPE.test(r.headers.get('content-type') ?? '')) return { status: r.status, value: null };
  const text = await r.text();
  if (text.length > RESPONSE_MAX) throw new ChangeError('UNKNOWN');
  try { return { status: r.status, value: JSON.parse(text) as unknown }; } catch { return { status: r.status, value: null }; }
}

/** What a refused answer means. Only these exact answers are definitive; anything else (busy, 5xx, drift) is UNKNOWN. */
export function changeErrorFor(status: number, code: string | null): ChangeError {
  if (status === 403) return new ChangeError('DENIED', code);
  if (status === 404) return new ChangeError('GONE', code);
  if (status === 400) return new ChangeError('INVALID', code);
  if (status === 429) return new ChangeError('RATE', code);
  if (status === 422 && code === 'MEMBERSHIP_PAUSE_TOO_LONG') return new ChangeError('TOO_LONG', code);
  if (status === 422 && code === 'MEMBERSHIP_PAUSE_YEARLY_LIMIT') return new ChangeError('YEARLY', code);
  if (status === 409) {
    if (code === 'VERSION_CONFLICT') return new ChangeError('CHANGED', code);
    if (code === 'MEMBERSHIP_NOT_ACTIVE' || code === 'MEMBERSHIP_NOT_PAUSED' || code === 'MEMBERSHIP_NOT_CANCELLED') return new ChangeError('STATE', code);
    if (code === 'MEMBERSHIP_PAUSE_NOT_OFFERED') return new ChangeError('NOT_OFFERED', code);
    if (code === 'MEMBERSHIP_PAUSE_REQUIRES_BILLING_ARRANGEMENT') return new ChangeError('SCHEDULE', code);
    if (code === 'MEMBERSHIP_PAUSE_EVIDENCE_MISSING') return new ChangeError('LEGACY', code);
    if (code === 'SCHOOL_TIMEZONE_INVALID') return new ChangeError('TIMEZONE', code);
    if (code === 'IDEMPOTENCY_KEY_REUSED') return new ChangeError('INVALID', code);
  }
  // MEMBERSHIP_LIFECYCLE_CONFLICT (a lock or serialization wait), IDEMPOTENCY_IN_PROGRESS, 5xx: the same request may be sent again.
  return new ChangeError('UNKNOWN', code);
}

async function read<T>(path: string, verify: (v: unknown) => T, signal: AbortSignal, owned: Owned): Promise<T> {
  let answer: { status: number; value: unknown };
  try { answer = await exchange(path, signal, owned); }
  catch (error) { if (error instanceof ChangeError || signal.aborted) throw error; throw new ChangeError('UNKNOWN'); }
  if (answer.status !== 200) throw changeErrorFor(answer.status, codeOf(answer.value));
  try { return verify(data(answer.value)); } catch { throw new ChangeError('UNKNOWN'); }
}
async function command<T>(path: string, name: string, body: unknown, key: string, verify: (v: unknown) => T, signal: AbortSignal, owned: Owned): Promise<T> {
  if (typeof key !== 'string' || !UUID.test(key)) throw new ChangeError('INVALID');
  let answer: { status: number; value: unknown };
  try { answer = await exchange(path, signal, owned, { name, body: JSON.stringify(body), key }); }
  catch (error) { if (error instanceof ChangeError) throw error; throw new ChangeError('UNKNOWN'); }
  if (answer.status !== 200) throw changeErrorFor(answer.status, codeOf(answer.value));
  try { return verify(data(answer.value)); } catch { throw new ChangeError('UNKNOWN'); }
}
function checked<T>(validate: () => T): T { try { return validate(); } catch { throw new ChangeError('INVALID'); } }

/** The 0177 cancellation receipt: exactly the known keys, this membership, CANCELLED. */
export function verifyCancelledMembership(value: unknown, membershipId: string): CancelledMembership {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('shape');
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some((k) => !CANCEL_KEYS.includes(k)) || typeof row.id !== 'string' || row.id.toLowerCase() !== membershipId.toLowerCase()
    || row.state !== 'CANCELLED' || !Number.isSafeInteger(row.version) || (row.version as number) < 2) throw new Error('shape');
  return { id: row.id, state: 'CANCELLED', version: row.version as number };
}
export function cancellationReason(value: string): string {
  const reason = value.trim();
  if (reason.length < 1 || reason.length > 1000 || CONTROL.test(reason)) throw new ChangeError('INVALID');
  return reason;
}

export const membershipChangesApi = {
  /** The school's pause rules (or none yet) and the school's local today. */
  policy(scope: ChangeScope, signal: AbortSignal, owned: Owned): Promise<SchoolMembershipPausePolicyRead> {
    return Promise.resolve().then(() => read(`${base(scope)}/membership-pause-policy`, verifySchoolMembershipPausePolicyRead, signal, owned));
  },
  /** One membership's current state and version, its pauses and its refund records. */
  history(scope: ChangeScope, membershipId: string, signal: AbortSignal, owned: Owned): Promise<MembershipPausesAndRefunds> {
    return Promise.resolve().then(() => read(`${membershipPath(scope, membershipId)}/pauses-and-refunds`, (v) => verifyMembershipPausesAndRefunds(v, membershipId), signal, owned));
  },
  async setPolicy(scope: ChangeScope, input: SetSchoolMembershipPausePolicyInput, key: string, signal: AbortSignal, owned: Owned): Promise<SchoolMembershipPausePolicy> {
    const body = checked(() => validateSetSchoolMembershipPausePolicyInput(input));
    return command(`${base(scope)}/membership-pause-policy`, 'billing.membership.pause_policy.set', body, key, verifySchoolMembershipPausePolicy, signal, owned);
  },
  async pause(scope: ChangeScope, membershipId: string, input: PauseMembershipInput, key: string, signal: AbortSignal, owned: Owned): Promise<MembershipPauseReceipt> {
    const path = `${membershipPath(scope, membershipId)}/pause`, body = checked(() => validatePauseMembershipInput(input));
    return command(path, 'billing.membership.pause', body, key, (v) => verifyMembershipPauseReceipt(v, membershipId, 'FROZEN'), signal, owned);
  },
  async resume(scope: ChangeScope, membershipId: string, input: ResumeMembershipInput, key: string, signal: AbortSignal, owned: Owned): Promise<MembershipPauseReceipt> {
    const path = `${membershipPath(scope, membershipId)}/resume`, body = checked(() => validateResumeMembershipInput(input));
    return command(path, 'billing.membership.resume', body, key, (v) => verifyMembershipPauseReceipt(v, membershipId, 'ACTIVE'), signal, owned);
  },
  /** The existing 0177 cancellation: immediate, also from a pause. No refund, credit or payment change. */
  async cancel(scope: ChangeScope, membershipId: string, input: { expectedVersion: number; cancellationReason: string }, key: string, signal: AbortSignal, owned: Owned): Promise<CancelledMembership> {
    const path = `${membershipPath(scope, membershipId)}/cancel`;
    const body = checked(() => {
      if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) throw new Error('version');
      return { expectedVersion: input.expectedVersion, cancellationReason: cancellationReason(input.cancellationReason) };
    });
    return command(path, 'billing.membership.cancel', body, key, (v) => verifyCancelledMembership(v, membershipId), signal, owned);
  },
  /** A record of money returned outside HON. Nothing is refunded through HON. */
  async recordRefund(scope: ChangeScope, membershipId: string, input: RecordMembershipRefundInput, key: string, signal: AbortSignal, owned: Owned): Promise<MembershipRefundRecord> {
    const path = `${membershipPath(scope, membershipId)}/refund-records`, body = checked(() => validateRecordMembershipRefundInput(input));
    return command(path, 'billing.membership.refund.record', body, key, (v) => verifyMembershipRefundRecord(v, membershipId), signal, owned);
  },
};
export type MembershipChangesApi = typeof membershipChangesApi;

/** Whether a failed command may be sent again with the same key: only when its outcome is not known, or nothing was sent (rate limit). */
export const keepForRetry = (error: unknown) => !(error instanceof ChangeError) || error.kind === 'UNKNOWN' || error.kind === 'RATE';

/** Major-unit text ("12.50") to minor units for this currency; null when it is not a positive amount with the currency's decimals. */
export function toMinor(text: string, currency: string): number | null {
  if (!/^[A-Z]{3}$/.test(currency)) return null;
  let digits: number;
  try { digits = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2; } catch { return null; }
  const match = /^(\d{1,9})(?:\.(\d+))?$/.exec(text.trim());
  if (!match || (match[2] ?? '').length > digits) return null;
  const minor = Number(match[1]) * 10 ** digits + Number((match[2] ?? '').padEnd(digits, '0') || '0');
  return Number.isSafeInteger(minor) && minor >= 1 && minor <= 100_000_000 ? minor : null;
}
/** Minor units shown in the currency's own format. */
export function money(language: string, amountMinor: number, currency: string): string {
  try {
    const format = new Intl.NumberFormat(language, { style: 'currency', currency });
    return format.format(amountMinor / 10 ** (format.resolvedOptions().maximumFractionDigits ?? 2));
  } catch { return `${amountMinor} ${currency}`; }
}
/** A school-local calendar date plus whole days, as YYYY-MM-DD. */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00.000Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10);
}
