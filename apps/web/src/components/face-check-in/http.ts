import {
  FACE_CHECKIN_HUMAN_COMMAND, FACE_CHECKIN_SCAN_COMMAND, FAMILY_FACE_CHECKIN_COMMAND, FAMILY_FACE_CHECKIN_WITHDRAW_COMMAND, accountClosed, accountUuid,
  validateFaceCheckInConfirmInput, validateFaceCheckInConfirmResult, validateFaceCheckInConsentInput, validateFaceCheckInConsentResult,
  validateFaceCheckInEnrollInput, validateFaceCheckInEnrollResult, validateFaceCheckInMatchInput, validateFaceCheckInMatchResult, validateFaceCheckInRead,
  validateFaceCheckInSettingsInput, validateFaceCheckInSettingsResult, validateFaceCheckInWithdrawInput, validateFamilyFaceCheckInRead,
  validateFamilyFaceCheckInSignInput, validateFamilyFaceCheckInWithdrawInput,
  type FaceCheckInConfirmInput, type FaceCheckInConfirmResult, type FaceCheckInConsentInput, type FaceCheckInConsentResult, type FaceCheckInEnrollResult,
  type FaceCheckInMatchInput, type FaceCheckInMatchResult, type FaceCheckInRead, type FaceCheckInSettingsInput, type FaceCheckInSettingsResult,
  type FamilyFaceCheckInRead, type FamilyFaceCheckInSignInput,
} from '@hon/contracts';
import { reportConfirmedSessionInvalidation } from '../session-invalidation';

/**
 * Face check-in (0443). The server decides every permission from the verified session. Staff calls name the school; the
 * parent portal names nothing (the family comes from the parent's one live family grant). Each command sends one closed
 * body with its exact human-command marker and an idempotency key. A camera picture is sent once and never kept here.
 */
export type FaceErrorKind =
  /** Session ended. */ 'SESSION'
  /** Not allowed, or the program / school setting does not allow it now. Nothing changed. */ | 'DENIED'
  /** The student, consent, class or match is not there. Nothing changed. */ | 'MISSING'
  /** Changed since it was read (or the form changed). Nothing changed. */ | 'CONFLICT'
  /** Not accepted. Nothing changed. */ | 'INVALID'
  /** Still being saved, or nothing was saved; the same request may be sent again. */ | 'BUSY'
  /** The outcome is not known; only the identical request (same key) may be sent again. */ | 'UNKNOWN';
export class FaceError extends Error { constructor(readonly kind: FaceErrorKind, readonly code: string | null = null) { super(kind); } }
export type Owned = () => boolean;

const RESPONSE_MAX = 600_000;
const JSON_TYPE = /^application\/json(?:\s*;|$)/i;
const codeOf = (v: unknown): string | null => v && typeof v === 'object' && !Array.isArray(v) && typeof (v as { code?: unknown }).code === 'string' ? (v as { code: string }).code : null;
const NOT_FOUND = /^FACE_CHECKIN_(STUDENT|CONSENT|MATCH|SESSION)_NOT_FOUND$/;
const CONFLICTS = new Set(['FACE_CHECKIN_VERSION_CONFLICT', 'FACE_CHECKIN_FORM_CHANGED', 'FACE_CHECKIN_ALREADY_ON', 'FACE_CHECKIN_ALREADY_OFF', 'FACE_CHECKIN_CONSENT_EXISTS']);

/** What a refused answer means. Only these exact answers are definitive; anything else is UNKNOWN. */
export function faceErrorFor(status: number, code: string | null): FaceError {
  if (status === 403) return new FaceError('DENIED', code);
  if (status === 404 && code !== null && NOT_FOUND.test(code)) return new FaceError('MISSING', code);
  if (status === 400) return new FaceError('INVALID', code);
  if (status === 409 && code !== null && CONFLICTS.has(code)) return new FaceError('CONFLICT', code);
  if (status === 409 && code !== null && /^FACE_(CHECKIN_KEY_REUSED|TEMPLATE_DUPLICATE)$/.test(code)) return new FaceError('INVALID', code);
  if (status === 503 && code === 'FACE_CHECKIN_BUSY') return new FaceError('BUSY', code);
  return new FaceError('UNKNOWN', code);
}
/** Only an unknown outcome or a busy answer keeps the exact request for Try again. */
export const keepFaceForRetry = (error: unknown) => !(error instanceof FaceError) || error.kind === 'UNKNOWN' || error.kind === 'BUSY';

async function exchange(path: string, signal: AbortSignal, owned: Owned, command?: Readonly<{ marker: string; body: string; key: string }>): Promise<{ status: number; value: unknown }> {
  let r: Response;
  try {
    r = await fetch(path, { method: command ? 'POST' : 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', signal,
      headers: { Accept: 'application/json', ...(command ? { 'Content-Type': 'application/json', 'X-HON-Human-Command': command.marker, 'Idempotency-Key': command.key } : {}) },
      ...(command ? { body: command.body } : {}) });
  } catch (error) { if (signal.aborted && !command) throw error; throw new FaceError('UNKNOWN'); }
  if (signal.aborted && !command) signal.throwIfAborted();
  if (r.status === 401) { if (owned()) reportConfirmedSessionInvalidation(); throw new FaceError('SESSION'); }
  if (r.redirected || !JSON_TYPE.test(r.headers.get('content-type') ?? '')) return { status: r.status, value: null };
  let text: string;
  try { text = await r.text(); } catch { throw new FaceError('UNKNOWN'); }
  if (text.length > RESPONSE_MAX) throw new FaceError('UNKNOWN');
  try { return { status: r.status, value: JSON.parse(text) as unknown }; } catch { return { status: r.status, value: null }; }
}
const dataOf = (v: unknown) => accountClosed(v, ['data']).data;
async function readJson<T>(path: string, signal: AbortSignal, owned: Owned, check: (v: unknown) => T): Promise<T> {
  const { status, value } = await exchange(path, signal, owned);
  if (status !== 200) throw faceErrorFor(status, codeOf(value));
  try { return check(dataOf(value)); } catch { throw new FaceError('UNKNOWN'); }
}
async function command<T>(path: string, marker: string, body: unknown, key: string, signal: AbortSignal, owned: Owned, check: (v: unknown) => T): Promise<T> {
  let k: string;
  try { k = accountUuid(key); } catch { throw new FaceError('INVALID'); }
  const { status, value } = await exchange(path, signal, owned, { marker, body: JSON.stringify(body), key: k });
  if (status !== 200) throw faceErrorFor(status, codeOf(value));
  try { return check(dataOf(value)); } catch { throw new FaceError('UNKNOWN'); }
}
const valid = <T>(f: () => T): T => { try { return f(); } catch { throw new FaceError('INVALID'); } };
const same = <T>(check: (v: unknown) => T, ok: (out: T) => boolean) => (v: unknown): T => { const out = check(v); if (!ok(out)) throw new Error('mismatch'); return out; };

export const faceApi = {
  async read(schoolId: string, signal: AbortSignal, owned: Owned): Promise<FaceCheckInRead> {
    const path = valid(() => `/api/v1/school/schools/${accountUuid(schoolId).toLowerCase()}/face-check-in`);
    return readJson(path, signal, owned, validateFaceCheckInRead);
  },
  async saveSettings(input: FaceCheckInSettingsInput, key: string, signal: AbortSignal, owned: Owned): Promise<FaceCheckInSettingsResult> {
    const body = valid(() => validateFaceCheckInSettingsInput(input));
    return command('/api/v1/school/face-check-in/settings', FACE_CHECKIN_HUMAN_COMMAND, body, key, signal, owned,
      same(validateFaceCheckInSettingsResult, out => (out.settings.status === 'ON') === body.enabled));
  },
  /** A paper form that a staff member watched being signed. */
  async recordConsent(input: FaceCheckInConsentInput, key: string, signal: AbortSignal, owned: Owned): Promise<FaceCheckInConsentResult> {
    const body = valid(() => validateFaceCheckInConsentInput(input));
    return command('/api/v1/school/face-check-in/consent', FACE_CHECKIN_HUMAN_COMMAND, body, key, signal, owned,
      same(validateFaceCheckInConsentResult, out => out.studentProfileId === body.studentProfileId && out.consent.formId === body.formId));
  },
  async withdrawConsent(schoolId: string, consentId: string, expectedVersion: number, key: string, signal: AbortSignal, owned: Owned): Promise<FaceCheckInConsentResult> {
    const body = valid(() => validateFaceCheckInWithdrawInput({ schoolId, consentId, expectedVersion }));
    return command('/api/v1/school/face-check-in/withdraw', FACE_CHECKIN_HUMAN_COMMAND, body, key, signal, owned,
      same(validateFaceCheckInConsentResult, out => out.consent.consentId === body.consentId && out.consent.state === 'WITHDRAWN'));
  },
  async enroll(schoolId: string, studentProfileId: string, key: string, signal: AbortSignal, owned: Owned): Promise<FaceCheckInEnrollResult> {
    const body = valid(() => validateFaceCheckInEnrollInput({ schoolId, studentProfileId }));
    return command('/api/v1/school/face-check-in/enroll', FACE_CHECKIN_HUMAN_COMMAND, body, key, signal, owned,
      same(validateFaceCheckInEnrollResult, out => out.studentProfileId === body.studentProfileId));
  },
  /** One camera picture for one class. The answer proposes at most one student; nothing is recorded yet. */
  async match(input: FaceCheckInMatchInput, key: string, signal: AbortSignal, owned: Owned): Promise<FaceCheckInMatchResult> {
    const body = valid(() => validateFaceCheckInMatchInput(input));
    return command('/api/v1/school/face-check-in/match', FACE_CHECKIN_SCAN_COMMAND, body, key, signal, owned,
      same(validateFaceCheckInMatchResult, out => out.sessionId === body.sessionId));
  },
  /** A person's decision on one proposal. Only CONFIRMED records attendance. */
  async confirm(input: FaceCheckInConfirmInput, key: string, signal: AbortSignal, owned: Owned): Promise<FaceCheckInConfirmResult> {
    const body = valid(() => validateFaceCheckInConfirmInput(input));
    return command('/api/v1/school/face-check-in/confirm', FACE_CHECKIN_SCAN_COMMAND, body, key, signal, owned,
      same(validateFaceCheckInConfirmResult, out => out.matchId === body.matchId && (body.accept || out.outcome !== 'CONFIRMED')));
  },
};
export type FaceApi = typeof faceApi;

export const familyFaceApi = {
  async read(signal: AbortSignal, owned: Owned): Promise<FamilyFaceCheckInRead> { return readJson('/api/v1/parent/face-check-in', signal, owned, validateFamilyFaceCheckInRead); },
  async sign(input: FamilyFaceCheckInSignInput, key: string, signal: AbortSignal, owned: Owned): Promise<FaceCheckInConsentResult> {
    const body = valid(() => validateFamilyFaceCheckInSignInput(input));
    return command('/api/v1/parent/face-check-in/sign', FAMILY_FACE_CHECKIN_COMMAND, body, key, signal, owned,
      same(validateFaceCheckInConsentResult, out => out.studentProfileId === body.studentProfileId && out.consent.formId === body.formId));
  },
  async withdraw(consentId: string, expectedVersion: number, key: string, signal: AbortSignal, owned: Owned): Promise<FaceCheckInConsentResult> {
    const body = valid(() => validateFamilyFaceCheckInWithdrawInput({ consentId, expectedVersion }));
    return command('/api/v1/parent/face-check-in/withdraw', FAMILY_FACE_CHECKIN_WITHDRAW_COMMAND, body, key, signal, owned,
      same(validateFaceCheckInConsentResult, out => out.consent.consentId === body.consentId && out.consent.state === 'WITHDRAWN'));
  },
};
export type FamilyFaceApi = typeof familyFaceApi;
