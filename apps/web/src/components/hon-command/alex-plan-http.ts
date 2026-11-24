import { validateAlexPlanBrief, validateAlexPlanCreate, verifyAlexPlanList, verifyAlexPlanView, type AlexPlanBrief, type AlexPlanView } from '@hon/contracts';
import { reportConfirmedSessionInvalidation } from '../session-invalidation';

/**
 * P1 (0639): Alex delegation plans. The list is a plain same-origin GET; asking, creating tasks and dismissing each send
 * their own X-HON-Human-Command and an Idempotency-Key. The server decides every permission, the plan and the AI spend.
 */
export type AlexPlanErrorKind =
  /** Session ended. */ 'SESSION'
  /** This person or school cannot plan with Alex. Nothing was sent. */ | 'NO_ACCESS'
  /** Giving a task to someone else needs team task management. Nothing was created. */ | 'ASSIGN'
  /** A person in the plan can no longer take tasks. Nothing was created. */ | 'ASSIGNEE'
  /** AI help is paused or not available for this school now. Nothing was sent. */ | 'PAUSED'
  /** Already used, dismissed or not yours. Nothing changed. */ | 'GONE'
  /** Not accepted as written. Nothing was sent. */ | 'INVALID'
  /** The outcome is not known. Only the identical request (same key) may be sent again. */ | 'UNKNOWN';
export class AlexPlanError extends Error { constructor(readonly kind: AlexPlanErrorKind) { super(kind); } }
export type AlexPlanScope = Readonly<{ organizationId: string; schoolId: string }>;
export type Owned = () => boolean;
export type AlexPlanList = Readonly<{ aiAvailable: boolean; plans: AlexPlanView[] }>;

const JSON_TYPE = /^application\/json(?:\s*;|$)/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const codeOf = (v: unknown): string | null => v && typeof v === 'object' && !Array.isArray(v) && typeof (v as { code?: unknown }).code === 'string' ? (v as { code: string }).code : null;
const data = (v: unknown): unknown => { if (!v || typeof v !== 'object' || Array.isArray(v) || !Object.hasOwn(v, 'data')) throw new Error('shape'); return (v as { data: unknown }).data; };

export function alexPlanErrorFor(status: number, code: string | null): AlexPlanError {
  if (status === 403 && code === 'ALEX_PLAN_SPEND_STOPPED') return new AlexPlanError('PAUSED');
  if (status === 403 && code === 'ALEX_PLAN_ASSIGN_FORBIDDEN') return new AlexPlanError('ASSIGN');
  if (status === 403 && code === 'ALEX_PLAN_ASSIGNEE_UNAVAILABLE') return new AlexPlanError('ASSIGNEE');
  if (status === 403) return new AlexPlanError('NO_ACCESS');
  if (status === 404) return new AlexPlanError('GONE');
  if (status === 400) return new AlexPlanError('INVALID');
  if (status === 409 && code === 'ALEX_PLAN_NOT_OPEN') return new AlexPlanError('GONE');
  if (status === 409 && (code === 'IDEMPOTENCY_KEY_REUSED' || code === 'IDEMPOTENCY_KEY_REQUIRED')) return new AlexPlanError('INVALID');
  return new AlexPlanError('UNKNOWN');
}

function base(scope: AlexPlanScope): string {
  if (!UUID.test(scope.organizationId) || !UUID.test(scope.schoolId)) throw new AlexPlanError('INVALID');
  return `/api/v1/organizations/${scope.organizationId.toLowerCase()}/schools/${scope.schoolId.toLowerCase()}/alex/plans`;
}
async function exchange(path: string, signal: AbortSignal, owned: Owned, command?: Readonly<{ name: string; body: string; key: string }>): Promise<{ status: number; value: unknown }> {
  const r = await fetch(path, { method: command ? 'POST' : 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', signal,
    headers: { Accept: 'application/json', ...(command ? { 'Content-Type': 'application/json', 'X-HON-Human-Command': command.name, 'Idempotency-Key': command.key } : {}) },
    ...(command ? { body: command.body } : {}) });
  signal.throwIfAborted();
  if (r.status === 401) { if (owned()) reportConfirmedSessionInvalidation(); throw new AlexPlanError('SESSION'); }
  if (r.redirected || !JSON_TYPE.test(r.headers.get('content-type') ?? '')) return { status: r.status, value: null };
  const text = await r.text();
  if (text.length > 1_000_000) throw new AlexPlanError('UNKNOWN');
  try { return { status: r.status, value: JSON.parse(text) as unknown }; } catch { return { status: r.status, value: null }; }
}
async function post(scope: AlexPlanScope, path: string, name: string, body: unknown, key: string, signal: AbortSignal, owned: Owned): Promise<unknown> {
  if (typeof key !== 'string' || !UUID.test(key)) throw new AlexPlanError('INVALID');
  let answer: { status: number; value: unknown };
  try { answer = await exchange(base(scope) + path, signal, owned, { name, body: JSON.stringify(body), key }); }
  catch (error) { if (error instanceof AlexPlanError) throw error; throw new AlexPlanError('UNKNOWN'); }
  if (answer.status !== 200) throw alexPlanErrorFor(answer.status, codeOf(answer.value));
  try { return data(answer.value); } catch { throw new AlexPlanError('UNKNOWN'); }
}
const checked = <T,>(f: () => T): T => { try { return f(); } catch { throw new AlexPlanError('UNKNOWN'); } };

export const alexPlanApi = {
  /** Whether this server has the paid text route configured, and this school's latest plans. */
  async list(scope: AlexPlanScope, signal: AbortSignal, owned: Owned): Promise<AlexPlanList> {
    let answer: { status: number; value: unknown };
    try { answer = await exchange(base(scope), signal, owned); }
    catch (error) { if (error instanceof AlexPlanError || signal.aborted) throw error; throw new AlexPlanError('UNKNOWN'); }
    if (answer.status !== 200) throw alexPlanErrorFor(answer.status, codeOf(answer.value));
    return checked(() => {
      const v = data(answer.value);
      if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).sort().join(',') !== 'aiAvailable,plans') throw new Error('shape');
      const o = v as { aiAvailable: unknown; plans: unknown };
      if (typeof o.aiAvailable !== 'boolean') throw new Error('shape');
      return { aiAvailable: o.aiAvailable, plans: verifyAlexPlanList(o.plans) };
    });
  },
  async request(scope: AlexPlanScope, brief: AlexPlanBrief, key: string, signal: AbortSignal, owned: Owned): Promise<AlexPlanView> {
    let body; try { body = validateAlexPlanBrief(brief); } catch { throw new AlexPlanError('INVALID'); }
    const value = await post(scope, '', 'alex.plan.request', body, key, signal, owned);
    return checked(() => verifyAlexPlanView(value));
  },
  /** Create the ticked tasks as human work items (all or nothing). */
  async create(scope: AlexPlanScope, id: string, tasks: readonly number[], key: string, signal: AbortSignal, owned: Owned): Promise<AlexPlanView> {
    if (!UUID.test(id)) throw new AlexPlanError('INVALID');
    let body; try { body = validateAlexPlanCreate({ tasks: [...tasks] }); } catch { throw new AlexPlanError('INVALID'); }
    const value = await post(scope, `/${id.toLowerCase()}/create`, 'alex.plan.create', body, key, signal, owned);
    return checked(() => {
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'plan,replayed') throw new Error('shape');
      return verifyAlexPlanView((value as { plan: unknown }).plan);
    });
  },
  async dismiss(scope: AlexPlanScope, id: string, key: string, signal: AbortSignal, owned: Owned): Promise<AlexPlanView> {
    if (!UUID.test(id)) throw new AlexPlanError('INVALID');
    const value = await post(scope, `/${id.toLowerCase()}/close`, 'alex.plan.close', { status: 'DISMISSED' }, key, signal, owned);
    return checked(() => verifyAlexPlanView(value));
  },
};
export type AlexPlanApi = typeof alexPlanApi;
