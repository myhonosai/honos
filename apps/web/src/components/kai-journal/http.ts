import {
  isKaiJournalRange, validateSaveKaiJournalEntryInput, verifyKaiJournalRead, verifyKaiJournalReceipt, verifyKaiTeamJournalRead,
  type KaiJournalEntry, type KaiJournalRead, type KaiTeamJournalRead, type SaveKaiJournalEntryInput,
} from '@hon/contracts';
import { reportConfirmedSessionInvalidation } from '../session-invalidation';

/**
 * Kai teaching journal (0497). A read sends no Idempotency-Key; a save sends its own X-HON-Human-Command and an
 * Idempotency-Key. The server decides the permission, the author, the dates and the version again.
 */
export type JournalErrorKind =
  /** Session ended. */ 'SESSION'
  /** Not allowed here. Nothing changed. */ | 'DENIED'
  /** The entry changed since it was read. Nothing changed. */ | 'CHANGED'
  /** The entry was removed or is gone. Nothing changed. */ | 'GONE'
  /** The request was not accepted as sent. Nothing changed. */ | 'INVALID'
  /** Too many requests. Nothing changed; the same request may be sent again later. */ | 'RATE'
  /** Busy, or the outcome is not known. Only the identical request (same key) may be sent again. */ | 'UNKNOWN';
export class JournalError extends Error { constructor(readonly kind: JournalErrorKind, readonly code: string | null = null) { super(kind); } }
export type Owned = () => boolean;
export type JournalScope = Readonly<{ organizationId: string; schoolId: string }>;
export const JOURNAL_SAVE_COMMAND = 'kai_journal.save';

const RESPONSE_MAX = 1_500_000;
const JSON_TYPE = /^application\/json(?:\s*;|$)/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const codeOf = (v: unknown): string | null => v && typeof v === 'object' && !Array.isArray(v) && typeof (v as { code?: unknown }).code === 'string' ? (v as { code: string }).code : null;
function envelope(value: unknown): { data: unknown; meta: Record<string, unknown> } {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, 'data') || !Object.hasOwn(value, 'meta')) throw new Error('shape');
  const meta = (value as { meta: unknown }).meta;
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) throw new Error('shape');
  return { data: (value as { data: unknown }).data, meta: meta as Record<string, unknown> };
}
function id(value: string): string { if (!UUID.test(value)) throw new JournalError('INVALID'); return value.toLowerCase(); }
function base(scope: JournalScope, part: 'entries' | 'team' = 'entries'): string { return `/api/v1/organizations/${id(scope.organizationId)}/schools/${id(scope.schoolId)}/staff/kai/journal/${part}`; }

async function exchange(url: string, signal: AbortSignal, owned: Owned, command?: Readonly<{ body: string; key: string }>): Promise<{ status: number; value: unknown }> {
  const r = await fetch(url, { method: command ? 'POST' : 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error',
    referrerPolicy: 'no-referrer', signal,
    headers: { Accept: 'application/json', ...(command ? { 'Content-Type': 'application/json', 'X-HON-Human-Command': JOURNAL_SAVE_COMMAND, 'Idempotency-Key': command.key } : {}) },
    ...(command ? { body: command.body } : {}) });
  // A retired request (aborted, or no longer the one shown) never ends a newer session.
  signal.throwIfAborted();
  if (r.status === 401) { if (owned()) reportConfirmedSessionInvalidation(); throw new JournalError('SESSION'); }
  if (r.redirected || !JSON_TYPE.test(r.headers.get('content-type') ?? '')) return { status: r.status, value: null };
  const text = await r.text();
  if (text.length > RESPONSE_MAX) throw new JournalError('UNKNOWN');
  try { return { status: r.status, value: JSON.parse(text) as unknown }; } catch { return { status: r.status, value: null }; }
}

/** What a refused answer means. Only these exact answers are definitive; anything else (busy, 5xx, drift) is UNKNOWN. */
export function journalErrorFor(status: number, code: string | null): JournalError {
  if (status === 403) return new JournalError('DENIED', code);
  if (status === 400) return new JournalError('INVALID', code);
  if (status === 404) return new JournalError('GONE', code);
  if (status === 429) return new JournalError('RATE', code);
  if (status === 409 && code === 'VERSION_CONFLICT') return new JournalError('CHANGED', code);
  if (status === 409 && code === 'KAI_JOURNAL_ENTRY_REMOVED') return new JournalError('GONE', code);
  if (status === 409 && code === 'IDEMPOTENCY_KEY_REUSED') return new JournalError('INVALID', code);
  return new JournalError('UNKNOWN', code);
}

export const journalApi = {
  /** One's own active entries between two school-local dates (at most 120 days). */
  async read(scope: JournalScope, from: string, to: string, signal: AbortSignal, owned: Owned): Promise<KaiJournalRead> {
    if (!isKaiJournalRange(from, to)) throw new JournalError('INVALID');
    let answer: { status: number; value: unknown };
    try { answer = await exchange(`${base(scope)}/${from}/${to}`, signal, owned); }
    catch (error) { if (error instanceof JournalError || signal.aborted) throw error; throw new JournalError('UNKNOWN'); }
    if (answer.status !== 200) throw journalErrorFor(answer.status, codeOf(answer.value));
    try { return verifyKaiJournalRead(envelope(answer.value).data, { from, to }); } catch { throw new JournalError('UNKNOWN'); }
  },
  /** Entries other instructors at this school shared with the teaching team (read-only, display names only). */
  async readTeam(scope: JournalScope, from: string, to: string, signal: AbortSignal, owned: Owned): Promise<KaiTeamJournalRead> {
    if (!isKaiJournalRange(from, to)) throw new JournalError('INVALID');
    let answer: { status: number; value: unknown };
    try { answer = await exchange(`${base(scope, 'team')}/${from}/${to}`, signal, owned); }
    catch (error) { if (error instanceof JournalError || signal.aborted) throw error; throw new JournalError('UNKNOWN'); }
    if (answer.status !== 200) throw journalErrorFor(answer.status, codeOf(answer.value));
    try { return verifyKaiTeamJournalRead(envelope(answer.value).data, { from, to }); } catch { throw new JournalError('UNKNOWN'); }
  },
  /** Add, change or remove one entry. The receipt must be the next version of the same entry. */
  async save(scope: JournalScope, input: SaveKaiJournalEntryInput, key: string, signal: AbortSignal, owned: Owned): Promise<KaiJournalEntry> {
    if (typeof key !== 'string' || !UUID.test(key)) throw new JournalError('INVALID');
    let body: SaveKaiJournalEntryInput;
    try { body = validateSaveKaiJournalEntryInput(input); } catch { throw new JournalError('INVALID'); }
    let answer: { status: number; value: unknown };
    try { answer = await exchange(base(scope), signal, owned, { body: JSON.stringify(body), key }); }
    catch (error) { if (error instanceof JournalError) throw error; throw new JournalError('UNKNOWN'); }
    if (answer.status !== 200) throw journalErrorFor(answer.status, codeOf(answer.value));
    try { const e = envelope(answer.value); return verifyKaiJournalReceipt({ entry: e.data, replayed: e.meta.replayed }, body).entry; }
    catch { throw new JournalError('UNKNOWN'); }
  },
};
export type JournalApi = typeof journalApi;

/** Whether a failed save may be sent again with the same key: only when its outcome is not known, or nothing was sent (rate limit). */
export const keepForRetry = (error: unknown) => !(error instanceof JournalError) || error.kind === 'UNKNOWN' || error.kind === 'RATE';
