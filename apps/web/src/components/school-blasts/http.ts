import {
  SCHOOL_BLAST_COMMANDS, validateCancelSchoolBlast, validateSaveSchoolBlast, validateSendSchoolBlast, verifySchoolBlast,
  verifySchoolBlastAudience, verifySchoolBlastList, verifySchoolBlastReceipt, type CancelSchoolBlastInput, type SaveSchoolBlastInput, type SchoolBlast,
  type SchoolBlastAudiencePreview, type SchoolBlastSummary, type SendSchoolBlastInput,
} from '@hon/contracts';
import { reportConfirmedSessionInvalidation } from '../session-invalidation';

/**
 * Marketing > Blasts (0524). Reads are plain same-origin GETs with no key; each command sends its own X-HON-Human-Command
 * name and an Idempotency-Key. The server decides the permission, the audience, the merge tags and the version again.
 */
export type BlastErrorKind =
  /** Session ended. */ 'SESSION'
  /** Not allowed here. Nothing changed. */ | 'DENIED'
  /** Someone changed this since it was read. Nothing changed. */ | 'CHANGED'
  /** Already sent or cancelled. Nothing changed. */ | 'NOT_DRAFT'
  /** Only a scheduled blast can be cancelled, before its time. Nothing changed. */ | 'NOT_CANCELLABLE'
  /** Nobody in the audience can receive it. Nothing changed. */ | 'NO_RECIPIENTS'
  /** More than 2,000 recipients. Nothing changed. */ | 'TOO_LARGE'
  /** 10 blasts in 24 hours already. Nothing changed. */ | 'DAILY_LIMIT'
  /** A filled-in message is too long. Nothing changed. */ | 'TOO_LONG'
  /** The blast is gone. Nothing changed. */ | 'GONE'
  /** The request was not accepted as sent. Nothing changed. */ | 'INVALID'
  /** Too many requests. Nothing changed. */ | 'RATE'
  /** Busy, or the outcome is not known. Only the identical request (same key) may be sent again. */ | 'UNKNOWN';
export class BlastError extends Error { constructor(readonly kind: BlastErrorKind, readonly code: string | null = null) { super(kind); } }
export type Owned = () => boolean;
export type BlastScope = Readonly<{ organizationId: string; schoolId: string }>;

const RESPONSE_MAX = 900_000;
const JSON_TYPE = /^application\/json(?:\s*;|$)/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const codeOf = (v: unknown): string | null => v && typeof v === 'object' && !Array.isArray(v) && typeof (v as { code?: unknown }).code === 'string' ? (v as { code: string }).code : null;
function envelope(value: unknown): { data: unknown; meta: Record<string, unknown> } {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, 'data') || !Object.hasOwn(value, 'meta')) throw new Error('shape');
  const meta = (value as { meta: unknown }).meta;
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) throw new Error('shape');
  return { data: (value as { data: unknown }).data, meta: meta as Record<string, unknown> };
}
function id(value: string): string { if (typeof value !== 'string' || !UUID.test(value)) throw new BlastError('INVALID'); return value.toLowerCase(); }
function base(scope: BlastScope): string { return `/api/v1/organizations/${id(scope.organizationId)}/schools/${id(scope.schoolId)}/marketing/blasts`; }

async function exchange(url: string, signal: AbortSignal, owned: Owned, command?: Readonly<{ name: string; body: string; key: string }>): Promise<{ status: number; value: unknown }> {
  const r = await fetch(url, { method: command ? 'POST' : 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error',
    referrerPolicy: 'no-referrer', signal,
    headers: { Accept: 'application/json', ...(command ? { 'Content-Type': 'application/json', 'X-HON-Human-Command': command.name, 'Idempotency-Key': command.key } : {}) },
    ...(command ? { body: command.body } : {}) });
  // A retired request (aborted, or no longer the one shown) never ends a newer session.
  signal.throwIfAborted();
  if (r.status === 401) { if (owned()) reportConfirmedSessionInvalidation(); throw new BlastError('SESSION'); }
  if (r.redirected || !JSON_TYPE.test(r.headers.get('content-type') ?? '')) return { status: r.status, value: null };
  const text = await r.text();
  if (text.length > RESPONSE_MAX) throw new BlastError('UNKNOWN');
  try { return { status: r.status, value: JSON.parse(text) as unknown }; } catch { return { status: r.status, value: null }; }
}

/** What a refused answer means. Only these exact answers are definitive; anything else (busy, 5xx, drift) is UNKNOWN. */
export function blastErrorFor(status: number, code: string | null): BlastError {
  if (status === 403) return new BlastError('DENIED', code);
  if (status === 404) return new BlastError('GONE', code);
  if (status === 429) return new BlastError('RATE', code);
  if (status === 400) return new BlastError(code === 'BLAST_TEXT_TOO_LONG' ? 'TOO_LONG' : 'INVALID', code);
  if (status === 409) {
    const kind = ({ VERSION_CONFLICT: 'CHANGED', BLAST_NOT_DRAFT: 'NOT_DRAFT', BLAST_NOT_CANCELLABLE: 'NOT_CANCELLABLE', BLAST_NO_RECIPIENTS: 'NO_RECIPIENTS',
      BLAST_AUDIENCE_TOO_LARGE: 'TOO_LARGE', BLAST_DAILY_LIMIT: 'DAILY_LIMIT', IDEMPOTENCY_KEY_REUSED: 'INVALID' } as Record<string, BlastErrorKind>)[code ?? ''];
    if (kind) return new BlastError(kind, code);
  }
  // SCHOOL_BLAST_CONFLICT (a lock wait), IDEMPOTENCY_IN_PROGRESS, 5xx: the same request may be sent again.
  return new BlastError('UNKNOWN', code);
}

async function read<T>(url: string, signal: AbortSignal, owned: Owned, verify: (value: unknown) => T): Promise<T> {
  let answer: { status: number; value: unknown };
  try { answer = await exchange(url, signal, owned); }
  catch (error) { if (error instanceof BlastError || signal.aborted) throw error; throw new BlastError('UNKNOWN'); }
  if (answer.status !== 200) throw blastErrorFor(answer.status, codeOf(answer.value));
  try { return verify(envelope(answer.value).data); } catch { throw new BlastError('UNKNOWN'); }
}
async function command(url: string, name: string, body: object, key: string, signal: AbortSignal, owned: Owned, verify: (data: unknown, replayed: unknown) => SchoolBlast): Promise<SchoolBlast> {
  if (typeof key !== 'string' || !UUID.test(key)) throw new BlastError('INVALID');
  let answer: { status: number; value: unknown };
  try { answer = await exchange(url, signal, owned, { name, body: JSON.stringify(body), key }); }
  catch (error) { if (error instanceof BlastError) throw error; throw new BlastError('UNKNOWN'); }
  if (answer.status !== 200) throw blastErrorFor(answer.status, codeOf(answer.value));
  try { const e = envelope(answer.value); return verify(e.data, e.meta.replayed); } catch { throw new BlastError('UNKNOWN'); }
}
function checked<T>(validate: (value: unknown) => T, value: unknown): T { try { return validate(value); } catch { throw new BlastError('INVALID'); } }

export const blastApi = {
  list(scope: BlastScope, signal: AbortSignal, owned: Owned): Promise<SchoolBlastSummary[]> {
    return read(base(scope), signal, owned, verifySchoolBlastList);
  },
  get(scope: BlastScope, blastId: string, signal: AbortSignal, owned: Owned): Promise<SchoolBlast> {
    const wanted = id(blastId);
    return read(`${base(scope)}/${wanted}`, signal, owned, (v) => { const b = verifySchoolBlast(v); if (b.blastId !== wanted) throw new Error('drift'); return b; });
  },
  audience(scope: BlastScope, blastId: string, signal: AbortSignal, owned: Owned): Promise<SchoolBlastAudiencePreview> {
    const wanted = id(blastId);
    return read(`${base(scope)}/${wanted}/audience`, signal, owned, (v) => verifySchoolBlastAudience(v, { blastId: wanted }));
  },
  async save(scope: BlastScope, input: SaveSchoolBlastInput, key: string, signal: AbortSignal, owned: Owned): Promise<SchoolBlast> {
    const body = checked(validateSaveSchoolBlast, input);
    return command(base(scope), SCHOOL_BLAST_COMMANDS.save, body, key, signal, owned, (data, replayed) => {
      const r = verifySchoolBlastReceipt({ blast: data, replayed }, { blastId: body.blastId, version: body.expectedVersion + 1, status: 'DRAFT' });
      if (r.blast.channel !== body.channel || r.blast.body !== body.body || r.blast.subject !== body.subject) throw new Error('drift');
      return r.blast;
    });
  },
  async send(scope: BlastScope, input: SendSchoolBlastInput, key: string, signal: AbortSignal, owned: Owned): Promise<SchoolBlast> {
    const body = checked(validateSendSchoolBlast, input);
    return command(`${base(scope)}/send`, SCHOOL_BLAST_COMMANDS.send, body, key, signal, owned, (data, replayed) => {
      const r = verifySchoolBlastReceipt({ blast: data, replayed }, { blastId: body.blastId, version: body.expectedVersion + 1, status: 'QUEUED' });
      if (r.blast.sendAt !== body.sendAt) throw new Error('drift');
      return r.blast;
    });
  },
  async cancel(scope: BlastScope, input: CancelSchoolBlastInput, key: string, signal: AbortSignal, owned: Owned): Promise<SchoolBlast> {
    const body = checked(validateCancelSchoolBlast, input);
    return command(`${base(scope)}/cancel`, SCHOOL_BLAST_COMMANDS.cancel, body, key, signal, owned,
      (data, replayed) => verifySchoolBlastReceipt({ blast: data, replayed }, { blastId: body.blastId, version: body.expectedVersion + 1, status: 'CANCELLED' }).blast);
  },
};
export type BlastApi = typeof blastApi;

/** Whether a failed command may be sent again with the same key: only when its outcome is not known, or nothing was sent (rate limit). */
export const keepForRetry = (error: unknown) => !(error instanceof BlastError) || error.kind === 'UNKNOWN' || error.kind === 'RATE';
