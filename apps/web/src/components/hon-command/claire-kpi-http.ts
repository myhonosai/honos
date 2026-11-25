import { validateClaireKpiBrief, verifyClaireKpiList, verifyClaireKpiView, type ClaireKpiBrief, type ClaireKpiView } from '@hon/contracts';
import { reportConfirmedSessionInvalidation } from '../session-invalidation';

/**
 * P4 (0643): Claire KPI report. The list is a plain same-origin GET; asking and dismissing each send their own
 * X-HON-Human-Command and an Idempotency-Key. The server decides every permission, the plan and the AI spend.
 */
export type ClaireKpiErrorKind =
  /** Session ended. */ 'SESSION'
  /** This person or school cannot use Claire KPI reports. Nothing was sent. */ | 'NO_ACCESS'
  /** AI help is paused or not available for this school now. Nothing was sent. */ | 'PAUSED'
  /** Already dismissed or not yours. Nothing changed. */ | 'GONE'
  /** Not accepted as written. Nothing was sent. */ | 'INVALID'
  /** The outcome is not known. Only the identical request (same key) may be sent again. */ | 'UNKNOWN';
export class ClaireKpiError extends Error { constructor(readonly kind: ClaireKpiErrorKind) { super(kind); } }
export type ClaireKpiScope = Readonly<{ organizationId: string; schoolId: string }>;
export type Owned = () => boolean;
export type ClaireKpiList = Readonly<{ aiAvailable: boolean; reports: ClaireKpiView[] }>;

const JSON_TYPE = /^application\/json(?:\s*;|$)/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const codeOf = (v: unknown): string | null => v && typeof v === 'object' && !Array.isArray(v) && typeof (v as { code?: unknown }).code === 'string' ? (v as { code: string }).code : null;
const data = (v: unknown): unknown => { if (!v || typeof v !== 'object' || Array.isArray(v) || !Object.hasOwn(v, 'data')) throw new Error('shape'); return (v as { data: unknown }).data; };

export function claireKpiErrorFor(status: number, code: string | null): ClaireKpiError {
  if (status === 403 && code === 'CLAIRE_KPI_SPEND_STOPPED') return new ClaireKpiError('PAUSED');
  if (status === 403) return new ClaireKpiError('NO_ACCESS');
  if (status === 404) return new ClaireKpiError('GONE');
  if (status === 400) return new ClaireKpiError('INVALID');
  if (status === 409 && code === 'CLAIRE_KPI_NOT_OPEN') return new ClaireKpiError('GONE');
  if (status === 409 && (code === 'IDEMPOTENCY_KEY_REUSED' || code === 'IDEMPOTENCY_KEY_REQUIRED')) return new ClaireKpiError('INVALID');
  return new ClaireKpiError('UNKNOWN');
}

function base(scope: ClaireKpiScope): string {
  if (!UUID.test(scope.organizationId) || !UUID.test(scope.schoolId)) throw new ClaireKpiError('INVALID');
  return `/api/v1/organizations/${scope.organizationId.toLowerCase()}/schools/${scope.schoolId.toLowerCase()}/claire/kpi-reports`;
}
async function exchange(path: string, signal: AbortSignal, owned: Owned, command?: Readonly<{ name: string; body: string; key: string }>): Promise<{ status: number; value: unknown }> {
  const r = await fetch(path, { method: command ? 'POST' : 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', signal,
    headers: { Accept: 'application/json', ...(command ? { 'Content-Type': 'application/json', 'X-HON-Human-Command': command.name, 'Idempotency-Key': command.key } : {}) },
    ...(command ? { body: command.body } : {}) });
  signal.throwIfAborted();
  if (r.status === 401) { if (owned()) reportConfirmedSessionInvalidation(); throw new ClaireKpiError('SESSION'); }
  if (r.redirected || !JSON_TYPE.test(r.headers.get('content-type') ?? '')) return { status: r.status, value: null };
  const text = await r.text();
  if (text.length > 1_000_000) throw new ClaireKpiError('UNKNOWN');
  try { return { status: r.status, value: JSON.parse(text) as unknown }; } catch { return { status: r.status, value: null }; }
}
async function post(scope: ClaireKpiScope, path: string, name: string, body: unknown, key: string, signal: AbortSignal, owned: Owned): Promise<unknown> {
  if (typeof key !== 'string' || !UUID.test(key)) throw new ClaireKpiError('INVALID');
  let answer: { status: number; value: unknown };
  try { answer = await exchange(base(scope) + path, signal, owned, { name, body: JSON.stringify(body), key }); }
  catch (error) { if (error instanceof ClaireKpiError) throw error; throw new ClaireKpiError('UNKNOWN'); }
  if (answer.status !== 200) throw claireKpiErrorFor(answer.status, codeOf(answer.value));
  try { return data(answer.value); } catch { throw new ClaireKpiError('UNKNOWN'); }
}
const checked = <T,>(f: () => T): T => { try { return f(); } catch { throw new ClaireKpiError('UNKNOWN'); } };

export const claireKpiApi = {
  /** Whether this server has the paid text route configured, and the person's latest KPI reports. */
  async list(scope: ClaireKpiScope, signal: AbortSignal, owned: Owned): Promise<ClaireKpiList> {
    let answer: { status: number; value: unknown };
    try { answer = await exchange(base(scope), signal, owned); }
    catch (error) { if (error instanceof ClaireKpiError || signal.aborted) throw error; throw new ClaireKpiError('UNKNOWN'); }
    if (answer.status !== 200) throw claireKpiErrorFor(answer.status, codeOf(answer.value));
    return checked(() => {
      const v = data(answer.value);
      if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).sort().join(',') !== 'aiAvailable,reports') throw new Error('shape');
      const o = v as { aiAvailable: unknown; reports: unknown };
      if (typeof o.aiAvailable !== 'boolean') throw new Error('shape');
      return { aiAvailable: o.aiAvailable, reports: verifyClaireKpiList(o.reports) };
    });
  },
  async request(scope: ClaireKpiScope, brief: ClaireKpiBrief, key: string, signal: AbortSignal, owned: Owned): Promise<ClaireKpiView> {
    let body; try { body = validateClaireKpiBrief(brief); } catch { throw new ClaireKpiError('INVALID'); }
    const value = await post(scope, '', 'claire.kpi_report.request', body, key, signal, owned);
    return checked(() => verifyClaireKpiView(value));
  },
  async dismiss(scope: ClaireKpiScope, id: string, key: string, signal: AbortSignal, owned: Owned): Promise<ClaireKpiView> {
    if (!UUID.test(id)) throw new ClaireKpiError('INVALID');
    const value = await post(scope, `/${id.toLowerCase()}/close`, 'claire.kpi_report.close', { status: 'DISMISSED' }, key, signal, owned);
    return checked(() => verifyClaireKpiView(value));
  },
};
export type ClaireKpiApi = typeof claireKpiApi;
