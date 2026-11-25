import { validateMayaCheckInApproval, validateMayaCheckInBrief, verifyMayaCheckInList, verifyMayaCheckInView, type MayaCheckInApproval, type MayaCheckInBrief, type MayaCheckInChannel, type MayaCheckInView } from '@hon/contracts';
import { reportConfirmedSessionInvalidation } from '../session-invalidation';

/**
 * P8 (0649): Maya check-in drafts. The list is a plain same-origin GET; asking, approving, cancelling and dismissing each send
 * their own X-HON-Human-Command and an Idempotency-Key. The server decides every permission, the AI spend, consent and the cap.
 */
export type MayaCheckInErrorKind =
  /** Session ended. */ 'SESSION'
  /** This person or school cannot use Maya check-in drafts. Nothing was sent. */ | 'NO_ACCESS'
  /** The student is not on the at-risk list now. Nothing was sent. */ | 'NOT_AT_RISK'
  /** The recipient has not agreed to messages on this channel. Nothing was sent. */ | 'NO_CONSENT'
  /** The recipient has no phone number or email for this channel. Nothing was sent. */ | 'NO_ADDRESS'
  /** The recipient already got 3 approved AI-drafted messages today. Nothing was sent. */ | 'DAILY_CAP'
  /** The message is already being sent. */ | 'NOT_CANCELLABLE'
  /** AI help is paused or not available for this school now. Nothing was sent. */ | 'PAUSED'
  /** Already used, dismissed or not yours. Nothing changed. */ | 'GONE'
  /** Not accepted as written. Nothing was sent. */ | 'INVALID'
  /** The outcome is not known. Only the identical request (same key) may be sent again. */ | 'UNKNOWN';
export class MayaCheckInError extends Error { constructor(readonly kind: MayaCheckInErrorKind) { super(kind); } }
export type MayaCheckInScope = Readonly<{ organizationId: string; schoolId: string }>;
export type Owned = () => boolean;
export type MayaCheckInList = Readonly<{ aiAvailable: boolean; checkIns: MayaCheckInView[] }>;

const JSON_TYPE = /^application\/json(?:\s*;|$)/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const codeOf = (v: unknown): string | null => v && typeof v === 'object' && !Array.isArray(v) && typeof (v as { code?: unknown }).code === 'string' ? (v as { code: string }).code : null;
const data = (v: unknown): unknown => { if (!v || typeof v !== 'object' || Array.isArray(v) || !Object.hasOwn(v, 'data')) throw new Error('shape'); return (v as { data: unknown }).data; };

export function mayaCheckInErrorFor(status: number, code: string | null): MayaCheckInError {
  if (status === 403 && code === 'MAYA_CHECK_IN_SPEND_STOPPED') return new MayaCheckInError('PAUSED');
  if (status === 403) return new MayaCheckInError('NO_ACCESS');
  if (status === 404 && code === 'MAYA_CHECK_IN_NOT_AT_RISK') return new MayaCheckInError('NOT_AT_RISK');
  if (status === 404) return new MayaCheckInError('GONE');
  if (status === 400) return new MayaCheckInError('INVALID');
  if (status === 409 && code === 'MAYA_CHECK_IN_NOT_OPEN') return new MayaCheckInError('GONE');
  if (status === 409 && code === 'MAYA_CHECK_IN_NO_CONSENT') return new MayaCheckInError('NO_CONSENT');
  if (status === 409 && code === 'MAYA_CHECK_IN_NO_ADDRESS') return new MayaCheckInError('NO_ADDRESS');
  if (status === 409 && code === 'MAYA_CHECK_IN_DAILY_CAP') return new MayaCheckInError('DAILY_CAP');
  if (status === 409 && code === 'MAYA_CHECK_IN_NOT_CANCELLABLE') return new MayaCheckInError('NOT_CANCELLABLE');
  if (status === 409 && (code === 'IDEMPOTENCY_KEY_REUSED' || code === 'IDEMPOTENCY_KEY_REQUIRED')) return new MayaCheckInError('INVALID');
  return new MayaCheckInError('UNKNOWN');
}

function base(scope: MayaCheckInScope): string {
  if (!UUID.test(scope.organizationId) || !UUID.test(scope.schoolId)) throw new MayaCheckInError('INVALID');
  return `/api/v1/organizations/${scope.organizationId.toLowerCase()}/schools/${scope.schoolId.toLowerCase()}/maya/check-ins`;
}
async function exchange(path: string, signal: AbortSignal, owned: Owned, command?: Readonly<{ name: string; body: string; key: string }>): Promise<{ status: number; value: unknown }> {
  const r = await fetch(path, { method: command ? 'POST' : 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', signal,
    headers: { Accept: 'application/json', ...(command ? { 'Content-Type': 'application/json', 'X-HON-Human-Command': command.name, 'Idempotency-Key': command.key } : {}) },
    ...(command ? { body: command.body } : {}) });
  signal.throwIfAborted();
  if (r.status === 401) { if (owned()) reportConfirmedSessionInvalidation(); throw new MayaCheckInError('SESSION'); }
  if (r.redirected || !JSON_TYPE.test(r.headers.get('content-type') ?? '')) return { status: r.status, value: null };
  const text = await r.text();
  if (text.length > 1_000_000) throw new MayaCheckInError('UNKNOWN');
  try { return { status: r.status, value: JSON.parse(text) as unknown }; } catch { return { status: r.status, value: null }; }
}
async function post(scope: MayaCheckInScope, path: string, name: string, body: unknown, key: string, signal: AbortSignal, owned: Owned): Promise<unknown> {
  if (typeof key !== 'string' || !UUID.test(key)) throw new MayaCheckInError('INVALID');
  let answer: { status: number; value: unknown };
  try { answer = await exchange(base(scope) + path, signal, owned, { name, body: JSON.stringify(body), key }); }
  catch (error) { if (error instanceof MayaCheckInError) throw error; throw new MayaCheckInError('UNKNOWN'); }
  if (answer.status !== 200) throw mayaCheckInErrorFor(answer.status, codeOf(answer.value));
  try { return data(answer.value); } catch { throw new MayaCheckInError('UNKNOWN'); }
}
const checked = <T,>(f: () => T): T => { try { return f(); } catch { throw new MayaCheckInError('UNKNOWN'); } };

export const mayaCheckInApi = {
  /** Whether this server has the paid text route configured, and your latest check-in drafts. */
  async list(scope: MayaCheckInScope, signal: AbortSignal, owned: Owned): Promise<MayaCheckInList> {
    let answer: { status: number; value: unknown };
    try { answer = await exchange(base(scope), signal, owned); }
    catch (error) { if (error instanceof MayaCheckInError || signal.aborted) throw error; throw new MayaCheckInError('UNKNOWN'); }
    if (answer.status !== 200) throw mayaCheckInErrorFor(answer.status, codeOf(answer.value));
    return checked(() => {
      const v = data(answer.value);
      if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).sort().join(',') !== 'aiAvailable,checkIns') throw new Error('shape');
      const o = v as { aiAvailable: unknown; checkIns: unknown };
      if (typeof o.aiAvailable !== 'boolean') throw new Error('shape');
      return { aiAvailable: o.aiAvailable, checkIns: verifyMayaCheckInList(o.checkIns) };
    });
  },
  async request(scope: MayaCheckInScope, brief: MayaCheckInBrief, key: string, signal: AbortSignal, owned: Owned): Promise<MayaCheckInView> {
    let body; try { body = validateMayaCheckInBrief(brief); } catch { throw new MayaCheckInError('INVALID'); }
    const value = await post(scope, '', 'maya.check_in.request', body, key, signal, owned);
    return checked(() => verifyMayaCheckInView(value));
  },
  /** Approve (button or voice): queues one message; the school's delivery checks still run at send time. */
  async approve(scope: MayaCheckInScope, id: string, channel: MayaCheckInChannel, approval: MayaCheckInApproval, key: string, signal: AbortSignal, owned: Owned): Promise<MayaCheckInView> {
    if (!UUID.test(id)) throw new MayaCheckInError('INVALID');
    let body; try { body = validateMayaCheckInApproval(approval, channel); } catch { throw new MayaCheckInError('INVALID'); }
    const value = await post(scope, `/${id.toLowerCase()}/approve`, 'maya.check_in.approve', body, key, signal, owned);
    return checked(() => {
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'checkIn,replayed') throw new Error('shape');
      return verifyMayaCheckInView((value as { checkIn: unknown }).checkIn);
    });
  },
  async cancel(scope: MayaCheckInScope, id: string, key: string, signal: AbortSignal, owned: Owned): Promise<MayaCheckInView> {
    if (!UUID.test(id)) throw new MayaCheckInError('INVALID');
    const value = await post(scope, `/${id.toLowerCase()}/cancel`, 'maya.check_in.cancel', {}, key, signal, owned);
    return checked(() => verifyMayaCheckInView(value));
  },
  async dismiss(scope: MayaCheckInScope, id: string, key: string, signal: AbortSignal, owned: Owned): Promise<MayaCheckInView> {
    if (!UUID.test(id)) throw new MayaCheckInError('INVALID');
    const value = await post(scope, `/${id.toLowerCase()}/close`, 'maya.check_in.close', { status: 'DISMISSED' }, key, signal, owned);
    return checked(() => verifyMayaCheckInView(value));
  },
};
export type MayaCheckInApi = typeof mayaCheckInApi;
