import { HQ_PLAN_PROMOTION_COMMANDS, encodeHqPlanPromotionCursor, saasUuid, validateHqPlanPromotionCreateInput, validateHqPlanPromotionDetail,
  validateHqPlanPromotionList, validateHqPlanPromotionReceipt, validateHqPlanPromotionStatusInput, validateHqPlanPromotionUpdateInput,
  type HqPlanPromotionCreateInput, type HqPlanPromotionCursor, type HqPlanPromotionDetail, type HqPlanPromotionList, type HqPlanPromotionListFilter,
  type HqPlanPromotionReceipt, type HqPlanPromotionStatusInput, type HqPlanPromotionUpdateInput } from '@hon/contracts';
import { MarketingError, marketingExchange, marketingRead, type Owned } from '../hq-marketing/http';

/**
 * HQ plan promotions (0308). Same transport rules as HQ marketing: same-origin GET reads with the declared query only,
 * commands with the human-command marker, JSON and an Idempotency-Key. The database decides every time who may read or
 * write; only an HQ owner can change a promotion. In-app only: nothing here sends an email or text.
 */
export { MarketingError as PromotionError };
const CHANGED = new Set(['SAAS_VERSION_CONFLICT', 'HQ_PLAN_PROMOTION_PREVIEW_STALE', 'HQ_PLAN_PROMOTION_ENDED', 'HQ_PLAN_PROMOTION_NOT_DRAFT']);
const REFUSED = new Set(['HQ_PLAN_PROMOTION_CODE_TAKEN', 'HQ_PLAN_PROMOTION_NO_CHANGE', 'HQ_PLAN_PROMOTION_STATUS_NOT_ALLOWED',
  'HQ_PLAN_PROMOTION_OFFER_NOT_ON_SALE', 'HQ_PLAN_PROMOTION_WINDOW_ENDED']);
const codeOf = (v: unknown): string | null => v && typeof v === 'object' && !Array.isArray(v) && typeof (v as { code?: unknown }).code === 'string' ? (v as { code: string }).code : null;
/** What a refused command means. Only these exact answers are definitive; anything else is UNKNOWN. */
export function promotionCommandError(status: number, code: string | null): MarketingError {
  if (status === 403) return new MarketingError('DENIED', code);
  if (status === 400) return new MarketingError('INVALID', code);
  if (status === 404 && code === 'SAAS_UNAVAILABLE') return new MarketingError('GONE', code);
  if ((status === 409 || status === 422) && code !== null && CHANGED.has(code)) return new MarketingError('CHANGED', code);
  if (status === 422 && code !== null && REFUSED.has(code)) return new MarketingError('REFUSED', code);
  if (status === 409 && code === 'IDEMPOTENCY_KEY_REUSED') return new MarketingError('KEY_REUSED', code);
  return new MarketingError('UNKNOWN', code);
}
export function promotionId(value: unknown): string | null { try { return saasUuid(value); } catch { return null; } }
async function command(path: string, marker: string, body: object, key: string, signal: AbortSignal, owned: Owned): Promise<HqPlanPromotionReceipt> {
  const k = saasUuid(key);
  const answer = await marketingExchange(path, signal, owned, { marker, body: JSON.stringify(body), key: k });
  if (answer.status !== 200) throw promotionCommandError(answer.status, codeOf(answer.value));
  const v = answer.value;
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).length !== 1 || !Object.hasOwn(v, 'data')) throw new MarketingError('UNKNOWN');
  try { return validateHqPlanPromotionReceipt((v as { data: unknown }).data); } catch { throw new MarketingError('UNKNOWN'); }
}
const CONTENT = ['headline', 'body', 'buttonLabel', 'audience', 'startsAt', 'endsAt', 'marketingCampaignId'] as const;
const sameContent = (p: Record<string, unknown> & { offer: { offerId: string }; schoolIds: string[] }, b: HqPlanPromotionCreateInput | HqPlanPromotionUpdateInput) =>
  CONTENT.every(k => p[k] === b[k]) && p.offer.offerId === b.offerId && p.schoolIds.join() === [...b.schoolIds].sort().join();

export type PromotionListRequest = Readonly<{ status: HqPlanPromotionListFilter | null; cursor: HqPlanPromotionCursor | null }>;
export const PROMOTION_PAGE_SIZE = 25;
export const promotionsApi = {
  async list(request: PromotionListRequest, signal: AbortSignal, owned: Owned): Promise<HqPlanPromotionList> {
    const q = new URLSearchParams();
    if (request.status) q.set('status', request.status);
    if (request.cursor) q.set('cursor', encodeHqPlanPromotionCursor(request.cursor));
    q.set('limit', String(PROMOTION_PAGE_SIZE));
    const view = await marketingRead(`/api/v1/hq/plan-promotions?${q}`, signal, owned, validateHqPlanPromotionList);
    const fits = (s: string) => !request.status || (request.status === 'OPEN' ? s !== 'ENDED' : s === request.status);
    if (view.limit !== PROMOTION_PAGE_SIZE || view.promotions.some(p => !fits(p.status))) throw new MarketingError('UNKNOWN');
    return view;
  },
  async read(id: string, signal: AbortSignal, owned: Owned): Promise<HqPlanPromotionDetail> {
    const pid = promotionId(id);
    if (!pid) throw new MarketingError('INVALID');
    const view = await marketingRead(`/api/v1/hq/plan-promotions/${pid}`, signal, owned, validateHqPlanPromotionDetail);
    if (view.promotion.promotionId.toLowerCase() !== pid) throw new MarketingError('UNKNOWN');
    return view;
  },
  async create(input: HqPlanPromotionCreateInput, key: string, signal: AbortSignal, owned: Owned): Promise<HqPlanPromotionReceipt> {
    let body: HqPlanPromotionCreateInput;
    try { body = validateHqPlanPromotionCreateInput(input); } catch { throw new MarketingError('INVALID'); }
    const r = await command('/api/v1/hq/plan-promotions', HQ_PLAN_PROMOTION_COMMANDS.create, body, key, signal, owned), p = r.promotion;
    if (r.operation !== 'CREATE' || p.code !== body.code || p.status !== 'DRAFT' || !sameContent(p as never, body)) throw new MarketingError('UNKNOWN');
    return r;
  },
  async update(id: string, input: HqPlanPromotionUpdateInput, key: string, signal: AbortSignal, owned: Owned): Promise<HqPlanPromotionReceipt> {
    const pid = promotionId(id);
    let body: HqPlanPromotionUpdateInput;
    try { if (!pid) throw new Error('id'); body = validateHqPlanPromotionUpdateInput(input); } catch { throw new MarketingError('INVALID'); }
    const r = await command(`/api/v1/hq/plan-promotions/${pid}/versions`, HQ_PLAN_PROMOTION_COMMANDS.update, body, key, signal, owned), p = r.promotion;
    if (r.operation !== 'UPDATE' || p.promotionId.toLowerCase() !== pid || p.version !== body.expectedVersion + 1 || !sameContent(p as never, body)) throw new MarketingError('UNKNOWN');
    return r;
  },
  async status(id: string, input: HqPlanPromotionStatusInput, key: string, signal: AbortSignal, owned: Owned): Promise<HqPlanPromotionReceipt> {
    const pid = promotionId(id);
    let body: HqPlanPromotionStatusInput;
    try { if (!pid) throw new Error('id'); body = validateHqPlanPromotionStatusInput(input); } catch { throw new MarketingError('INVALID'); }
    const r = await command(`/api/v1/hq/plan-promotions/${pid}/status`, HQ_PLAN_PROMOTION_COMMANDS.status, body, key, signal, owned), p = r.promotion;
    if (r.operation !== 'STATUS' || p.promotionId.toLowerCase() !== pid || p.version !== body.expectedVersion + 1 || p.status !== body.status
      || (body.previewDigest !== null && p.approvedDigest !== body.previewDigest)) throw new MarketingError('UNKNOWN');
    return r;
  },
};
export type PromotionsApi = typeof promotionsApi;
