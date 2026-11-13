import {
  ONBOARDING_HUMAN_COMMAND, validateOnboardingSaveInput, verifyOnboardingProfile, verifySchoolOnboarding,
  type OnboardingProfile, type OnboardingSaveInput, type SchoolOnboarding,
} from '@hon/contracts';
import { reportConfirmedSessionInvalidation } from '../session-invalidation';

/**
 * Onboarding (0323). The read is a plain same-origin GET with no key and no query; the save sends its own
 * X-HON-Human-Command and an Idempotency-Key, so an unknown outcome can be sent again exactly. The server decides the
 * permission, the access state and every step's status from the school's real records. Nothing here is authority.
 */
export type OnboardingErrorKind =
  /** Session ended. */ 'SESSION'
  /** Not allowed for this person at this school. Nothing changed. */ | 'DENIED'
  /** The answers changed since they were read. Nothing changed. */ | 'CHANGED'
  /** The answers were not accepted as sent. Nothing changed. */ | 'INVALID'
  /** Too many requests. Nothing changed. */ | 'RATE'
  /** Busy, or the outcome is not known. Only the identical request (same key) may be sent again. */ | 'UNKNOWN';
export class OnboardingError extends Error { constructor(readonly kind: OnboardingErrorKind, readonly code: string | null = null) { super(kind); } }
export type OnboardingScope = Readonly<{ organizationId: string; schoolId: string }>;
export type Owned = () => boolean;

const RESPONSE_MAX = 200_000;
const JSON_TYPE = /^application\/json(?:\s*;|$)/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const codeOf = (v: unknown): string | null => v && typeof v === 'object' && !Array.isArray(v) && typeof (v as { code?: unknown }).code === 'string' ? (v as { code: string }).code : null;

function base(scope: OnboardingScope): string {
  if (!UUID.test(scope.organizationId) || !UUID.test(scope.schoolId)) throw new OnboardingError('INVALID');
  return `/api/v1/organizations/${scope.organizationId.toLowerCase()}/schools/${scope.schoolId.toLowerCase()}/onboarding`;
}
function data(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, 'data') || !Object.hasOwn(value, 'meta')) throw new Error('shape');
  return (value as { data: unknown }).data;
}

async function exchange(path: string, signal: AbortSignal, owned: Owned, command?: Readonly<{ body: string; key: string }>): Promise<{ status: number; value: unknown }> {
  const r = await fetch(path, { method: command ? 'POST' : 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error',
    referrerPolicy: 'no-referrer', signal,
    headers: { Accept: 'application/json', ...(command ? { 'Content-Type': 'application/json', 'X-HON-Human-Command': ONBOARDING_HUMAN_COMMAND, 'Idempotency-Key': command.key } : {}) },
    ...(command ? { body: command.body } : {}) });
  signal.throwIfAborted();
  // A retired request never ends a newer session.
  if (r.status === 401) { if (owned()) reportConfirmedSessionInvalidation(); throw new OnboardingError('SESSION'); }
  if (r.redirected || !JSON_TYPE.test(r.headers.get('content-type') ?? '')) return { status: r.status, value: null };
  const text = await r.text();
  if (text.length > RESPONSE_MAX) throw new OnboardingError('UNKNOWN');
  try { return { status: r.status, value: JSON.parse(text) as unknown }; } catch { return { status: r.status, value: null }; }
}

/** Only these exact answers are definitive; anything else (busy, 5xx, drift) is UNKNOWN. */
export function onboardingErrorFor(status: number, code: string | null): OnboardingError {
  if (status === 403) return new OnboardingError('DENIED', code);
  if (status === 429) return new OnboardingError('RATE', code);
  if (status === 400) return new OnboardingError('INVALID', code);
  if (status === 409 && code === 'VERSION_CONFLICT') return new OnboardingError('CHANGED', code);
  if (status === 409 && (code === 'IDEMPOTENCY_KEY_REUSED' || code === 'IDEMPOTENCY_KEY_NOT_ACCEPTED')) return new OnboardingError('INVALID', code);
  return new OnboardingError('UNKNOWN', code);
}

export const onboardingApi = {
  /** The school's saved answers, access state and each setup step, recomputed by the server from live records. */
  async read(scope: OnboardingScope, signal: AbortSignal, owned: Owned): Promise<SchoolOnboarding> {
    const path = base(scope);
    let answer: { status: number; value: unknown };
    try { answer = await exchange(path, signal, owned); }
    catch (error) { if (error instanceof OnboardingError || signal.aborted) throw error; throw new OnboardingError('UNKNOWN'); }
    if (answer.status !== 200) throw onboardingErrorFor(answer.status, codeOf(answer.value));
    try { return verifySchoolOnboarding(data(answer.value)); } catch { throw new OnboardingError('UNKNOWN'); }
  },
  /** Saves the whole answer set at the version that was read. */
  async save(scope: OnboardingScope, input: OnboardingSaveInput, key: string, signal: AbortSignal, owned: Owned): Promise<OnboardingProfile> {
    const path = `${base(scope)}/profile`;
    if (typeof key !== 'string' || !UUID.test(key)) throw new OnboardingError('INVALID');
    let body: OnboardingSaveInput;
    try { body = validateOnboardingSaveInput(input); } catch { throw new OnboardingError('INVALID'); }
    let answer: { status: number; value: unknown };
    try { answer = await exchange(path, signal, owned, { body: JSON.stringify(body), key }); }
    catch (error) { if (error instanceof OnboardingError) throw error; throw new OnboardingError('UNKNOWN'); }
    if (answer.status !== 200) throw onboardingErrorFor(answer.status, codeOf(answer.value));
    try {
      const profile = verifyOnboardingProfile(data(answer.value));
      // A first save and its exact replay both return the version this save created.
      if (profile.version !== body.expectedVersion + 1) throw new Error('version');
      return profile;
    } catch { throw new OnboardingError('UNKNOWN'); }
  },
};
export type OnboardingApi = typeof onboardingApi;

/** A failed save may be sent again with the same key only when its outcome is not known, or it was rate limited. */
export const keepForRetry = (error: unknown) => !(error instanceof OnboardingError) || error.kind === 'UNKNOWN' || error.kind === 'RATE';
