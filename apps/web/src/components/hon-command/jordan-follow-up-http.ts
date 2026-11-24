import { validateJordanFollowUpApply, validateJordanFollowUpBrief, verifyJordanFollowUpList, verifyJordanFollowUpView, type JordanFollowUpBrief, type JordanFollowUpView } from '@hon/contracts';
import { reportConfirmedSessionInvalidation } from '../session-invalidation';

/**
 * P2 (0640): Jordan follow-through. The list is a plain same-origin GET; asking, applying and dismissing each send
 * their own X-HON-Human-Command and an Idempotency-Key. The server decides every permission, the plan and the AI spend.
 */
export type JordanFollowUpErrorKind =
  /** Session ended. */ 'SESSION'
  /** This person or school cannot use Jordan follow-through. Nothing was sent. */ | 'NO_ACCESS'
  /** A person in the suggestions can no longer take tasks. Nothing was applied. */ | 'ASSIGNEE'
  /** A task changed after Jordan read it. Nothing was applied. */ | 'CHANGED'
  /** AI help is paused or not available for this school now. Nothing was sent. */ | 'PAUSED'
  /** Already used, dismissed or not yours. Nothing changed. */ | 'GONE'
  /** Not accepted as written. Nothing was sent. */ | 'INVALID'
  /** The outcome is not known. Only the identical request (same key) may be sent again. */ | 'UNKNOWN';
export class JordanFollowUpError extends Error { constructor(readonly kind: JordanFollowUpErrorKind) { super(kind); } }
export type JordanFollowUpScope = Readonly<{ organizationId: string; schoolId: string }>;
export type Owned = () => boolean;
export type JordanFollowUpList = Readonly<{ aiAvailable: boolean; followUps: JordanFollowUpView[] }>;

const JSON_TYPE = /^application\/json(?:\s*;|$)/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const codeOf = (v: unknown): string | null => v && typeof v === 'object' && !Array.isArray(v) && typeof (v as { code?: unknown }).code === 'string' ? (v as { code: string }).code : null;
const data = (v: unknown): unknown => { if (!v || typeof v !== 'object' || Array.isArray(v) || !Object.hasOwn(v, 'data')) throw new Error('shape'); return (v as { data: unknown }).data; };

export function jordanFollowUpErrorFor(status: number, code: string | null): JordanFollowUpError {
  if (status === 403 && code === 'JORDAN_FOLLOW_UP_SPEND_STOPPED') return new JordanFollowUpError('PAUSED');
  if (status === 403 && code === 'JORDAN_FOLLOW_UP_ASSIGNEE_UNAVAILABLE') return new JordanFollowUpError('ASSIGNEE');
  if (status === 403) return new JordanFollowUpError('NO_ACCESS');
  if (status === 404) return new JordanFollowUpError('GONE');
  if (status === 400) return new JordanFollowUpError('INVALID');
  if (status === 409 && code === 'JORDAN_FOLLOW_UP_NOT_OPEN') return new JordanFollowUpError('GONE');
  if (status === 409 && code === 'JORDAN_FOLLOW_UP_TASK_CHANGED') return new JordanFollowUpError('CHANGED');
  if (status === 409 && (code === 'IDEMPOTENCY_KEY_REUSED' || code === 'IDEMPOTENCY_KEY_REQUIRED')) return new JordanFollowUpError('INVALID');
  return new JordanFollowUpError('UNKNOWN');
}

function base(scope: JordanFollowUpScope): string {
  if (!UUID.test(scope.organizationId) || !UUID.test(scope.schoolId)) throw new JordanFollowUpError('INVALID');
  return `/api/v1/organizations/${scope.organizationId.toLowerCase()}/schools/${scope.schoolId.toLowerCase()}/jordan/follow-ups`;
}
async function exchange(path: string, signal: AbortSignal, owned: Owned, command?: Readonly<{ name: string; body: string; key: string }>): Promise<{ status: number; value: unknown }> {
  const r = await fetch(path, { method: command ? 'POST' : 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', signal,
    headers: { Accept: 'application/json', ...(command ? { 'Content-Type': 'application/json', 'X-HON-Human-Command': command.name, 'Idempotency-Key': command.key } : {}) },
    ...(command ? { body: command.body } : {}) });
  signal.throwIfAborted();
  if (r.status === 401) { if (owned()) reportConfirmedSessionInvalidation(); throw new JordanFollowUpError('SESSION'); }
  if (r.redirected || !JSON_TYPE.test(r.headers.get('content-type') ?? '')) return { status: r.status, value: null };
  const text = await r.text();
  if (text.length > 1_000_000) throw new JordanFollowUpError('UNKNOWN');
  try { return { status: r.status, value: JSON.parse(text) as unknown }; } catch { return { status: r.status, value: null }; }
}
async function post(scope: JordanFollowUpScope, path: string, name: string, body: unknown, key: string, signal: AbortSignal, owned: Owned): Promise<unknown> {
  if (typeof key !== 'string' || !UUID.test(key)) throw new JordanFollowUpError('INVALID');
  let answer: { status: number; value: unknown };
  try { answer = await exchange(base(scope) + path, signal, owned, { name, body: JSON.stringify(body), key }); }
  catch (error) { if (error instanceof JordanFollowUpError) throw error; throw new JordanFollowUpError('UNKNOWN'); }
  if (answer.status !== 200) throw jordanFollowUpErrorFor(answer.status, codeOf(answer.value));
  try { return data(answer.value); } catch { throw new JordanFollowUpError('UNKNOWN'); }
}
const checked = <T,>(f: () => T): T => { try { return f(); } catch { throw new JordanFollowUpError('UNKNOWN'); } };

export const jordanFollowUpApi = {
  /** Whether this server has the paid text route configured, and this school's latest follow-up lists. */
  async list(scope: JordanFollowUpScope, signal: AbortSignal, owned: Owned): Promise<JordanFollowUpList> {
    let answer: { status: number; value: unknown };
    try { answer = await exchange(base(scope), signal, owned); }
    catch (error) { if (error instanceof JordanFollowUpError || signal.aborted) throw error; throw new JordanFollowUpError('UNKNOWN'); }
    if (answer.status !== 200) throw jordanFollowUpErrorFor(answer.status, codeOf(answer.value));
    return checked(() => {
      const v = data(answer.value);
      if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).sort().join(',') !== 'aiAvailable,followUps') throw new Error('shape');
      const o = v as { aiAvailable: unknown; followUps: unknown };
      if (typeof o.aiAvailable !== 'boolean') throw new Error('shape');
      return { aiAvailable: o.aiAvailable, followUps: verifyJordanFollowUpList(o.followUps) };
    });
  },
  async request(scope: JordanFollowUpScope, brief: JordanFollowUpBrief, key: string, signal: AbortSignal, owned: Owned): Promise<JordanFollowUpView> {
    let body; try { body = validateJordanFollowUpBrief(brief); } catch { throw new JordanFollowUpError('INVALID'); }
    const value = await post(scope, '', 'jordan.follow_up.request', body, key, signal, owned);
    return checked(() => verifyJordanFollowUpView(value));
  },
  /** Apply the ticked suggestions through the human work path (all or nothing). */
  async apply(scope: JordanFollowUpScope, id: string, suggestions: readonly number[], key: string, signal: AbortSignal, owned: Owned): Promise<JordanFollowUpView> {
    if (!UUID.test(id)) throw new JordanFollowUpError('INVALID');
    let body; try { body = validateJordanFollowUpApply({ suggestions: [...suggestions] }); } catch { throw new JordanFollowUpError('INVALID'); }
    const value = await post(scope, `/${id.toLowerCase()}/apply`, 'jordan.follow_up.apply', body, key, signal, owned);
    return checked(() => {
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'followUp,replayed') throw new Error('shape');
      return verifyJordanFollowUpView((value as { followUp: unknown }).followUp);
    });
  },
  async dismiss(scope: JordanFollowUpScope, id: string, key: string, signal: AbortSignal, owned: Owned): Promise<JordanFollowUpView> {
    if (!UUID.test(id)) throw new JordanFollowUpError('INVALID');
    const value = await post(scope, `/${id.toLowerCase()}/close`, 'jordan.follow_up.close', { status: 'DISMISSED' }, key, signal, owned);
    return checked(() => verifyJordanFollowUpView(value));
  },
};
export type JordanFollowUpApi = typeof jordanFollowUpApi;
