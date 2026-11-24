import { HQ_PLAN_PROMOTION_COMMANDS, saasUuid, validateSchoolPlanPromotionEventReceipt, validateSchoolPlanPromotions,
  type SchoolPlanPromotionEventKind, type SchoolPlanPromotionEventReceipt, type SchoolPlanPromotions } from '@hon/contracts';

/**
 * School plan promotions (0308). The server decides which promotions this school's billing staff see: only live ones for
 * an offer on sale that the school may buy now. Staff without billing.hon.purchase get 403 and see nothing. Recording
 * seen / opened / dismissed never buys, reserves or switches anything; it is once per person and safe to repeat.
 */
export class SchoolPromotionError extends Error {
  constructor(readonly kind: 'DENIED' | 'UNAVAILABLE' | 'INVALID') { super(kind); }
}
const NO_STORE = /(?:^|,)\s*no-store\s*(?:,|$)/i, JSON_TYPE = /^application\/json(?:\s*;|$)/i;
async function exchange(path: string, init: RequestInit): Promise<unknown> {
  let response: Response;
  try { response = await fetch(path, { ...init, mode: 'same-origin', credentials: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer' }); }
  catch (error) { if (error instanceof Error && error.name === 'AbortError') throw error; throw new SchoolPromotionError('UNAVAILABLE'); }
  if (response.status === 401 || response.status === 403) throw new SchoolPromotionError('DENIED');
  if (response.status !== 200) throw new SchoolPromotionError('UNAVAILABLE');
  if (response.redirected || !NO_STORE.test(response.headers.get('Cache-Control') ?? '') || !JSON_TYPE.test(response.headers.get('Content-Type') ?? '')) throw new SchoolPromotionError('INVALID');
  if (response.url && (typeof location === 'undefined' || response.url !== new URL(path, location.origin).href)) throw new SchoolPromotionError('INVALID');
  let body: unknown; try { body = await response.json(); } catch { throw new SchoolPromotionError('INVALID'); }
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 || !Object.hasOwn(body, 'data')) throw new SchoolPromotionError('INVALID');
  return (body as { data: unknown }).data;
}
const id = (v: string): string => { try { return saasUuid(v); } catch { throw new SchoolPromotionError('INVALID'); } };

export async function loadSchoolPlanPromotions(schoolId: string, signal?: AbortSignal): Promise<SchoolPlanPromotions> {
  const sid = id(schoolId);
  const data = await exchange(`/api/v1/schools/${sid}/plan-promotions`, { method: 'GET', headers: { Accept: 'application/json' }, ...(signal ? { signal } : {}) });
  let view: SchoolPlanPromotions;
  try { view = validateSchoolPlanPromotions(data); } catch { throw new SchoolPromotionError('INVALID'); }
  // An answer for another school is never shown.
  if (view.schoolId.toLowerCase() !== sid) throw new SchoolPromotionError('INVALID');
  return view;
}

/** keepalive lets "opened" reach the server while the page moves to the offer. */
export async function recordSchoolPlanPromotionEvent(schoolId: string, promotionId: string, kind: SchoolPlanPromotionEventKind): Promise<SchoolPlanPromotionEventReceipt> {
  const sid = id(schoolId), pid = id(promotionId);
  const data = await exchange(`/api/v1/schools/${sid}/plan-promotions/${pid}/events`, {
    method: 'POST', keepalive: true, body: JSON.stringify({ kind }),
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-HON-Human-Command': HQ_PLAN_PROMOTION_COMMANDS.schoolEvent },
  });
  let receipt: SchoolPlanPromotionEventReceipt;
  try { receipt = validateSchoolPlanPromotionEventReceipt(data); } catch { throw new SchoolPromotionError('INVALID'); }
  if (receipt.promotionId.toLowerCase() !== pid || receipt.kind !== kind) throw new SchoolPromotionError('INVALID');
  return receipt;
}

/** The subscription page link for a promotion's offer. The id is only a display hint; that page re-reads the school's offers. */
export function promotionOfferHref(offerId: string): string { return `/staff/subscription?offer=${id(offerId)}#hon-os-prices-title`; }
/** The ?offer= hint on the subscription page, if it is a well-formed id. Never more than a hint. */
export function offerHintFrom(search: string): string | null {
  const v = new URLSearchParams(search).get('offer');
  if (!v) return null;
  try { return saasUuid(v); } catch { return null; }
}
export const schoolPromotionsApi = { load: loadSchoolPlanPromotions, record: recordSchoolPlanPromotionEvent };
export type SchoolPromotionsApi = typeof schoolPromotionsApi;
