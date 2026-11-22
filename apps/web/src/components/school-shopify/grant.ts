/**
 * Optional Shopify permissions (Allow finance, Allow orders).
 *
 * HON's Shopify app uses Shopify managed installation, where the approval page HON builds (`/admin/oauth/authorize`)
 * grants only the app's required permissions and ignores extra ones. Optional permissions are granted on Shopify's own
 * request page, which returns the owner to the app's address (this Commerce page) and not to HON's return page. Checked
 * on the test store on 2026-11-22: after that page, one more pass through HON's approval records the new permission.
 *
 * So an Allow button takes two hops: Shopify's request page first, then HON's usual approval. A note in the browser's
 * session storage says the second hop is still owed. It holds no secret: the action, the school and the shop domain.
 */
export type GrantAction = 'allowFinance' | 'allowOrders';
const KEY = 'hon.shopify.grant';
/** As long as an unused HON approval lives. */
export const GRANT_NOTE_MS = 10 * 60 * 1000;

/** Shopify's request page for these optional permissions, or null when the approval is not Shopify's own page (development). */
export function shopifyGrantUrl(authorizeUrl: string, shopDomain: string, scopes: readonly string[]): string | null {
  let url: URL;
  try { url = new URL(authorizeUrl); } catch { return null; }
  if (url.protocol !== 'https:' || url.hostname !== shopDomain || url.pathname !== '/admin/oauth/authorize') return null;
  const clientId = url.searchParams.get('client_id') ?? '', store = shopDomain.replace(/\.myshopify\.com$/, '');
  if (!/^[0-9a-f]{32}$/.test(clientId) || !/^[a-z0-9][a-z0-9-]{0,59}$/.test(store) || store === shopDomain) return null;
  if (!scopes.length || scopes.some(s => !/^[a-z_]{1,60}$/.test(s))) return null;
  return `https://admin.shopify.com/store/${store}/oauth/install?${new URLSearchParams({ client_id: clientId, optional_scopes: scopes.join(',') }).toString()}`;
}

/** Notes that the second hop is owed. False when the browser cannot keep the note (the caller then skips the first hop). */
export function rememberGrant(action: GrantAction, schoolId: string, shopDomain: string, now: number = Date.now()): boolean {
  try { window.sessionStorage.setItem(KEY, JSON.stringify({ action, schoolId, shopDomain, at: now })); return true; } catch { return false; }
}

/** The owed second hop for this school and shop, if the note is fresh. The note is removed whatever it says, so it is used at most once. */
export function takeGrant(schoolId: string, shopDomain: string, now: number = Date.now()): GrantAction | null {
  let raw: string | null = null;
  try { raw = window.sessionStorage.getItem(KEY); window.sessionStorage.removeItem(KEY); } catch { return null; }
  if (!raw || raw.length > 400) return null;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    if (v.schoolId !== schoolId || v.shopDomain !== shopDomain || typeof v.at !== 'number' || now - v.at < 0 || now - v.at > GRANT_NOTE_MS) return null;
    return v.action === 'allowFinance' || v.action === 'allowOrders' ? v.action : null;
  } catch { return null; }
}
