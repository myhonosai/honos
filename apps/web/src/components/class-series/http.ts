import {
  validateCreateClassSeriesInput, validateEndClassSeriesInput, validateFillClassSeriesInput, validateReviseClassSeriesInput, validateSetClassSeriesOngoingInput,
  validateTimetableQuery, validateTopUpClassSeriesInput, verifyClassSeriesReceipt, verifyClassSeriesTopUpReceipt, verifySchoolClassSeries, verifyWeeklyTimetable,
  type ClassSeriesReceipt, type ClassSeriesTopUpReceipt, type CreateClassSeriesInput, type EndClassSeriesInput, type FillClassSeriesInput, type ReviseClassSeriesInput,
  type SchoolClassSeries, type SetClassSeriesOngoingInput, type WeeklyTimetable,
} from '@hon/contracts';
import { reportConfirmedSessionInvalidation } from '../session-invalidation';

/**
 * Recurring classes (B-SCH-1, 0239). Reads send no Idempotency-Key; each command sends its own X-HON-Human-Command and an
 * Idempotency-Key, so one command can never be replayed as another. The server decides every permission, version and date
 * again. Sessions are created by an explicit fill, by switching a series to ongoing, or by the page's top-up of due ongoing
 * series (0251) when a manager opens it; nothing here runs on a timer, contacts anyone, or charges.
 */
export type SeriesErrorKind =
  /** Session ended. */ 'SESSION'
  /** Not allowed for this staff member at this school. Nothing changed. */ | 'DENIED'
  /** The series or program is not available at this school. */ | 'GONE'
  /** The series changed since it was read. Nothing changed. */ | 'CHANGED'
  /** The series has ended. Nothing changed. */ | 'ENDED'
  /** The fill date is in the past or more than 12 weeks ahead. Nothing changed. */ | 'TOO_FAR'
  /** The school's time zone is not usable. */ | 'TIMEZONE'
  /** The request was not accepted as sent. Nothing changed. */ | 'INVALID'
  /** Too many requests. Nothing changed; the same request may be sent again later. */ | 'RATE'
  /** Busy, or the outcome is not known. Only the identical request (same key) may be sent again. */ | 'UNKNOWN';
export class SeriesError extends Error { constructor(readonly kind: SeriesErrorKind, readonly code: string | null = null) { super(kind); } }
export type Owned = () => boolean;
export type SeriesScope = Readonly<{ organizationId: string; schoolId: string }>;
export type SeriesAction = 'create' | 'revise' | 'end' | 'fill' | 'ongoing';

const RESPONSE_MAX = 1_000_000;
const JSON_TYPE = /^application\/json(?:\s*;|$)/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const SERIES_COMMANDS: Readonly<Record<SeriesAction, string>> = {
  create: 'schedule.series.create', revise: 'schedule.series.revise', end: 'schedule.series.end', fill: 'schedule.series.fill', ongoing: 'schedule.series.ongoing',
};
export const SERIES_TOP_UP_COMMAND = 'schedule.series.top_up';

const codeOf = (v: unknown): string | null => v && typeof v === 'object' && !Array.isArray(v) && typeof (v as { code?: unknown }).code === 'string' ? (v as { code: string }).code : null;
function data(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, 'data') || !Object.hasOwn(value, 'meta')) throw new Error('shape');
  return (value as { data: unknown }).data;
}
function id(value: string): string { if (!UUID.test(value)) throw new SeriesError('INVALID'); return value.toLowerCase(); }
function base(scope: SeriesScope): string { return `/api/v1/organizations/${id(scope.organizationId)}/schools/${id(scope.schoolId)}/schedule`; }

async function exchange(path: string, signal: AbortSignal, owned: Owned, command?: Readonly<{ name: string; body: string; key: string }>): Promise<{ status: number; value: unknown }> {
  const r = await fetch(path, { method: command ? 'POST' : 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error',
    referrerPolicy: 'no-referrer', signal,
    headers: { Accept: 'application/json', ...(command ? { 'Content-Type': 'application/json', 'X-HON-Human-Command': command.name, 'Idempotency-Key': command.key } : {}) },
    ...(command ? { body: command.body } : {}) });
  // A retired request (aborted, or no longer the one shown) never ends a newer session.
  signal.throwIfAborted();
  if (r.status === 401) { if (owned()) reportConfirmedSessionInvalidation(); throw new SeriesError('SESSION'); }
  if (r.redirected || !JSON_TYPE.test(r.headers.get('content-type') ?? '')) return { status: r.status, value: null };
  const text = await r.text();
  if (text.length > RESPONSE_MAX) throw new SeriesError('UNKNOWN');
  try { return { status: r.status, value: JSON.parse(text) as unknown }; } catch { return { status: r.status, value: null }; }
}

/** What a refused answer means. Only these exact answers are definitive; anything else (busy, 5xx, drift) is UNKNOWN. */
export function seriesErrorFor(status: number, code: string | null): SeriesError {
  if (status === 403) return new SeriesError('DENIED', code);
  if (status === 404) return new SeriesError('GONE', code);
  if (status === 400) return new SeriesError('INVALID', code);
  if (status === 429) return new SeriesError('RATE', code);
  if (status === 422 && code === 'CLASS_SERIES_FILL_TOO_FAR') return new SeriesError('TOO_FAR', code);
  if (status === 409) {
    if (code === 'VERSION_CONFLICT') return new SeriesError('CHANGED', code);
    if (code === 'CLASS_SERIES_ENDED') return new SeriesError('ENDED', code);
    if (code === 'SCHOOL_TIMEZONE_INVALID') return new SeriesError('TIMEZONE', code);
    if (code === 'IDEMPOTENCY_KEY_REUSED') return new SeriesError('INVALID', code);
  }
  // CLASS_SERIES_CONFLICT (a lock or serialization wait), IDEMPOTENCY_IN_PROGRESS, 5xx: the same request may be sent again.
  return new SeriesError('UNKNOWN', code);
}

async function read<T>(path: string, verify: (v: unknown) => T, signal: AbortSignal, owned: Owned): Promise<T> {
  let answer: { status: number; value: unknown };
  try { answer = await exchange(path, signal, owned); }
  catch (error) { if (error instanceof SeriesError || signal.aborted) throw error; throw new SeriesError('UNKNOWN'); }
  if (answer.status !== 200) throw seriesErrorFor(answer.status, codeOf(answer.value));
  try { return verify(data(answer.value)); } catch { throw new SeriesError('UNKNOWN'); }
}
async function command<T>(path: string, name: string, body: unknown, key: string, verify: (v: unknown) => T, signal: AbortSignal, owned: Owned): Promise<T> {
  if (typeof key !== 'string' || !UUID.test(key)) throw new SeriesError('INVALID');
  let answer: { status: number; value: unknown };
  try { answer = await exchange(path, signal, owned, { name, body: JSON.stringify(body), key }); }
  catch (error) { if (error instanceof SeriesError) throw error; throw new SeriesError('UNKNOWN'); }
  if (answer.status !== 200) throw seriesErrorFor(answer.status, codeOf(answer.value));
  try { return verify(data(answer.value)); } catch { throw new SeriesError('UNKNOWN'); }
}
const receiptFor = (seriesId: string | undefined) => (v: unknown) => verifyClassSeriesReceipt(v, seriesId === undefined ? {} : { seriesId });
function checked<T>(validate: () => T): T { try { return validate(); } catch { throw new SeriesError('INVALID'); } }

export type SeriesBody =
  | Readonly<{ action: 'create'; input: CreateClassSeriesInput }>
  | Readonly<{ action: 'revise'; seriesId: string; input: ReviseClassSeriesInput }>
  | Readonly<{ action: 'end'; seriesId: string; input: EndClassSeriesInput }>
  | Readonly<{ action: 'fill'; seriesId: string; input: FillClassSeriesInput }>
  | Readonly<{ action: 'ongoing'; seriesId: string; input: SetClassSeriesOngoingInput }>;

export const classSeriesApi = {
  /** The school's class series and programs (schedule.session.manage). */
  list(scope: SeriesScope, signal: AbortSignal, owned: Owned): Promise<SchoolClassSeries> {
    return Promise.resolve().then(() => read(`${base(scope)}/class-series`, verifySchoolClassSeries, signal, owned));
  },
  /** One school week, Monday to Sunday in school time (schedule.session.read). */
  timetable(scope: SeriesScope, weekOf: string | null, signal: AbortSignal, owned: Owned): Promise<WeeklyTimetable> {
    return Promise.resolve().then(() => {
      const query = checked(() => validateTimetableQuery(weekOf === null ? {} : { weekOf }));
      const search = query.weekOf ? `?${new URLSearchParams({ weekOf: query.weekOf }).toString()}` : '';
      return read(`${base(scope)}/timetable${search}`, (v) => verifyWeeklyTimetable(v, query), signal, owned);
    });
  },
  /** Create, revise, end, fill or switch a series to ongoing. Each body is validated again here before it is sent. */
  async send(scope: SeriesScope, body: SeriesBody, key: string, signal: AbortSignal, owned: Owned): Promise<ClassSeriesReceipt> {
    const name = SERIES_COMMANDS[body.action];
    if (body.action === 'create') return command(`${base(scope)}/class-series`, name, checked(() => validateCreateClassSeriesInput(body.input)), key, receiptFor(undefined), signal, owned);
    const path = `${base(scope)}/class-series/${id(body.seriesId)}/${body.action}`;
    const input = checked(() => body.action === 'revise' ? validateReviseClassSeriesInput(body.input)
      : body.action === 'end' ? validateEndClassSeriesInput(body.input) : body.action === 'ongoing' ? validateSetClassSeriesOngoingInput(body.input)
      : validateFillClassSeriesInput(body.input));
    return command(path, name, input, key, receiptFor(body.seriesId), signal, owned);
  },
  /** Top up the school's due ongoing series to 12 weeks ahead (schedule.session.manage). Safe to send again with a new key. */
  topUp(scope: SeriesScope, key: string, signal: AbortSignal, owned: Owned): Promise<ClassSeriesTopUpReceipt> {
    return Promise.resolve().then(() => command(`${base(scope)}/class-series/top-up`, SERIES_TOP_UP_COMMAND, checked(() => validateTopUpClassSeriesInput({})), key,
      verifyClassSeriesTopUpReceipt, signal, owned));
  },
};
export type ClassSeriesApi = typeof classSeriesApi;

/** Whether a failed command may be sent again with the same key: only when its outcome is not known, or nothing was sent (rate limit). */
export const keepForRetry = (error: unknown) => !(error instanceof SeriesError) || error.kind === 'UNKNOWN' || error.kind === 'RATE';
