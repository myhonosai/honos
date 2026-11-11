import { HQ_MARKETING_COMMANDS, encodeHqMarketingCursor, saasUuid, validateHqMarketingCampaignDetail, validateHqMarketingCampaignList,
  validateHqMarketingCreateInput, validateHqMarketingReceipt, validateHqMarketingStatusInput, validateHqMarketingUpdateInput,
  type HqMarketingCampaignDetail, type HqMarketingCampaignList, type HqMarketingCreateInput, type HqMarketingCursor, type HqMarketingListFilter,
  type HqMarketingReceipt, type HqMarketingStatusInput, type HqMarketingUpdateInput } from '@hon/contracts';
import { reportConfirmedSessionInvalidation } from '../session-invalidation';

/**
 * HQ marketing campaigns (M1, 0252). Reads go through the SaaS read guard (same origin, GET, declared query only, no-store);
 * commands through the SaaS command guard (same origin, human-command marker, JSON, Idempotency-Key). The database decides
 * every time who may read or write. Planning only: nothing here reaches Google, Meta or any ad provider.
 */
export type MarketingErrorKind = 'SESSION' | 'DENIED' | 'GONE' | 'INVALID' | 'CHANGED' | 'REFUSED' | 'KEY_REUSED' | 'UNKNOWN';
export class MarketingError extends Error {
  constructor(readonly kind: MarketingErrorKind, readonly code: string | null = null) { super(kind); }
}
/** Whether the caller still stands behind this request. A 401 for a retired request must not end a newer session. */
export type Owned = () => boolean;
const RESPONSE_MAX = 2_000_000;
const JSON_TYPE = /^application\/json(?:\s*;|$)/i;
const CHANGED = new Set(['SAAS_VERSION_CONFLICT', 'HQ_CAMPAIGN_ARCHIVED']);
const REFUSED = new Set(['HQ_CAMPAIGN_CODE_TAKEN', 'HQ_CAMPAIGN_NO_CHANGE', 'HQ_CAMPAIGN_STATUS_NOT_ALLOWED']);

export function marketingCampaignId(value: unknown): string | null {
  try { return saasUuid(value); } catch { return null; }
}

async function exchange(path: string, signal: AbortSignal, owned: Owned, command?: Readonly<{ marker: string; body: string; key: string }>): Promise<{ status: number; value: unknown }> {
  let r: Response;
  try {
    r = await fetch(path, { method: command ? 'POST' : 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error',
      referrerPolicy: 'no-referrer', signal,
      headers: { Accept: 'application/json', ...(command ? { 'Content-Type': 'application/json', 'X-HON-Human-Command': command.marker, 'Idempotency-Key': command.key } : {}) },
      ...(command ? { body: command.body } : {}) });
  } catch (error) { if (signal.aborted && !command) throw error; throw new MarketingError('UNKNOWN'); }
  if (signal.aborted) { if (command) throw new MarketingError('UNKNOWN'); signal.throwIfAborted(); }
  if (r.status === 401) { if (owned()) reportConfirmedSessionInvalidation(); throw new MarketingError('SESSION'); }
  if (r.redirected || !JSON_TYPE.test(r.headers.get('content-type') ?? '')) return { status: r.status, value: null };
  const text = await r.text();
  if (text.length > RESPONSE_MAX) throw new MarketingError('UNKNOWN');
  try { return { status: r.status, value: JSON.parse(text) as unknown }; } catch { return { status: r.status, value: null }; }
}
const codeOf = (v: unknown): string | null => v && typeof v === 'object' && !Array.isArray(v) && typeof (v as { code?: unknown }).code === 'string' ? (v as { code: string }).code : null;
function data(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 || !Object.hasOwn(value, 'data')) throw new Error('shape');
  return (value as { data: unknown }).data;
}
function readError(status: number, code: string | null): MarketingError {
  if (status === 403) return new MarketingError('DENIED', code);
  if (status === 404 && code === 'SAAS_UNAVAILABLE') return new MarketingError('GONE', code);
  if (status === 400) return new MarketingError('INVALID', code);
  return new MarketingError('UNKNOWN', code);
}
/** What a refused command means. Only these exact answers are definitive; anything else is UNKNOWN. */
export function marketingCommandError(status: number, code: string | null): MarketingError {
  if (status === 403) return new MarketingError('DENIED', code);
  if (status === 400) return new MarketingError('INVALID', code);
  if (status === 404 && code === 'SAAS_UNAVAILABLE') return new MarketingError('GONE', code);
  if ((status === 409 || status === 422) && code !== null && CHANGED.has(code)) return new MarketingError('CHANGED', code);
  if (status === 422 && code !== null && REFUSED.has(code)) return new MarketingError('REFUSED', code);
  if (status === 409 && code === 'IDEMPOTENCY_KEY_REUSED') return new MarketingError('KEY_REUSED', code);
  return new MarketingError('UNKNOWN', code);
}
async function read<T>(path: string, signal: AbortSignal, owned: Owned, validate: (v: unknown) => T): Promise<T> {
  const { status, value } = await exchange(path, signal, owned);
  if (status !== 200) throw readError(status, codeOf(value));
  try { return validate(data(value)); } catch { throw new MarketingError('UNKNOWN'); }
}
async function command(path: string, marker: string, body: object, key: string, signal: AbortSignal, owned: Owned): Promise<HqMarketingReceipt> {
  const k = saasUuid(key);
  const answer = await exchange(path, signal, owned, { marker, body: JSON.stringify(body), key: k });
  if (answer.status !== 200) throw marketingCommandError(answer.status, codeOf(answer.value));
  try { return validateHqMarketingReceipt(data(answer.value)); } catch { throw new MarketingError('UNKNOWN'); }
}
const PLAN = ['name', 'goal', 'audience', 'offerLabel', 'channel', 'startsOn', 'endsOn', 'plannedBudgetMinor'] as const;
const samePlan = (a: Record<string, unknown>, b: Record<string, unknown>) => PLAN.every(k => a[k] === b[k]);

export type MarketingListRequest = Readonly<{ status: HqMarketingListFilter | null; cursor: HqMarketingCursor | null }>;
export const MARKETING_PAGE_SIZE = 25;
export const marketingApi = {
  async list(request: MarketingListRequest, signal: AbortSignal, owned: Owned): Promise<HqMarketingCampaignList> {
    const q = new URLSearchParams();
    if (request.status) q.set('status', request.status);
    if (request.cursor) q.set('cursor', encodeHqMarketingCursor(request.cursor));
    q.set('limit', String(MARKETING_PAGE_SIZE));
    const view = await read(`/api/v1/hq/marketing/campaigns?${q}`, signal, owned, validateHqMarketingCampaignList);
    const fits = (s: string) => !request.status || (request.status === 'OPEN' ? s !== 'ARCHIVED' : s === request.status);
    if (view.limit !== MARKETING_PAGE_SIZE || view.campaigns.some(c => !fits(c.status))) throw new MarketingError('UNKNOWN');
    return view;
  },
  async read(campaignId: string, signal: AbortSignal, owned: Owned): Promise<HqMarketingCampaignDetail> {
    const id = marketingCampaignId(campaignId);
    if (!id) throw new MarketingError('INVALID');
    const view = await read(`/api/v1/hq/marketing/campaigns/${id}`, signal, owned, validateHqMarketingCampaignDetail);
    if (view.campaign.campaignId.toLowerCase() !== id) throw new MarketingError('UNKNOWN');
    return view;
  },
  /** One create attempt. The same key and body replay the saved answer. */
  async create(input: HqMarketingCreateInput, key: string, signal: AbortSignal, owned: Owned): Promise<HqMarketingReceipt> {
    let body: HqMarketingCreateInput;
    try { body = validateHqMarketingCreateInput(input); } catch { throw new MarketingError('INVALID'); }
    const receipt = await command('/api/v1/hq/marketing/campaigns', HQ_MARKETING_COMMANDS.create, body, key, signal, owned), c = receipt.campaign;
    if (receipt.operation !== 'CREATE' || c.code !== body.code || c.status !== 'DRAFT' || !samePlan(c as never, body as never)) throw new MarketingError('UNKNOWN');
    return receipt;
  },
  async update(campaignId: string, input: HqMarketingUpdateInput, key: string, signal: AbortSignal, owned: Owned): Promise<HqMarketingReceipt> {
    const id = marketingCampaignId(campaignId);
    let body: HqMarketingUpdateInput;
    try { if (!id) throw new Error('id'); body = validateHqMarketingUpdateInput(input); } catch { throw new MarketingError('INVALID'); }
    const receipt = await command(`/api/v1/hq/marketing/campaigns/${id}/versions`, HQ_MARKETING_COMMANDS.update, body, key, signal, owned), c = receipt.campaign;
    if (receipt.operation !== 'UPDATE' || c.campaignId.toLowerCase() !== id || c.version !== body.expectedVersion + 1 || !samePlan(c as never, body as never)) throw new MarketingError('UNKNOWN');
    return receipt;
  },
  async status(campaignId: string, input: HqMarketingStatusInput, key: string, signal: AbortSignal, owned: Owned): Promise<HqMarketingReceipt> {
    const id = marketingCampaignId(campaignId);
    let body: HqMarketingStatusInput;
    try { if (!id) throw new Error('id'); body = validateHqMarketingStatusInput(input); } catch { throw new MarketingError('INVALID'); }
    const receipt = await command(`/api/v1/hq/marketing/campaigns/${id}/status`, HQ_MARKETING_COMMANDS.status, body, key, signal, owned), c = receipt.campaign;
    if (receipt.operation !== 'STATUS' || c.campaignId.toLowerCase() !== id || c.version !== body.expectedVersion + 1 || c.status !== body.status) throw new MarketingError('UNKNOWN');
    return receipt;
  },
};
export type MarketingApi = typeof marketingApi;
