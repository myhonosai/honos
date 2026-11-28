import { DESIGN_DRAFT_COMMAND, validateDesignDraftBrief, verifyDesignDraftView, type CreativeDesignSizeCode, type DesignDraftBrief, type DesignDraftLanguage, type DesignDraftView } from '@hon/contracts';
import type { DesignsScope } from './http';

/**
 * Design AI draft calls (0705, E4a; docs/architecture/CREATIVE_DESIGN_EDITOR.md). Same-origin only; the school in the path is
 * the shell's verified school. The server decides who may ask, whether AI is switched on and what it costs. Failures carry a
 * code the screen turns into words in the person's language.
 */
export class DesignDraftError extends Error { constructor(readonly code: string) { super(code); } }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const base = (scope: DesignsScope) => {
  if (!UUID.test(scope.organizationId) || !UUID.test(scope.schoolId)) throw new DesignDraftError('DESIGN_DRAFT_UNAVAILABLE');
  return `/api/v1/organizations/${scope.organizationId.toLowerCase()}/schools/${scope.schoolId.toLowerCase()}/creative-studio/design-drafts`;
};

async function call(url: string, body?: object, key?: string): Promise<unknown> {
  const headers: Record<string, string> = { Accept: 'application/json', 'X-Hon-Human-Command': DESIGN_DRAFT_COMMAND };
  if (body) { headers['Content-Type'] = 'application/json'; headers['Idempotency-Key'] = key ?? ''; }
  const response = await fetch(url, { method: body ? 'POST' : 'GET', credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer',
    headers, ...(body ? { body: JSON.stringify(body) } : {}) });
  const json = /^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '');
  const value: unknown = json ? await response.json().catch(() => null) : null;
  const root = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  if (!response.ok) {
    if (response.status === 401) throw new DesignDraftError('SESSION');
    const code = String(root?.code ?? '');
    throw new DesignDraftError(/^DESIGN_DRAFT_[A-Z_]{1,40}$/.test(code) ? code : response.status === 403 ? 'DESIGN_DRAFT_FORBIDDEN' : 'DESIGN_DRAFT_UNAVAILABLE');
  }
  if (!root || !Object.hasOwn(root, 'data')) throw new DesignDraftError('DESIGN_DRAFT_UNAVAILABLE');
  return root.data;
}

export type DesignDraftApi = Readonly<{
  available: (scope: DesignsScope) => Promise<boolean>;
  draft: (scope: DesignsScope, brief: string, size: CreativeDesignSizeCode, language: DesignDraftLanguage, key: string) => Promise<DesignDraftView>;
  close: (scope: DesignsScope, id: string, status: 'APPLIED' | 'DISMISSED', key: string) => Promise<void>;
}>;

export const designDraftApi: DesignDraftApi = {
  /** Whether AI drafting is switched on for this server. Any failure reads as "not available": the box then explains and stays off. */
  async available(scope) {
    try { const data = await call(base(scope)) as { aiAvailable?: unknown } | null; return data?.aiAvailable === true; } catch { return false; }
  },
  async draft(scope, brief, size, language, key) {
    let input: DesignDraftBrief;
    try { input = validateDesignDraftBrief({ brief, size, language }); } catch { throw new DesignDraftError('DESIGN_DRAFT_INVALID'); }
    try { return verifyDesignDraftView(await call(base(scope), input, key)); }
    catch (error) { throw error instanceof DesignDraftError ? error : new DesignDraftError('DESIGN_DRAFT_UNAVAILABLE'); }
  },
  async close(scope, id, status, key) {
    if (!UUID.test(id)) return; await call(`${base(scope)}/${id.toLowerCase()}/close`, { status }, key);
  },
};

/** The editor language as the AI draft takes it: en, ko or es (anything else asks in English). */
export function draftLanguage(language: string): DesignDraftLanguage {
  const two = language.slice(0, 2);
  return two === 'ko' || two === 'es' ? two : 'en';
}
