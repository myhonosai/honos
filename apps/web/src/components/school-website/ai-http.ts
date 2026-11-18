import {
  validateWebsiteAiApplyInput, validateWebsiteAiEditRequest, verifySchoolWebsite, verifyWebsiteAiEditList, verifyWebsiteAiEditView,
  type SchoolWebsite, type WebsiteAiEditView,
} from '@hon/contracts';
import { reportConfirmedSessionInvalidation } from '../session-invalidation';
import { websiteBase, type Owned, type WebsiteScope } from './http';

/**
 * WB5 (0507): suggestions from Marcus for the website draft. The list is a plain same-origin GET; asking, applying and
 * dismissing each send their own X-HON-Human-Command and an Idempotency-Key. The server decides every permission.
 */
export type WebsiteAiErrorKind =
  /** Session ended. */ 'SESSION'
  /** This person or school cannot use Marcus here (website editing, Marcus and an active Complete plan). Nothing was sent. */ | 'NO_ACCESS'
  /** AI help is paused or not available for this school now. Nothing was sent. */ | 'PAUSED'
  /** The draft changed. Nothing was sent or changed. */ | 'STALE'
  /** The suggestion no longer fits the current draft. Nothing changed. */ | 'DOES_NOT_FIT'
  /** Already applied, dismissed or not yours. Nothing changed. */ | 'GONE'
  /** Not accepted as written. Nothing was sent. */ | 'INVALID'
  /** The outcome is not known. Only the identical request (same key) may be sent again. */ | 'UNKNOWN';
export class WebsiteAiError extends Error { constructor(readonly kind: WebsiteAiErrorKind) { super(kind); } }
export type WebsiteAiCommand = 'request' | 'apply' | 'dismiss';

const JSON_TYPE = /^application\/json(?:\s*;|$)/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const codeOf = (v: unknown): string | null => v && typeof v === 'object' && !Array.isArray(v) && typeof (v as { code?: unknown }).code === 'string' ? (v as { code: string }).code : null;
const data = (v: unknown): unknown => { if (!v || typeof v !== 'object' || Array.isArray(v) || !Object.hasOwn(v, 'data')) throw new Error('shape'); return (v as { data: unknown }).data; };

export function websiteAiErrorFor(status: number, code: string | null): WebsiteAiError {
  if (status === 403 && code === 'SCHOOL_WEBSITE_AI_SPEND_STOPPED') return new WebsiteAiError('PAUSED');
  if (status === 403) return new WebsiteAiError('NO_ACCESS');
  if (status === 404) return new WebsiteAiError('GONE');
  if (status === 400) return new WebsiteAiError('INVALID');
  if (status === 409 && (code === 'SCHOOL_WEBSITE_AI_STALE' || code === 'VERSION_CONFLICT')) return new WebsiteAiError('STALE');
  if (status === 409 && code === 'SCHOOL_WEBSITE_AI_DOES_NOT_FIT') return new WebsiteAiError('DOES_NOT_FIT');
  if (status === 409 && code === 'SCHOOL_WEBSITE_AI_NOT_OPEN') return new WebsiteAiError('GONE');
  if (status === 409 && (code === 'IDEMPOTENCY_KEY_REUSED' || code === 'IDEMPOTENCY_KEY_REQUIRED')) return new WebsiteAiError('INVALID');
  return new WebsiteAiError('UNKNOWN');
}

async function exchange(path: string, signal: AbortSignal, owned: Owned, command?: Readonly<{ name: string; body: string; key: string }>): Promise<{ status: number; value: unknown }> {
  const r = await fetch(path, { method: command ? 'POST' : 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', signal,
    headers: { Accept: 'application/json', ...(command ? { 'Content-Type': 'application/json', 'X-HON-Human-Command': command.name, 'Idempotency-Key': command.key } : {}) },
    ...(command ? { body: command.body } : {}) });
  signal.throwIfAborted();
  if (r.status === 401) { if (owned()) reportConfirmedSessionInvalidation(); throw new WebsiteAiError('SESSION'); }
  if (r.redirected || !JSON_TYPE.test(r.headers.get('content-type') ?? '')) return { status: r.status, value: null };
  const text = await r.text();
  if (text.length > 3_000_000) throw new WebsiteAiError('UNKNOWN');
  try { return { status: r.status, value: JSON.parse(text) as unknown }; } catch { return { status: r.status, value: null }; }
}
async function post(scope: WebsiteScope, path: string, name: string, body: unknown, key: string, signal: AbortSignal, owned: Owned): Promise<unknown> {
  if (typeof key !== 'string' || !UUID.test(key)) throw new WebsiteAiError('INVALID');
  let answer: { status: number; value: unknown };
  try { answer = await exchange(websiteBase(scope) + '/ai-edits' + path, signal, owned, { name, body: JSON.stringify(body), key }); }
  catch (error) { if (error instanceof WebsiteAiError) throw error; throw new WebsiteAiError('UNKNOWN'); }
  if (answer.status !== 200) throw websiteAiErrorFor(answer.status, codeOf(answer.value));
  try { return data(answer.value); } catch { throw new WebsiteAiError('UNKNOWN'); }
}
const checked = <T,>(f: () => T): T => { try { return f(); } catch { throw new WebsiteAiError('UNKNOWN'); } };

export const websiteAiApi = {
  async list(scope: WebsiteScope, signal: AbortSignal, owned: Owned): Promise<WebsiteAiEditView[]> {
    let answer: { status: number; value: unknown };
    try { answer = await exchange(websiteBase(scope) + '/ai-edits', signal, owned); }
    catch (error) { if (error instanceof WebsiteAiError || signal.aborted) throw error; throw new WebsiteAiError('UNKNOWN'); }
    if (answer.status !== 200) throw websiteAiErrorFor(answer.status, codeOf(answer.value));
    return checked(() => verifyWebsiteAiEditList(data(answer.value)));
  },
  async request(scope: WebsiteScope, input: unknown, key: string, signal: AbortSignal, owned: Owned): Promise<WebsiteAiEditView> {
    let body; try { body = validateWebsiteAiEditRequest(input); } catch { throw new WebsiteAiError('INVALID'); }
    const value = await post(scope, '', 'website.ai.request', body, key, signal, owned);
    return checked(() => verifyWebsiteAiEditView(value));
  },
  async apply(scope: WebsiteScope, id: string, input: unknown, key: string, signal: AbortSignal, owned: Owned): Promise<{ website: SchoolWebsite; suggestion: WebsiteAiEditView }> {
    if (!UUID.test(id)) throw new WebsiteAiError('INVALID');
    let body; try { body = validateWebsiteAiApplyInput(input); } catch { throw new WebsiteAiError('INVALID'); }
    const value = await post(scope, `/${id.toLowerCase()}/apply`, 'website.ai.apply', body, key, signal, owned);
    return checked(() => {
      if (!value || typeof value !== 'object' || Object.keys(value).sort().join(',') !== 'suggestion,website') throw new Error('shape');
      const v = value as { website: unknown; suggestion: unknown };
      return { website: verifySchoolWebsite(v.website), suggestion: verifyWebsiteAiEditView(v.suggestion) };
    });
  },
  async dismiss(scope: WebsiteScope, id: string, key: string, signal: AbortSignal, owned: Owned): Promise<WebsiteAiEditView> {
    if (!UUID.test(id)) throw new WebsiteAiError('INVALID');
    const value = await post(scope, `/${id.toLowerCase()}/dismiss`, 'website.ai.dismiss', {}, key, signal, owned);
    return checked(() => verifyWebsiteAiEditView(value));
  },
};
export type WebsiteAiApi = typeof websiteAiApi;
