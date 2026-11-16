import {
  ATTENDANCE_CARDS_HUMAN_COMMAND, ATTENDANCE_SCAN_HUMAN_COMMAND, accountClosed, accountUuid, validateAttendanceCardIssueInput, validateAttendanceCardIssueResult,
  validateAttendanceCardRevokeInput, validateAttendanceCardRevokeResult, validateAttendanceCardSettingsInput, validateAttendanceCardSettingsResult,
  validateAttendanceCardsRead, validateAttendanceCheckInInput, validateAttendanceCheckInResult, validateAttendancePhotoConsentInput,
  validateAttendancePhotoConsentResult, type AttendancePhotoConsentResult, type AttendanceCardIssueResult, type AttendanceCardRevokeResult,
  type AttendanceCardSettingsInput, type AttendanceCardSettingsResult, type AttendanceCardsRead, type AttendanceCheckInResult, type AttendanceCheckInStatus,
} from '@hon/contracts';
import { reportConfirmedSessionInvalidation } from '../session-invalidation';

/**
 * Attendance cards and scan check-in (0394). The server decides authority from the verified session; the browser names
 * the school and sends one closed body per command with its exact human-command marker and an idempotency key.
 */
export type CardsErrorKind =
  /** Session ended. */ 'SESSION'
  /** Not allowed at this school. Nothing changed. */ | 'DENIED'
  /** The student, card or class is not at this school. Nothing changed. */ | 'MISSING'
  /** Changed since it was read. Nothing changed. */ | 'CONFLICT'
  /** Not accepted. Nothing changed. */ | 'INVALID'
  /** Still being saved, or nothing was saved; the same request may be sent again. */ | 'BUSY'
  /** The outcome is not known; only the identical request (same key) may be sent again. */ | 'UNKNOWN';
export class CardsError extends Error { constructor(readonly kind: CardsErrorKind, readonly code: string | null = null) { super(kind); } }
export type Owned = () => boolean;

const RESPONSE_MAX = 400_000;
const JSON_TYPE = /^application\/json(?:\s*;|$)/i;
const codeOf = (v: unknown): string | null => v && typeof v === 'object' && !Array.isArray(v) && typeof (v as { code?: unknown }).code === 'string' ? (v as { code: string }).code : null;

/** What a refused answer means. Only these exact answers are definitive; anything else is UNKNOWN. */
export function cardsErrorFor(status: number, code: string | null): CardsError {
  if (status === 403) return new CardsError('DENIED', code);
  if (status === 404 && code !== null && /^ATTENDANCE_(CARD_NOT_FOUND|CARD_STUDENT_NOT_FOUND|SESSION_NOT_FOUND)$/.test(code)) return new CardsError('MISSING', code);
  if (status === 400) return new CardsError('INVALID', code);
  if (status === 409 && code === 'ATTENDANCE_CARD_VERSION_CONFLICT') return new CardsError('CONFLICT', code);
  if (status === 409 && code === 'ATTENDANCE_CARD_KEY_REUSED') return new CardsError('INVALID', code);
  if (status === 503 && code === 'ATTENDANCE_CARDS_BUSY') return new CardsError('BUSY', code);
  return new CardsError('UNKNOWN', code);
}
/** Only an unknown outcome or a busy answer keeps the exact request for Try again. */
export const keepForRetry = (error: unknown) => !(error instanceof CardsError) || error.kind === 'UNKNOWN' || error.kind === 'BUSY';

async function exchange(path: string, signal: AbortSignal, owned: Owned, command?: Readonly<{ marker: string; body: string; key: string }>): Promise<{ status: number; value: unknown }> {
  let r: Response;
  try {
    r = await fetch(path, { method: command ? 'POST' : 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', signal,
      headers: { Accept: 'application/json', ...(command ? { 'Content-Type': 'application/json', 'X-HON-Human-Command': command.marker, 'Idempotency-Key': command.key } : {}) },
      ...(command ? { body: command.body } : {}) });
  } catch (error) { if (signal.aborted && !command) throw error; throw new CardsError('UNKNOWN'); }
  if (signal.aborted && !command) signal.throwIfAborted();
  if (r.status === 401) { if (owned()) reportConfirmedSessionInvalidation(); throw new CardsError('SESSION'); }
  if (r.redirected || !JSON_TYPE.test(r.headers.get('content-type') ?? '')) return { status: r.status, value: null };
  let text: string;
  try { text = await r.text(); } catch { throw new CardsError('UNKNOWN'); }
  if (text.length > RESPONSE_MAX) throw new CardsError('UNKNOWN');
  try { return { status: r.status, value: JSON.parse(text) as unknown }; } catch { return { status: r.status, value: null }; }
}
const dataOf = (v: unknown) => accountClosed(v, ['data']).data;
async function command<T>(path: string, marker: string, body: unknown, key: string, signal: AbortSignal, owned: Owned, check: (v: unknown) => T): Promise<T> {
  let k: string;
  try { k = accountUuid(key); } catch { throw new CardsError('INVALID'); }
  const { status, value } = await exchange(path, signal, owned, { marker, body: JSON.stringify(body), key: k });
  if (status !== 200) throw cardsErrorFor(status, codeOf(value));
  try { return check(dataOf(value)); } catch { throw new CardsError('UNKNOWN'); }
}
const valid = <T>(f: () => T): T => { try { return f(); } catch { throw new CardsError('INVALID'); } };

export const cardsApi = {
  async read(schoolId: string, signal: AbortSignal, owned: Owned): Promise<AttendanceCardsRead> {
    const path = valid(() => `/api/v1/school/schools/${accountUuid(schoolId).toLowerCase()}/attendance/cards`);
    const { status, value } = await exchange(path, signal, owned);
    if (status !== 200) throw cardsErrorFor(status, codeOf(value));
    try { return validateAttendanceCardsRead(dataOf(value)); } catch { throw new CardsError('UNKNOWN'); }
  },
  async configure(input: AttendanceCardSettingsInput, key: string, signal: AbortSignal, owned: Owned): Promise<AttendanceCardSettingsResult> {
    const body = valid(() => validateAttendanceCardSettingsInput(input));
    return command('/api/v1/school/attendance/cards/settings', ATTENDANCE_CARDS_HUMAN_COMMAND, body, key, signal, owned, validateAttendanceCardSettingsResult);
  },
  /** Prints new cards. A fresh answer carries each code once; a replayed one has none (print again for new cards). */
  async print(schoolId: string, studentProfileIds: readonly string[], key: string, signal: AbortSignal, owned: Owned): Promise<AttendanceCardIssueResult> {
    const body = valid(() => validateAttendanceCardIssueInput({ schoolId, studentProfileIds }));
    return command('/api/v1/school/attendance/cards/print', ATTENDANCE_CARDS_HUMAN_COMMAND, body, key, signal, owned, v => {
      const out = validateAttendanceCardIssueResult(v);
      const asked = new Set(body.studentProfileIds);
      if (out.cards.length !== asked.size || out.cards.some(c => !asked.has(c.studentProfileId))) throw new Error('mismatch');
      return out;
    });
  },
  async cancel(schoolId: string, cardId: string, expectedVersion: number, key: string, signal: AbortSignal, owned: Owned): Promise<AttendanceCardRevokeResult> {
    const body = valid(() => validateAttendanceCardRevokeInput({ schoolId, cardId, expectedVersion }));
    return command('/api/v1/school/attendance/cards/cancel', ATTENDANCE_CARDS_HUMAN_COMMAND, body, key, signal, owned, v => {
      const out = validateAttendanceCardRevokeResult(v); if (out.card.cardId !== body.cardId) throw new Error('mismatch'); return out;
    });
  },
  /** Records that a parent (or the adult student) agreed to the photo on the card, or withdrew. */
  async photoConsent(schoolId: string, studentProfileId: string, given: boolean, expectedVersion: number, key: string, signal: AbortSignal, owned: Owned): Promise<AttendancePhotoConsentResult> {
    const body = valid(() => validateAttendancePhotoConsentInput({ schoolId, studentProfileId, given, expectedVersion }));
    return command('/api/v1/school/attendance/cards/photo-consent', ATTENDANCE_CARDS_HUMAN_COMMAND, body, key, signal, owned, v => {
      const out = validateAttendancePhotoConsentResult(v); if (out.studentProfileId !== body.studentProfileId) throw new Error('mismatch'); return out;
    });
  },
  /** One scan. The code is checked here first (a misread never leaves the browser). */
  async checkIn(schoolId: string, sessionId: string, code: string, status: AttendanceCheckInStatus, key: string, signal: AbortSignal, owned: Owned): Promise<AttendanceCheckInResult> {
    const body = valid(() => validateAttendanceCheckInInput({ schoolId, sessionId, code, status }));
    return command('/api/v1/school/attendance/check-in', ATTENDANCE_SCAN_HUMAN_COMMAND, body, key, signal, owned, validateAttendanceCheckInResult);
  },
};
export type CardsApi = typeof cardsApi;
