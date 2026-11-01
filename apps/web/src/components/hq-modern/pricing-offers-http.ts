import {
  SAAS_COMMANDS, saasUuid,
  validateSaasHonOsOfferManagementView, validateSaasHonOsOfferSetDetail,
  validateSaasHonOsOfferSetDraftInput, validateSaasHonOsOfferSetReviseInput,
  validateSaasHonOsOfferSetDiscardInput, validateSaasHonOsOfferSetPublishInput, validateSaasHonOsOfferStopSalesInput,
  validateSaasHonOsOfferSetReceipt, validateSaasHonOsOfferSetDiscardReceipt,
  validateSaasHonOsOfferSetPublishReceipt, validateSaasHonOsOfferStopSalesReceipt,
  type SaasHonOsOffer, type SaasHonOsOfferInput, type SaasHonOsOfferSet, type SaasHonOsOfferManagementView,
  type SaasHonOsOfferSetDetail, type SaasHonOsOfferSetReceipt, type SaasHonOsOfferSetDiscardReceipt,
  type SaasHonOsOfferSetPublishReceipt, type SaasHonOsOfferStopSalesReceipt,
} from '@hon/contracts';
import { verifyHqOverviewSnapshot } from '../hq-overview-http';

export type PricingCommandKind = 'create' | 'revise' | 'discard' | 'publish' | 'stop';
export type PricingRequest = Readonly<{ kind: PricingCommandKind; target: string | null; subject: string; body: string; key: string }>;
export type PricingReceipt = { kind: 'create' | 'revise'; data: SaasHonOsOfferSetReceipt }
  | { kind: 'discard'; data: SaasHonOsOfferSetDiscardReceipt } | { kind: 'publish'; data: SaasHonOsOfferSetPublishReceipt }
  | { kind: 'stop'; data: SaasHonOsOfferStopSalesReceipt };
export type PricingAccess = { subject: string; owner: boolean; management: SaasHonOsOfferManagementView };
export class PricingError extends Error {
  constructor(readonly code: string, readonly status = 0, readonly uncertain = false) { super('HON pricing could not be verified.'); }
}
const root = '/api/v1/hq/saas/offers';
const options = { mode: 'same-origin', credentials: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer' } as const;
const validators = { create: validateSaasHonOsOfferSetDraftInput, revise: validateSaasHonOsOfferSetReviseInput,
  discard: validateSaasHonOsOfferSetDiscardInput, publish: validateSaasHonOsOfferSetPublishInput, stop: validateSaasHonOsOfferStopSalesInput };
const markers = { create: SAAS_COMMANDS.createOfferSetDraft, revise: SAAS_COMMANDS.reviseOfferSetDraft,
  discard: SAAS_COMMANDS.discardOfferSetDraft, publish: SAAS_COMMANDS.publishOfferSet, stop: SAAS_COMMANDS.stopOfferSales };
const codes = new Set(['SAAS_FORBIDDEN','SAAS_UNAVAILABLE','SAAS_VERSION_CONFLICT','SAAS_OFFER_SET_NOT_DRAFT','IDEMPOTENCY_KEY_REUSED',
  'SAAS_OFFER_PREVIEW_CHANGED','SAAS_OFFER_SET_NOT_READY','SAAS_OFFER_NOT_PUBLISHED','SAAS_OFFER_SALES_ALREADY_STOPPED','INVALID_SAAS_INPUT',
  'HUMAN_UI_REQUIRED','HUMAN_UI_ORIGIN_NOT_CONFIGURED','IDEMPOTENCY_IN_PROGRESS']);
const invalid = (): never => { throw new PricingError('INVALID_RESPONSE'); };
function closed(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(k => !Object.hasOwn(value,k))) invalid();
  return value as Record<string,unknown>;
}
async function exchange(path: string, request?: PricingRequest): Promise<unknown> {
  let response: Response;
  try { response = await fetch(path, { ...options, method: request ? 'POST' : 'GET', signal: AbortSignal.timeout(request ? 30_000 : 15_000),
    headers: { Accept: 'application/json', ...(request ? { 'Content-Type':'application/json', 'X-HON-Human-Command': markers[request.kind], 'Idempotency-Key':request.key } : {}) },
    ...(request ? { body:request.body } : {}) }); }
  catch { throw new PricingError(request ? 'UNKNOWN' : 'UNAVAILABLE', 0, !!request); }
  if (!response.ok) {
    let code = '';
    try { const raw = await response.text(); if (raw.length < 4000) { const v = JSON.parse(raw); if (typeof v?.code === 'string' && codes.has(v.code)) code = v.code; } } catch { /* Never expose private error bodies. */ }
    const uncertain = !!request && (![400,401,403,404,405,409,413,415,422].includes(response.status) || code === 'IDEMPOTENCY_IN_PROGRESS');
    throw new PricingError(response.status === 401 ? 'UNAUTHORIZED' : response.status === 403 ? 'FORBIDDEN' : code || (uncertain ? 'UNKNOWN' : 'UNAVAILABLE'), response.status, uncertain);
  }
  try {
    if (response.status !== 200 || response.redirected || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) invalid();
    // Existing identity/overview controllers have no SaaS cache header; requests still prohibit caching.
    if (!['/api/v1/identity/me','/api/v1/hq/overview'].includes(path) && !/(?:^|,)\s*no-store\s*(?:,|$)/i.test(response.headers.get('cache-control') ?? '')) invalid();
    const raw = await response.text(); if (raw.length > 2_000_000) invalid();
    return closed(JSON.parse(raw), ['data']).data;
  } catch { throw new PricingError(request ? 'UNKNOWN' : 'INVALID_RESPONSE', 0, !!request); }
}
export async function readPricingIdentity(): Promise<string> {
  const row = closed(await exchange('/api/v1/identity/me'), ['externalSubject']);
  if (typeof row.externalSubject !== 'string' || !row.externalSubject.length || row.externalSubject.length > 512 || /[\u0000-\u001f\u007f]/.test(row.externalSubject)) return invalid();
  return row.externalSubject;
}
/** Fresh session binding plus independent HQ billing authorization; role is only a conservative UI affordance. */
export async function readPricingAccess(expectedSubject?: string): Promise<PricingAccess> {
  const subject = await readPricingIdentity();
  if (expectedSubject && subject !== expectedSubject) throw new PricingError('IDENTITY_CHANGED',401);
  const [view, overview] = await Promise.all([exchange(root), exchange('/api/v1/hq/overview')]);
  let management: SaasHonOsOfferManagementView, owner: boolean;
  try { management = validateSaasHonOsOfferManagementView(view); owner = verifyHqOverviewSnapshot(closed(overview,['overview']).overview).callerHqRole === 'OWNER'; }
  catch { return invalid(); }
  if (await readPricingIdentity() !== subject) throw new PricingError('IDENTITY_CHANGED',401);
  return { subject, management, owner };
}
export async function readPricingSet(id: string): Promise<SaasHonOsOfferSetDetail> {
  const key = saasUuid(id); let result: SaasHonOsOfferSetDetail;
  try { result = validateSaasHonOsOfferSetDetail(await exchange(`${root}/sets/${key}`)); } catch (e) { if (e instanceof PricingError) throw e; return invalid(); }
  if (result.set.setId !== key) invalid();
  return result;
}
/** Presentation/preflight only. Live checkout counts are server facts, never browser expiry calculations. */
export function pricingCanStopOffer(management:SaasHonOsOfferManagementView|null,detail:SaasHonOsOfferSetDetail|null,offerId:string):boolean {
  const offer=detail?.set.offers.find(o=>o.offerId===offerId);
  if(!offer||offer.salesStop!==null||!management||!detail)return false;
  if(detail.set.status==='PUBLISHED')return management.published?.setId===detail.set.setId;
  return detail.set.status==='RETIRED'&&management.honOsSales.offers.some(row=>row.offerId===offerId&&row.setVersion===detail.set.setVersion&&row.openCheckouts>0);
}
export function pricingOfferInput(o: SaasHonOsOffer): SaasHonOsOfferInput {
  return { offerCode:o.offerCode, offerKind:o.offerKind, displayName:o.displayName, priceMinor:o.priceMinor,
    salesOpensAt:o.salesOpensAt, salesClosesAt:o.salesClosesAt, eligibility:o.eligibility, saleLimit:o.saleLimit,
    priceLock:o.priceLock, priceLockMonths:o.priceLockMonths, annualRenewal:o.annualRenewal,
    plannedMonthlyPremiumCredits:o.plannedMonthlyPremiumCredits, aiFairUseReference:o.aiFairUseReference,
    refundWindowDays:o.refundWindowDays, cancellationTiming:o.cancellationTiming };
}
export function preparePricingRequest(kind: PricingCommandKind, target: string | null, input: unknown, key: string, subject: string): PricingRequest {
  if (!Object.hasOwn(validators,kind) || !subject || (kind === 'create' ? target !== null : !target)) throw new PricingError('INVALID_SAAS_INPUT');
  return Object.freeze({ kind, target:target ? saasUuid(target) : null, body:JSON.stringify(validators[kind](input)), key:saasUuid(key), subject });
}
function contentMatches(set: SaasHonOsOfferSet, input: Record<string,unknown>): boolean {
  return set.termsReference === input.termsReference && set.founderTotalLimit === input.founderTotalLimit
    && JSON.stringify(set.offers.map(pricingOfferInput)) === JSON.stringify(input.offers);
}
/** Retries reuse the frozen body and key, even if the original already advanced the set. Never auto-resends. */
export async function sendPricingRequest(request: PricingRequest, retry = false): Promise<PricingReceipt> {
  closed(request,['kind','target','subject','body','key']);
  const canonical = preparePricingRequest(request.kind,request.target,JSON.parse(request.body),request.key,request.subject);
  if (canonical.body !== request.body || canonical.key !== request.key) throw new PricingError('INVALID_SAAS_INPUT');
  const access = await readPricingAccess(request.subject);
  if (!access.owner) throw new PricingError('FORBIDDEN',403);
  const input = JSON.parse(request.body);
  if (!retry && request.kind === 'stop' && request.target) {
    const published=access.management.published;
    const row=access.management.honOsSales.offers.find(o=>o.offerId===request.target);
    const summary=published?.offers.some(o=>o.offerId===request.target)?published:access.management.history.find(s=>s.setVersion===row?.setVersion&&s.status==='RETIRED');
    if(!summary)throw new PricingError('SAAS_UNAVAILABLE',404);
    const live=await readPricingSet(summary.setId);
    if(!pricingCanStopOffer(access.management,live,request.target))throw new PricingError(live.set.offers.some(o=>o.offerId===request.target&&o.salesStop!==null)?'SAAS_OFFER_SALES_ALREADY_STOPPED':'SAAS_OFFER_NOT_PUBLISHED',422);
  }
  if (!retry && request.target && request.kind !== 'stop') {
    const live = await readPricingSet(request.target);
    if (live.set.status !== 'DRAFT') throw new PricingError('SAAS_OFFER_SET_NOT_DRAFT',409);
    if (live.set.revision !== input.expectedRevision) throw new PricingError('SAAS_VERSION_CONFLICT',409);
    if (request.kind === 'publish' && live.preview.previewDigest !== input.previewDigest) throw new PricingError('SAAS_OFFER_PREVIEW_CHANGED',422);
    if (request.kind === 'publish' && !live.preview.ready) throw new PricingError('SAAS_OFFER_SET_NOT_READY',422);
  }
  if (await readPricingIdentity() !== request.subject) throw new PricingError('IDENTITY_CHANGED',401);
  const path = request.kind === 'create' ? `${root}/sets` : request.kind === 'stop' ? `${root}/${request.target}/stop-sales` : `${root}/sets/${request.target}/${request.kind}`;
  const data = await exchange(path,request);
  try {
    let receipt: PricingReceipt;
    if (request.kind === 'create' || request.kind === 'revise') {
      const value = validateSaasHonOsOfferSetReceipt(data);
      if (!contentMatches(value.set,input) || value.set.revision !== (request.kind === 'create' ? 1 : input.expectedRevision + 1)
        || (request.kind === 'create' ? value.set.basedOnSetId !== input.basedOnSetId : value.set.setId !== request.target)) invalid();
      receipt = { kind:request.kind, data:value };
    } else if (request.kind === 'publish') {
      const value = validateSaasHonOsOfferSetPublishReceipt(data);
      if (value.set.setId !== request.target || value.set.revision !== input.expectedRevision || value.set.approvedPreviewDigest !== input.previewDigest) invalid();
      receipt = { kind:'publish',data:value };
    } else if (request.kind === 'discard') {
      const value = validateSaasHonOsOfferSetDiscardReceipt(data);
      if (value.set.setId !== request.target || value.set.revision !== input.expectedRevision) invalid();
      receipt = { kind:'discard',data:value };
    } else {
      const value = validateSaasHonOsOfferStopSalesReceipt(data);
      if (value.offer.offerId !== request.target || value.offer.salesStop?.reasonCode !== input.reasonCode) invalid();
      receipt = { kind:'stop',data:value };
    }
    if (await readPricingIdentity() !== request.subject) throw new PricingError('IDENTITY_CHANGED',401,true);
    return receipt;
  } catch (e) { if (e instanceof PricingError && e.code === 'IDENTITY_CHANGED') throw e; throw new PricingError('UNKNOWN',0,true); }
}
export const pricingApi = { access:readPricingAccess, detail:readPricingSet, send:sendPricingRequest };
export type PricingApi = typeof pricingApi;
