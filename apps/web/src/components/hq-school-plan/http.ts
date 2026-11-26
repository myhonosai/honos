import { HQ_SCHOOL_PLAN_COMMANDS, saasUuid, validateHqSchoolPlanAssignInput, validateHqSchoolPlanReceipt, validateHqSchoolPlanRemoveInput,
  validateHqSchoolPlanView, type HqSchoolPlanAssignInput, type HqSchoolPlanReceipt, type HqSchoolPlanRemoveInput, type HqSchoolPlanView } from '@hon/contracts';
import { MarketingError, marketingExchange, marketingRead, type Owned } from '../hq-marketing/http';

/**
 * HQ school plan (0676). Same transport rules as the other HQ SaaS screens: same-origin GET reads, commands with the
 * human-command marker, JSON and an Idempotency-Key. The database decides every time who may read or change a plan; only
 * an HQ owner can change one. Records only: nothing here charges or opens a checkout.
 */
export { MarketingError as PlanError, type Owned };
const CHANGED = new Set(['SAAS_VERSION_CONFLICT']);
const REFUSED = new Set(['HQ_SCHOOL_PLAN_OFFER_NOT_AVAILABLE', 'HQ_SCHOOL_PLAN_NO_CHANGE', 'HQ_SCHOOL_PLAN_NONE', 'HQ_SCHOOL_PLAN_SCHOOL_ARCHIVED',
  'HQ_SCHOOL_PLAN_FREE_END_INVALID', 'HQ_SCHOOL_PLAN_END_DATE_ONLY_WHEN_FREE']);
const codeOf = (v: unknown): string | null => v && typeof v === 'object' && !Array.isArray(v) && typeof (v as { code?: unknown }).code === 'string' ? (v as { code: string }).code : null;
/** What a refused command means. Only these exact answers are definitive; anything else is UNKNOWN (retry with the same key). */
export function planCommandError(status: number, code: string | null): MarketingError {
  if (status === 403) return new MarketingError('DENIED', code);
  if (status === 400) return new MarketingError('INVALID', code);
  if (status === 404 && code === 'SAAS_UNAVAILABLE') return new MarketingError('GONE', code);
  if (status === 409 && code !== null && CHANGED.has(code)) return new MarketingError('CHANGED', code);
  if (status === 422 && code !== null && REFUSED.has(code)) return new MarketingError('REFUSED', code);
  if (status === 409 && code === 'IDEMPOTENCY_KEY_REUSED') return new MarketingError('KEY_REUSED', code);
  return new MarketingError('UNKNOWN', code);
}
export function planSchoolId(value: unknown): string | null { try { return saasUuid(value); } catch { return null; } }
async function command(path: string, marker: string, body: object, key: string, signal: AbortSignal, owned: Owned): Promise<HqSchoolPlanReceipt> {
  const answer = await marketingExchange(path, signal, owned, { marker, body: JSON.stringify(body), key: saasUuid(key) });
  if (answer.status !== 200) throw planCommandError(answer.status, codeOf(answer.value));
  const v = answer.value;
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).length !== 1 || !Object.hasOwn(v, 'data')) throw new MarketingError('UNKNOWN');
  try { return validateHqSchoolPlanReceipt((v as { data: unknown }).data); } catch { throw new MarketingError('UNKNOWN'); }
}
export const schoolPlanApi = {
  async read(schoolId: string, signal: AbortSignal, owned: Owned): Promise<HqSchoolPlanView> {
    const id = planSchoolId(schoolId);
    if (!id) throw new MarketingError('INVALID');
    const view = await marketingRead(`/api/v1/hq/schools/${id}/plan`, signal, owned, validateHqSchoolPlanView);
    if (view.schoolId.toLowerCase() !== id) throw new MarketingError('UNKNOWN');
    return view;
  },
  async assign(schoolId: string, input: HqSchoolPlanAssignInput, key: string, signal: AbortSignal, owned: Owned): Promise<HqSchoolPlanReceipt> {
    const id = planSchoolId(schoolId);
    let body: HqSchoolPlanAssignInput;
    try { if (!id) throw new Error('id'); body = validateHqSchoolPlanAssignInput(input); } catch { throw new MarketingError('INVALID'); }
    const r = await command(`/api/v1/hq/schools/${id}/plan/assign`, HQ_SCHOOL_PLAN_COMMANDS.assign, body, key, signal, owned);
    if (r.operation !== 'ASSIGN' || r.schoolId.toLowerCase() !== id || r.assignment.revision !== body.expectedRevision + 1) throw new MarketingError('UNKNOWN');
    return r;
  },
  async remove(schoolId: string, input: HqSchoolPlanRemoveInput, key: string, signal: AbortSignal, owned: Owned): Promise<HqSchoolPlanReceipt> {
    const id = planSchoolId(schoolId);
    let body: HqSchoolPlanRemoveInput;
    try { if (!id) throw new Error('id'); body = validateHqSchoolPlanRemoveInput(input); } catch { throw new MarketingError('INVALID'); }
    const r = await command(`/api/v1/hq/schools/${id}/plan/remove`, HQ_SCHOOL_PLAN_COMMANDS.remove, body, key, signal, owned);
    if (r.operation !== 'REMOVE' || r.schoolId.toLowerCase() !== id || r.assignment.revision !== body.expectedRevision + 1) throw new MarketingError('UNKNOWN');
    return r;
  },
};
export type SchoolPlanApi = typeof schoolPlanApi;
