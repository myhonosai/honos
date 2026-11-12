import {
  isPublicEventId, normalizeEventBookingCode, validatePublicEventBookingInput, validateSaveSchoolEventInput, validateSetSchoolEventBookingStatusInput,
  validateSetSchoolEventStatusInput, verifyPublicEventBookingOutcome, verifyPublicEventCancelOutcome, verifyPublicSchoolEvent, verifySchoolEventBookingReceipt,
  verifySchoolEventDetail, verifySchoolEventReceipt, verifySchoolEvents,
  type PublicEventBookingOutcome, type PublicEventCancelResult, type PublicSchoolEvent, type PublicSchoolEventBookingInput, type SaveSchoolEventInput,
  type SchoolEventBookingReceipt, type SchoolEventDetail, type SchoolEventReceipt, type SchoolEvents, type SetSchoolEventBookingStatusInput, type SetSchoolEventStatusInput,
} from '@hon/contracts';
import { reportConfirmedSessionInvalidation } from '../session-invalidation';

/**
 * Sale-day and event slot booking (B-SCH-3, 0261). Staff reads send no key; each staff command sends its own
 * X-HON-Human-Command and an Idempotency-Key, so one command can never be replayed as another. The family side uses the
 * public link id only: no cookie, no tenant id. The server decides every permission, spot and rule again.
 */
export type EventErrorKind =
  /** Session ended. */ 'SESSION'
  /** Not allowed for this staff member at this school. Nothing changed. */ | 'DENIED'
  /** The event or booking is not available at this school. */ | 'GONE'
  /** It changed since it was shown. Nothing changed. */ | 'CHANGED'
  /** A rule refused it (times fixed, spots below booked, cancelled event, status). Nothing changed. */ | 'REFUSED'
  /** The date is outside today to 365 days ahead, or no slot is left. Nothing changed. */ | 'DATE'
  /** The request was not accepted as sent. Nothing changed. */ | 'INVALID'
  /** Busy, or the outcome is not known. Only the identical request (same key) may be sent again. */ | 'UNKNOWN';
export class EventError extends Error { constructor(readonly kind: EventErrorKind, readonly code: string | null = null) { super(kind); } }
export type Owned = () => boolean;
export type EventScope = Readonly<{ organizationId: string; schoolId: string }>;

const RESPONSE_MAX = 2_000_000;
const JSON_TYPE = /^application\/json(?:\s*;|$)/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const EVENT_COMMANDS = { save: 'schedule.event.save', status: 'schedule.event.status', booking: 'schedule.event.booking_status' } as const;

const codeOf = (v: unknown): string | null => v && typeof v === 'object' && !Array.isArray(v) && typeof (v as { code?: unknown }).code === 'string' ? (v as { code: string }).code : null;
function data(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, 'data') || !Object.hasOwn(value, 'meta')) throw new Error('shape');
  return (value as { data: unknown }).data;
}
function id(value: string): string { if (!UUID.test(value)) throw new EventError('INVALID'); return value.toLowerCase(); }
function base(scope: EventScope): string { return `/api/v1/organizations/${id(scope.organizationId)}/schools/${id(scope.schoolId)}/schedule/events`; }
function checked<T>(run: () => T): T { try { return run(); } catch { throw new EventError('INVALID'); } }

async function exchange(path: string, signal: AbortSignal, owned: Owned | null, command?: Readonly<{ name?: string; body: string; key: string }>): Promise<{ status: number; value: unknown }> {
  const staff = owned !== null;
  const r = await fetch(path, { method: command ? 'POST' : 'GET', credentials: staff ? 'same-origin' : 'omit', mode: 'same-origin', cache: 'no-store', redirect: 'error',
    referrerPolicy: 'no-referrer', signal,
    headers: { Accept: 'application/json', ...(command ? { 'Content-Type': 'application/json', 'Idempotency-Key': command.key, ...(command.name ? { 'X-HON-Human-Command': command.name } : {}) } : {}) },
    ...(command ? { body: command.body } : {}) });
  signal.throwIfAborted();
  if (staff && r.status === 401) { if (owned()) reportConfirmedSessionInvalidation(); throw new EventError('SESSION'); }
  if (r.redirected || !JSON_TYPE.test(r.headers.get('content-type') ?? '')) return { status: r.status, value: null };
  const text = await r.text();
  if (text.length > RESPONSE_MAX) throw new EventError('UNKNOWN');
  try { return { status: r.status, value: JSON.parse(text) as unknown }; } catch { return { status: r.status, value: null }; }
}

/** What a refused staff answer means. Only these exact answers are definitive; anything else is UNKNOWN. */
export function eventErrorFor(status: number, code: string | null): EventError {
  if (status === 403) return new EventError('DENIED', code);
  if (status === 404) return new EventError('GONE', code);
  if (status === 400) return new EventError('INVALID', code);
  if (status === 422) return new EventError('DATE', code);
  if (status === 409) {
    if (code === 'VERSION_CONFLICT') return new EventError('CHANGED', code);
    if (code === 'IDEMPOTENCY_KEY_REUSED') return new EventError('INVALID', code);
    if (code && /^SCHOOL_EVENT_(SCHEDULE_LOCKED|SPOTS_BELOW_BOOKED|CANCELLED|STATUS_INVALID|BOOKING_STATUS_INVALID)$/.test(code)) return new EventError('REFUSED', code);
  }
  return new EventError('UNKNOWN', code);
}

async function read<T>(path: string, verify: (v: unknown) => T, signal: AbortSignal, owned: Owned): Promise<T> {
  let answer: { status: number; value: unknown };
  try { answer = await exchange(path, signal, owned); }
  catch (error) { if (error instanceof EventError || signal.aborted) throw error; throw new EventError('UNKNOWN'); }
  if (answer.status !== 200) throw eventErrorFor(answer.status, codeOf(answer.value));
  try { return verify(data(answer.value)); } catch { throw new EventError('UNKNOWN'); }
}
async function command<T>(path: string, name: string, body: unknown, key: string, verify: (v: unknown) => T, signal: AbortSignal, owned: Owned): Promise<T> {
  if (typeof key !== 'string' || !UUID.test(key)) throw new EventError('INVALID');
  let answer: { status: number; value: unknown };
  try { answer = await exchange(path, signal, owned, { name, body: JSON.stringify(body), key }); }
  catch (error) { if (error instanceof EventError) throw error; throw new EventError('UNKNOWN'); }
  if (answer.status !== 200) throw eventErrorFor(answer.status, codeOf(answer.value));
  try { return verify(data(answer.value)); } catch { throw new EventError('UNKNOWN'); }
}

export type EventCommand =
  | Readonly<{ action: 'create'; input: SaveSchoolEventInput }>
  | Readonly<{ action: 'edit'; eventId: string; input: SaveSchoolEventInput }>
  | Readonly<{ action: 'status'; eventId: string; input: SetSchoolEventStatusInput }>;

export const schoolEventsApi = {
  list(scope: EventScope, signal: AbortSignal, owned: Owned): Promise<SchoolEvents> {
    return Promise.resolve().then(() => read(base(scope), verifySchoolEvents, signal, owned));
  },
  detail(scope: EventScope, eventId: string, signal: AbortSignal, owned: Owned): Promise<SchoolEventDetail> {
    return Promise.resolve().then(() => { const e = id(eventId); return read(`${base(scope)}/${e}`, (v) => verifySchoolEventDetail(v, e), signal, owned); });
  },
  send(scope: EventScope, body: EventCommand, key: string, signal: AbortSignal, owned: Owned): Promise<SchoolEventReceipt> {
    return Promise.resolve().then(() => {
      if (body.action === 'create') {
        const input = checked(() => validateSaveSchoolEventInput(body.input));
        if (input.expectedVersion !== 0) throw new EventError('INVALID');
        return command(base(scope), EVENT_COMMANDS.save, input, key, (v) => verifySchoolEventReceipt(v, {}), signal, owned);
      }
      const e = id(body.eventId);
      if (body.action === 'edit') {
        const input = checked(() => validateSaveSchoolEventInput(body.input));
        if (input.expectedVersion < 1) throw new EventError('INVALID');
        return command(`${base(scope)}/${e}/edit`, EVENT_COMMANDS.save, input, key, (v) => verifySchoolEventReceipt(v, { eventId: e }), signal, owned);
      }
      return command(`${base(scope)}/${e}/status`, EVENT_COMMANDS.status, checked(() => validateSetSchoolEventStatusInput(body.input)), key,
        (v) => verifySchoolEventReceipt(v, { eventId: e }), signal, owned);
    });
  },
  bookingStatus(scope: EventScope, bookingId: string, input: SetSchoolEventBookingStatusInput, key: string, signal: AbortSignal, owned: Owned): Promise<SchoolEventBookingReceipt> {
    return Promise.resolve().then(() => {
      const b = id(bookingId);
      return command(`${base(scope)}/bookings/${b}/status`, EVENT_COMMANDS.booking, checked(() => validateSetSchoolEventBookingStatusInput(input)), key,
        (v) => verifySchoolEventBookingReceipt(v, { bookingId: b }), signal, owned);
    });
  },
};
export type SchoolEventsApi = typeof schoolEventsApi;
export const keepEventForRetry = (error: unknown) => !(error instanceof EventError) || error.kind === 'UNKNOWN';

/** Family side. Results are the server's closed words; anything else is UNAVAILABLE and may be sent again with the same key. */
export const publicEventApi = {
  async read(publicId: string, signal: AbortSignal): Promise<PublicSchoolEvent | 'NOT_FOUND' | 'UNAVAILABLE'> {
    if (!isPublicEventId(publicId)) return 'NOT_FOUND';
    try {
      const answer = await exchange(`/api/v1/public/events/${publicId}`, signal, null);
      if (answer.status === 404 || answer.status === 400) return 'NOT_FOUND';
      if (answer.status !== 200 || !answer.value || typeof answer.value !== 'object' || Object.keys(answer.value).join() !== 'data') return 'UNAVAILABLE';
      return verifyPublicSchoolEvent((answer.value as { data: unknown }).data, publicId);
    } catch { return 'UNAVAILABLE'; }
  },
  async book(publicId: string, input: PublicSchoolEventBookingInput, key: string, signal: AbortSignal): Promise<PublicEventBookingOutcome> {
    if (!isPublicEventId(publicId) || !/^[A-Za-z0-9_-]{16,100}$/.test(key)) return { result: 'INVALID' };
    let body: PublicSchoolEventBookingInput;
    try { body = validatePublicEventBookingInput(input); } catch { return { result: 'INVALID' }; }
    try {
      const answer = await exchange(`/api/v1/public/events/${publicId}/bookings`, signal, null, { body: JSON.stringify(body), key });
      return verifyPublicEventBookingOutcome(answer.value);
    } catch { return { result: 'UNAVAILABLE' }; }
  },
  async cancel(publicId: string, code: string, signal: AbortSignal): Promise<PublicEventCancelResult> {
    if (!isPublicEventId(publicId)) return 'INVALID';
    let normalized: string;
    try { normalized = normalizeEventBookingCode(code); } catch { return 'INVALID'; }
    try {
      const answer = await exchange(`/api/v1/public/events/${publicId}/cancellations`, signal, null, { body: JSON.stringify({ code: normalized }), key: globalThis.crypto.randomUUID() });
      return verifyPublicEventCancelOutcome(answer.value);
    } catch { return 'UNAVAILABLE'; }
  },
};
export type PublicEventApi = typeof publicEventApi;
