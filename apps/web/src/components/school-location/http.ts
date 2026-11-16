import {
  validateSaveSchoolLocationInput, verifySchoolLocationView,
  type SaveSchoolLocationInput, type SchoolLocationView,
} from '@hon/contracts';
import { reportConfirmedSessionInvalidation } from '../session-invalidation';

/**
 * The school's address (0392) and the face check-in notice it decides. The read sends no Idempotency-Key; the save sends its
 * own X-HON-Human-Command and an Idempotency-Key. The server decides the permission, the version and the notice again.
 */
export type LocationErrorKind =
  /** Session ended. */ 'SESSION'
  /** Not allowed for this staff member at this school. Nothing changed. */ | 'DENIED'
  /** Someone saved the address since it was read. Nothing changed. */ | 'CHANGED'
  /** The request was not accepted as sent. Nothing changed. */ | 'INVALID'
  /** Too many requests. Nothing changed; the same request may be sent again later. */ | 'RATE'
  /** Busy, or the outcome is not known. Only the identical request (same key) may be sent again. */ | 'UNKNOWN';
export class LocationError extends Error { constructor(readonly kind: LocationErrorKind, readonly code: string | null = null) { super(kind); } }
export type Owned = () => boolean;
export type LocationScope = Readonly<{ organizationId: string; schoolId: string }>;
export const LOCATION_SAVE_COMMAND = 'school_location.save';

const RESPONSE_MAX = 100_000;
const JSON_TYPE = /^application\/json(?:\s*;|$)/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const codeOf = (v: unknown): string | null => v && typeof v === 'object' && !Array.isArray(v) && typeof (v as { code?: unknown }).code === 'string' ? (v as { code: string }).code : null;
function envelope(value: unknown): { data: unknown; meta: Record<string, unknown> } {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, 'data') || !Object.hasOwn(value, 'meta')) throw new Error('shape');
  const meta = (value as { meta: unknown }).meta;
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) throw new Error('shape');
  return { data: (value as { data: unknown }).data, meta: meta as Record<string, unknown> };
}
function id(value: string): string { if (!UUID.test(value)) throw new LocationError('INVALID'); return value.toLowerCase(); }
function path(scope: LocationScope): string { return `/api/v1/organizations/${id(scope.organizationId)}/schools/${id(scope.schoolId)}/settings/location`; }

async function exchange(url: string, signal: AbortSignal, owned: Owned, command?: Readonly<{ body: string; key: string }>): Promise<{ status: number; value: unknown }> {
  const r = await fetch(url, { method: command ? 'POST' : 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error',
    referrerPolicy: 'no-referrer', signal,
    headers: { Accept: 'application/json', ...(command ? { 'Content-Type': 'application/json', 'X-HON-Human-Command': LOCATION_SAVE_COMMAND, 'Idempotency-Key': command.key } : {}) },
    ...(command ? { body: command.body } : {}) });
  // A retired request (aborted, or no longer the one shown) never ends a newer session.
  signal.throwIfAborted();
  if (r.status === 401) { if (owned()) reportConfirmedSessionInvalidation(); throw new LocationError('SESSION'); }
  if (r.redirected || !JSON_TYPE.test(r.headers.get('content-type') ?? '')) return { status: r.status, value: null };
  const text = await r.text();
  if (text.length > RESPONSE_MAX) throw new LocationError('UNKNOWN');
  try { return { status: r.status, value: JSON.parse(text) as unknown }; } catch { return { status: r.status, value: null }; }
}

/** What a refused answer means. Only these exact answers are definitive; anything else (busy, 5xx, drift) is UNKNOWN. */
export function locationErrorFor(status: number, code: string | null): LocationError {
  if (status === 403) return new LocationError('DENIED', code);
  if (status === 400) return new LocationError('INVALID', code);
  if (status === 429) return new LocationError('RATE', code);
  if (status === 409 && code === 'VERSION_CONFLICT') return new LocationError('CHANGED', code);
  if (status === 409 && code === 'IDEMPOTENCY_KEY_REUSED') return new LocationError('INVALID', code);
  // SCHOOL_LOCATION_CONFLICT (a lock wait), IDEMPOTENCY_IN_PROGRESS, 5xx: the same request may be sent again.
  return new LocationError('UNKNOWN', code);
}

export const locationApi = {
  /** This school's address and face check-in notice (location null when none was saved). */
  async read(scope: LocationScope, signal: AbortSignal, owned: Owned): Promise<SchoolLocationView> {
    const url = path(scope);
    let answer: { status: number; value: unknown };
    try { answer = await exchange(url, signal, owned); }
    catch (error) { if (error instanceof LocationError || signal.aborted) throw error; throw new LocationError('UNKNOWN'); }
    if (answer.status !== 200) throw locationErrorFor(answer.status, codeOf(answer.value));
    try { return verifySchoolLocationView(envelope(answer.value).data); } catch { throw new LocationError('UNKNOWN'); }
  },
  /** Save the address. The receipt must be the next version. */
  async save(scope: LocationScope, input: SaveSchoolLocationInput, key: string, signal: AbortSignal, owned: Owned): Promise<SchoolLocationView> {
    const url = path(scope);
    if (typeof key !== 'string' || !UUID.test(key)) throw new LocationError('INVALID');
    let body: SaveSchoolLocationInput;
    try { body = validateSaveSchoolLocationInput(input); } catch { throw new LocationError('INVALID'); }
    let answer: { status: number; value: unknown };
    try { answer = await exchange(url, signal, owned, { body: JSON.stringify(body), key }); }
    catch (error) { if (error instanceof LocationError) throw error; throw new LocationError('UNKNOWN'); }
    if (answer.status !== 200) throw locationErrorFor(answer.status, codeOf(answer.value));
    try { return verifySchoolLocationView(envelope(answer.value).data, { version: body.expectedVersion + 1 }); } catch { throw new LocationError('UNKNOWN'); }
  },
};
export type LocationApi = typeof locationApi;

/** Whether a failed save may be sent again with the same key: only when its outcome is not known, or nothing was sent (rate limit). */
export const keepForRetry = (error: unknown) => !(error instanceof LocationError) || error.kind === 'UNKNOWN' || error.kind === 'RATE';
