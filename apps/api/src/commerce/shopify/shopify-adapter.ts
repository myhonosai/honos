import { randomBytes, randomUUID } from 'node:crypto';
import { SHOPIFY_SCOPES, SHOPIFY_STOREFRONT_METAFIELD, type ShopifyFinanceSnapshot, type ShopifyStorefrontSettings } from '@hon/contracts';
import { SHOP_DOMAIN, signShopifyQuery } from './shopify-oauth.js';
import { signShopifyWebhook } from './shopify-webhook.js';
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

/** REJECTED (SH4a): Shopify answered a write with user errors, so nothing in that write was saved. */
export type ShopifyFailure = 'AUTH' | 'RATE_LIMITED' | 'UNAVAILABLE' | 'INVALID_RESPONSE' | 'REJECTED';
/** The only error the adapter throws: never a Shopify body, header or token. */
export class ShopifyProviderError extends Error { constructor(readonly failure: ShopifyFailure) { super(failure); } }

export interface ShopifyTokens { accessToken: string; refreshToken: string; accessExpiresAt: string; refreshExpiresAt: string; scope: string }
export interface ShopifyShopInfo { name: string; currency: string }
/** Exactly the page shapes hon.record_shopify_sync_page accepts. */
export interface MirrorVariant {
  id: string; title: string; sku: string | null; barcode: string | null; price: string; compareAtPrice: string | null; unitCost: string | null;
  tracked: boolean; inventoryQuantity: number | null;
  /** The third-party fulfilment service that stocks this variant (a print-on-demand provider, for example), null for the school's own
   *  location. Left out when the read did not ask Shopify, so the mirror keeps what it had. */
  fulfilledBy?: string | null;
}
export interface MirrorProduct {
  id: string; title: string; status: 'ACTIVE' | 'DRAFT' | 'ARCHIVED' | 'UNLISTED'; vendor: string | null; productType: string | null; handle: string | null;
  imageUrl: string | null; variants: MirrorVariant[];
}
/** SH4a: a new product, always created as DRAFT under the handle HON chose. */
export interface ShopifyDraftInput {
  title: string; descriptionHtml: string | null; productType: string | null; vendor: string | null; handle: string;
  price: string; compareAtPrice: string | null; unitCost: string | null; sku: string | null;
}
export interface ShopifyProductFields { title?: string; productType?: string | null; vendor?: string | null; status?: 'ACTIVE' | 'DRAFT' | 'ARCHIVED' }
export interface ShopifyVariantFields { variantId: string; price?: string; compareAtPrice?: string | null; unitCost?: string | null }
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
  // SH4a writes, each called only after a person approved that exact change.
  product(shop: string, accessToken: string, productId: string): Promise<MirrorProduct | null>;
  productByHandle(shop: string, accessToken: string, handle: string): Promise<MirrorProduct | null>;
  /** Creates the DRAFT product and returns its id (its one variant is priced by updateVariants). */
  createDraft(shop: string, accessToken: string, input: ShopifyDraftInput): Promise<{ productId: string; variantId: string }>;
  updateProduct(shop: string, accessToken: string, productId: string, fields: ShopifyProductFields): Promise<void>;
  updateVariants(shop: string, accessToken: string, productId: string, variants: readonly ShopifyVariantFields[], sku?: string | null): Promise<void>;
  /** SH-F1 read: the Shopify Payments balance, the latest 20 payouts and the latest 50 balance transactions. Needs read_shopify_payments_accounts. */
  finance(shop: string, accessToken: string): Promise<ShopifyFinanceSnapshot>;
  /**
   * TB2: the school's storefront settings as one app-data metafield on HON's own app installation, which HON's theme app
   * extension reads. Idempotent: setting the same value again changes nothing. Needs no access scope.
   */
  setStorefrontSettings(shop: string, accessToken: string, settings: ShopifyStorefrontSettings): Promise<void>;
  /**
   * SH2 (0613): add `delta` to a variant's available count at the store's one own stock location (never a print
   * provider's). `idempotencyKey` is sent as Shopify's own idempotency key, so the same key changes the count at most
   * once however often it is sent. A change Shopify cannot take as it is comes back as REFUSED with the reason; a lost
   * or failed call throws. Needs write_inventory.
   */
  adjustInventory(shop: string, accessToken: string, input: ShopifyInventoryAdjustment): Promise<ShopifyInventoryAnswer>;
  /**
   * SH2b (0614): the PAID order a print provider works from, for made-to-order items sold at the front desk. HON took
   * the money at the desk and sends the customer nothing. The order carries the tag `hon-pos-<key>`; an order that
   * already has it is answered instead of creating a second one. A refusal by Shopify's own rules is REFUSED; a lost
   * or failed call throws. Needs write_orders (and read_orders to look for the tag).
   */
  createPosOrder(shop: string, accessToken: string, input: ShopifyPosOrderInput): Promise<ShopifyPosOrderAnswer>;
}
export interface ShopifyPosAddress { name: string; address1: string; address2: string | null; city: string; province: string | null; zip: string | null; country: string }
export interface ShopifyPosOrderInput {
  key: string; currency: string; note: string; shipTo: ShopifyPosAddress;
  /** unitPrice is a decimal string in the store currency: what the desk charged for one. */
  lines: readonly { variantId: string; quantity: number; unitPrice: string }[];
}
export type ShopifyPosOrderAnswer = { outcome: 'DONE'; orderId: string; orderName: string } | { outcome: 'REFUSED'; reason: 'SHOPIFY_REJECTED' };
export interface ShopifyInventoryAdjustment { variantId: string; delta: number; idempotencyKey: string; reference: string }
export type ShopifyInventoryRefusal = 'VARIANT_GONE' | 'NOT_TRACKED' | 'NO_LOCATION' | 'MULTIPLE_LOCATIONS' | 'SHOPIFY_REJECTED';
export type ShopifyInventoryAnswer = { outcome: 'DONE' } | { outcome: 'REFUSED'; reason: ShopifyInventoryRefusal };

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
/** Shopify Payments money, which may be negative ("-41.9"); at most 4 decimals kept. */
function signedMoney(v: unknown): string {
  const t = typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : null;
  if (t === null) bad();
  const m = /^(-?)(0|[1-9][0-9]{0,8})(?:\.([0-9]+))?$/.exec(t);
  if (!m) bad();
  return `${m[1]}${m[2]}${m[3] ? '.' + m[3].slice(0, 4) : ''}`;
}
function moneyV2(v: unknown): { amount: string; currency: string } {
  const o = obj(v);
  if (typeof o.currencyCode !== 'string' || !/^[A-Z]{3}$/.test(o.currencyCode)) bad();
  return { amount: signedMoney(o.amount), currency: o.currencyCode };
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

/** The first third-party fulfilment service among a variant's stock locations, by the name Shopify shows; null when the school's own
 *  locations stock it. A name HON cannot keep (empty, too long) is treated as unknown rather than refusing the whole page. */
export function fulfilledBy(levels: unknown): string | null {
  const nodes = obj(levels).nodes;
  if (!Array.isArray(nodes)) bad();
  for (const n of nodes as unknown[]) {
    const location = maybeObj(obj(n).location), service = location ? maybeObj(location.fulfillmentService) : null;
    if (!service || service.type !== 'THIRD_PARTY') continue;
    const name = cleanText(service.serviceName, 64);
    if (name) return name;
  }
  return null;
}

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
      inventoryQuantity: v.inventoryQuantity === null || v.inventoryQuantity === undefined ? null : int(v.inventoryQuantity, -10_000_000, 10_000_000),
      ...(item && item.inventoryLevels !== undefined ? { fulfilledBy: fulfilledBy(item.inventoryLevels) } : {}) });
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

const STOCK_LOCATIONS = ' inventoryLevels(first: 2) { nodes { location { fulfillmentService { serviceName type } } } }';
const variantsQuery = (stockLocations: boolean) => `query HonVariants($after: String) {
  productVariants(first: 50, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id title sku barcode price compareAtPrice inventoryQuantity position
      inventoryItem { tracked unitCost { amount }${stockLocations ? STOCK_LOCATIONS : ''} }
      product { id title status vendor productType handle featuredMedia { preview { image { url } } } }
    }
  }
}`;
const VARIANTS_QUERY = variantsQuery(true);
/** The catalog read without the stock locations: what the sync falls back to when Shopify refuses the full read. */
const VARIANTS_PLAIN_QUERY = variantsQuery(false);
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
const FINANCE_QUERY = `query HonFinance { shopifyPaymentsAccount { activated balance { amount currencyCode }
  payouts(first: 20, reverse: true) { nodes { id status transactionType issuedAt net { amount currencyCode } } }
  balanceTransactions(first: 50, reverse: true) { nodes { id type test transactionDate amount { amount currencyCode }
    fee { amount currencyCode } net { amount currencyCode } associatedPayout { id } } } } }`;
const PRODUCT_FIELDS = `id title status vendor productType handle featuredMedia { preview { image { url } } }
    variants(first: 100) { nodes { id title sku barcode price compareAtPrice inventoryQuantity position inventoryItem { tracked unitCost { amount } } } }`;
const PRODUCT_QUERY = `query HonProduct($id: ID!) { product(id: $id) { ${PRODUCT_FIELDS} } }`;
const PRODUCT_BY_HANDLE_QUERY = `query HonProductByHandle($handle: String!) { productByIdentifier(identifier: { handle: $handle }) { ${PRODUCT_FIELDS} } }`;
const CREATE_DRAFT = `mutation HonCreateDraft($product: ProductCreateInput!) {
  productCreate(product: $product) { product { id variants(first: 1) { nodes { id } } } userErrors { field message } }
}`;
const UPDATE_PRODUCT = `mutation HonUpdateProduct($product: ProductUpdateInput!) {
  productUpdate(product: $product) { product { id } userErrors { field message } }
}`;
const UPDATE_VARIANTS = `mutation HonUpdateVariants($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
  productVariantsBulkUpdate(productId: $productId, variants: $variants) { product { id } userErrors { field message } }
}`;

/** One product node (with its variants connection) as a mirror record, or null when Shopify has none. */
export function productFromNode(n: unknown): MirrorProduct | null {
  if (n === null || n === undefined) return null;
  const p = obj(n), { variants, ...rest } = p;
  const nodes = list(obj(variants).nodes).map(v => ({ ...obj(v), product: rest }));
  if (nodes.length === 0) bad();
  return productsFromVariantNodes(nodes)[0] ?? bad();
}
/** A payload's userErrors: any at all means Shopify saved nothing in that write. */
function noUserErrors(payload: unknown): Record<string, unknown> {
  const p = obj(payload);
  if (list(p.userErrors).length > 0) throw new ShopifyProviderError('REJECTED');
  return p;
}
const blankable = (v: string | null | undefined) => (v === undefined ? undefined : v ?? '');
export function variantInputs(variants: readonly ShopifyVariantFields[], sku?: string | null): Record<string, unknown>[] {
  return variants.map((v, i) => {
    const item: Record<string, unknown> = {};
    if (v.unitCost !== undefined) item.cost = v.unitCost;
    if (i === 0 && sku) item.sku = sku;
    return { id: `gid://shopify/ProductVariant/${v.variantId}`, ...(v.price !== undefined ? { price: v.price } : {}),
      ...(v.compareAtPrice !== undefined ? { compareAtPrice: v.compareAtPrice } : {}), ...(Object.keys(item).length ? { inventoryItem: item } : {}) };
  });
}

/** The Shopify Admin API through the HON app. Only called with a verified shop and a token HON holds. */
/** shopifyPaymentsAccount as HON keeps it: ids, statuses, instants and amounts only. null or not activated -> payments off. */
export function financeFromAccount(v: unknown): ShopifyFinanceSnapshot {
  const a = maybeObj(v);
  if (!a || a.activated !== true) return { paymentsActive: false, balances: [], payouts: [], transactions: [] };
  const seen = new Set<string>();
  const balances = list(a.balance).slice(0, 10).map(moneyV2).filter(b => !seen.has(b.currency) && !!seen.add(b.currency))
    .map(b => ({ currency: b.currency, amount: b.amount }));
  const payouts = list(obj(a.payouts).nodes).slice(0, 20).map(n => {
    const p = obj(n), net = moneyV2(p.net);
    const status = ['SCHEDULED', 'IN_TRANSIT', 'PAID', 'FAILED', 'CANCELED'].includes(p.status as string) ? p.status as ShopifyFinanceSnapshot['payouts'][number]['status'] : bad();
    const direction: 'DEPOSIT' | 'WITHDRAWAL' = p.transactionType === 'DEPOSIT' || p.transactionType === 'WITHDRAWAL' ? p.transactionType : bad();
    return { id: gidNumber(p.id, 'ShopifyPaymentsPayout'), status, direction, issuedAt: instant(p.issuedAt), currency: net.currency, net: net.amount };
  });
  const transactions = list(obj(a.balanceTransactions).nodes).slice(0, 50).map(n => {
    const t = obj(n), amount = moneyV2(t.amount), fee = signedMoney(obj(t.fee).amount), net = signedMoney(obj(t.net).amount);
    const type = word(t.type); if (type === null) bad();
    if (typeof t.test !== 'boolean') bad();
    const payout = maybeObj(t.associatedPayout);
    return { id: gidNumber(t.id, 'ShopifyPaymentsBalanceTransaction'), type, at: instant(t.transactionDate), currency: amount.currency,
      amount: amount.amount, fee, net, test: t.test, payoutId: payout && payout.id != null ? gidNumber(payout.id, 'ShopifyPaymentsPayout') : null };
  });
  if (new Set(payouts.map(p => p.id)).size !== payouts.length || new Set(transactions.map(t => t.id)).size !== transactions.length) bad();
  return { paymentsActive: true, balances, payouts, transactions };
}

// ---- TB2 storefront settings (app-data metafield on HON's own app installation) ----
const APP_INSTALLATION_QUERY = `query HonAppInstallation { currentAppInstallation { id } }`;
const METAFIELDS_SET = `mutation HonStorefrontSettings($metafields: [MetafieldsSetInput!]!) {
  metafieldsSet(metafields: $metafields) { metafields { namespace key } userErrors { field message } } }`;
/** The metafield value: the settings as compact JSON, the keys in a fixed order. */
export function storefrontValue(v: ShopifyStorefrontSettings): string {
  return JSON.stringify({ primaryColor: v.primaryColor, accentColor: v.accentColor, sizeGuideTitle: v.sizeGuideTitle,
    sizeGuideText: v.sizeGuideText, pickupNote: v.pickupNote });
}

// ---- SH2 inventory adjustment (a POS sale or a refund restock) ----
const VARIANT_STOCK_QUERY = `query HonVariantStock($id: ID!) { productVariant(id: $id) { id inventoryItem { id tracked
  inventoryLevels(first: 20) { nodes { location { id isActive fulfillmentService { type } } } } } } }`;
const INVENTORY_ADJUST = `mutation HonPosStock($input: InventoryAdjustQuantitiesInput!, $key: String!) {
  inventoryAdjustQuantities(input: $input) @idempotent(key: $key) { inventoryAdjustmentGroup { id } userErrors { field message } } }`;
const POS_ORDER_FIND = `query HonPosOrderFind($query: String!) { orders(first: 1, query: $query) { nodes { id name } } }`;
const POS_ORDER_CREATE = `mutation HonPosOrder($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput) {
  orderCreate(order: $order, options: $options) { order { id name } userErrors { field message } } }`;
const POS_ORDER_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** The tag that makes a front-desk order findable again after a lost answer. */
export const posOrderTag = (key: string) => `hon-pos-${key}`;
/** Shopify's order as HON keeps it: the numeric id and the name staff see (for example #1042). */
function posOrderFrom(v: unknown): { orderId: string; orderName: string } {
  const o = obj(v), name = cleanText(o.name, 40);
  if (!name) bad();
  return { orderId: gidNumber(o.id, 'Order'), orderName: name };
}
/** The exact orderCreate variables for a front-desk order: paid, no customer record, no email, inventory left alone. */
export function posOrderVariables(input: ShopifyPosOrderInput): Record<string, unknown> {
  if (!POS_ORDER_KEY.test(input.key) || !/^[A-Z]{3}$/.test(input.currency) || input.lines.length < 1 || input.lines.length > 50) bad();
  const a = input.shipTo;
  return {
    order: {
      currency: input.currency, financialStatus: 'PAID', note: input.note, tags: ['hon-pos', posOrderTag(input.key)],
      lineItems: input.lines.map((l) => {
        if (!/^[1-9][0-9]{0,17}$/.test(l.variantId) || !Number.isInteger(l.quantity) || l.quantity < 1 || l.quantity > 999 || !/^\d{1,9}(\.\d{1,2})?$/.test(l.unitPrice)) bad();
        return { variantId: `gid://shopify/ProductVariant/${l.variantId}`, quantity: l.quantity, priceSet: { shopMoney: { amount: l.unitPrice, currencyCode: input.currency } } };
      }),
      shippingAddress: { lastName: a.name, address1: a.address1, ...(a.address2 ? { address2: a.address2 } : {}), city: a.city,
        ...(a.province ? { provinceCode: a.province } : {}), ...(a.zip ? { zip: a.zip } : {}), countryCode: a.country },
    },
    options: { inventoryBehaviour: 'BYPASS', sendReceipt: false, sendFulfillmentReceipt: false },
  };
}
/** Where HON may change a variant's count: its inventory item and the store's one own, active location stocking it. */
export function ownStockLocation(variant: unknown): { inventoryItemId: string; locationId: string } | ShopifyInventoryRefusal {
  if (variant === null || variant === undefined) return 'VARIANT_GONE';
  const item = maybeObj(obj(variant).inventoryItem);
  if (!item || typeof item.id !== 'string' || !/^gid:\/\/shopify\/InventoryItem\/[1-9][0-9]{0,17}$/.test(item.id)) return bad();
  if (item.tracked !== true) return 'NOT_TRACKED';
  const own: string[] = [];
  for (const n of list(obj(item.inventoryLevels).nodes)) {
    const location = maybeObj(obj(n).location);
    if (!location || location.isActive === false) continue;
    const service = maybeObj(location.fulfillmentService);
    if (service && service.type === 'THIRD_PARTY') continue;
    if (typeof location.id !== 'string' || !/^gid:\/\/shopify\/Location\/[1-9][0-9]{0,17}$/.test(location.id)) return bad();
    own.push(location.id);
  }
  if (own.length === 0) return 'NO_LOCATION';
  if (own.length > 1) return 'MULTIPLE_LOCATIONS';
  return { inventoryItemId: item.id, locationId: own[0]! };
}

/**
 * One log line for a GraphQL answer Shopify refused, so the cause can be found afterwards. It names HON's own operation
 * and, per error, only Shopify's machine code, the field names on the error's path and any access scope names. Never the
 * shop, the message text, ids or values: field names and scope names come from HON's query and Shopify's public schema.
 */
export function refusalNote(query: string, errors: readonly unknown[]): string {
  const operation = /^(?:query|mutation) ([A-Za-z]{1,40})/.exec(query)?.[1] ?? 'unknown';
  const parts = errors.slice(0, 5).map((e) => {
    const rec = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
    const o = rec(e), x = rec(o.extensions);
    const code = typeof x.code === 'string' && /^[A-Z_]{1,40}$/.test(x.code) ? x.code : 'NO_CODE';
    const path = Array.isArray(o.path) ? o.path.filter((s): s is string => typeof s === 'string' && /^[A-Za-z]{1,40}$/.test(s)).slice(0, 8).join('.') : '';
    const scopes = [...new Set(`${typeof x.requiredAccess === 'string' ? x.requiredAccess : ''} ${typeof o.message === 'string' ? o.message : ''}`
      .match(/\b(?:read|write)_[a-z_]{1,50}\b/g) ?? [])].slice(0, 6).join(',');
    return `${code}${path ? ' at ' + path : ''}${scopes ? ' needs ' + scopes : ''}`;
  });
  return `shopify_graphql_refused operation=${operation} errors=${errors.length} [${parts.join('; ')}]`;
}

export class GraphqlShopifyAdapter implements ShopifyAdapter {
  readonly kind = 'SHOPIFY' as const;
  constructor(private readonly clientId: string, private readonly clientSecret: string, private readonly send: typeof fetch,
    private readonly wait: (ms: number) => Promise<void> = ms => new Promise(r => setTimeout(r, ms)),
    private readonly note: (line: string) => void = line => console.warn(line)) {}

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
        if (!throttled) this.note(refusalNote(query, body.errors));
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

  async finance(shop: string, accessToken: string): Promise<ShopifyFinanceSnapshot> {
    return financeFromAccount((await this.graphql(shop, accessToken, FINANCE_QUERY, {})).shopifyPaymentsAccount);
  }

  async setStorefrontSettings(shop: string, accessToken: string, settings: ShopifyStorefrontSettings): Promise<void> {
    const installation = obj((await this.graphql(shop, accessToken, APP_INSTALLATION_QUERY, {})).currentAppInstallation);
    if (typeof installation.id !== 'string' || !/^gid:\/\/shopify\/AppInstallation\/[1-9][0-9]{0,17}$/.test(installation.id)) bad();
    const r = obj((await this.graphql(shop, accessToken, METAFIELDS_SET, { metafields: [{ ownerId: installation.id,
      namespace: SHOPIFY_STOREFRONT_METAFIELD.namespace, key: SHOPIFY_STOREFRONT_METAFIELD.key, type: 'json', value: storefrontValue(settings) }] })).metafieldsSet);
    if (list(r.userErrors).length) throw new ShopifyProviderError('REJECTED');
    const set = list(r.metafields).map(obj);
    if (set.length !== 1 || set[0]!.namespace !== SHOPIFY_STOREFRONT_METAFIELD.namespace || set[0]!.key !== SHOPIFY_STOREFRONT_METAFIELD.key) bad();
  }

  async adjustInventory(shop: string, accessToken: string, input: ShopifyInventoryAdjustment): Promise<ShopifyInventoryAnswer> {
    if (!/^[1-9][0-9]{0,17}$/.test(input.variantId) || !Number.isInteger(input.delta) || input.delta === 0 || Math.abs(input.delta) > 999) bad();
    const where = ownStockLocation((await this.graphql(shop, accessToken, VARIANT_STOCK_QUERY, { id: `gid://shopify/ProductVariant/${input.variantId}` })).productVariant);
    if (typeof where === 'string') return { outcome: 'REFUSED', reason: where };
    const r = obj((await this.graphql(shop, accessToken, INVENTORY_ADJUST, { key: input.idempotencyKey, input: { reason: 'correction', name: 'available',
      referenceDocumentUri: input.reference, changes: [{ delta: input.delta, inventoryItemId: where.inventoryItemId, locationId: where.locationId, changeFromQuantity: null }] } })).inventoryAdjustQuantities);
    if (list(r.userErrors).length) return { outcome: 'REFUSED', reason: 'SHOPIFY_REJECTED' };
    return { outcome: 'DONE' };
  }

  async createPosOrder(shop: string, accessToken: string, input: ShopifyPosOrderInput): Promise<ShopifyPosOrderAnswer> {
    const variables = posOrderVariables(input);
    const found = list(obj((await this.graphql(shop, accessToken, POS_ORDER_FIND, { query: `tag:'${posOrderTag(input.key)}'` })).orders).nodes);
    if (found.length) return { outcome: 'DONE', ...posOrderFrom(found[0]) };
    const r = obj((await this.graphql(shop, accessToken, POS_ORDER_CREATE, variables)).orderCreate);
    if (list(r.userErrors).length) return { outcome: 'REFUSED', reason: 'SHOPIFY_REJECTED' };
    return { outcome: 'DONE', ...posOrderFrom(r.order) };
  }

  async catalog(shop: string, accessToken: string): Promise<{ products: MirrorProduct[]; complete: boolean }> {
    const nodes: unknown[] = [];
    let after: string | null = null, complete = true, query = VARIANTS_QUERY;
    for (;;) {
      let data: Record<string, unknown>;
      try { data = await this.graphql(shop, accessToken, query, { after }); } catch (e) {
        // Some stores refuse the stock-location part of the read (a location another app owns, for example), and Shopify
        // then answers nothing for the whole page. The catalog matters more than who fulfils it: read the rest of this
        // sync without that part. Variants then carry no fulfilledBy, so the mirror keeps what it had.
        if (!(e instanceof ShopifyProviderError) || e.failure !== 'INVALID_RESPONSE' || query === VARIANTS_PLAIN_QUERY) throw e;
        query = VARIANTS_PLAIN_QUERY;
        continue;
      }
      const page = obj(data.productVariants);
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

  async product(shop: string, accessToken: string, productId: string): Promise<MirrorProduct | null> {
    return productFromNode((await this.graphql(shop, accessToken, PRODUCT_QUERY, { id: `gid://shopify/Product/${productId}` })).product);
  }
  async productByHandle(shop: string, accessToken: string, handle: string): Promise<MirrorProduct | null> {
    return productFromNode((await this.graphql(shop, accessToken, PRODUCT_BY_HANDLE_QUERY, { handle })).productByIdentifier);
  }
  async createDraft(shop: string, accessToken: string, input: ShopifyDraftInput): Promise<{ productId: string; variantId: string }> {
    const product = { title: input.title, handle: input.handle, status: 'DRAFT', ...(input.descriptionHtml ? { descriptionHtml: input.descriptionHtml } : {}),
      ...(input.productType ? { productType: input.productType } : {}), ...(input.vendor ? { vendor: input.vendor } : {}) };
    const p = noUserErrors((await this.graphql(shop, accessToken, CREATE_DRAFT, { product })).productCreate);
    const created = obj(p.product), first = list(obj(created.variants).nodes)[0];
    return { productId: gidNumber(created.id, 'Product'), variantId: gidNumber(obj(first).id, 'ProductVariant') };
  }
  async updateProduct(shop: string, accessToken: string, productId: string, fields: ShopifyProductFields): Promise<void> {
    const product = { id: `gid://shopify/Product/${productId}`, ...(fields.title !== undefined ? { title: fields.title } : {}),
      ...(fields.status !== undefined ? { status: fields.status } : {}), ...(fields.productType !== undefined ? { productType: blankable(fields.productType) } : {}),
      ...(fields.vendor !== undefined ? { vendor: blankable(fields.vendor) } : {}) };
    noUserErrors((await this.graphql(shop, accessToken, UPDATE_PRODUCT, { product })).productUpdate);
  }
  async updateVariants(shop: string, accessToken: string, productId: string, variants: readonly ShopifyVariantFields[], sku?: string | null): Promise<void> {
    noUserErrors((await this.graphql(shop, accessToken, UPDATE_VARIANTS, { productId: `gid://shopify/Product/${productId}`, variants: variantInputs(variants, sku) }))
      .productVariantsBulkUpdate);
  }
}

// ---------------------------------------------------------------------------------------------------------------------

/**
 * In-memory Shopify for development and tests. Every store starts with the same small martial-arts catalog and a few
 * orders. Tokens expire after an hour like Shopify's; tests can reject tokens or change the catalog.
 */
export class FakeShopify implements ShopifyAdapter {
  readonly kind = 'FAKE' as const;
  private readonly codes = new Map<string, { shop: string; scope: string }>();
  private readonly tokens = new Map<string, { shop: string; kind: 'access' | 'refresh'; expiresAt: number; scope: string }>();
  private nextId = 9_500_000_000;
  /**
   * Test hook for the next write: 'REJECT' answers with user errors (nothing saved); 'LOSE_ANSWER' saves the write and
   * then fails as a dropped connection would (HON cannot tell it was saved).
   */
  writeFault: 'REJECT' | 'LOSE_ANSWER' | null = null;
  /** Test hook: what the store owner approves (the fake grants exactly this). */
  grantScopes: string | null = null;
  private readonly stores = new Map<string, { products: MirrorProduct[]; orders: MirrorOrder[]; name: string; currency: string; finance: ShopifyFinanceSnapshot; storefront: string | null; rejected: boolean }>();
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
  setStore(shop: string, change: Partial<{ products: MirrorProduct[]; orders: MirrorOrder[]; name: string; currency: string; finance: ShopifyFinanceSnapshot }>): void { Object.assign(this.store(shop), change); }
  /** Test hook: every token of this shop is refused from now on (the owner uninstalled the app). */
  rejectTokens(shop: string, rejected = true): void { this.store(shop).rejected = rejected; }

  /** What Shopify's redirect would carry after the owner approves: a signed query for HON's return page. */
  approve(shop: string, state: string, at: number = this.now(), scopes: readonly string[] = SHOPIFY_SCOPES): string {
    const code = randomBytes(16).toString('hex');
    this.codes.set(code, { shop, scope: this.grantScopes ?? scopes.join(',') });
    const params = { code, host: Buffer.from(`admin.shopify.com/store/${shop.split('.')[0]}`).toString('base64url'), shop, state, timestamp: String(Math.floor(at / 1000)) };
    return new URLSearchParams({ ...params, hmac: signShopifyQuery(params, this.secret) }).toString();
  }

  /** A delivery signed as Shopify would sign it, for tests of HON's webhook endpoint (the payload is never read). */
  webhook(topic: string, shop: string, webhookId: string = randomUUID(), at: number = this.now()): { body: Buffer; headers: Record<string, string> } {
    const body = Buffer.from(JSON.stringify({ shop_domain: shop, sample: true }), 'utf8');
    return { body, headers: { 'content-type': 'application/json', 'x-shopify-topic': topic, 'x-shopify-shop-domain': shop, 'x-shopify-webhook-id': webhookId,
      'x-shopify-triggered-at': new Date(at).toISOString(), 'x-shopify-api-version': SHOPIFY_API_VERSION, 'x-shopify-hmac-sha256': signShopifyWebhook(body, this.secret) } };
  }

  private issue(shop: string, scope: string): ShopifyTokens {
    const now = this.now(), access = 'fake_at_' + randomBytes(16).toString('hex'), refresh = 'fake_rt_' + randomBytes(16).toString('hex');
    this.tokens.set(access, { shop, kind: 'access', expiresAt: now + 3600_000, scope });
    this.tokens.set(refresh, { shop, kind: 'refresh', expiresAt: now + 90 * 86400_000, scope });
    return { accessToken: access, refreshToken: refresh, scope, accessExpiresAt: new Date(now + 3600_000).toISOString(),
      refreshExpiresAt: new Date(now + 90 * 86400_000).toISOString() };
  }
  private check(shop: string, token: string, kind: 'access' | 'refresh', scope?: string): string {
    const t = this.tokens.get(token);
    if (!t || t.shop !== shop || t.kind !== kind || t.expiresAt <= this.now() || this.store(shop).rejected) throw new ShopifyProviderError('AUTH');
    // Shopify refuses a write the store never granted (a top-level ACCESS_DENIED error).
    if (scope && !t.scope.split(',').includes(scope)) throw new ShopifyProviderError('INVALID_RESPONSE');
    return t.scope;
  }
  /** Applies a write unless a fault is set; LOSE_ANSWER applies it and then fails. */
  private write<T>(apply: () => T): T {
    const fault = this.writeFault;
    this.writeFault = null;
    if (fault === 'REJECT') throw new ShopifyProviderError('REJECTED');
    const out = apply();
    if (fault === 'LOSE_ANSWER') throw new ShopifyProviderError('UNAVAILABLE');
    return out;
  }

  async exchangeCode(shop: string, code: string): Promise<ShopifyTokens> {
    this.calls.push('exchangeCode:' + shop);
    const approved = this.codes.get(code);
    if (approved?.shop !== shop) throw new ShopifyProviderError('AUTH');
    this.codes.delete(code);
    return this.issue(shop, approved.scope);
  }
  async refresh(shop: string, refreshToken: string): Promise<ShopifyTokens> {
    this.calls.push('refresh:' + shop);
    const scope = this.check(shop, refreshToken, 'refresh');
    this.tokens.delete(refreshToken);
    return this.issue(shop, scope);
  }
  async shopInfo(shop: string, accessToken: string): Promise<ShopifyShopInfo> {
    this.calls.push('shopInfo:' + shop); this.check(shop, accessToken, 'access');
    const s = this.store(shop); return { name: s.name, currency: s.currency };
  }
  async setStorefrontSettings(shop: string, accessToken: string, settings: ShopifyStorefrontSettings): Promise<void> {
    await Promise.resolve();
    this.calls.push('storefrontSettings:' + shop); this.check(shop, accessToken, 'access');
    const value = storefrontValue(settings);
    this.write(() => { this.store(shop).storefront = value; });
  }
  /** Front-desk orders the fake store holds, by their HON key (test hook: read them to see what was sent). */
  readonly posOrders = new Map<string, { shop: string; orderId: string; orderName: string; input: ShopifyPosOrderInput }>();
  async createPosOrder(shop: string, accessToken: string, input: ShopifyPosOrderInput): Promise<ShopifyPosOrderAnswer> {
    await Promise.resolve();
    this.calls.push('createPosOrder:' + shop); this.check(shop, accessToken, 'access', 'write_orders');
    posOrderVariables(input);
    const had = this.posOrders.get(input.key);
    if (had) { this.writeFault = null; return { outcome: 'DONE', orderId: had.orderId, orderName: had.orderName }; }
    const variants = this.store(shop).products.flatMap(p => p.variants);
    if (input.lines.some(l => !variants.some(v => v.id === l.variantId))) { this.writeFault = null; return { outcome: 'REFUSED', reason: 'SHOPIFY_REJECTED' }; }
    if (this.writeFault === 'REJECT') { this.writeFault = null; return { outcome: 'REFUSED', reason: 'SHOPIFY_REJECTED' }; }
    return this.write(() => {
      const made = { shop, orderId: String(this.nextId++), orderName: `#${1001 + this.posOrders.size}`, input };
      this.posOrders.set(input.key, made);
      return { outcome: 'DONE' as const, orderId: made.orderId, orderName: made.orderName };
    });
  }
  private readonly adjusted = new Set<string>();
  async adjustInventory(shop: string, accessToken: string, input: ShopifyInventoryAdjustment): Promise<ShopifyInventoryAnswer> {
    await Promise.resolve();
    this.calls.push('adjustInventory:' + shop); this.check(shop, accessToken, 'access', 'write_inventory');
    const v = this.store(shop).products.flatMap(p => p.variants).find(x => x.id === input.variantId);
    const refusal: ShopifyInventoryRefusal | null = !v ? 'VARIANT_GONE' : v.fulfilledBy ? 'NO_LOCATION' : !v.tracked || v.inventoryQuantity === null ? 'NOT_TRACKED' : null;
    if (refusal) { this.writeFault = null; return { outcome: 'REFUSED', reason: refusal }; }
    // Shopify applies one idempotency key at most once; a repeat answers as the first did.
    this.write(() => { if (!this.adjusted.has(input.idempotencyKey)) { this.adjusted.add(input.idempotencyKey); v!.inventoryQuantity = v!.inventoryQuantity! + input.delta; } });
    return { outcome: 'DONE' };
  }
  /** Test hook: the storefront settings metafield as the fake holds it (null before the first publish). */
  storefrontSettings(shop: string): string | null { return this.store(shop).storefront; }

  async finance(shop: string, accessToken: string): Promise<ShopifyFinanceSnapshot> {
    // Shopify refuses this read when the store never granted the scope (a top-level ACCESS_DENIED error).
    this.calls.push('finance:' + shop); this.check(shop, accessToken, 'access', 'read_shopify_payments_accounts');
    return structuredClone(this.store(shop).finance);
  }
  async catalog(shop: string, accessToken: string) {
    this.calls.push('catalog:' + shop); this.check(shop, accessToken, 'access');
    return { products: structuredClone(this.store(shop).products), complete: true };
  }
  async orders(shop: string, accessToken: string, sinceIso: string) {
    this.calls.push('orders:' + shop); this.check(shop, accessToken, 'access');
    return { orders: structuredClone(this.store(shop).orders.filter(o => o.placedAt >= sinceIso)), complete: true };
  }
  async product(shop: string, accessToken: string, productId: string) {
    this.calls.push('product:' + shop); this.check(shop, accessToken, 'access');
    const p = this.store(shop).products.find(x => x.id === productId);
    return p ? structuredClone(p) : null;
  }
  async productByHandle(shop: string, accessToken: string, handle: string) {
    this.calls.push('productByHandle:' + shop); this.check(shop, accessToken, 'access');
    const p = this.store(shop).products.find(x => x.handle === handle);
    return p ? structuredClone(p) : null;
  }
  async createDraft(shop: string, accessToken: string, input: ShopifyDraftInput) {
    this.calls.push('createDraft:' + shop); this.check(shop, accessToken, 'access', 'write_products');
    return this.write(() => {
      const productId = String(this.nextId++), variantId = String(this.nextId++);
      this.store(shop).products.push({ id: productId, title: input.title, status: 'DRAFT', vendor: input.vendor, productType: input.productType, handle: input.handle,
        imageUrl: null, variants: [{ id: variantId, title: 'Default Title', sku: null, barcode: null, price: '0', compareAtPrice: null, unitCost: null, tracked: false, inventoryQuantity: 0 }] });
      return { productId, variantId };
    });
  }
  async updateProduct(shop: string, accessToken: string, productId: string, fields: ShopifyProductFields) {
    this.calls.push('updateProduct:' + shop); this.check(shop, accessToken, 'access', 'write_products');
    const p = this.store(shop).products.find(x => x.id === productId);
    if (!p) { this.writeFault = null; throw new ShopifyProviderError('REJECTED'); }
    this.write(() => {
      if (fields.title !== undefined) p.title = fields.title;
      if (fields.status !== undefined) p.status = fields.status;
      if (fields.productType !== undefined) p.productType = fields.productType;
      if (fields.vendor !== undefined) p.vendor = fields.vendor;
    });
  }
  async updateVariants(shop: string, accessToken: string, productId: string, variants: readonly ShopifyVariantFields[], sku?: string | null) {
    this.calls.push('updateVariants:' + shop);
    this.check(shop, accessToken, 'access', 'write_products');
    if (variants.some(v => v.unitCost !== undefined)) this.check(shop, accessToken, 'access', 'write_inventory');
    const p = this.store(shop).products.find(x => x.id === productId);
    if (!p || variants.some(v => !p.variants.some(x => x.id === v.variantId))) { this.writeFault = null; throw new ShopifyProviderError('REJECTED'); }
    this.write(() => {
      variants.forEach((v, i) => {
        const x = p.variants.find(y => y.id === v.variantId)!;
        if (v.price !== undefined) x.price = v.price;
        if (v.compareAtPrice !== undefined) x.compareAtPrice = v.compareAtPrice;
        if (v.unitCost !== undefined) x.unitCost = v.unitCost;
        if (i === 0 && sku) x.sku = sku;
      });
    });
  }
}

function sampleStore(shop: string, now: number): { products: MirrorProduct[]; orders: MirrorOrder[]; name: string; currency: string; finance: ShopifyFinanceSnapshot; storefront: string | null } {
  const v = (id: string, title: string, sku: string, price: string, unitCost: string | null, qty: number | null): MirrorVariant =>
    ({ id, title, sku, barcode: null, price, compareAtPrice: null, unitCost, tracked: qty !== null, inventoryQuantity: qty, fulfilledBy: sku.startsWith('HOOD') ? 'Sample Print Co' : null });
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
  const finance: ShopifyFinanceSnapshot = { paymentsActive: true, balances: [{ currency: 'USD', amount: '245.18' }],
    payouts: [
      { id: '9400000002', status: 'SCHEDULED', direction: 'DEPOSIT', issuedAt: day(0), currency: 'USD', net: '136.04' },
      { id: '9400000001', status: 'PAID', direction: 'DEPOSIT', issuedAt: day(3), currency: 'USD', net: '128.31' }],
    transactions: [
      { id: '9450000003', type: 'CHARGE', at: day(2), currency: 'USD', amount: '140.73', fee: '4.38', net: '136.35', test: true, payoutId: '9400000002' },
      { id: '9450000002', type: 'REFUND', at: day(4), currency: 'USD', amount: '-0.31', fee: '0', net: '-0.31', test: true, payoutId: '9400000002' },
      { id: '9450000001', type: 'CHARGE', at: day(5), currency: 'USD', amount: '150.00', fee: '4.65', net: '145.35', test: true, payoutId: null }] };
  return { products, orders, finance, storefront: null, name: shop.split('.')[0]!.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '), currency: 'USD' };
}
