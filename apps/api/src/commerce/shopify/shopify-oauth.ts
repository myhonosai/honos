import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Shopify OAuth (authorization code grant) for the one HON Shopify app. The redirect query is verified with the app
 * secret before any of its values is used: hex HMAC-SHA256 over every parameter except `hmac`, sorted by name and joined
 * as `name=value&...` (Shopify's documented rule). Nothing here talks to Shopify.
 */
export const SHOP_DOMAIN = /^[a-z0-9][a-z0-9-]{0,59}\.myshopify\.com$/;
const CODE = /^[A-Za-z0-9_-]{1,512}$/;
const STATE = /^[A-Za-z0-9_-]{43}$/;
const HMAC = /^[0-9a-f]{64}$/;
const KNOWN = new Set(['code', 'hmac', 'host', 'shop', 'state', 'timestamp']);
/** How far Shopify's `timestamp` may be from our clock. */
export const SHOPIFY_CALLBACK_SKEW_SECONDS = 600;

export interface ShopifyCallback { code: string; shop: string; state: string }

function message(params: [string, string][]): string {
  return params.filter(([k]) => k !== 'hmac').sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join('&');
}

/** The hex signature Shopify puts on a redirect (also used by the fake to sign its own answers). */
export function signShopifyQuery(params: Record<string, string>, secret: string): string {
  return createHmac('sha256', secret).update(message(Object.entries(params)), 'utf8').digest('hex');
}

/**
 * The verified `code`, `shop` and `state`, or null. Refused: duplicate or unknown parameters, a missing or wrong
 * signature, a timestamp more than ten minutes away, a shop outside myshopify.com, or a malformed code or state.
 */
export function verifyShopifyCallback(query: string, secret: string, nowMs: number = Date.now()): ShopifyCallback | null {
  if (typeof query !== 'string' || query.length > 4096 || !secret) return null;
  let params: [string, string][];
  try { params = [...new URLSearchParams(query).entries()]; } catch { return null; }
  const names = params.map(([k]) => k);
  if (new Set(names).size !== names.length || names.some(k => !KNOWN.has(k))) return null;
  const get = (k: string) => params.find(([n]) => n === k)?.[1];
  const hmac = get('hmac'), code = get('code'), shop = get('shop'), state = get('state'), timestamp = get('timestamp');
  if (!hmac || !HMAC.test(hmac) || !code || !CODE.test(code) || !shop || !SHOP_DOMAIN.test(shop) || !state || !STATE.test(state)
    || !timestamp || !/^[0-9]{1,12}$/.test(timestamp)) return null;
  const expected = Buffer.from(createHmac('sha256', secret).update(message(params), 'utf8').digest('hex'), 'utf8');
  const given = Buffer.from(hmac, 'utf8');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  if (Math.abs(nowMs / 1000 - Number(timestamp)) > SHOPIFY_CALLBACK_SKEW_SECONDS) return null;
  return { code, shop, state };
}

/** Shopify's approval screen for this shop. Offline access (no per-user grant option). */
export function shopifyAuthorizeUrl(input: { shop: string; clientId: string; scopes: readonly string[]; redirectUri: string; state: string }): string {
  if (!SHOP_DOMAIN.test(input.shop)) throw new Error('SHOPIFY_SHOP_INVALID');
  const query = new URLSearchParams({ client_id: input.clientId, scope: input.scopes.join(','), redirect_uri: input.redirectUri, state: input.state });
  return `https://${input.shop}/admin/oauth/authorize?${query.toString()}`;
}

/** Every requested scope was granted. A `write_x` grant includes `read_x`. */
export function scopesGranted(requested: readonly string[], granted: string): boolean {
  const have = new Set(granted.split(',').map(s => s.trim()).filter(Boolean));
  return requested.every(s => have.has(s) || (s.startsWith('read_') && have.has('write_' + s.slice(5))));
}
