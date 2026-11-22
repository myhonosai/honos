import {
  accountUuid, validateHqShopifyStoreRequestSettle, validateShopifyStoreRequestCancel, validateShopifyStoreRequestInput, verifyHqShopifyStoreRequest,
  verifyHqShopifyStoreRequests, verifyShopifyStoreRequestView, type HqShopifyStoreRequest, type HqShopifyStoreRequests, type ShopifyStoreRequestView,
} from '@hon/contracts';
import { ShopifyError, shopifyAnswer, type Owned } from './http';

/**
 * "Make my shop" (0655): a school with no Shopify store asks HON to make one, and HON HQ records what it did. Same transport
 * rules as the rest of the Shopify page. Nothing here reaches Shopify: HQ creates the store by hand in the Partner Dashboard.
 */
export type MakeShopErrorKind = 'SESSION' | 'DENIED' | 'INVALID' | 'OPEN' | 'DONE' | 'CONNECTED' | 'LIMIT' | 'STALE' | 'GONE' | 'UNKNOWN';
export class MakeShopError extends Error { constructor(readonly kind: MakeShopErrorKind) { super(kind); } }
const CODES: Readonly<Record<string, MakeShopErrorKind>> = {
  SHOPIFY_STORE_REQUEST_OPEN: 'OPEN', SHOPIFY_STORE_REQUEST_SETTLED: 'DONE', SHOPIFY_STORE_REQUEST_CONNECTED: 'CONNECTED',
  SHOPIFY_STORE_REQUEST_LIMIT: 'LIMIT', SHOPIFY_VERSION_CONFLICT: 'STALE', SHOPIFY_NOT_FOUND: 'GONE',
};
/** What a refused answer means here. Only exact answers are definitive; anything else is UNKNOWN. */
export function makeShopErrorFor(error: unknown): MakeShopError {
  if (error instanceof MakeShopError) return error;
  if (!(error instanceof ShopifyError)) return new MakeShopError('UNKNOWN');
  if (error.kind === 'SESSION' || error.kind === 'DENIED' || error.kind === 'INVALID') return new MakeShopError(error.kind);
  return new MakeShopError((error.code && CODES[error.code]) || 'UNKNOWN');
}
async function guarded<T>(work: () => Promise<T>): Promise<T> { try { return await work(); } catch (e) { if (e instanceof DOMException) throw e; throw makeShopErrorFor(e); } }
function school(id: string): string { try { return accountUuid(id).toLowerCase(); } catch { throw new MakeShopError('INVALID'); } }
function checked<T>(validate: (v: unknown) => T, v: unknown): T { try { return validate(v); } catch { throw new MakeShopError('INVALID'); } }
function same(out: ShopifyStoreRequestView, id: string): ShopifyStoreRequestView { if (out.schoolId.toLowerCase() !== id) throw new MakeShopError('UNKNOWN'); return out; }

export const makeShopApi = {
  read(schoolId: string, signal: AbortSignal, owned: Owned): Promise<ShopifyStoreRequestView> {
    return guarded(async () => { const id = school(schoolId); return same(await shopifyAnswer(`/api/v1/school/schools/${id}/shopify/store-request`, signal, owned, verifyShopifyStoreRequestView), id); });
  },
  ask(schoolId: string, shopName: string, ownerEmail: string, note: string | null, signal: AbortSignal, owned: Owned): Promise<ShopifyStoreRequestView> {
    return guarded(async () => {
      const body = checked(validateShopifyStoreRequestInput, { schoolId: school(schoolId), shopName, ownerEmail, note });
      const out = same(await shopifyAnswer('/api/v1/school/shopify/store-request', signal, owned, verifyShopifyStoreRequestView, JSON.stringify(body)), body.schoolId);
      if (out.request?.status !== 'REQUESTED') throw new MakeShopError('UNKNOWN');
      return out;
    });
  },
  cancel(schoolId: string, requestId: string, signal: AbortSignal, owned: Owned): Promise<ShopifyStoreRequestView> {
    return guarded(async () => {
      const body = checked(validateShopifyStoreRequestCancel, { schoolId: school(schoolId), requestId });
      const out = same(await shopifyAnswer('/api/v1/school/shopify/store-request/cancel', signal, owned, verifyShopifyStoreRequestView, JSON.stringify(body)), body.schoolId);
      if (out.request?.requestId !== body.requestId || out.request.status !== 'CANCELLED') throw new MakeShopError('UNKNOWN');
      return out;
    });
  },
};
export type MakeShopApi = typeof makeShopApi;

export const hqShopRequestsApi = {
  list(signal: AbortSignal, owned: Owned): Promise<HqShopifyStoreRequests> {
    return guarded(() => shopifyAnswer('/api/v1/hq/shopify/store-requests', signal, owned, verifyHqShopifyStoreRequests));
  },
  settle(requestId: string, expectedVersion: number, outcome: 'CREATED' | 'DECLINED', shopDomain: string | null, signal: AbortSignal, owned: Owned): Promise<HqShopifyStoreRequest> {
    return guarded(async () => {
      const body = checked(validateHqShopifyStoreRequestSettle, { requestId, expectedVersion, outcome, shopDomain });
      const out = await shopifyAnswer('/api/v1/hq/shopify/store-requests/settle', signal, owned, verifyHqShopifyStoreRequest, JSON.stringify(body));
      if (out.requestId !== body.requestId || out.status !== body.outcome) throw new MakeShopError('UNKNOWN');
      return out;
    });
  },
};
export type HqShopRequestsApi = typeof hqShopRequestsApi;
