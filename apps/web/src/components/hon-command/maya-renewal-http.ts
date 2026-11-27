import { validateMayaRenewalApply, validateMayaRenewalBrief, verifyMayaRenewalList, verifyMayaRenewalView, type MayaRenewalBrief, type MayaRenewalView } from '@hon/contracts';
import { reportConfirmedSessionInvalidation } from '../session-invalidation';

/**
 * P5 (0646): Maya renewal prep. The list is a plain same-origin GET; asking, applying and dismissing each send
 * their own X-HON-Human-Command and an Idempotency-Key. The server decides every permission, the plan and the AI spend.
 */
export type MayaRenewalErrorKind =
  /** Session ended. */ 'SESSION'
  /** This person or school cannot use Maya renewal prep. Nothing was sent. */ | 'NO_ACCESS'
  /** A membership already has an open renewal review. Nothing was applied. */ | 'REVIEW_OPEN'
  /** A membership changed or ended after Maya read it. Nothing was applied. */ | 'CHANGED'
  /** AI help is paused or not available for this school now. Nothing was sent. */ | 'PAUSED'
  /** Already used, dismissed or not yours. Nothing changed. */ | 'GONE'
  /** Not accepted as written. Nothing was sent. */ | 'INVALID'
  /** The outcome is not known. Only the identical request (same key) may be sent again. */ | 'UNKNOWN';
export class MayaRenewalError extends Error { constructor(readonly kind: MayaRenewalErrorKind) { super(kind); } }
export type MayaRenewalScope = Readonly<{ organizationId: string; schoolId: string }>;
export type Owned = () => boolean;
export type MayaRenewalList = Readonly<{ aiAvailable: boolean; renewalPreps: MayaRenewalView[] }>;

const JSON_TYPE = /^application\/json(?:\s*;|$)/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const codeOf = (v: unknown): string | null => v && typeof v === 'object' && !Array.isArray(v) && typeof (v as { code?: unknown }).code === 'string' ? (v as { code: string }).code : null;
const data = (v: unknown): unknown => { if (!v || typeof v !== 'object' || Array.isArray(v) || !Object.hasOwn(v, 'data')) throw new Error('shape'); return (v as { data: unknown }).data; };

export function mayaRenewalErrorFor(status: number, code: string | null): MayaRenewalError {
  if (status === 403 && code === 'MAYA_RENEWAL_SPEND_STOPPED') return new MayaRenewalError('PAUSED');
  if (status === 403) return new MayaRenewalError('NO_ACCESS');
  if (status === 404) return new MayaRenewalError('GONE');
  if (status === 400) return new MayaRenewalError('INVALID');
  if (status === 409 && code === 'MAYA_RENEWAL_NOT_OPEN') return new MayaRenewalError('GONE');
  if (status === 409 && code === 'MAYA_RENEWAL_MEMBERSHIP_CHANGED') return new MayaRenewalError('CHANGED');
  if (status === 409 && code === 'MAYA_RENEWAL_REVIEW_OPEN') return new MayaRenewalError('REVIEW_OPEN');
  if (status === 409 && (code === 'IDEMPOTENCY_KEY_REUSED' || code === 'IDEMPOTENCY_KEY_REQUIRED')) return new MayaRenewalError('INVALID');
  return new MayaRenewalError('UNKNOWN');
}

function base(scope: MayaRenewalScope): string {
  if (!UUID.test(scope.organizationId) || !UUID.test(scope.schoolId)) throw new MayaRenewalError('INVALID');
  return `/api/v1/organizations/${scope.organizationId.toLowerCase()}/schools/${scope.schoolId.toLowerCase()}/maya/renewal-prep`;
}
async function exchange(path: string, signal: AbortSignal, owned: Owned, command?: Readonly<{ name: string; body: string; key: string }>): Promise<{ status: number; value: unknown }> {
  const r = await fetch(path, { method: command ? 'POST' : 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', signal,
    headers: { Accept: 'application/json', ...(command ? { 'Content-Type': 'application/json', 'X-HON-Human-Command': command.name, 'Idempotency-Key': command.key } : {}) },
    ...(command ? { body: command.body } : {}) });
  signal.throwIfAborted();
  if (r.status === 401) { if (owned()) reportConfirmedSessionInvalidation(); throw new MayaRenewalError('SESSION'); }
  if (r.redirected || !JSON_TYPE.test(r.headers.get('content-type') ?? '')) return { status: r.status, value: null };
  const text = await r.text();
  if (text.length > 1_000_000) throw new MayaRenewalError('UNKNOWN');
  try { return { status: r.status, value: JSON.parse(text) as unknown }; } catch { return { status: r.status, value: null }; }
}
async function post(scope: MayaRenewalScope, path: string, name: string, body: unknown, key: string, signal: AbortSignal, owned: Owned): Promise<unknown> {
  if (typeof key !== 'string' || !UUID.test(key)) throw new MayaRenewalError('INVALID');
  let answer: { status: number; value: unknown };
  try { answer = await exchange(base(scope) + path, signal, owned, { name, body: JSON.stringify(body), key }); }
  catch (error) { if (error instanceof MayaRenewalError) throw error; throw new MayaRenewalError('UNKNOWN'); }
  if (answer.status !== 200) throw mayaRenewalErrorFor(answer.status, codeOf(answer.value));
  try { return data(answer.value); } catch { throw new MayaRenewalError('UNKNOWN'); }
}
const checked = <T,>(f: () => T): T => { try { return f(); } catch { throw new MayaRenewalError('UNKNOWN'); } };

export const mayaRenewalApi = {
  /** Whether this server has the paid text route configured, and your latest renewal lists. */
  async list(scope: MayaRenewalScope, signal: AbortSignal, owned: Owned): Promise<MayaRenewalList> {
    let answer: { status: number; value: unknown };
    try { answer = await exchange(base(scope), signal, owned); }
    catch (error) { if (error instanceof MayaRenewalError || signal.aborted) throw error; throw new MayaRenewalError('UNKNOWN'); }
    if (answer.status !== 200) throw mayaRenewalErrorFor(answer.status, codeOf(answer.value));
    return checked(() => {
      const v = data(answer.value);
      if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).sort().join(',') !== 'aiAvailable,renewalPreps') throw new Error('shape');
      const o = v as { aiAvailable: unknown; renewalPreps: unknown };
      if (typeof o.aiAvailable !== 'boolean') throw new Error('shape');
      return { aiAvailable: o.aiAvailable, renewalPreps: verifyMayaRenewalList(o.renewalPreps) };
    });
  },
  async request(scope: MayaRenewalScope, brief: MayaRenewalBrief, key: string, signal: AbortSignal, owned: Owned): Promise<MayaRenewalView> {
    let body; try { body = validateMayaRenewalBrief(brief); } catch { throw new MayaRenewalError('INVALID'); }
    const value = await post(scope, '', 'maya.renewal_prep.request', body, key, signal, owned);
    return checked(() => verifyMayaRenewalView(value));
  },
  /** Open a renewal review for each ticked suggestion through the human renewal path (all or nothing). */
  async apply(scope: MayaRenewalScope, id: string, suggestions: readonly number[], key: string, signal: AbortSignal, owned: Owned): Promise<MayaRenewalView> {
    if (!UUID.test(id)) throw new MayaRenewalError('INVALID');
    let body; try { body = validateMayaRenewalApply({ suggestions: [...suggestions] }); } catch { throw new MayaRenewalError('INVALID'); }
    const value = await post(scope, `/${id.toLowerCase()}/apply`, 'maya.renewal_prep.apply', body, key, signal, owned);
    return checked(() => {
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'renewalPrep,replayed') throw new Error('shape');
      return verifyMayaRenewalView((value as { renewalPrep: unknown }).renewalPrep);
    });
  },
  async dismiss(scope: MayaRenewalScope, id: string, key: string, signal: AbortSignal, owned: Owned): Promise<MayaRenewalView> {
    if (!UUID.test(id)) throw new MayaRenewalError('INVALID');
    const value = await post(scope, `/${id.toLowerCase()}/close`, 'maya.renewal_prep.close', { status: 'DISMISSED' }, key, signal, owned);
    return checked(() => verifyMayaRenewalView(value));
  },
};
export type MayaRenewalApi = typeof mayaRenewalApi;
