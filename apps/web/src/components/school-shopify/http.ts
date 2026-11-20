import {
  SHOPIFY_HUMAN_COMMAND, accountClosed, accountUuid, validateShopifyCompleteInput, validateShopifyConnectInput, validateShopifyDisconnectInput,
  verifyShopifyCatalog, verifyShopifyConnectResult, verifyShopifyConnectStart, verifyShopifyDisconnectResult, verifyShopifyOrders, verifyShopifyOverview,
  verifyShopifySyncResult, validateShopifyProposeInput, validateShopifyChangeCommandInput, verifyShopifyProductChanges, verifyShopifyChangeResult,
  type ShopifyCatalog, type ShopifyProductChanges, type ShopifyChangeResult, type ShopifyDraftChanges, type ShopifyUpdateChanges, type ShopifyConnectResult, type ShopifyConnectStart, type ShopifyDisconnectResult, type ShopifyOrders, type ShopifyOverview,
  type ShopifySyncResult, type ShopifyFinanceView, verifyShopifyFinanceView,
  validateShopifyThemeCommand, verifyShopifyThemeWorkResult, verifyShopifyThemeWorkspace, type ShopifyThemeCommand, type ShopifyThemeWorkResult, type ShopifyThemeWorkspace,
} from '@hon/contracts';
import { reportConfirmedSessionInvalidation } from '../session-invalidation';

/**
 * The school's Shopify store (0405). Reads are plain same-origin GETs; each command sends its own X-HON-Human-Command.
 * The server decides the permission, the school and every outcome; the browser never sees a Shopify token.
 */
export type ShopifyErrorKind =
  'SESSION' | 'DENIED' | 'NOT_ENABLED' | 'STATE' | 'TAKEN' | 'OTHER_STORE' | 'STALE' | 'BUSY' | 'NOT_CONNECTED' | 'LIMIT' | 'REJECTED' | 'SCOPES' | 'INVALID' | 'UNKNOWN'
  | 'EDIT_OFF' | 'CHANGE_STALE' | 'CHANGE_OPEN' | 'CHANGE_DONE' | 'ATTEMPTS' | 'TOO_MANY'
  | 'THEMES_OFF' | 'THEME_BUSY' | 'THEME_NOT_UNDOABLE' | 'THEME_DONE' | 'THEME_LIMIT';
export class ShopifyError extends Error { constructor(readonly kind: ShopifyErrorKind, readonly code: string | null = null) { super(kind); } }
export type Owned = () => boolean;

const RESPONSE_MAX = 4_000_000;
const JSON_TYPE = /^application\/json(?:\s*;|$)/i;
const codeOf = (v: unknown): string | null => v && typeof v === 'object' && !Array.isArray(v) && typeof (v as { code?: unknown }).code === 'string' ? (v as { code: string }).code : null;

/** What a refused answer means. Only these exact answers are definitive; anything else is UNKNOWN. */
export function shopifyErrorFor(status: number, code: string | null): ShopifyError {
  if (status === 403) return new ShopifyError('DENIED', code);
  if (status === 400 && (code === 'SHOPIFY_CONNECT_STATE_INVALID' || code === 'SHOPIFY_CONNECT_STATE_EXPIRED')) return new ShopifyError('STATE', code);
  if (status === 400 && code === 'SHOPIFY_CONNECT_REJECTED') return new ShopifyError('REJECTED', code);
  if (status === 400 && code === 'SHOPIFY_SCOPES_MISSING') return new ShopifyError('SCOPES', code);
  if (status === 400) return new ShopifyError('INVALID', code);
  if (status === 409 && code === 'SHOPIFY_SHOP_TAKEN') return new ShopifyError('TAKEN', code);
  if (status === 409 && code === 'SHOPIFY_OTHER_STORE_CONNECTED') return new ShopifyError('OTHER_STORE', code);
  if (status === 409 && code === 'SHOPIFY_SYNC_RUNNING') return new ShopifyError('BUSY', code);
  if (status === 409 && code === 'SHOPIFY_VERSION_CONFLICT') return new ShopifyError('STALE', code);
  if (status === 409 && code === 'SHOPIFY_EDIT_NOT_ALLOWED') return new ShopifyError('EDIT_OFF', code);
  if (status === 409 && code === 'SHOPIFY_CHANGE_STALE') return new ShopifyError('CHANGE_STALE', code);
  if (status === 409 && code === 'SHOPIFY_CHANGE_OPEN') return new ShopifyError('CHANGE_OPEN', code);
  if (status === 409 && (code === 'SHOPIFY_CHANGE_NOT_PENDING' || code === 'SHOPIFY_CHANGE_NOT_LEASED')) return new ShopifyError('CHANGE_DONE', code);
  if (status === 409 && code === 'SHOPIFY_CHANGE_ATTEMPTS') return new ShopifyError('ATTEMPTS', code);
  if (status === 409 && code === 'SHOPIFY_TOO_MANY_DRAFTS') return new ShopifyError('TOO_MANY', code);
  if (status === 409 && code === 'SHOPIFY_THEMES_NOT_ALLOWED') return new ShopifyError('THEMES_OFF', code);
  if (status === 409 && code === 'SHOPIFY_THEME_BUSY') return new ShopifyError('THEME_BUSY', code);
  if (status === 409 && code === 'SHOPIFY_THEME_NOT_UNDOABLE') return new ShopifyError('THEME_NOT_UNDOABLE', code);
  if (status === 409 && code === 'SHOPIFY_THEME_NOT_LEASED') return new ShopifyError('THEME_DONE', code);
  if (status === 429 && code === 'SHOPIFY_THEME_LIMIT') return new ShopifyError('THEME_LIMIT', code);
  if ((status === 409 && code === 'SHOPIFY_NOT_CONNECTED') || (status === 404 && code === 'SHOPIFY_NOT_FOUND')) return new ShopifyError('NOT_CONNECTED', code);
  if (status === 429) return new ShopifyError('LIMIT', code);
  if (status === 503 && code === 'SHOPIFY_CONNECT_OFF') return new ShopifyError('NOT_ENABLED', code);
  return new ShopifyError('UNKNOWN', code);
}

async function exchange(path: string, signal: AbortSignal, owned: Owned, body?: string): Promise<{ status: number; value: unknown }> {
  let r: Response;
  try {
    r = await fetch(path, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', signal,
      headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'X-HON-Human-Command': SHOPIFY_HUMAN_COMMAND }) },
      ...(body === undefined ? {} : { body }) });
  } catch (error) { if (signal.aborted && body === undefined) throw error; throw new ShopifyError('UNKNOWN'); }
  if (signal.aborted && body === undefined) signal.throwIfAborted();
  if (r.status === 401) { if (owned()) reportConfirmedSessionInvalidation(); throw new ShopifyError('SESSION'); }
  if (r.redirected || !JSON_TYPE.test(r.headers.get('content-type') ?? '')) return { status: r.status, value: null };
  let text: string;
  try { text = await r.text(); } catch { throw new ShopifyError('UNKNOWN'); }
  if (text.length > RESPONSE_MAX) throw new ShopifyError('UNKNOWN');
  try { return { status: r.status, value: JSON.parse(text) as unknown }; } catch { return { status: r.status, value: null }; }
}
function school(id: string): string { try { return accountUuid(id).toLowerCase(); } catch { throw new ShopifyError('INVALID'); } }
async function answer<T>(path: string, signal: AbortSignal, owned: Owned, verify: (v: unknown) => T, body?: string): Promise<T> {
  const { status, value } = await exchange(path, signal, owned, body);
  if (status !== 200) throw shopifyErrorFor(status, codeOf(value));
  try { return verify(accountClosed(value, ['data']).data); } catch { throw new ShopifyError('UNKNOWN'); }
}
function input<T>(validate: (v: unknown) => T, v: unknown): T { try { return validate(v); } catch { throw new ShopifyError('INVALID'); } }

export const shopifyApi = {
  async overview(schoolId: string, signal: AbortSignal, owned: Owned): Promise<ShopifyOverview> {
    const id = school(schoolId);
    const out = await answer(`/api/v1/school/schools/${id}/shopify`, signal, owned, verifyShopifyOverview);
    if (out.schoolId.toLowerCase() !== id) throw new ShopifyError('UNKNOWN');
    return out;
  },
  async catalog(schoolId: string, signal: AbortSignal, owned: Owned): Promise<ShopifyCatalog> {
    const id = school(schoolId);
    const out = await answer(`/api/v1/school/schools/${id}/shopify/catalog`, signal, owned, verifyShopifyCatalog);
    if (out.schoolId.toLowerCase() !== id) throw new ShopifyError('UNKNOWN');
    return out;
  },
  async orders(schoolId: string, signal: AbortSignal, owned: Owned): Promise<ShopifyOrders> {
    const id = school(schoolId);
    const out = await answer(`/api/v1/school/schools/${id}/shopify/orders`, signal, owned, verifyShopifyOrders);
    if (out.schoolId.toLowerCase() !== id) throw new ShopifyError('UNKNOWN');
    return out;
  },
  /** Starts a connection. The answer is Shopify's approval page (or, in development, HON's own return page). */
  async connect(schoolId: string, shopDomain: string, signal: AbortSignal, owned: Owned, allowEditing = false, allowFinance = false, allowThemes = false): Promise<ShopifyConnectStart> {
    const body = input(validateShopifyConnectInput, { schoolId: school(schoolId), shopDomain, allowEditing, allowFinance, allowThemes });
    const out = await answer('/api/v1/school/shopify/connect', signal, owned, verifyShopifyConnectStart, JSON.stringify(body));
    if (out.shopDomain !== body.shopDomain) throw new ShopifyError('UNKNOWN');
    const url = new URL(out.authorizeUrl);
    const ownReturn = url.origin === globalThis.location?.origin && url.pathname === '/staff/billing/shopify/return';
    if (!(url.protocol === 'https:' && url.hostname === body.shopDomain) && !ownReturn) throw new ShopifyError('UNKNOWN');
    return out;
  },
  /** Finishes a connection with the exact query Shopify put on the return address. */
  async complete(schoolId: string, query: string, signal: AbortSignal, owned: Owned): Promise<ShopifyConnectResult> {
    const body = input(validateShopifyCompleteInput, { schoolId: school(schoolId), query });
    return answer('/api/v1/school/shopify/connect/complete', signal, owned, verifyShopifyConnectResult, JSON.stringify(body));
  },
  async sync(schoolId: string, signal: AbortSignal, owned: Owned): Promise<ShopifySyncResult> {
    return answer('/api/v1/school/shopify/sync', signal, owned, verifyShopifySyncResult, JSON.stringify({ schoolId: school(schoolId) }));
  },
  async disconnect(schoolId: string, connectionId: string, expectedVersion: number, signal: AbortSignal, owned: Owned): Promise<ShopifyDisconnectResult> {
    const body = input(validateShopifyDisconnectInput, { schoolId: school(schoolId), connectionId, expectedVersion });
    const out = await answer('/api/v1/school/shopify/disconnect', signal, owned, verifyShopifyDisconnectResult, JSON.stringify(body));
    if (out.connection.connectionId.toLowerCase() !== body.connectionId.toLowerCase()) throw new ShopifyError('UNKNOWN');
    return out;
  },
  /** SH-F1 (commerce.shopify.manage): the Shopify Payments balance, payouts and recent balance transactions HON last read. */
  async finance(schoolId: string, signal: AbortSignal, owned: Owned): Promise<ShopifyFinanceView> {
    const id = school(schoolId);
    const out = await answer(`/api/v1/school/schools/${id}/shopify/finance`, signal, owned, verifyShopifyFinanceView);
    if (out.schoolId.toLowerCase() !== id) throw new ShopifyError('UNKNOWN');
    return out;
  },
  /** TB1 (commerce.shopify.manage): whether theme editing is allowed, HON's draft copy of the live theme and the latest edits. */
  async theme(schoolId: string, signal: AbortSignal, owned: Owned): Promise<ShopifyThemeWorkspace> {
    const id = school(schoolId);
    const out = await answer(`/api/v1/school/schools/${id}/shopify/theme`, signal, owned, verifyShopifyThemeWorkspace);
    if (out.schoolId.toLowerCase() !== id) throw new ShopifyError('UNKNOWN');
    return out;
  },
  /** TB1: preview a ready-made change (nothing is written), write it to HON's draft copy, or undo one edit. Never replayed. */
  async themeWork(schoolId: string, command: Omit<ShopifyThemeCommand, 'schoolId'>, signal: AbortSignal, owned: Owned): Promise<ShopifyThemeWorkResult> {
    const body = input(validateShopifyThemeCommand, { ...command, schoolId: school(schoolId) });
    const out = await answer('/api/v1/school/shopify/theme', signal, owned, verifyShopifyThemeWorkResult, JSON.stringify(body));
    if (out.workspace.schoolId.toLowerCase() !== body.schoolId || (out.preview !== null) !== (body.purpose === 'PREVIEW' && out.outcome === 'DONE')) throw new ShopifyError('UNKNOWN');
    return out;
  },
  /** SH4a: whether the store lets HON edit, and the latest product changes (open ones first). */
  async changes(schoolId: string, signal: AbortSignal, owned: Owned): Promise<ShopifyProductChanges> {
    const id = school(schoolId);
    const out = await answer(`/api/v1/school/schools/${id}/shopify/changes`, signal, owned, verifyShopifyProductChanges);
    if (out.schoolId.toLowerCase() !== id) throw new ShopifyError('UNKNOWN');
    return out;
  },
  /** Saves a change for approval. Nothing reaches Shopify until someone approves it. */
  async propose(schoolId: string, change: { kind: 'CREATE_DRAFT'; changes: ShopifyDraftChanges } | { kind: 'UPDATE'; productId: string; changes: ShopifyUpdateChanges },
    signal: AbortSignal, owned: Owned): Promise<ShopifyChangeResult> {
    const body = input(validateShopifyProposeInput, { schoolId: school(schoolId), kind: change.kind, productId: change.kind === 'UPDATE' ? change.productId : null, changes: change.changes });
    const out = await answer('/api/v1/school/shopify/changes', signal, owned, verifyShopifyChangeResult, JSON.stringify(body));
    if (out.change.kind !== body.kind || out.change.status !== 'PENDING') throw new ShopifyError('UNKNOWN');
    return out;
  },
  async cancelChange(schoolId: string, changeId: string, expectedVersion: number, signal: AbortSignal, owned: Owned): Promise<ShopifyChangeResult> {
    return command('/api/v1/school/shopify/changes/cancel', schoolId, changeId, expectedVersion, signal, owned);
  },
  /** Approves this exact version: HON checks the product in Shopify, writes it, reads it back and answers with the result. */
  async approveChange(schoolId: string, changeId: string, expectedVersion: number, signal: AbortSignal, owned: Owned): Promise<ShopifyChangeResult> {
    return command('/api/v1/school/shopify/changes/approve', schoolId, changeId, expectedVersion, signal, owned);
  },
};
async function command(path: string, schoolId: string, changeId: string, expectedVersion: number, signal: AbortSignal, owned: Owned): Promise<ShopifyChangeResult> {
  const body = input(validateShopifyChangeCommandInput, { schoolId: school(schoolId), changeId, expectedVersion });
  const out = await answer(path, signal, owned, verifyShopifyChangeResult, JSON.stringify(body));
  if (out.change.changeId.toLowerCase() !== body.changeId.toLowerCase()) throw new ShopifyError('UNKNOWN');
  return out;
}
export type ShopifyApi = typeof shopifyApi;
