import {
  isPublicBookingTypeId, normalizeBookingTypeCode, validatePublicBookingTypeInput, validateSaveBookingTypeInput, validateSetBookingTypeBookingStatusInput,
  validateSetBookingTypeStatusInput, verifyBookingTypeBookingReceipt, verifyBookingTypeDetail, verifyBookingTypeReceipt, verifyBookingTypes,
  verifyPublicBookingType, verifyPublicBookingTypeCancelOutcome, verifyPublicBookingTypeOutcome,
  type BookingTypeBookingReceipt, type BookingTypeDetail, type BookingTypeReceipt, type BookingTypes, type PublicBookingType,
  type PublicBookingTypeBookingInput, type PublicBookingTypeCancelResult, type PublicBookingTypeOutcome, type SaveBookingTypeInput,
  type SetBookingTypeBookingStatusInput, type SetBookingTypeStatusInput,
} from '@hon/contracts';
import { reportConfirmedSessionInvalidation } from '../session-invalidation';

/**
 * School booking types, web side (0286 PR 2). Staff reads send no key; each staff command sends its own X-HON-Human-Command
 * and an Idempotency-Key, so one command can never be replayed as another. The family side uses the public link id only: no
 * cookie and no tenant id. The server decides every permission, time, spot and rule again.
 */
export type BookingTypeErrorKind =
  /** Session ended. */ 'SESSION'
  /** Not allowed for this staff member at this school. Nothing changed. */ | 'DENIED'
  /** The type or booking is not available at this school. */ | 'GONE'
  /** It changed since it was shown. Nothing changed. */ | 'CHANGED'
  /** A rule refused it (20 types, spots below booked, archived, status). Nothing changed. */ | 'REFUSED'
  /** The hours give no bookable time yet. Nothing changed. */ | 'NO_TIMES'
  /** The request was not accepted as sent. Nothing changed. */ | 'INVALID'
  /** Busy, or the outcome is not known. Only the identical request (same key) may be sent again. */ | 'UNKNOWN';
export class BookingTypeError extends Error { constructor(readonly kind: BookingTypeErrorKind, readonly code: string | null = null) { super(kind); } }
export type Owned = () => boolean;
export type BookingTypeScope = Readonly<{ organizationId: string; schoolId: string }>;

const RESPONSE_MAX = 2_000_000;
const JSON_TYPE = /^application\/json(?:\s*;|$)/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const BOOKING_TYPE_COMMANDS = {
  save: 'schedule.booking_type.save', status: 'schedule.booking_type.status', booking: 'schedule.booking_type.booking_status',
} as const;

const codeOf = (v: unknown): string | null => v && typeof v === 'object' && !Array.isArray(v) && typeof (v as { code?: unknown }).code === 'string' ? (v as { code: string }).code : null;
function data(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, 'data') || !Object.hasOwn(value, 'meta')) throw new Error('shape');
  return (value as { data: unknown }).data;
}
function id(value: string): string { if (!UUID.test(value)) throw new BookingTypeError('INVALID'); return value.toLowerCase(); }
function base(scope: BookingTypeScope): string { return `/api/v1/organizations/${id(scope.organizationId)}/schools/${id(scope.schoolId)}/settings/booking-types`; }
function checked<T>(run: () => T): T { try { return run(); } catch { throw new BookingTypeError('INVALID'); } }

async function exchange(path: string, signal: AbortSignal, owned: Owned | null, command?: Readonly<{ name?: string; body: string; key: string }>): Promise<{ status: number; value: unknown }> {
  const staff = owned !== null;
  const r = await fetch(path, { method: command ? 'POST' : 'GET', credentials: staff ? 'same-origin' : 'omit', mode: 'same-origin', cache: 'no-store', redirect: 'error',
    referrerPolicy: 'no-referrer', signal,
    headers: { Accept: 'application/json', ...(command ? { 'Content-Type': 'application/json', 'Idempotency-Key': command.key, ...(command.name ? { 'X-HON-Human-Command': command.name } : {}) } : {}) },
    ...(command ? { body: command.body } : {}) });
  signal.throwIfAborted();
  if (staff && r.status === 401) { if (owned()) reportConfirmedSessionInvalidation(); throw new BookingTypeError('SESSION'); }
  if (r.redirected || !JSON_TYPE.test(r.headers.get('content-type') ?? '')) return { status: r.status, value: null };
  const text = await r.text();
  if (text.length > RESPONSE_MAX) throw new BookingTypeError('UNKNOWN');
  try { return { status: r.status, value: JSON.parse(text) as unknown }; } catch { return { status: r.status, value: null }; }
}

/** What a refused staff answer means. Only these exact answers are definitive; anything else is UNKNOWN. */
export function bookingTypeErrorFor(status: number, code: string | null): BookingTypeError {
  if (status === 403) return new BookingTypeError('DENIED', code);
  if (status === 404) return new BookingTypeError('GONE', code);
  if (status === 400) return new BookingTypeError('INVALID', code);
  if (status === 422 && code === 'SCHOOL_BOOKING_TYPE_NO_TIMES') return new BookingTypeError('NO_TIMES', code);
  if (status === 409) {
    if (code === 'VERSION_CONFLICT') return new BookingTypeError('CHANGED', code);
    if (code === 'IDEMPOTENCY_KEY_REUSED') return new BookingTypeError('INVALID', code);
    if (code && /^SCHOOL_BOOKING_TYPE_(LIMIT|SPOTS_BELOW_BOOKED|ARCHIVED|STATUS_INVALID|BOOKING_STATUS_INVALID)$/.test(code)) return new BookingTypeError('REFUSED', code);
  }
  return new BookingTypeError('UNKNOWN', code);
}

async function read<T>(path: string, verify: (v: unknown) => T, signal: AbortSignal, owned: Owned): Promise<T> {
  let answer: { status: number; value: unknown };
  try { answer = await exchange(path, signal, owned); }
  catch (error) { if (error instanceof BookingTypeError || signal.aborted) throw error; throw new BookingTypeError('UNKNOWN'); }
  if (answer.status !== 200) throw bookingTypeErrorFor(answer.status, codeOf(answer.value));
  try { return verify(data(answer.value)); } catch { throw new BookingTypeError('UNKNOWN'); }
}
async function command<T>(path: string, name: string, body: unknown, key: string, verify: (v: unknown) => T, signal: AbortSignal, owned: Owned): Promise<T> {
  if (typeof key !== 'string' || !UUID.test(key)) throw new BookingTypeError('INVALID');
  let answer: { status: number; value: unknown };
  try { answer = await exchange(path, signal, owned, { name, body: JSON.stringify(body), key }); }
  catch (error) { if (error instanceof BookingTypeError) throw error; throw new BookingTypeError('UNKNOWN'); }
  if (answer.status !== 200) throw bookingTypeErrorFor(answer.status, codeOf(answer.value));
  try { return verify(data(answer.value)); } catch { throw new BookingTypeError('UNKNOWN'); }
}

export type BookingTypeCommand =
  | Readonly<{ action: 'create'; input: SaveBookingTypeInput }>
  | Readonly<{ action: 'edit'; typeId: string; input: SaveBookingTypeInput }>
  | Readonly<{ action: 'status'; typeId: string; input: SetBookingTypeStatusInput }>;

export const bookingTypesApi = {
  list(scope: BookingTypeScope, signal: AbortSignal, owned: Owned): Promise<BookingTypes> {
    return Promise.resolve().then(() => read(base(scope), verifyBookingTypes, signal, owned));
  },
  detail(scope: BookingTypeScope, typeId: string, signal: AbortSignal, owned: Owned): Promise<BookingTypeDetail> {
    return Promise.resolve().then(() => { const t = id(typeId); return read(`${base(scope)}/${t}`, (v) => verifyBookingTypeDetail(v, t), signal, owned); });
  },
  send(scope: BookingTypeScope, body: BookingTypeCommand, key: string, signal: AbortSignal, owned: Owned): Promise<BookingTypeReceipt> {
    return Promise.resolve().then(() => {
      if (body.action === 'create') {
        const input = checked(() => validateSaveBookingTypeInput(body.input));
        if (input.expectedVersion !== 0) throw new BookingTypeError('INVALID');
        return command(base(scope), BOOKING_TYPE_COMMANDS.save, input, key, (v) => verifyBookingTypeReceipt(v, {}), signal, owned);
      }
      const t = id(body.typeId);
      if (body.action === 'edit') {
        const input = checked(() => validateSaveBookingTypeInput(body.input));
        if (input.expectedVersion < 1) throw new BookingTypeError('INVALID');
        return command(`${base(scope)}/${t}/edit`, BOOKING_TYPE_COMMANDS.save, input, key, (v) => verifyBookingTypeReceipt(v, { typeId: t }), signal, owned);
      }
      return command(`${base(scope)}/${t}/status`, BOOKING_TYPE_COMMANDS.status, checked(() => validateSetBookingTypeStatusInput(body.input)), key,
        (v) => verifyBookingTypeReceipt(v, { typeId: t }), signal, owned);
    });
  },
  bookingStatus(scope: BookingTypeScope, bookingId: string, input: SetBookingTypeBookingStatusInput, key: string, signal: AbortSignal, owned: Owned): Promise<BookingTypeBookingReceipt> {
    return Promise.resolve().then(() => {
      const b = id(bookingId);
      return command(`${base(scope)}/bookings/${b}/status`, BOOKING_TYPE_COMMANDS.booking, checked(() => validateSetBookingTypeBookingStatusInput(input)), key,
        (v) => verifyBookingTypeBookingReceipt(v, { bookingId: b }), signal, owned);
    });
  },
};
export type BookingTypesApi = typeof bookingTypesApi;
export const keepBookingTypeForRetry = (error: unknown) => !(error instanceof BookingTypeError) || error.kind === 'UNKNOWN';

/** Family side. Results are the server's closed words; anything else is UNAVAILABLE and may be sent again with the same key. */
export const publicBookingTypeApi = {
  async read(publicId: string, signal: AbortSignal): Promise<PublicBookingType | 'NOT_FOUND' | 'UNAVAILABLE'> {
    if (!isPublicBookingTypeId(publicId)) return 'NOT_FOUND';
    try {
      const answer = await exchange(`/api/v1/public/booking-types/${publicId}`, signal, null);
      if (answer.status === 404 || answer.status === 400) return 'NOT_FOUND';
      if (answer.status !== 200 || !answer.value || typeof answer.value !== 'object' || Object.keys(answer.value).join() !== 'data') return 'UNAVAILABLE';
      return verifyPublicBookingType((answer.value as { data: unknown }).data, publicId);
    } catch { return 'UNAVAILABLE'; }
  },
  async book(publicId: string, type: Pick<PublicBookingType, 'questions' | 'waiver'>, input: PublicBookingTypeBookingInput, key: string, signal: AbortSignal): Promise<PublicBookingTypeOutcome> {
    if (!isPublicBookingTypeId(publicId) || !/^[A-Za-z0-9_-]{16,100}$/.test(key)) return { result: 'INVALID' };
    let body: PublicBookingTypeBookingInput;
    try { body = validatePublicBookingTypeInput(input, type); } catch { return { result: 'INVALID' }; }
    try {
      const answer = await exchange(`/api/v1/public/booking-types/${publicId}/bookings`, signal, null, { body: JSON.stringify(body), key });
      return verifyPublicBookingTypeOutcome(answer.value);
    } catch { return { result: 'UNAVAILABLE' }; }
  },
  async cancel(publicId: string, code: string, signal: AbortSignal): Promise<PublicBookingTypeCancelResult> {
    if (!isPublicBookingTypeId(publicId)) return 'INVALID';
    let normalized: string;
    try { normalized = normalizeBookingTypeCode(code); } catch { return 'INVALID'; }
    try {
      const answer = await exchange(`/api/v1/public/booking-types/${publicId}/cancellations`, signal, null, { body: JSON.stringify({ code: normalized }), key: globalThis.crypto.randomUUID() });
      return verifyPublicBookingTypeCancelOutcome(answer.value);
    } catch { return 'UNAVAILABLE'; }
  },
};
export type PublicBookingTypeApi = typeof publicBookingTypeApi;
