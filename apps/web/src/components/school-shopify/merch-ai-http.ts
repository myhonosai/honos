import { validateMerchAiBrief, verifyMerchAiList, verifyMerchAiView, type MerchAiBrief, type MerchAiView } from '@hon/contracts';
import { reportConfirmedSessionInvalidation } from '../session-invalidation';

/**
 * CS-M2 (0566): merch ideas from Marcus. The list is a plain same-origin GET; asking, using and dismissing each send their
 * own X-HON-Human-Command and an Idempotency-Key. The server decides every permission, the plan and the AI spend.
 */
export type MerchAiErrorKind =
  /** Session ended. */ 'SESSION'
  /** This person or school cannot ask Marcus (Shopify management, Marcus and an active Complete plan). Nothing was sent. */ | 'NO_ACCESS'
  /** AI help is paused or not available for this school now. Nothing was sent. */ | 'PAUSED'
  /** The store is not connected. Nothing was sent. */ | 'NOT_CONNECTED'
  /** Already used, dismissed or not yours. Nothing changed. */ | 'GONE'
  /** Not accepted as written. Nothing was sent. */ | 'INVALID'
  /** The outcome is not known. Only the identical request (same key) may be sent again. */ | 'UNKNOWN';
export class MerchAiError extends Error { constructor(readonly kind: MerchAiErrorKind) { super(kind); } }
export type MerchAiScope = Readonly<{ organizationId: string; schoolId: string }>;
export type Owned = () => boolean;
export type MerchAiList = Readonly<{ aiAvailable: boolean; requests: MerchAiView[] }>;

const JSON_TYPE = /^application\/json(?:\s*;|$)/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const codeOf = (v: unknown): string | null => v && typeof v === 'object' && !Array.isArray(v) && typeof (v as { code?: unknown }).code === 'string' ? (v as { code: string }).code : null;
const data = (v: unknown): unknown => { if (!v || typeof v !== 'object' || Array.isArray(v) || !Object.hasOwn(v, 'data')) throw new Error('shape'); return (v as { data: unknown }).data; };

export function merchAiErrorFor(status: number, code: string | null): MerchAiError {
  if (status === 403 && code === 'SHOPIFY_MERCH_AI_SPEND_STOPPED') return new MerchAiError('PAUSED');
  if (status === 403) return new MerchAiError('NO_ACCESS');
  if (status === 404 && code === 'SHOPIFY_MERCH_AI_NOT_CONNECTED') return new MerchAiError('NOT_CONNECTED');
  if (status === 404) return new MerchAiError('GONE');
  if (status === 400) return new MerchAiError('INVALID');
  if (status === 409 && code === 'SHOPIFY_MERCH_AI_NOT_CONNECTED') return new MerchAiError('NOT_CONNECTED');
  if (status === 409 && code === 'SHOPIFY_MERCH_AI_NOT_OPEN') return new MerchAiError('GONE');
  if (status === 409 && (code === 'IDEMPOTENCY_KEY_REUSED' || code === 'IDEMPOTENCY_KEY_REQUIRED')) return new MerchAiError('INVALID');
  return new MerchAiError('UNKNOWN');
}

function base(scope: MerchAiScope): string {
  if (!UUID.test(scope.organizationId) || !UUID.test(scope.schoolId)) throw new MerchAiError('INVALID');
  return `/api/v1/organizations/${scope.organizationId.toLowerCase()}/schools/${scope.schoolId.toLowerCase()}/shopify/merch-ideas`;
}
async function exchange(path: string, signal: AbortSignal, owned: Owned, command?: Readonly<{ name: string; body: string; key: string }>): Promise<{ status: number; value: unknown }> {
  const r = await fetch(path, { method: command ? 'POST' : 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', signal,
    headers: { Accept: 'application/json', ...(command ? { 'Content-Type': 'application/json', 'X-HON-Human-Command': command.name, 'Idempotency-Key': command.key } : {}) },
    ...(command ? { body: command.body } : {}) });
  signal.throwIfAborted();
  if (r.status === 401) { if (owned()) reportConfirmedSessionInvalidation(); throw new MerchAiError('SESSION'); }
  if (r.redirected || !JSON_TYPE.test(r.headers.get('content-type') ?? '')) return { status: r.status, value: null };
  const text = await r.text();
  if (text.length > 1_000_000) throw new MerchAiError('UNKNOWN');
  try { return { status: r.status, value: JSON.parse(text) as unknown }; } catch { return { status: r.status, value: null }; }
}
async function post(scope: MerchAiScope, path: string, name: string, body: unknown, key: string, signal: AbortSignal, owned: Owned): Promise<unknown> {
  if (typeof key !== 'string' || !UUID.test(key)) throw new MerchAiError('INVALID');
  let answer: { status: number; value: unknown };
  try { answer = await exchange(base(scope) + path, signal, owned, { name, body: JSON.stringify(body), key }); }
  catch (error) { if (error instanceof MerchAiError) throw error; throw new MerchAiError('UNKNOWN'); }
  if (answer.status !== 200) throw merchAiErrorFor(answer.status, codeOf(answer.value));
  try { return data(answer.value); } catch { throw new MerchAiError('UNKNOWN'); }
}
const checked = <T,>(f: () => T): T => { try { return f(); } catch { throw new MerchAiError('UNKNOWN'); } };

export const merchAiApi = {
  /** Whether this server has the paid text route configured, and this person's latest requests at this school. */
  async list(scope: MerchAiScope, signal: AbortSignal, owned: Owned): Promise<MerchAiList> {
    let answer: { status: number; value: unknown };
    try { answer = await exchange(base(scope), signal, owned); }
    catch (error) { if (error instanceof MerchAiError || signal.aborted) throw error; throw new MerchAiError('UNKNOWN'); }
    if (answer.status !== 200) throw merchAiErrorFor(answer.status, codeOf(answer.value));
    return checked(() => {
      const v = data(answer.value);
      if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).sort().join(',') !== 'aiAvailable,requests') throw new Error('shape');
      const o = v as { aiAvailable: unknown; requests: unknown };
      if (typeof o.aiAvailable !== 'boolean') throw new Error('shape');
      return { aiAvailable: o.aiAvailable, requests: verifyMerchAiList(o.requests) };
    });
  },
  async request(scope: MerchAiScope, brief: MerchAiBrief, key: string, signal: AbortSignal, owned: Owned): Promise<MerchAiView> {
    let body; try { body = validateMerchAiBrief(brief); } catch { throw new MerchAiError('INVALID'); }
    const value = await post(scope, '', 'shopify.merch.ai.request', body, key, signal, owned);
    return checked(() => verifyMerchAiView(value));
  },
  /** APPLIED once the owner has sent one of the ideas for approval, or DISMISSED. */
  async close(scope: MerchAiScope, id: string, status: 'APPLIED' | 'DISMISSED', key: string, signal: AbortSignal, owned: Owned): Promise<MerchAiView> {
    if (!UUID.test(id)) throw new MerchAiError('INVALID');
    const value = await post(scope, `/${id.toLowerCase()}/close`, 'shopify.merch.ai.close', { status }, key, signal, owned);
    return checked(() => verifyMerchAiView(value));
  },
};
export type MerchAiApi = typeof merchAiApi;
