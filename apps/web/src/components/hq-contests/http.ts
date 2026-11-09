import { CHAMPIONS_COMMANDS, validateChampionsContestCommand, validateChampionsContestDetail, validateChampionsContestList, validateChampionsContestReceipt,
  type ChampionsContestCommand, type ChampionsContestDetail, type ChampionsContestList, type ChampionsContestReceipt, type ChampionsContestStatus } from '@hon/contracts';
import { reportConfirmedSessionInvalidation } from '../session-invalidation';

/**
 * HQ referral contests (Champions Club, migration 0152). Reads go through the Champions read guard (same origin, GET,
 * declared query only); commands through the Champions command guard (same origin, human-command marker, JSON,
 * Idempotency-Key). The database decides every time who may act: an HQ owner, or an HQ operator with
 * hq.champions.manage (owner only for schedule, resume, early end, winner decisions, complete and cancel).
 * Prizes are recorded liabilities only: nothing is bought, sent, paid or published from here.
 */
export type ContestErrorKind =
  /** Session ended. */ 'SESSION'
  /** Not allowed (not HQ, or an owner-only step). Nothing was saved. */ | 'DENIED'
  /** No such contest or winner. */ | 'GONE'
  /** The request was not accepted as sent. */ | 'INVALID'
  /** The contest changed since it was read, or this step does not apply now. Nothing was saved. Re-read. */ | 'CHANGED'
  /** A contest rule refused it (see code). Nothing was saved. */ | 'REFUSED'
  /** The same key was already used for a different request. Nothing was saved by this one. */ | 'KEY_REUSED'
  /** The outcome is not known. Retry only the identical request with the same key. */ | 'UNKNOWN';
export class ContestError extends Error {
  constructor(readonly kind: ContestErrorKind, readonly code: string | null = null) { super(kind); }
}
export type Owned = () => boolean;
const RESPONSE_MAX = 4_000_000;
const JSON_TYPE = /^application\/json(?:\s*;|$)/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const CONTEST_RULE_REFUSALS = ['CHAMPIONS_CONTEST_INCOMPLETE', 'CHAMPIONS_CONTEST_WINDOW_PASSED', 'CHAMPIONS_CONTEST_OVER_BUDGET',
  'CHAMPIONS_GIFT_CARDS_NOT_PERMITTED', 'CHAMPIONS_CONTEST_NOT_STARTED', 'CHAMPIONS_CONTEST_WINNER_NOT_ELIGIBLE', 'CHAMPIONS_CONTEST_WINNERS_UNRESOLVED',
  'CHAMPIONS_CONTEST_PRIZES_OVERLAP'] as const;
export type ContestRuleRefusal = typeof CONTEST_RULE_REFUSALS[number];
const CHANGED = new Set(['CHAMPIONS_VERSION_CONFLICT', 'CHAMPIONS_TRANSITION_NOT_ALLOWED']);

/** Lower-case contest id for a path, or null when the value is not a contest id. */
export function contestId(value: unknown): string | null {
  return typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : null;
}

async function exchange(path: string, signal: AbortSignal, owned: Owned, command?: Readonly<{ body: string; key: string }>): Promise<{ status: number; value: unknown }> {
  let r: Response;
  try {
    r = await fetch(path, { method: command ? 'POST' : 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error',
      referrerPolicy: 'no-referrer', signal,
      headers: { Accept: 'application/json', ...(command ? { 'Content-Type': 'application/json', 'X-HON-Human-Command': CHAMPIONS_COMMANDS.contestCommand, 'Idempotency-Key': command.key } : {}) },
      ...(command ? { body: command.body } : {}) });
  } catch (error) { if (signal.aborted && !command) throw error; throw new ContestError('UNKNOWN'); }
  if (signal.aborted) { if (command) throw new ContestError('UNKNOWN'); signal.throwIfAborted(); }
  if (r.status === 401) { if (owned()) reportConfirmedSessionInvalidation(); throw new ContestError('SESSION'); }
  if (r.redirected || !JSON_TYPE.test(r.headers.get('content-type') ?? '')) return { status: r.status, value: null };
  const text = await r.text();
  if (text.length > RESPONSE_MAX) throw new ContestError('UNKNOWN');
  try { return { status: r.status, value: JSON.parse(text) as unknown }; } catch { return { status: r.status, value: null }; }
}
const codeOf = (v: unknown): string | null => v && typeof v === 'object' && !Array.isArray(v) && typeof (v as { code?: unknown }).code === 'string' ? (v as { code: string }).code : null;
function data(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 || !Object.hasOwn(value, 'data')) throw new Error('shape');
  return (value as { data: unknown }).data;
}
function readError(status: number, code: string | null): ContestError {
  if (status === 403) return new ContestError('DENIED', code);
  if (status === 404 && code === 'CHAMPIONS_UNAVAILABLE') return new ContestError('GONE', code);
  if (status === 400) return new ContestError('INVALID', code);
  return new ContestError('UNKNOWN', code);
}
/** What a refused command means. Only these exact answers are definitive; anything else is UNKNOWN. */
export function contestCommandError(status: number, code: string | null): ContestError {
  if (status === 403) return new ContestError('DENIED', code);
  if (status === 400) return new ContestError('INVALID', code);
  if (status === 404 && code === 'CHAMPIONS_UNAVAILABLE') return new ContestError('GONE', code);
  if (status === 409 && code !== null && CHANGED.has(code)) return new ContestError('CHANGED', code);
  if (status === 422 && code !== null && (CONTEST_RULE_REFUSALS as readonly string[]).includes(code)) return new ContestError('REFUSED', code);
  if (status === 409 && code === 'IDEMPOTENCY_KEY_REUSED') return new ContestError('KEY_REUSED', code);
  return new ContestError('UNKNOWN', code);
}
async function read<T>(path: string, signal: AbortSignal, owned: Owned, validate: (v: unknown) => T): Promise<T> {
  const { status, value } = await exchange(path, signal, owned);
  if (status !== 200) throw readError(status, codeOf(value));
  try { return validate(data(value)); } catch { throw new ContestError('UNKNOWN'); }
}

export const contestApi = {
  async list(status: ChampionsContestStatus | null, signal: AbortSignal, owned: Owned): Promise<ChampionsContestList> {
    const view = await read(`/api/v1/hq/champions/contests${status ? `?status=${status}` : ''}`, signal, owned, validateChampionsContestList);
    if (status && view.contests.some(c => c.status !== status)) throw new ContestError('UNKNOWN');
    return view;
  },
  async read(id: string, signal: AbortSignal, owned: Owned): Promise<ChampionsContestDetail> {
    const cid = contestId(id);
    if (!cid) throw new ContestError('INVALID');
    const view = await read(`/api/v1/hq/champions/contests/${cid}`, signal, owned, validateChampionsContestDetail);
    if (view.contest.contestId.toLowerCase() !== cid) throw new ContestError('UNKNOWN');
    return view;
  },
  /**
   * One command. CREATE goes to the collection; everything else to the contest. The answer must match what was asked:
   * same action, same contest (or a new one for CREATE/DUPLICATE), and one version forward for steps on an existing contest.
   */
  async command(id: string | null, input: ChampionsContestCommand, key: string, signal: AbortSignal, owned: Owned): Promise<ChampionsContestReceipt> {
    let body: ChampionsContestCommand;
    const cid = id === null ? null : contestId(id);
    try {
      body = validateChampionsContestCommand(input);
      if ((body.action === 'CREATE') !== (id === null) || (id !== null && !cid) || !UUID.test(key)) throw new Error('shape');
    } catch { throw new ContestError('INVALID'); }
    const path = cid ? `/api/v1/hq/champions/contests/${cid}/commands` : '/api/v1/hq/champions/contests';
    const answer = await exchange(path, signal, owned, { body: JSON.stringify(body), key: key.toLowerCase() });
    if (answer.status !== 200) throw contestCommandError(answer.status, codeOf(answer.value));
    let receipt: ChampionsContestReceipt;
    try { receipt = validateChampionsContestReceipt(data(answer.value)); } catch { throw new ContestError('UNKNOWN'); }
    const c = receipt.contest;
    if (receipt.action !== body.action) throw new ContestError('UNKNOWN');
    if (body.action === 'CREATE' || body.action === 'DUPLICATE') {
      if (c.status !== 'DRAFT' || c.version !== 1 || c.name !== body.name || c.startsAt !== body.startsAt || c.endsAt !== body.endsAt
        || (body.action === 'DUPLICATE' && c.duplicatedFrom !== cid)) throw new ContestError('UNKNOWN');
    } else if (c.contestId.toLowerCase() !== cid || c.version !== body.expectedVersion + 1) throw new ContestError('UNKNOWN');
    return receipt;
  },
};
export type ContestApi = typeof contestApi;
