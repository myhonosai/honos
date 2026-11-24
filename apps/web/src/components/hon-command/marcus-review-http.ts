import { validateMarcusReviewBrief, verifyMarcusReviewList, verifyMarcusReviewView, type MarcusReviewBrief, type MarcusReviewView } from '@hon/contracts';
import { reportConfirmedSessionInvalidation } from '../session-invalidation';

/**
 * P3 (0641): Marcus marketing review. The list is a plain same-origin GET; asking and dismissing each send their own
 * X-HON-Human-Command and an Idempotency-Key. The server decides every permission, the plan and the AI spend.
 */
export type MarcusReviewErrorKind =
  /** Session ended. */ 'SESSION'
  /** This person or school cannot use Marcus reviews. Nothing was sent. */ | 'NO_ACCESS'
  /** AI help is paused or not available for this school now. Nothing was sent. */ | 'PAUSED'
  /** Already dismissed or not yours. Nothing changed. */ | 'GONE'
  /** Not accepted as written. Nothing was sent. */ | 'INVALID'
  /** The outcome is not known. Only the identical request (same key) may be sent again. */ | 'UNKNOWN';
export class MarcusReviewError extends Error { constructor(readonly kind: MarcusReviewErrorKind) { super(kind); } }
export type MarcusReviewScope = Readonly<{ organizationId: string; schoolId: string }>;
export type Owned = () => boolean;
export type MarcusReviewList = Readonly<{ aiAvailable: boolean; reviews: MarcusReviewView[] }>;

const JSON_TYPE = /^application\/json(?:\s*;|$)/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const codeOf = (v: unknown): string | null => v && typeof v === 'object' && !Array.isArray(v) && typeof (v as { code?: unknown }).code === 'string' ? (v as { code: string }).code : null;
const data = (v: unknown): unknown => { if (!v || typeof v !== 'object' || Array.isArray(v) || !Object.hasOwn(v, 'data')) throw new Error('shape'); return (v as { data: unknown }).data; };

export function marcusReviewErrorFor(status: number, code: string | null): MarcusReviewError {
  if (status === 403 && code === 'MARCUS_REVIEW_SPEND_STOPPED') return new MarcusReviewError('PAUSED');
  if (status === 403) return new MarcusReviewError('NO_ACCESS');
  if (status === 404) return new MarcusReviewError('GONE');
  if (status === 400) return new MarcusReviewError('INVALID');
  if (status === 409 && code === 'MARCUS_REVIEW_NOT_OPEN') return new MarcusReviewError('GONE');
  if (status === 409 && (code === 'IDEMPOTENCY_KEY_REUSED' || code === 'IDEMPOTENCY_KEY_REQUIRED')) return new MarcusReviewError('INVALID');
  return new MarcusReviewError('UNKNOWN');
}

function base(scope: MarcusReviewScope): string {
  if (!UUID.test(scope.organizationId) || !UUID.test(scope.schoolId)) throw new MarcusReviewError('INVALID');
  return `/api/v1/organizations/${scope.organizationId.toLowerCase()}/schools/${scope.schoolId.toLowerCase()}/marcus/reviews`;
}
async function exchange(path: string, signal: AbortSignal, owned: Owned, command?: Readonly<{ name: string; body: string; key: string }>): Promise<{ status: number; value: unknown }> {
  const r = await fetch(path, { method: command ? 'POST' : 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', signal,
    headers: { Accept: 'application/json', ...(command ? { 'Content-Type': 'application/json', 'X-HON-Human-Command': command.name, 'Idempotency-Key': command.key } : {}) },
    ...(command ? { body: command.body } : {}) });
  signal.throwIfAborted();
  if (r.status === 401) { if (owned()) reportConfirmedSessionInvalidation(); throw new MarcusReviewError('SESSION'); }
  if (r.redirected || !JSON_TYPE.test(r.headers.get('content-type') ?? '')) return { status: r.status, value: null };
  const text = await r.text();
  if (text.length > 1_000_000) throw new MarcusReviewError('UNKNOWN');
  try { return { status: r.status, value: JSON.parse(text) as unknown }; } catch { return { status: r.status, value: null }; }
}
async function post(scope: MarcusReviewScope, path: string, name: string, body: unknown, key: string, signal: AbortSignal, owned: Owned): Promise<unknown> {
  if (typeof key !== 'string' || !UUID.test(key)) throw new MarcusReviewError('INVALID');
  let answer: { status: number; value: unknown };
  try { answer = await exchange(base(scope) + path, signal, owned, { name, body: JSON.stringify(body), key }); }
  catch (error) { if (error instanceof MarcusReviewError) throw error; throw new MarcusReviewError('UNKNOWN'); }
  if (answer.status !== 200) throw marcusReviewErrorFor(answer.status, codeOf(answer.value));
  try { return data(answer.value); } catch { throw new MarcusReviewError('UNKNOWN'); }
}
const checked = <T,>(f: () => T): T => { try { return f(); } catch { throw new MarcusReviewError('UNKNOWN'); } };

export const marcusReviewApi = {
  /** Whether this server has the paid text route configured, and the person's latest marketing reviews. */
  async list(scope: MarcusReviewScope, signal: AbortSignal, owned: Owned): Promise<MarcusReviewList> {
    let answer: { status: number; value: unknown };
    try { answer = await exchange(base(scope), signal, owned); }
    catch (error) { if (error instanceof MarcusReviewError || signal.aborted) throw error; throw new MarcusReviewError('UNKNOWN'); }
    if (answer.status !== 200) throw marcusReviewErrorFor(answer.status, codeOf(answer.value));
    return checked(() => {
      const v = data(answer.value);
      if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).sort().join(',') !== 'aiAvailable,reviews') throw new Error('shape');
      const o = v as { aiAvailable: unknown; reviews: unknown };
      if (typeof o.aiAvailable !== 'boolean') throw new Error('shape');
      return { aiAvailable: o.aiAvailable, reviews: verifyMarcusReviewList(o.reviews) };
    });
  },
  async request(scope: MarcusReviewScope, brief: MarcusReviewBrief, key: string, signal: AbortSignal, owned: Owned): Promise<MarcusReviewView> {
    let body; try { body = validateMarcusReviewBrief(brief); } catch { throw new MarcusReviewError('INVALID'); }
    const value = await post(scope, '', 'marcus.review.request', body, key, signal, owned);
    return checked(() => verifyMarcusReviewView(value));
  },
  async dismiss(scope: MarcusReviewScope, id: string, key: string, signal: AbortSignal, owned: Owned): Promise<MarcusReviewView> {
    if (!UUID.test(id)) throw new MarcusReviewError('INVALID');
    const value = await post(scope, `/${id.toLowerCase()}/close`, 'marcus.review.close', { status: 'DISMISSED' }, key, signal, owned);
    return checked(() => verifyMarcusReviewView(value));
  },
};
export type MarcusReviewApi = typeof marcusReviewApi;
