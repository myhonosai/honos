import {
  isStaffShiftWeekStart, validateSaveTimeEntry, validateTimeClockPunch, validateTimesheetDecision, verifyMyTimeClock, verifyTimeEntryReceipt,
  verifyTimesheetDecisionReceipt, verifyTimesheetWeek, type MyTimeClock, type SaveTimeEntryInput, type TimeClockPunchInput, type TimeEntry,
  type TimesheetDecisionInput, type TimesheetWeek, type WeekApproval,
} from '@hon/contracts';
import { reportConfirmedSessionInvalidation } from '../session-invalidation';

/**
 * Staff > Hours (0478). Reads send no Idempotency-Key; each command sends its own X-HON-Human-Command and an
 * Idempotency-Key. A punch never carries a time: the server's clock is the only clock. The server decides the
 * permission, the person, the times and the version again.
 */
export type HoursErrorKind =
  /** Session ended. */ 'SESSION'
  /** Not allowed here, or the person is not current staff. Nothing changed. */ | 'DENIED'
  /** A manager tried to approve their own week; only the school's owner may. Nothing changed. */ | 'SELF_APPROVAL'
  /** Someone (or another device) changed this since it was read. Nothing changed. */ | 'CHANGED'
  /** The entry overlaps another entry of the same person. Nothing changed. */ | 'OVERLAP'
  /** The week is approved. Nothing changed. */ | 'APPROVED'
  /** Someone is still clocked in that week. Nothing changed. */ | 'OPEN_ENTRY'
  /** The open entry is over 24 hours; a manager fixes it. Nothing changed. */ | 'TOO_LONG'
  /** The entry is gone. Nothing changed. */ | 'GONE'
  /** The request was not accepted as sent. Nothing changed. */ | 'INVALID'
  /** Too many requests. Nothing changed; the same request may be sent again later. */ | 'RATE'
  /** Busy, or the outcome is not known. Only the identical request (same key) may be sent again. */ | 'UNKNOWN';
export class HoursError extends Error { constructor(readonly kind: HoursErrorKind, readonly code: string | null = null) { super(kind); } }
export type Owned = () => boolean;
export type HoursScope = Readonly<{ organizationId: string; schoolId: string }>;
export const HOURS_COMMANDS = { punch: 'staff_time.punch', entry: 'staff_time.entry.save', decide: 'staff_timesheet.decide' } as const;

const RESPONSE_MAX = 900_000;
const JSON_TYPE = /^application\/json(?:\s*;|$)/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const codeOf = (v: unknown): string | null => v && typeof v === 'object' && !Array.isArray(v) && typeof (v as { code?: unknown }).code === 'string' ? (v as { code: string }).code : null;
function envelope(value: unknown): { data: unknown; meta: Record<string, unknown> } {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, 'data') || !Object.hasOwn(value, 'meta')) throw new Error('shape');
  const meta = (value as { meta: unknown }).meta;
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) throw new Error('shape');
  return { data: (value as { data: unknown }).data, meta: meta as Record<string, unknown> };
}
function id(value: string): string { if (!UUID.test(value)) throw new HoursError('INVALID'); return value.toLowerCase(); }
function base(scope: HoursScope): string { return `/api/v1/organizations/${id(scope.organizationId)}/schools/${id(scope.schoolId)}/staff/time`; }

async function exchange(url: string, signal: AbortSignal, owned: Owned, command?: Readonly<{ name: string; body: string; key: string }>): Promise<{ status: number; value: unknown }> {
  const r = await fetch(url, { method: command ? 'POST' : 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error',
    referrerPolicy: 'no-referrer', signal,
    headers: { Accept: 'application/json', ...(command ? { 'Content-Type': 'application/json', 'X-HON-Human-Command': command.name, 'Idempotency-Key': command.key } : {}) },
    ...(command ? { body: command.body } : {}) });
  // A retired request (aborted, or no longer the one shown) never ends a newer session.
  signal.throwIfAborted();
  if (r.status === 401) { if (owned()) reportConfirmedSessionInvalidation(); throw new HoursError('SESSION'); }
  if (r.redirected || !JSON_TYPE.test(r.headers.get('content-type') ?? '')) return { status: r.status, value: null };
  const text = await r.text();
  if (text.length > RESPONSE_MAX) throw new HoursError('UNKNOWN');
  try { return { status: r.status, value: JSON.parse(text) as unknown }; } catch { return { status: r.status, value: null }; }
}

/** What a refused answer means. Only these exact answers are definitive; anything else (busy, 5xx, drift) is UNKNOWN. */
export function hoursErrorFor(status: number, code: string | null): HoursError {
  if (status === 403) return new HoursError(code === 'TIMESHEET_SELF_APPROVAL' ? 'SELF_APPROVAL' : 'DENIED', code);
  if (status === 400) return new HoursError('INVALID', code);
  if (status === 404) return new HoursError('GONE', code);
  if (status === 429) return new HoursError('RATE', code);
  if (status === 409) {
    const kind = ({ VERSION_CONFLICT: 'CHANGED', TIME_CLOCK_STATE_CHANGED: 'CHANGED', TIME_ENTRY_OVERLAP: 'OVERLAP', TIMESHEET_APPROVED: 'APPROVED',
      TIMESHEET_HAS_OPEN_ENTRY: 'OPEN_ENTRY', TIME_ENTRY_TOO_LONG: 'TOO_LONG', IDEMPOTENCY_KEY_REUSED: 'INVALID' } as Record<string, HoursErrorKind>)[code ?? ''];
    if (kind) return new HoursError(kind, code);
  }
  // STAFF_TIME_CONFLICT (a lock wait), IDEMPOTENCY_IN_PROGRESS, 5xx: the same request may be sent again.
  return new HoursError('UNKNOWN', code);
}

async function read<T>(url: string, signal: AbortSignal, owned: Owned, verify: (value: unknown) => T): Promise<T> {
  let answer: { status: number; value: unknown };
  try { answer = await exchange(url, signal, owned); }
  catch (error) { if (error instanceof HoursError || signal.aborted) throw error; throw new HoursError('UNKNOWN'); }
  if (answer.status !== 200) throw hoursErrorFor(answer.status, codeOf(answer.value));
  try { return verify(envelope(answer.value).data); } catch { throw new HoursError('UNKNOWN'); }
}
async function command<T>(url: string, name: string, body: object, key: string, signal: AbortSignal, owned: Owned, verify: (data: unknown, replayed: unknown) => T): Promise<T> {
  if (typeof key !== 'string' || !UUID.test(key)) throw new HoursError('INVALID');
  let answer: { status: number; value: unknown };
  try { answer = await exchange(url, signal, owned, { name, body: JSON.stringify(body), key }); }
  catch (error) { if (error instanceof HoursError) throw error; throw new HoursError('UNKNOWN'); }
  if (answer.status !== 200) throw hoursErrorFor(answer.status, codeOf(answer.value));
  try { const e = envelope(answer.value); return verify(e.data, e.meta.replayed); } catch { throw new HoursError('UNKNOWN'); }
}
function checked<T>(validate: (value: unknown) => T, value: unknown): T { try { return validate(value); } catch { throw new HoursError('INVALID'); } }

export const hoursApi = {
  /** The signed-in person's clock and this week's entries. */
  clock(scope: HoursScope, signal: AbortSignal, owned: Owned): Promise<MyTimeClock> {
    return read(`${base(scope)}/clock`, signal, owned, verifyMyTimeClock);
  },
  /** Everyone's week (staff.timesheet.manage). */
  timesheet(scope: HoursScope, weekStart: string, signal: AbortSignal, owned: Owned): Promise<TimesheetWeek> {
    if (!isStaffShiftWeekStart(weekStart)) return Promise.reject(new HoursError('INVALID'));
    return read(`${base(scope)}/weeks/${weekStart}`, signal, owned, (v) => verifyTimesheetWeek(v, { weekStart }));
  },
  async punch(scope: HoursScope, input: TimeClockPunchInput, key: string, signal: AbortSignal, owned: Owned): Promise<TimeEntry> {
    const body = checked(validateTimeClockPunch, input);
    return command(`${base(scope)}/clock`, HOURS_COMMANDS.punch, body, key, signal, owned,
      (data, replayed) => verifyTimeEntryReceipt({ entry: data, replayed }, { version: body.expectedVersion + 1, closed: body.action === 'CLOCK_OUT' }).entry);
  },
  async saveEntry(scope: HoursScope, input: SaveTimeEntryInput, key: string, signal: AbortSignal, owned: Owned): Promise<TimeEntry> {
    const body = checked(validateSaveTimeEntry, input);
    return command(`${base(scope)}/entries`, HOURS_COMMANDS.entry, body, key, signal, owned,
      (data, replayed) => verifyTimeEntryReceipt({ entry: data, replayed }, { version: body.expectedVersion + 1, closed: true, entryId: body.entryId, staffPrincipalId: body.staffPrincipalId }).entry);
  },
  async decide(scope: HoursScope, input: TimesheetDecisionInput, key: string, signal: AbortSignal, owned: Owned): Promise<WeekApproval> {
    const body = checked(validateTimesheetDecision, input);
    return command(`${base(scope)}/weeks`, HOURS_COMMANDS.decide, body, key, signal, owned,
      (data, replayed) => verifyTimesheetDecisionReceipt({ approval: data, replayed }, body).approval);
  },
};
export type HoursApi = typeof hoursApi;

/** Whether a failed command may be sent again with the same key: only when its outcome is not known, or nothing was sent (rate limit). */
export const keepForRetry = (error: unknown) => !(error instanceof HoursError) || error.kind === 'UNKNOWN' || error.kind === 'RATE';
