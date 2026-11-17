import {
  isStaffShiftWeekStart, validateSaveStaffShiftInput, verifyStaffShiftReceipt, verifyStaffShiftWeek,
  type SaveStaffShiftInput, type StaffShift, type StaffShiftWeek,
} from '@hon/contracts';
import { reportConfirmedSessionInvalidation } from '../session-invalidation';

/**
 * Staff > Shifts (0467). The week read sends no Idempotency-Key; a save sends its own X-HON-Human-Command and an
 * Idempotency-Key. The server decides the permission, the person, the times and the version again.
 */
export type ShiftErrorKind =
  /** Session ended. */ 'SESSION'
  /** Not allowed here, or the person is not current staff. Nothing changed. */ | 'DENIED'
  /** Someone changed the shift since it was read. Nothing changed. */ | 'CHANGED'
  /** The person already has a shift at that time. Nothing changed. */ | 'OVERLAP'
  /** The shift was cancelled or is gone. Nothing changed. */ | 'GONE'
  /** The request was not accepted as sent. Nothing changed. */ | 'INVALID'
  /** Too many requests. Nothing changed; the same request may be sent again later. */ | 'RATE'
  /** Busy, or the outcome is not known. Only the identical request (same key) may be sent again. */ | 'UNKNOWN';
export class ShiftError extends Error { constructor(readonly kind: ShiftErrorKind, readonly code: string | null = null) { super(kind); } }
export type Owned = () => boolean;
export type ShiftScope = Readonly<{ organizationId: string; schoolId: string }>;
export const SHIFT_SAVE_COMMAND = 'staff_shift.save';

const RESPONSE_MAX = 400_000;
const JSON_TYPE = /^application\/json(?:\s*;|$)/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const codeOf = (v: unknown): string | null => v && typeof v === 'object' && !Array.isArray(v) && typeof (v as { code?: unknown }).code === 'string' ? (v as { code: string }).code : null;
function envelope(value: unknown): { data: unknown; meta: Record<string, unknown> } {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, 'data') || !Object.hasOwn(value, 'meta')) throw new Error('shape');
  const meta = (value as { meta: unknown }).meta;
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) throw new Error('shape');
  return { data: (value as { data: unknown }).data, meta: meta as Record<string, unknown> };
}
function id(value: string): string { if (!UUID.test(value)) throw new ShiftError('INVALID'); return value.toLowerCase(); }
function base(scope: ShiftScope): string { return `/api/v1/organizations/${id(scope.organizationId)}/schools/${id(scope.schoolId)}/staff/shifts`; }

async function exchange(url: string, signal: AbortSignal, owned: Owned, command?: Readonly<{ body: string; key: string }>): Promise<{ status: number; value: unknown }> {
  const r = await fetch(url, { method: command ? 'POST' : 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error',
    referrerPolicy: 'no-referrer', signal,
    headers: { Accept: 'application/json', ...(command ? { 'Content-Type': 'application/json', 'X-HON-Human-Command': SHIFT_SAVE_COMMAND, 'Idempotency-Key': command.key } : {}) },
    ...(command ? { body: command.body } : {}) });
  // A retired request (aborted, or no longer the one shown) never ends a newer session.
  signal.throwIfAborted();
  if (r.status === 401) { if (owned()) reportConfirmedSessionInvalidation(); throw new ShiftError('SESSION'); }
  if (r.redirected || !JSON_TYPE.test(r.headers.get('content-type') ?? '')) return { status: r.status, value: null };
  const text = await r.text();
  if (text.length > RESPONSE_MAX) throw new ShiftError('UNKNOWN');
  try { return { status: r.status, value: JSON.parse(text) as unknown }; } catch { return { status: r.status, value: null }; }
}

/** What a refused answer means. Only these exact answers are definitive; anything else (busy, 5xx, drift) is UNKNOWN. */
export function shiftErrorFor(status: number, code: string | null): ShiftError {
  if (status === 403) return new ShiftError('DENIED', code);
  if (status === 400) return new ShiftError('INVALID', code);
  if (status === 404) return new ShiftError('GONE', code);
  if (status === 429) return new ShiftError('RATE', code);
  if (status === 409 && code === 'VERSION_CONFLICT') return new ShiftError('CHANGED', code);
  if (status === 409 && code === 'SHIFT_OVERLAP') return new ShiftError('OVERLAP', code);
  if (status === 409 && code === 'STAFF_SHIFT_CANCELLED') return new ShiftError('GONE', code);
  if (status === 409 && code === 'IDEMPOTENCY_KEY_REUSED') return new ShiftError('INVALID', code);
  // STAFF_SHIFT_CONFLICT (a lock wait), IDEMPOTENCY_IN_PROGRESS, 5xx: the same request may be sent again.
  return new ShiftError('UNKNOWN', code);
}

export const shiftApi = {
  /** One Monday-to-Sunday week. */
  async week(scope: ShiftScope, weekStart: string, signal: AbortSignal, owned: Owned): Promise<StaffShiftWeek> {
    if (!isStaffShiftWeekStart(weekStart)) throw new ShiftError('INVALID');
    let answer: { status: number; value: unknown };
    try { answer = await exchange(`${base(scope)}/weeks/${weekStart}`, signal, owned); }
    catch (error) { if (error instanceof ShiftError || signal.aborted) throw error; throw new ShiftError('UNKNOWN'); }
    if (answer.status !== 200) throw shiftErrorFor(answer.status, codeOf(answer.value));
    try { return verifyStaffShiftWeek(envelope(answer.value).data, { weekStart }); } catch { throw new ShiftError('UNKNOWN'); }
  },
  /** Add, change or cancel one shift. The receipt must be the next version of the same person's shift. */
  async save(scope: ShiftScope, input: SaveStaffShiftInput, key: string, signal: AbortSignal, owned: Owned): Promise<StaffShift> {
    if (typeof key !== 'string' || !UUID.test(key)) throw new ShiftError('INVALID');
    let body: SaveStaffShiftInput;
    try { body = validateSaveStaffShiftInput(input); } catch { throw new ShiftError('INVALID'); }
    let answer: { status: number; value: unknown };
    try { answer = await exchange(base(scope), signal, owned, { body: JSON.stringify(body), key }); }
    catch (error) { if (error instanceof ShiftError) throw error; throw new ShiftError('UNKNOWN'); }
    if (answer.status !== 200) throw shiftErrorFor(answer.status, codeOf(answer.value));
    try {
      const e = envelope(answer.value);
      const shift = verifyStaffShiftReceipt({ shift: e.data, replayed: e.meta.replayed }, { version: body.expectedVersion + 1, staffPrincipalId: body.staffPrincipalId }).shift;
      if ((body.shiftId !== null && shift.shiftId !== body.shiftId) || shift.status !== body.status) throw new Error('drift');
      return shift;
    } catch { throw new ShiftError('UNKNOWN'); }
  },
};
export type ShiftApi = typeof shiftApi;

/** Whether a failed save may be sent again with the same key: only when its outcome is not known, or nothing was sent (rate limit). */
export const keepForRetry = (error: unknown) => !(error instanceof ShiftError) || error.kind === 'UNKNOWN' || error.kind === 'RATE';
