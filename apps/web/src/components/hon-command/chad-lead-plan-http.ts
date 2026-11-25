import { validateChadLeadPlanBrief, validateChadLeadPlanStep, verifyChadLeadPlanList, verifyChadLeadPlanView, type ChadLeadPlanBrief, type ChadLeadPlanView } from '@hon/contracts';
import { reportConfirmedSessionInvalidation } from '../session-invalidation';

/**
 * P9 (0650): Chad lead next steps. The list is a plain same-origin GET; asking, recording a step and dismissing each send
 * their own X-HON-Human-Command and an Idempotency-Key. The step itself (a stage move or a trial booking) is the ordinary
 * human command, sent by the panel before the step is recorded. The server decides every permission, the plan and the AI spend.
 */
export type ChadLeadPlanErrorKind =
  /** Session ended. */ 'SESSION'
  /** This person or school cannot use Chad lead next steps. Nothing was sent. */ | 'NO_ACCESS'
  /** HON found no matching change made by this person since the list was written. Nothing was recorded. */ | 'NOT_DONE'
  /** AI help is paused or not available for this school now. Nothing was sent. */ | 'PAUSED'
  /** Already used, dismissed or not yours. Nothing changed. */ | 'GONE'
  /** Not accepted as written. Nothing was sent. */ | 'INVALID'
  /** The outcome is not known. Only the identical request (same key) may be sent again. */ | 'UNKNOWN';
export class ChadLeadPlanError extends Error { constructor(readonly kind: ChadLeadPlanErrorKind) { super(kind); } }
export type ChadLeadPlanScope = Readonly<{ organizationId: string; schoolId: string }>;
export type Owned = () => boolean;
export type ChadLeadPlanList = Readonly<{ aiAvailable: boolean; leadPlans: ChadLeadPlanView[] }>;

const JSON_TYPE = /^application\/json(?:\s*;|$)/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const codeOf = (v: unknown): string | null => v && typeof v === 'object' && !Array.isArray(v) && typeof (v as { code?: unknown }).code === 'string' ? (v as { code: string }).code : null;
const data = (v: unknown): unknown => { if (!v || typeof v !== 'object' || Array.isArray(v) || !Object.hasOwn(v, 'data')) throw new Error('shape'); return (v as { data: unknown }).data; };

export function chadLeadPlanErrorFor(status: number, code: string | null): ChadLeadPlanError {
  if (status === 403 && code === 'CHAD_LEAD_PLAN_SPEND_STOPPED') return new ChadLeadPlanError('PAUSED');
  if (status === 403) return new ChadLeadPlanError('NO_ACCESS');
  if (status === 404) return new ChadLeadPlanError('GONE');
  if (status === 400) return new ChadLeadPlanError('INVALID');
  if (status === 409 && code === 'CHAD_LEAD_PLAN_NOT_OPEN') return new ChadLeadPlanError('GONE');
  if (status === 409 && code === 'CHAD_LEAD_PLAN_NOT_DONE') return new ChadLeadPlanError('NOT_DONE');
  if (status === 409 && (code === 'IDEMPOTENCY_KEY_REUSED' || code === 'IDEMPOTENCY_KEY_REQUIRED')) return new ChadLeadPlanError('INVALID');
  return new ChadLeadPlanError('UNKNOWN');
}

function base(scope: ChadLeadPlanScope): string {
  if (!UUID.test(scope.organizationId) || !UUID.test(scope.schoolId)) throw new ChadLeadPlanError('INVALID');
  return `/api/v1/organizations/${scope.organizationId.toLowerCase()}/schools/${scope.schoolId.toLowerCase()}/chad/lead-plan`;
}
async function exchange(path: string, signal: AbortSignal, owned: Owned, command?: Readonly<{ name: string; body: string; key: string }>): Promise<{ status: number; value: unknown }> {
  const r = await fetch(path, { method: command ? 'POST' : 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', signal,
    headers: { Accept: 'application/json', ...(command ? { 'Content-Type': 'application/json', 'X-HON-Human-Command': command.name, 'Idempotency-Key': command.key } : {}) },
    ...(command ? { body: command.body } : {}) });
  signal.throwIfAborted();
  if (r.status === 401) { if (owned()) reportConfirmedSessionInvalidation(); throw new ChadLeadPlanError('SESSION'); }
  if (r.redirected || !JSON_TYPE.test(r.headers.get('content-type') ?? '')) return { status: r.status, value: null };
  const text = await r.text();
  if (text.length > 1_000_000) throw new ChadLeadPlanError('UNKNOWN');
  try { return { status: r.status, value: JSON.parse(text) as unknown }; } catch { return { status: r.status, value: null }; }
}
async function post(scope: ChadLeadPlanScope, path: string, name: string, body: unknown, key: string, signal: AbortSignal, owned: Owned): Promise<unknown> {
  if (typeof key !== 'string' || !UUID.test(key)) throw new ChadLeadPlanError('INVALID');
  let answer: { status: number; value: unknown };
  try { answer = await exchange(base(scope) + path, signal, owned, { name, body: JSON.stringify(body), key }); }
  catch (error) { if (error instanceof ChadLeadPlanError) throw error; throw new ChadLeadPlanError('UNKNOWN'); }
  if (answer.status !== 200) throw chadLeadPlanErrorFor(answer.status, codeOf(answer.value));
  try { return data(answer.value); } catch { throw new ChadLeadPlanError('UNKNOWN'); }
}
const checked = <T,>(f: () => T): T => { try { return f(); } catch { throw new ChadLeadPlanError('UNKNOWN'); } };

export const chadLeadPlanApi = {
  /** Whether this server has the paid text route configured, and your latest lead lists. */
  async list(scope: ChadLeadPlanScope, signal: AbortSignal, owned: Owned): Promise<ChadLeadPlanList> {
    let answer: { status: number; value: unknown };
    try { answer = await exchange(base(scope), signal, owned); }
    catch (error) { if (error instanceof ChadLeadPlanError || signal.aborted) throw error; throw new ChadLeadPlanError('UNKNOWN'); }
    if (answer.status !== 200) throw chadLeadPlanErrorFor(answer.status, codeOf(answer.value));
    return checked(() => {
      const v = data(answer.value);
      if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).sort().join(',') !== 'aiAvailable,leadPlans') throw new Error('shape');
      const o = v as { aiAvailable: unknown; leadPlans: unknown };
      if (typeof o.aiAvailable !== 'boolean') throw new Error('shape');
      return { aiAvailable: o.aiAvailable, leadPlans: verifyChadLeadPlanList(o.leadPlans) };
    });
  },
  async request(scope: ChadLeadPlanScope, brief: ChadLeadPlanBrief, key: string, signal: AbortSignal, owned: Owned): Promise<ChadLeadPlanView> {
    let body; try { body = validateChadLeadPlanBrief(brief); } catch { throw new ChadLeadPlanError('INVALID'); }
    const value = await post(scope, '', 'chad.lead_plan.request', body, key, signal, owned);
    return checked(() => verifyChadLeadPlanView(value));
  },
  /** Record the step the person's own command just made: the trial appointment id for a booking, or null for a stage move. */
  async step(scope: ChadLeadPlanScope, id: string, index: number, appointmentId: string | null, key: string, signal: AbortSignal, owned: Owned): Promise<ChadLeadPlanView> {
    if (!UUID.test(id) || !Number.isInteger(index) || index < 0 || index > 9) throw new ChadLeadPlanError('INVALID');
    let body; try { body = validateChadLeadPlanStep({ appointmentId: appointmentId === null ? null : appointmentId.toLowerCase() }); } catch { throw new ChadLeadPlanError('INVALID'); }
    const value = await post(scope, `/${id.toLowerCase()}/steps/${index}`, 'chad.lead_plan.step', body, key, signal, owned);
    return checked(() => {
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'leadPlan,replayed') throw new Error('shape');
      return verifyChadLeadPlanView((value as { leadPlan: unknown }).leadPlan);
    });
  },
  async dismiss(scope: ChadLeadPlanScope, id: string, key: string, signal: AbortSignal, owned: Owned): Promise<ChadLeadPlanView> {
    if (!UUID.test(id)) throw new ChadLeadPlanError('INVALID');
    const value = await post(scope, `/${id.toLowerCase()}/close`, 'chad.lead_plan.close', { status: 'DISMISSED' }, key, signal, owned);
    return checked(() => verifyChadLeadPlanView(value));
  },
};
export type ChadLeadPlanApi = typeof chadLeadPlanApi;
