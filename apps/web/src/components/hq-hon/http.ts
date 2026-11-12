import { SAAS_COMMANDS, validateHqHonAskInput, validateHqHonConversation, validateHqHonTurnReceipt,
  type HqHonAskInput, type HqHonConversation, type HqHonTurnReceipt } from '@hon/contracts';
import { MarketingError, marketingExchange, marketingRead, type Owned } from '../hq-marketing/http';
import { saasUuid } from '@hon/contracts';

/**
 * HQ Ask HON (0263) and the six HQ executives (0264). Same transport rules as the other HQ screens: same origin, no-store
 * reads, the human-command marker and an Idempotency-Key on every question. The database decides who may ask whom, the
 * budget and every rule; the server chooses the provider. With none connected a question is refused before anything is
 * reserved.
 */
const REFUSED = new Set(['HQ_HON_PAUSED_BY_HQ', 'HQ_HON_NO_ELIGIBLE_ROUTE', 'HQ_HON_BUDGET_NOT_SET', 'HQ_HON_TOO_MANY_IN_PROGRESS',
  'HQ_HON_BUDGET_EXHAUSTED', 'HQ_HON_PROVIDER_NOT_CONNECTED']);
const codeOf = (v: unknown): string | null =>
  v && typeof v === 'object' && !Array.isArray(v) && typeof (v as { code?: unknown }).code === 'string' ? (v as { code: string }).code : null;

/** What a refused question means. Only these exact answers are definitive; anything else is UNKNOWN (it may have been asked). */
export function hqHonAskError(status: number, code: string | null): MarketingError {
  if (status === 403) return new MarketingError('DENIED', code);
  if (status === 400) return new MarketingError('INVALID', code);
  if ((status === 422 || status === 503) && code !== null && REFUSED.has(code)) return new MarketingError('REFUSED', code);
  if (status === 409 && code === 'HQ_HON_TURN_IN_PROGRESS') return new MarketingError('CHANGED', code);
  if (status === 409 && code === 'IDEMPOTENCY_KEY_REUSED') return new MarketingError('KEY_REUSED', code);
  return new MarketingError('UNKNOWN', code);
}

export const hqHonApi = {
  conversation(signal: AbortSignal, owned: Owned): Promise<HqHonConversation> {
    return marketingRead('/api/v1/hq/hon', signal, owned, validateHqHonConversation);
  },
  /** One attempt. The same key and body replay the saved turn and never call the provider again. */
  async ask(input: HqHonAskInput, key: string, signal: AbortSignal, owned: Owned): Promise<HqHonTurnReceipt> {
    let body: HqHonAskInput;
    try { body = validateHqHonAskInput(input); } catch { throw new MarketingError('INVALID'); }
    const k = saasUuid(key);
    const answer = await marketingExchange('/api/v1/hq/hon/turns', signal, owned, { marker: SAAS_COMMANDS.askHqHon, body: JSON.stringify(body), key: k });
    if (answer.status !== 200) throw hqHonAskError(answer.status, codeOf(answer.value));
    let r: HqHonTurnReceipt;
    try {
      const v = answer.value as { data?: unknown } | null;
      if (!v || typeof v !== 'object' || Object.keys(v).length !== 1) throw new Error('shape');
      r = validateHqHonTurnReceipt(v.data);
    } catch { throw new MarketingError('UNKNOWN'); }
    if (r.turn.question !== body.question || r.turn.agentKey !== body.agentKey || r.turn.replyMode !== body.replyMode) throw new MarketingError('UNKNOWN');
    return r;
  },
};
export type HqHonApi = typeof hqHonApi;
