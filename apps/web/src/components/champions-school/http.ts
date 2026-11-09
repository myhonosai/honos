import {
  CHAMPIONS_COMMANDS, championsUuid, validateChampionsLeaderboardQuery, validateChampionsPreferenceInput, validateChampionsPreferenceReceipt,
  validateChampionsReferralCodeReceipt, validateChampionsSchoolContests, validateChampionsSchoolLeaderboard, validateChampionsSchoolRewards,
  validateChampionsSchoolStatistics, validateChampionsSchoolView,
  type ChampionsDisplayMode, type ChampionsPreferenceReceipt, type ChampionsReferralCodeReceipt, type ChampionsSchoolContests,
  type ChampionsSchoolLeaderboard, type ChampionsSchoolRewards, type ChampionsSchoolStatistics, type ChampionsSchoolView,
} from '@hon/contracts';
import { reportConfirmedSessionInvalidation } from '../session-invalidation';

/**
 * Champions Club for the school the shell verified. Reads send only Accept (the leaderboard adds its period and month);
 * the two commands send their own X-HON-Human-Command and an Idempotency-Key. The database decides who at the school may
 * read or act; the school id in the path is only a selector. Nothing here pays, credits or messages anyone.
 */
export type ChampionsErrorKind =
  /** Session ended. */ 'SESSION'
  /** Not allowed at this school. Nothing changed. */ | 'DENIED'
  /** The program or school is not available. Nothing changed. */ | 'MISSING'
  /** Not accepted as sent. Nothing changed. */ | 'INVALID'
  /** The outcome is not known; only the identical request (same key) may be sent again. */ | 'UNKNOWN';
export class ChampionsError extends Error { constructor(readonly kind: ChampionsErrorKind, readonly code: string | null = null) { super(kind); } }
export type Owned = () => boolean;
export type LeaderboardPick = Readonly<{ period: 'ALL_TIME' } | { period: 'MONTH'; month: string }>;

const RESPONSE_MAX = 1_000_000;
const JSON_TYPE = /^application\/json(?:\s*;|$)/i;
const codeOf = (v: unknown): string | null => v && typeof v === 'object' && !Array.isArray(v) && typeof (v as { code?: unknown }).code === 'string' ? (v as { code: string }).code : null;

/** What a refused answer means. Only these exact answers are definitive; anything else (busy, 5xx, outcome unknown) is UNKNOWN. */
export function championsErrorFor(status: number, code: string | null): ChampionsError {
  if (status === 403) return new ChampionsError('DENIED', code);
  if (status === 404) return new ChampionsError('MISSING', code);
  if (status === 400 || (status === 409 && code === 'IDEMPOTENCY_KEY_REUSED')) return new ChampionsError('INVALID', code);
  return new ChampionsError('UNKNOWN', code);
}
export const keepForRetry = (error: unknown) => !(error instanceof ChampionsError) || error.kind === 'UNKNOWN';

async function exchange(path: string, signal: AbortSignal, owned: Owned, command?: Readonly<{ marker: string; body: string; key: string }>): Promise<{ status: number; value: unknown }> {
  const r = await fetch(path, { method: command ? 'POST' : 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', signal,
    headers: { Accept: 'application/json', ...(command ? { 'Content-Type': 'application/json', 'X-HON-Human-Command': command.marker, 'Idempotency-Key': command.key } : {}) },
    ...(command ? { body: command.body } : {}) });
  // A retired read never ends a newer session.
  signal.throwIfAborted();
  if (r.status === 401) { if (owned()) reportConfirmedSessionInvalidation(); throw new ChampionsError('SESSION'); }
  if (r.redirected || !JSON_TYPE.test(r.headers.get('content-type') ?? '')) return { status: r.status, value: null };
  const text = await r.text();
  if (text.length > RESPONSE_MAX) throw new ChampionsError('UNKNOWN');
  try { return { status: r.status, value: JSON.parse(text) as unknown }; } catch { return { status: r.status, value: null }; }
}
function data(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 || !Object.hasOwn(value, 'data')) throw new Error('shape');
  return (value as { data: unknown }).data;
}
const base = (schoolId: string) => `/api/v1/schools/${championsUuid(schoolId).toLowerCase()}/champions`;
function sameSchool(a: string, b: string) { if (a.toLowerCase() !== b.toLowerCase()) throw new Error('school'); }

async function read<T>(path: () => string, verify: (v: unknown) => T, signal: AbortSignal, owned: Owned): Promise<T> {
  let url: string;
  try { url = path(); } catch { throw new ChampionsError('INVALID'); }
  let answer: { status: number; value: unknown };
  try { answer = await exchange(url, signal, owned); }
  catch (error) { if (error instanceof ChampionsError || signal.aborted) throw error; throw new ChampionsError('UNKNOWN'); }
  if (answer.status !== 200) throw championsErrorFor(answer.status, codeOf(answer.value));
  try { return verify(data(answer.value)); } catch { throw new ChampionsError('UNKNOWN'); }
}
async function command<T>(path: () => string, marker: string, body: () => unknown, key: string, verify: (v: unknown) => T, signal: AbortSignal, owned: Owned): Promise<T> {
  let url: string, payload: string, k: string;
  try { url = path(); payload = JSON.stringify(body()); k = championsUuid(key); } catch { throw new ChampionsError('INVALID'); }
  let answer: { status: number; value: unknown };
  try { answer = await exchange(url, signal, owned, { marker, body: payload, key: k }); }
  catch (error) { if (error instanceof ChampionsError) throw error; throw new ChampionsError('UNKNOWN'); }
  if (answer.status !== 200) throw championsErrorFor(answer.status, codeOf(answer.value));
  try { return verify(data(answer.value)); } catch { throw new ChampionsError('UNKNOWN'); }
}

export const championsSchoolApi = {
  /** Referral code, program status and referral counts. */
  summary(schoolId: string, signal: AbortSignal, owned: Owned): Promise<ChampionsSchoolView> {
    return read(() => `${base(schoolId)}/summary`, (v) => { const x = validateChampionsSchoolView(v); sameSchool(x.schoolId, schoolId); return x; }, signal, owned);
  },
  statistics(schoolId: string, signal: AbortSignal, owned: Owned): Promise<ChampionsSchoolStatistics> {
    return read(() => `${base(schoolId)}/statistics`, (v) => { const x = validateChampionsSchoolStatistics(v); sameSchool(x.schoolId, schoolId); return x; }, signal, owned);
  },
  rewards(schoolId: string, signal: AbortSignal, owned: Owned): Promise<ChampionsSchoolRewards> {
    return read(() => `${base(schoolId)}/rewards`, (v) => { const x = validateChampionsSchoolRewards(v); sameSchool(x.schoolId, schoolId); return x; }, signal, owned);
  },
  contests(schoolId: string, signal: AbortSignal, owned: Owned): Promise<ChampionsSchoolContests> {
    return read(() => `${base(schoolId)}/contests`, (v) => { const x = validateChampionsSchoolContests(v); sameSchool(x.schoolId, schoolId); return x; }, signal, owned);
  },
  /** The top 25 schools by qualified referrals, all time or for one UTC month; the answer must be for the period asked. */
  leaderboard(schoolId: string, pick: LeaderboardPick, signal: AbortSignal, owned: Owned): Promise<ChampionsSchoolLeaderboard> {
    let query: { period: string; month: string | null };
    try { query = validateChampionsLeaderboardQuery(pick); } catch { return Promise.reject(new ChampionsError('INVALID')); }
    const params = new URLSearchParams({ period: query.period }); if (query.month !== null) params.set('month', query.month);
    return read(() => `${base(schoolId)}/leaderboard?${params}`, (v) => {
      const x = validateChampionsSchoolLeaderboard(v);
      if (x.period !== query.period || x.month !== query.month) throw new Error('period');
      sameSchool(x.you.schoolId, schoolId); return x;
    }, signal, owned);
  },
  /** Issue this school's referral code once; a second call returns the same code. */
  issueCode(schoolId: string, key: string, signal: AbortSignal, owned: Owned): Promise<ChampionsReferralCodeReceipt> {
    return command(() => `${base(schoolId)}/referral-code`, CHAMPIONS_COMMANDS.issueReferralCode, () => ({}), key,
      (v) => { const x = validateChampionsReferralCodeReceipt(v); sameSchool(x.schoolId, schoolId); return x; }, signal, owned);
  },
  /** Show this school's name on the leaderboard, or stay anonymous. */
  setDisplay(schoolId: string, displayMode: ChampionsDisplayMode, key: string, signal: AbortSignal, owned: Owned): Promise<ChampionsPreferenceReceipt> {
    return command(() => `${base(schoolId)}/leaderboard-preference`, CHAMPIONS_COMMANDS.setLeaderboardPreference, () => validateChampionsPreferenceInput({ displayMode }), key,
      (v) => { const x = validateChampionsPreferenceReceipt(v); sameSchool(x.schoolId, schoolId); if (x.displayMode !== displayMode) throw new Error('mode'); return x; }, signal, owned);
  },
};
export type ChampionsSchoolApi = typeof championsSchoolApi;

/** The current UTC month as YYYY-MM (the leaderboard counts in UTC). */
export const utcMonth = (now: number) => new Date(now).toISOString().slice(0, 7);
