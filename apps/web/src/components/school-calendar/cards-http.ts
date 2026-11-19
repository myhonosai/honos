import {
  validateCalendarCardsQuery, validateCreateCalendarCardInput, validateMoveCalendarCardInput, verifyCalendarCards, verifyCreateCalendarCardReceipt,
  verifyMoveCalendarCardReceipt, type CalendarCards, type CreateCalendarCardInput, type CreateCalendarCardReceipt, type MoveCalendarCardInput,
  type MoveCalendarCardReceipt,
} from '@hon/contracts';
import { reportConfirmedSessionInvalidation } from '../session-invalidation';

/**
 * Calendar cards (0551): the card details read, create from the calendar, and move or resize one class. Reads send no
 * Idempotency-Key; each command sends its own X-HON-Human-Command and an Idempotency-Key. The server decides every
 * permission, version and time again. Nothing here contacts families.
 */
export type CardErrorKind =
  /** Session ended. */ 'SESSION'
  /** Not allowed for this staff member at this school. Nothing changed. */ | 'DENIED'
  /** The class, program or instructor is not available at this school. Nothing changed. */ | 'GONE'
  /** Someone else changed the class since it was read. Nothing changed. */ | 'CHANGED'
  /** The class has started, ended, been cancelled or has attendance. Nothing changed. */ | 'LOCKED'
  /** The new time is not in the future. Nothing changed. */ | 'PAST'
  /** The request was not accepted as sent. Nothing changed. */ | 'INVALID'
  /** Too many requests. Nothing changed. */ | 'RATE'
  /** The school already has the most block-outs or shared calendars allowed. Nothing changed. */ | 'LIMIT'
  /** Busy, or the outcome is not known. Only the identical request (same key) may be sent again. */ | 'UNKNOWN';
export class CardError extends Error { constructor(readonly kind: CardErrorKind, readonly code: string | null = null) { super(kind); } }
export type Owned = () => boolean;
export type CardScope = Readonly<{ organizationId: string; schoolId: string }>;
export const CARD_COMMANDS = { create: 'schedule.calendar.create', move: 'schedule.calendar.move' } as const;

const RESPONSE_MAX = 2_000_000;
const JSON_TYPE = /^application\/json(?:\s*;|$)/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const codeOf = (v: unknown): string | null => v && typeof v === 'object' && !Array.isArray(v) && typeof (v as { code?: unknown }).code === 'string' ? (v as { code: string }).code : null;
function data(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, 'data') || !Object.hasOwn(value, 'meta')) throw new Error('shape');
  return (value as { data: unknown }).data;
}
function id(value: string): string { if (!UUID.test(value)) throw new CardError('INVALID'); return value.toLowerCase(); }
const base = (scope: CardScope) => `/api/v1/organizations/${id(scope.organizationId)}/schools/${id(scope.schoolId)}/schedule/calendar/cards`;
function checked<T>(validate: () => T): T { try { return validate(); } catch { throw new CardError('INVALID'); } }

/** What a refused answer means. Only these exact answers are definitive; anything else is UNKNOWN. */
export function cardErrorFor(status: number, code: string | null): CardError {
  if (status === 403) return new CardError('DENIED', code);
  if (status === 404) return new CardError('GONE', code);
  if (status === 400) return new CardError(code === 'CALENDAR_CARD_NOT_IN_FUTURE' ? 'PAST' : 'INVALID', code);
  if (status === 429) return new CardError('RATE', code);
  if (status === 409) {
    if (code === 'VERSION_CONFLICT') return new CardError('CHANGED', code);
    if (code === 'CALENDAR_CARD_LOCKED') return new CardError('LOCKED', code);
    if (code === 'IDEMPOTENCY_KEY_REUSED') return new CardError('INVALID', code);
    if (code === 'CALENDAR_SETTINGS_LIMIT') return new CardError('LIMIT', code);
  }
  return new CardError('UNKNOWN', code);
}

/** One same-origin JSON exchange: a GET read, or a POST command with its own X-HON-Human-Command and Idempotency-Key. */
export async function exchange<T>(path: string, verify: (v: unknown) => T, signal: AbortSignal, owned: Owned, command?: Readonly<{ name: string; body: unknown; key: string }>): Promise<T> {
  if (command && !UUID.test(command.key)) throw new CardError('INVALID');
  let r: Response;
  try {
    r = await fetch(path, { method: command ? 'POST' : 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error',
      referrerPolicy: 'no-referrer', signal,
      headers: { Accept: 'application/json', ...(command ? { 'Content-Type': 'application/json', 'X-HON-Human-Command': command.name, 'Idempotency-Key': command.key } : {}) },
      ...(command ? { body: JSON.stringify(command.body) } : {}) });
  } catch (error) { if (signal.aborted) throw error; throw new CardError('UNKNOWN'); }
  signal.throwIfAborted();
  if (r.status === 401) { if (owned()) reportConfirmedSessionInvalidation(); throw new CardError('SESSION'); }
  let value: unknown = null;
  if (!r.redirected && JSON_TYPE.test(r.headers.get('content-type') ?? '')) {
    const text = await r.text();
    if (text.length > RESPONSE_MAX) throw new CardError('UNKNOWN');
    try { value = JSON.parse(text) as unknown; } catch { value = null; }
  }
  if (r.status !== 200) throw cardErrorFor(r.status, codeOf(value));
  try { return verify(data(value)); } catch { throw new CardError('UNKNOWN'); }
}

export interface CalendarCardsApi {
  read(scope: CardScope, from: string, to: string, signal: AbortSignal, owned: Owned): Promise<CalendarCards>;
  create(scope: CardScope, input: CreateCalendarCardInput, key: string, signal: AbortSignal, owned: Owned): Promise<CreateCalendarCardReceipt>;
  move(scope: CardScope, sessionId: string, input: MoveCalendarCardInput, key: string, signal: AbortSignal, owned: Owned): Promise<MoveCalendarCardReceipt>;
}

export const calendarCardsApi: CalendarCardsApi = {
  /** Kind, program, roster, lead instructor and booked count of each class in [from, to] (schedule.session.read). */
  read(scope, from, to, signal, owned) {
    return Promise.resolve().then(() => {
      const query = checked(() => validateCalendarCardsQuery({ from, to }));
      return exchange(`${base(scope)}?${new URLSearchParams({ from: query.from, to: query.to }).toString()}`, (v) => verifyCalendarCards(v, query), signal, owned);
    });
  },
  /** One class, or a weekly roster and its classes (schedule.session.manage). */
  create(scope, input, key, signal, owned) {
    return Promise.resolve().then(() => exchange(base(scope), verifyCreateCalendarCardReceipt, signal, owned,
      { name: CARD_COMMANDS.create, body: checked(() => validateCreateCalendarCardInput(input)), key }));
  },
  /** New start and end of one class, with the version the page read (schedule.session.manage). */
  move(scope, sessionId, input, key, signal, owned) {
    return Promise.resolve().then(() => {
      const body = checked(() => validateMoveCalendarCardInput(input));
      return exchange(`${base(scope)}/${id(sessionId)}/move`, (v) => verifyMoveCalendarCardReceipt(v, { sessionId, input: body }), signal, owned,
        { name: CARD_COMMANDS.move, body, key });
    });
  },
};
