import { randomBytes } from 'node:crypto';
import { SHOPIFY_SCOPES } from '@hon/contracts';
import { SHOP_DOMAIN, signShopifyQuery } from './shopify-oauth.js';
import { ephemeralShopifyVault, shopifyVaultFromEnvironment, type ShopifyVault } from './shopify-vault.js';

type Env = Record<string, string | undefined>;
export const SHOPIFY_APP = Symbol('SHOPIFY_APP');
/** The Admin API version HON calls (latest stable on 2026-11-16, supported until October 2027). */
export const SHOPIFY_API_VERSION = '2026-10';
export const SHOPIFY_MAX_PRODUCTS = 2000;
export const SHOPIFY_MAX_VARIANTS_PER_PRODUCT = 100;
export const SHOPIFY_MAX_VARIANTS = 20000;
export const SHOPIFY_MAX_ORDERS = 1000;
export const SHOPIFY_ORDER_LINES = 25;

export type ShopifyFailure = 'AUTH' | 'RATE_LIMITED' | 'UNAVAILABLE' | 'INVALID_RESPONSE';
/** The only error the adapter throws: never a Shopify body, header or token. */
export class ShopifyProviderError extends Error { constructor(readonly failure: ShopifyFailure) { super(failure); } }

export interface ShopifyTokens { accessToken: string; refreshToken: string; accessExpiresAt: string; refreshExpiresAt: string; scope: string }
export interface ShopifyShopInfo { name: string; currency: string }
/** Exactly the page shapes hon.record_shopify_sync_page accepts. */
export interface MirrorVariant {
  id: string; title: string; sku: string | null; barcode: string | null; price: string; compareAtPrice: string | null; unitCost: string | null;
  tracked: boolean; inventoryQuantity: number | null;
}
export interface MirrorProduct {
  id: string; title: string; status: 'ACTIVE' | 'DRAFT' | 'ARCHIVED' | 'UNLISTED'; vendor: string | null; productType: string | null; handle: string | null;
  imageUrl: string | null; variants: MirrorVariant[];
}
export interface MirrorOrderLine { title: string; sku: string | null; variantId: string | null; quantity: number; unitPrice: string }
export interface MirrorOrder {
  id: string; name: string; placedAt: string; cancelledAt: string | null; financialStatus: string | null; fulfillmentStatus: string | null;
  sourceName: string | null; currency: string; subtotal: string; discounts: string; tax: string; total: string; lines: MirrorOrderLine[];
}

/** The Shopify operations SH1 uses. Callers pass HON's own values (a verified shop, a code from a verified redirect). */
export interface ShopifyAdapter {
  readonly kind: 'SHOPIFY' | 'FAKE';
  exchangeCode(shop: string, code: string): Promise<ShopifyTokens>;
  refresh(shop: string, refreshToken: string): Promise<ShopifyTokens>;
  shopInfo(shop: string, accessToken: string): Promise<ShopifyShopInfo>;
  catalog(shop: string, accessToken: string): Promise<{ products: MirrorProduct[]; complete: boolean }>;
  orders(shop: string, accessToken: string, sinceIso: string): Promise<{ orders: MirrorOrder[]; complete: boolean }>;
}

/** The one HON Shopify app, as configured on this server. */
export interface ShopifyApp {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly scopes: readonly string[];
  readonly vault: ShopifyVault;
  readonly adapter: ShopifyAdapter;
  /** Only the fake: an approval answer signed as Shopify would, for HON's own return page. */
  readonly fake: FakeShopify | null;
}

/** The deterministic fake runs only with HON_SHOPIFY_FAKE=1 outside production and staging. */
export function shopifyFakeEnabled(env: Env): boolean {
  if (env.HON_SHOPIFY_FAKE !== '1') return false;
  const deployment = env.HON_DEPLOYMENT_ENVIRONMENT;
  if (deployment === 'production' || deployment === 'staging') return false;
  return !(deployment === undefined && env.NODE_ENV === 'production');
}

/**
 * The real app only with SHOPIFY_API_KEY, SHOPIFY_API_SECRET (at least 32 characters), a valid HON_SHOPIFY_VAULT_KEY and
 * HON_SHOPIFY_CONNECT_APPROVED=true; else the fake when allowed; else null (connecting is off).
 */
export function shopifyAppFromEnvironment(env: Env = process.env, send: typeof fetch = (...a) => fetch(...a)): ShopifyApp | null {
  const clientId = env.SHOPIFY_API_KEY?.trim() ?? '', clientSecret = env.SHOPIFY_API_SECRET?.trim() ?? '';
  const vault = shopifyVaultFromEnvironment(env);
  if (env.HON_SHOPIFY_CONNECT_APPROVED === 'true' && /^[A-Za-z0-9_-]{16,128}$/.test(clientId) && clientSecret.length >= 32 && clientSecret.length <= 256 && vault) {
    return Object.freeze({ clientId, clientSecret, scopes: SHOPIFY_SCOPES, vault, adapter: new GraphqlShopifyAdapter(clientId, clientSecret, send), fake: null });
  }
  if (shopifyFakeEnabled(env)) {
    const secret = randomBytes(32).toString('hex'), fake = new FakeShopify('hon-fake-shopify-app', secret);
    return Object.freeze({ clientId: 'hon-fake-shopify-app', clientSecret: secret, scopes: SHOPIFY_SCOPES, vault: ephemeralShopifyVault(), adapter: fake, fake });
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------
// Parsing helpers: Shopify text is bounded plain text; anything unexpected is INVALID_RESPONSE.

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/g;
const MONEY = /^(0|[1-9][0-9]{0,8})(\.[0-9]{1,4})?$/;
const IMAGE = /^https:\/\/[a-z0-9.-]+\.(shopify\.com|shopifycdn\.net)\/[^\s"'<>\\]*$/;
const STATUS_WORD = /^[A-Z_]{1,40}$/;
function bad(): never { throw new ShopifyProviderError('INVALID_RESPONSE'); }
function obj(v: unknown): Record<string, unknown> { if (!v || typeof v !== 'object' || Array.isArray(v)) bad(); return v as Record<string, unknown>; }
function maybeObj(v: unknown): Record<string, unknown> | null { return v === null || v === undefined ? null : obj(v); }
function list(v: unknown): unknown[] { if (!Array.isArray(v)) bad(); return v; }
/** Shopify text as HON stores it: control characters become spaces, trimmed, at most `max` characters, empty -> null. */
export function cleanText(v: unknown, max = 255): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string') bad();
  const t = v.replace(CONTROL, ' ').trim();
  return t.length === 0 ? null : t.slice(0, max);
}
export function gidNumber(v: unknown, type: string): string {
  const m = typeof v === 'string' ? /^gid:\/\/shopify\/([A-Za-z]+)\/([1-9][0-9]{0,17})$/.exec(v) : null;
  if (!m || m[1] !== type) bad();
  return m[2]!;
}
function money(v: unknown): string {
  const t = typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : null;
  if (t === null) bad();
  // Shopify Decimal: "12.5", "12.50", "0.0". At most 4 decimals kept.
  const m = /^(0|[1-9][0-9]{0,8})(?:\.([0-9]+))?$/.exec(t);
  if (!m) bad();
  const out = m[2] ? `${m[1]}.${m[2].slice(0, 4)}` : m[1]!;
  if (!MONEY.test(out)) bad();
  return out;
}
function maybeMoney(v: unknown): string | null { return v === null || v === undefined ? null : money(v); }
function instant(v: unknown): string {
  if (typeof v !== 'string' || v.length > 40) bad();
  const t = Date.parse(v);
  if (!Number.isFinite(t)) bad();
  return new Date(t).toISOString();
}
function word(v: unknown): string | null { if (v === null || v === undefined) return null; if (typeof v !== 'string' || !STATUS_WORD.test(v)) bad(); return v; }
function int(v: unknown, lo: number, hi: number): number { if (!Number.isInteger(v) || (v as number) < lo || (v as number) > hi) bad(); return v as number; }

/** Groups a flat variant list into products (variant order by Shopify position), at most 100 variants per product. */
export function productsFromVariantNodes(nodes: unknown[]): MirrorProduct[] {
  const products = new Map<string, MirrorProduct & { positions: number[] }>();
  for (const n of nodes) {
    const v = obj(n), p = obj(v.product);
    const productId = gidNumber(p.id, 'Product');
    let product = products.get(productId);
    if (!product) {
      const status = p.status;
      if (status !== 'ACTIVE' && status !== 'DRAFT' && status !== 'ARCHIVED' && status !== 'UNLISTED') bad();
      const media = maybeObj(p.featuredMedia), preview = media ? maybeObj(media.preview) : null, image = preview ? maybeObj(preview.image) : null;
      const url = image && typeof image.url === 'string' && image.url.length <= 2048 && IMAGE.test(image.url) ? image.url : null;
      product = { id: productId, title: cleanText(p.title) ?? 'Untitled product', status, vendor: cleanText(p.vendor), productType: cleanText(p.productType),
        handle: cleanText(p.handle), imageUrl: url, variants: [], positions: [] };
      products.set(productId, product);
    }
    if (product.variants.length >= SHOPIFY_MAX_VARIANTS_PER_PRODUCT) continue;
    const item = maybeObj(v.inventoryItem), cost = item ? maybeObj(item.unitCost) : null;
    product.variants.push({ id: gidNumber(v.id, 'ProductVariant'), title: cleanText(v.title) ?? 'Default', sku: cleanText(v.sku), barcode: cleanText(v.barcode),
      price: money(v.price), compareAtPrice: maybeMoney(v.compareAtPrice), unitCost: cost ? maybeMoney(cost.amount) : null,
      tracked: item ? item.tracked === true : false,
      inventoryQuantity: v.inventoryQuantity === null || v.inventoryQuantity === undefined ? null : int(v.inventoryQuantity, -10_000_000, 10_000_000) });
    product.positions.push(Number.isInteger(v.position) ? (v.position as number) : product.positions.length + 1);
  }
  return [...products.values()].map(({ positions, ...p }) => {
    const order = p.variants.map((variant, i) => ({ variant, at: positions[i]! })).sort((a, b) => a.at - b.at || Number(a.variant.id) - Number(b.variant.id));
    return { ...p, variants: order.map(x => x.variant) };
  });
}

export function orderFromNode(n: unknown): MirrorOrder {
  const o = obj(n);
  const shop = (set: unknown) => { const s = maybeObj(set); return s ? obj(s.shopMoney) : null; };
  const subtotal = shop(o.subtotalPriceSet), total = shop(o.totalPriceSet);
  if (!total) bad();
  const currency = typeof total.currencyCode === 'string' && /^[A-Z]{3}$/.test(total.currencyCode) ? total.currencyCode : bad();
  const lines = list(obj(o.lineItems).nodes).slice(0, 50).map(l => {
    const x = obj(l), variant = maybeObj(x.variant), price = shop(x.originalUnitPriceSet);
    return { title: cleanText(x.title) ?? 'Item', sku: cleanText(x.sku), variantId: variant ? gidNumber(variant.id, 'ProductVariant') : null,
      quantity: int(x.quantity, 0, 100_000), unitPrice: price ? money(price.amount) : '0' };
  });
  return { id: gidNumber(o.id, 'Order'), name: cleanText(o.name, 64) ?? bad(), placedAt: instant(o.createdAt), cancelledAt: o.cancelledAt ? instant(o.cancelledAt) : null,
    financialStatus: word(o.displayFinancialStatus), fulfillmentStatus: word(o.displayFulfillmentStatus), sourceName: cleanText(o.sourceName, 64), currency,
    subtotal: subtotal ? money(subtotal.amount) : money(total.amount), discounts: money(shop(o.totalDiscountsSet)?.amount ?? '0'),
    tax: money(shop(o.totalTaxSet)?.amount ?? '0'), total: money(total.amount), lines };
}

function tokensFrom(body: unknown, now: number): ShopifyTokens {
  const b = obj(body);
  const access = b.access_token, refresh = b.refresh_token, scope = b.scope;
  const token = /^[\x21-\x7e]{1,1024}$/;
  if (typeof access !== 'string' || !token.test(access) || typeof refresh !== 'string' || !token.test(refresh) || typeof scope !== 'string' || !/^[a-z_,]{0,800}$/.test(scope)) bad();
  const expiresIn = int(b.expires_in, 60, 31_536_000), refreshIn = int(b.refresh_token_expires_in, 60, 31_536_000);
  return { accessToken: access, refreshToken: refresh, scope, accessExpiresAt: new Date(now + expiresIn * 1000).toISOString(),
    refreshExpiresAt: new Date(now + Math.max(refreshIn, expiresIn) * 1000).toISOString() };
}

// ---------------------------------------------------------------------------------------------------------------------

const VARIANTS_QUERY = `query HonVariants($after: String) {
  productVariants(first: 100, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id title sku barcode price compareAtPrice inventoryQuantity position
      inventoryItem { tracked unitCost { amount } }
      product { id title status vendor productType handle featuredMedia { preview { image { url } } } }
    }
  }
}`;
const ORDERS_QUERY = `query HonOrders($after: String, $q: String) {
  orders(first: 10, after: $after, query: $q, sortKey: CREATED_AT, reverse: true) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id name createdAt cancelledAt displayFinancialStatus displayFulfillmentStatus sourceName
      subtotalPriceSet { shopMoney { amount currencyCode } }
      totalDiscountsSet { shopMoney { amount } }
      totalTaxSet { shopMoney { amount } }
      totalPriceSet { shopMoney { amount currencyCode } }
      lineItems(first: ${SHOPIFY_ORDER_LINES}) { nodes { title sku quantity variant { id } originalUnitPriceSet { shopMoney { amount } } } }
    }
  }
}`;
const SHOP_QUERY = 'query HonShop { shop { name currencyCode } }';

/** The Shopify Admin API through the HON app. Only called with a verified shop and a token HON holds. */
export class GraphqlShopifyAdapter implements ShopifyAdapter {
  readonly kind = 'SHOPIFY' as const;
  constructor(private readonly clientId: string, private readonly clientSecret: string, private readonly send: typeof fetch,
    private readonly wait: (ms: number) => Promise<void> = ms => new Promise(r => setTimeout(r, ms))) {}

  private async request(url: string, init: RequestInit): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      let r: Response;
      try { r = await this.send(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(20_000) }); }
      catch { throw new ShopifyProviderError('UNAVAILABLE'); }
      if (r.status === 429 && attempt < 3) { await this.wait(1000 * 2 ** attempt); continue; }
      if (r.status === 429) throw new ShopifyProviderError('RATE_LIMITED');
      if (r.status === 401 || r.status === 403) throw new ShopifyProviderError('AUTH');
      if (r.status === 400 && url.endsWith('/admin/oauth/access_token')) throw new ShopifyProviderError('AUTH');
      if (!r.ok) throw new ShopifyProviderError('UNAVAILABLE');
      const text = await r.text();
      if (text.length > 5_000_000) bad();
      try { return JSON.parse(text) as unknown; } catch { return bad(); }
    }
  }

  private async graphql(shop: string, token: string, query: string, variables: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!SHOP_DOMAIN.test(shop)) bad();
    for (let attempt = 0; ; attempt++) {
      const body = obj(await this.request(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Shopify-Access-Token': token },
        body: JSON.stringify({ query, variables }) }));
      if (Array.isArray(body.errors) && body.errors.length) {
        const throttled = body.errors.some(e => obj(e).extensions && obj(obj(e).extensions).code === 'THROTTLED');
        if (throttled && attempt < 3) { await this.wait(1000 * 2 ** attempt); continue; }
        throw new ShopifyProviderError(throttled ? 'RATE_LIMITED' : 'INVALID_RESPONSE');
      }
      return obj(body.data);
    }
  }

  private async token(shop: string, form: Record<string, string>): Promise<ShopifyTokens> {
    if (!SHOP_DOMAIN.test(shop)) bad();
    const now = Date.now();
    const body = await this.request(`https://${shop}/admin/oauth/access_token`, { method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ client_id: this.clientId, client_secret: this.clientSecret, ...form }).toString() });
    return tokensFrom(body, now);
  }

  exchangeCode(shop: string, code: string) { return this.token(shop, { code, expiring: '1' }); }
  refresh(shop: string, refreshToken: string) { return this.token(shop, { grant_type: 'refresh_token', refresh_token: refreshToken }); }

  async shopInfo(shop: string, accessToken: string): Promise<ShopifyShopInfo> {
    const s = obj((await this.graphql(shop, accessToken, SHOP_QUERY, {})).shop);
    const currency = typeof s.currencyCode === 'string' && /^[A-Z]{3}$/.test(s.currencyCode) ? s.currencyCode : bad();
    return { name: cleanText(s.name, 120) ?? shop, currency };
  }

  async catalog(shop: string, accessToken: string): Promise<{ products: MirrorProduct[]; complete: boolean }> {
    const nodes: unknown[] = [];
    let after: string | null = null, complete = true;
    for (;;) {
      const page = obj((await this.graphql(shop, accessToken, VARIANTS_QUERY, { after })).productVariants);
      nodes.push(...list(page.nodes));
      const info = obj(page.pageInfo);
      if (info.hasNextPage !== true) break;
      if (nodes.length >= SHOPIFY_MAX_VARIANTS) { complete = false; break; }
      after = typeof info.endCursor === 'string' && info.endCursor.length <= 1024 ? info.endCursor : bad();
    }
    const products = productsFromVariantNodes(nodes);
    if (products.length > SHOPIFY_MAX_PRODUCTS) return { products: products.slice(0, SHOPIFY_MAX_PRODUCTS), complete: false };
    return { products, complete };
  }

  async orders(shop: string, accessToken: string, sinceIso: string): Promise<{ orders: MirrorOrder[]; complete: boolean }> {
    const out: MirrorOrder[] = [];
    let after: string | null = null;
    const q = `created_at:>='${sinceIso}'`;
    for (;;) {
      const page = obj((await this.graphql(shop, accessToken, ORDERS_QUERY, { after, q })).orders);
      out.push(...list(page.nodes).map(orderFromNode));
      const info = obj(page.pageInfo);
      if (info.hasNextPage !== true) return { orders: out.slice(0, SHOPIFY_MAX_ORDERS), complete: out.length <= SHOPIFY_MAX_ORDERS };
      if (out.length >= SHOPIFY_MAX_ORDERS) return { orders: out.slice(0, SHOPIFY_MAX_ORDERS), complete: false };
      after = typeof info.endCursor === 'string' && info.endCursor.length <= 1024 ? info.endCursor : bad();
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------

/**
 * In-memory Shopify for development and tests. Every store starts with the same small martial-arts catalog and a few
 * orders. Tokens expire after an hour like Shopify's; tests can reject tokens or change the catalog.
 */
export class FakeShopify implements ShopifyAdapter {
  readonly kind = 'FAKE' as const;
  private readonly codes = new Map<string, string>();
  private readonly tokens = new Map<string, { shop: string; kind: 'access' | 'refresh'; expiresAt: number }>();
  private readonly stores = new Map<string, { products: MirrorProduct[]; orders: MirrorOrder[]; name: string; currency: string; rejected: boolean }>();
  /** Calls the API made, for tests (no token values). */
  readonly calls: string[] = [];
  /** Test hook: the clock the fake uses. */
  now: () => number = () => Date.now();

  constructor(private readonly clientId: string, private readonly secret: string) {}

  private store(shop: string) {
    let s = this.stores.get(shop);
    if (!s) { s = { ...sampleStore(shop, this.now()), rejected: false }; this.stores.set(shop, s); }
    return s;
  }
  /** Test hook: replace a store's catalog or orders. */
  setStore(shop: string, change: Partial<{ products: MirrorProduct[]; orders: MirrorOrder[]; name: string; currency: string }>): void { Object.assign(this.store(shop), change); }
  /** Test hook: every token of this shop is refused from now on (the owner uninstalled the app). */
  rejectTokens(shop: string, rejected = true): void { this.store(shop).rejected = rejected; }

  /** What Shopify's redirect would carry after the owner approves: a signed query for HON's return page. */
  approve(shop: string, state: string, at: number = this.now()): string {
    const code = randomBytes(16).toString('hex');
    this.codes.set(code, shop);
    const params = { code, host: Buffer.from(`admin.shopify.com/store/${shop.split('.')[0]}`).toString('base64url'), shop, state, timestamp: String(Math.floor(at / 1000)) };
    return new URLSearchParams({ ...params, hmac: signShopifyQuery(params, this.secret) }).toString();
  }

  private issue(shop: string): ShopifyTokens {
    const now = this.now(), access = 'fake_at_' + randomBytes(16).toString('hex'), refresh = 'fake_rt_' + randomBytes(16).toString('hex');
    this.tokens.set(access, { shop, kind: 'access', expiresAt: now + 3600_000 });
    this.tokens.set(refresh, { shop, kind: 'refresh', expiresAt: now + 90 * 86400_000 });
    return { accessToken: access, refreshToken: refresh, scope: SHOPIFY_SCOPES.join(','), accessExpiresAt: new Date(now + 3600_000).toISOString(),
      refreshExpiresAt: new Date(now + 90 * 86400_000).toISOString() };
  }
  private check(shop: string, token: string, kind: 'access' | 'refresh'): void {
    const t = this.tokens.get(token);
    if (!t || t.shop !== shop || t.kind !== kind || t.expiresAt <= this.now() || this.store(shop).rejected) throw new ShopifyProviderError('AUTH');
  }

  async exchangeCode(shop: string, code: string): Promise<ShopifyTokens> {
    this.calls.push('exchangeCode:' + shop);
    if (this.codes.get(code) !== shop) throw new ShopifyProviderError('AUTH');
    this.codes.delete(code);
    return this.issue(shop);
  }
  async refresh(shop: string, refreshToken: string): Promise<ShopifyTokens> {
    this.calls.push('refresh:' + shop);
    this.check(shop, refreshToken, 'refresh');
    this.tokens.delete(refreshToken);
    return this.issue(shop);
  }
  async shopInfo(shop: string, accessToken: string): Promise<ShopifyShopInfo> {
    this.calls.push('shopInfo:' + shop); this.check(shop, accessToken, 'access');
    const s = this.store(shop); return { name: s.name, currency: s.currency };
  }
  async catalog(shop: string, accessToken: string) {
    this.calls.push('catalog:' + shop); this.check(shop, accessToken, 'access');
    return { products: structuredClone(this.store(shop).products), complete: true };
  }
  async orders(shop: string, accessToken: string, sinceIso: string) {
    this.calls.push('orders:' + shop); this.check(shop, accessToken, 'access');
    return { orders: structuredClone(this.store(shop).orders.filter(o => o.placedAt >= sinceIso)), complete: true };
  }
}

function sampleStore(shop: string, now: number): { products: MirrorProduct[]; orders: MirrorOrder[]; name: string; currency: string } {
  const v = (id: string, title: string, sku: string, price: string, unitCost: string | null, qty: number | null): MirrorVariant =>
    ({ id, title, sku, barcode: null, price, compareAtPrice: null, unitCost, tracked: qty !== null, inventoryQuantity: qty });
  const products: MirrorProduct[] = [
    { id: '9100000001', title: 'Student uniform', status: 'ACTIVE', vendor: 'HON Sample', productType: 'Uniform', handle: 'student-uniform', imageUrl: null,
      variants: [v('9200000011', 'Size 1', 'UNI-1', '65.00', '28.00', 8), v('9200000012', 'Size 2', 'UNI-2', '65.00', '28.00', 2), v('9200000013', 'Size 3', 'UNI-3', '70.00', '30.00', 0)] },
    { id: '9100000002', title: 'Sparring gear set', status: 'ACTIVE', vendor: 'HON Sample', productType: 'Equipment', handle: 'sparring-gear-set', imageUrl: null,
      variants: [v('9200000021', 'Youth', 'SPAR-Y', '120.00', '64.50', 5), v('9200000022', 'Adult', 'SPAR-A', '135.00', null, 4)] },
    { id: '9100000003', title: 'School hoodie', status: 'ACTIVE', vendor: 'HON Sample', productType: 'Apparel', handle: 'school-hoodie', imageUrl: null,
      variants: [v('9200000031', 'Black / M', 'HOOD-BK-M', '45.00', '19.25', null)] },
  ];
  const day = (n: number) => new Date(now - n * 86400_000).toISOString();
  const orders: MirrorOrder[] = [
    { id: '9300000001', name: '#1001', placedAt: day(2), cancelledAt: null, financialStatus: 'PAID', fulfillmentStatus: 'FULFILLED', sourceName: 'web', currency: 'USD',
      subtotal: '130.00', discounts: '0', tax: '10.73', total: '140.73', lines: [{ title: 'Student uniform', sku: 'UNI-2', variantId: '9200000012', quantity: 2, unitPrice: '65.00' }] },
    { id: '9300000002', name: '#1002', placedAt: day(5), cancelledAt: null, financialStatus: 'PAID', fulfillmentStatus: 'UNFULFILLED', sourceName: 'pos', currency: 'USD',
      subtotal: '165.00', discounts: '15.00', tax: '0', total: '150.00', lines: [
        { title: 'Sparring gear set', sku: 'SPAR-A', variantId: '9200000022', quantity: 1, unitPrice: '135.00' },
        { title: 'School hoodie', sku: 'HOOD-BK-M', variantId: '9200000031', quantity: 1, unitPrice: '45.00' }] },
    { id: '9300000003', name: '#1003', placedAt: day(40), cancelledAt: null, financialStatus: 'PAID', fulfillmentStatus: 'FULFILLED', sourceName: 'web', currency: 'USD',
      subtotal: '120.00', discounts: '0', tax: '0', total: '120.00', lines: [{ title: 'Sparring gear set', sku: 'SPAR-Y', variantId: '9200000021', quantity: 1, unitPrice: '120.00' }] },
  ];
  return { products, orders, name: shop.split('.')[0]!.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '), currency: 'USD' };
}
