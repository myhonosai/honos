/**
 * 0405 HON Shopify Connected (SH1). Shopify stays the source of truth for products, inventory and orders; HON connects one
 * store per school through the one HON Shopify app (OAuth) and keeps a read-only mirror. Nothing here writes to Shopify.
 */
import { accountClosed, accountUuid } from './school-owner-invitations.js';

export const SHOPIFY_HUMAN_COMMAND = 'school-shopify' as const;
/** Where Shopify sends the owner's browser back after they approve the HON app. */
export const SHOPIFY_RETURN_PATH = '/staff/billing/shopify/return' as const;
/** Read-only scopes for SH1. Later pieces ask the owner to approve more. */
export const SHOPIFY_SCOPES = ['read_products', 'read_inventory', 'read_orders'] as const;
export const SHOPIFY_LOW_STOCK_AT = 3;
export const SHOPIFY_CONNECTION_STATUSES = ['CONNECTED', 'NEEDS_RECONNECT', 'DISCONNECTED'] as const;
export type ShopifyConnectionStatus = typeof SHOPIFY_CONNECTION_STATUSES[number];
export const SHOPIFY_SYNC_OUTCOMES = ['SUCCEEDED', 'FAILED', 'NEEDS_RECONNECT'] as const;
export type ShopifySyncOutcome = typeof SHOPIFY_SYNC_OUTCOMES[number];

const SHOP = /^[a-z0-9][a-z0-9-]{0,59}\.myshopify\.com$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SHOPIFY_ID = /^[1-9][0-9]{0,17}$/;
const CURRENCY = /^[A-Z]{3}$/;
const STATUS_WORD = /^[A-Z_]{1,40}$/;

/**
 * The store name an owner typed, as `<name>.myshopify.com`, or null. Accepts `name`, `name.myshopify.com` and an admin or
 * store URL on that domain (`https://name.myshopify.com/admin`). Custom domains are refused: Shopify's OAuth needs the
 * permanent myshopify.com name.
 */
export function normalizeShopDomain(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  let v = value.trim().toLowerCase();
  if (v.length < 1 || v.length > 255) return null;
  v = v.replace(/^https?:\/\//, '');
  v = v.replace(/[/?#].*$/, '');
  if (!v.includes('.')) v += '.myshopify.com';
  return SHOP.test(v) ? v : null;
}

function fail(response: boolean): never { throw new Error(response ? 'SHOPIFY_RESPONSE_INVALID' : 'SHOPIFY_INPUT_INVALID'); }
function closed(v: unknown, keys: readonly string[], response: boolean): Record<string, unknown> { try { return accountClosed(v, keys); } catch { fail(response); } }
function id(v: unknown, response: boolean): string { try { return accountUuid(v).toLowerCase(); } catch { fail(response); } }
function int(v: unknown, lo: number, hi: number, response = true): number { if (!Number.isInteger(v) || (v as number) < lo || (v as number) > hi) fail(response); return v as number; }
function maybeInt(v: unknown, lo: number, hi: number): number | null { return v === null ? null : int(v, lo, hi); }
function bool(v: unknown): boolean { if (typeof v !== 'boolean') fail(true); return v; }
function text(v: unknown, max: number): string {
  // eslint-disable-next-line no-control-regex
  if (typeof v !== 'string' || v.length < 1 || v.length > max || /[\x01-\x1f\x7f]/.test(v)) fail(true);
  return v;
}
function maybeText(v: unknown, max: number): string | null { return v === null ? null : text(v, max); }
function iso(v: unknown): string { if (typeof v !== 'string' || !ISO.test(v)) fail(true); return v; }
function maybeIso(v: unknown): string | null { return v === null ? null : iso(v); }
function money(v: unknown, signed = false): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > 1e12 || (!signed && v < 0)) fail(true);
  return v;
}
function maybeMoney(v: unknown, signed = false): number | null { return v === null ? null : money(v, signed); }
function shopifyId(v: unknown): string { if (typeof v !== 'string' || !SHOPIFY_ID.test(v)) fail(true); return v; }
function maybeShopifyId(v: unknown): string | null { return v === null ? null : shopifyId(v); }
function currency(v: unknown): string { if (typeof v !== 'string' || !CURRENCY.test(v)) fail(true); return v; }
function maybeCurrency(v: unknown): string | null { return v === null ? null : currency(v); }
function word(v: unknown): string | null { if (v === null) return null; if (typeof v !== 'string' || !STATUS_WORD.test(v)) fail(true); return v; }
function oneOf<T extends string>(v: unknown, list: readonly T[], response = true): T { if (!(list as readonly unknown[]).includes(v)) fail(response); return v as T; }
function arr(v: unknown, max: number): unknown[] { if (!Array.isArray(v) || v.length > max) fail(true); return v; }
function shop(v: unknown, response = true): string { if (typeof v !== 'string' || !SHOP.test(v)) fail(response); return v; }

// ---- Inputs from the browser (closed; the API and the database check again) ----

export interface ShopifyConnectInput { schoolId: string; shopDomain: string }
export function validateShopifyConnectInput(v: unknown): ShopifyConnectInput {
  const o = closed(v, ['schoolId', 'shopDomain'], false);
  const domain = normalizeShopDomain(o.shopDomain);
  if (!domain) fail(false);
  return Object.freeze({ schoolId: id(o.schoolId, false), shopDomain: domain });
}
/** The raw query string Shopify put on the return URL, without the leading `?`. */
export interface ShopifyCompleteInput { schoolId: string; query: string }
export function validateShopifyCompleteInput(v: unknown): ShopifyCompleteInput {
  const o = closed(v, ['schoolId', 'query'], false);
  if (typeof o.query !== 'string' || o.query.length < 1 || o.query.length > 4096 || o.query.startsWith('?') || /[\s#]/.test(o.query)) fail(false);
  return Object.freeze({ schoolId: id(o.schoolId, false), query: o.query });
}
export interface ShopifySyncInput { schoolId: string }
export function validateShopifySyncInput(v: unknown): ShopifySyncInput {
  const o = closed(v, ['schoolId'], false);
  return Object.freeze({ schoolId: id(o.schoolId, false) });
}
export interface ShopifyDisconnectInput { schoolId: string; connectionId: string; expectedVersion: number }
export function validateShopifyDisconnectInput(v: unknown): ShopifyDisconnectInput {
  const o = closed(v, ['schoolId', 'connectionId', 'expectedVersion'], false);
  return Object.freeze({ schoolId: id(o.schoolId, false), connectionId: id(o.connectionId, false), expectedVersion: int(o.expectedVersion, 1, 1_000_000_000, false) });
}

// ---- Answers ----

export interface ShopifyConnection {
  connectionId: string; shopDomain: string; shopName: string | null; currency: string | null; status: ShopifyConnectionStatus; version: number;
  connectedAt: string; endedAt: string | null; lastSyncAt: string | null; lastSyncOutcome: ShopifySyncOutcome | null; syncRunning: boolean;
}
export function verifyShopifyConnection(v: unknown): ShopifyConnection {
  const o = closed(v, ['connectionId', 'shopDomain', 'shopName', 'currency', 'status', 'version', 'connectedAt', 'endedAt', 'lastSyncAt', 'lastSyncOutcome', 'syncRunning'], true);
  const status = oneOf(o.status, SHOPIFY_CONNECTION_STATUSES);
  const endedAt = maybeIso(o.endedAt);
  if ((status === 'CONNECTED') !== (endedAt === null)) fail(true);
  return Object.freeze({ connectionId: id(o.connectionId, true), shopDomain: shop(o.shopDomain), shopName: maybeText(o.shopName, 120), currency: maybeCurrency(o.currency),
    status, version: int(o.version, 1, 1_000_000_000), connectedAt: iso(o.connectedAt), endedAt, lastSyncAt: maybeIso(o.lastSyncAt),
    lastSyncOutcome: o.lastSyncOutcome === null ? null : oneOf(o.lastSyncOutcome, SHOPIFY_SYNC_OUTCOMES), syncRunning: bool(o.syncRunning) });
}

export interface ShopifySummary {
  days: number; orders: number; sales: number; averageOrder: number; itemsSold: number; lineSales: number; coveredSales: number;
  estimatedGrossProfit: number; topProducts: readonly { title: string; quantity: number; sales: number }[];
}
export interface ShopifyOverview {
  schoolId: string; canManage: boolean; connectEnabled: boolean; connection: ShopifyConnection | null;
  counts: { products: number; variants: number; lowStock: number; orders: number } | null; summary: ShopifySummary | null;
}
export function verifyShopifyOverview(v: unknown): ShopifyOverview {
  const o = closed(v, ['schoolId', 'canManage', 'connectEnabled', 'connection', 'counts', 'summary'], true);
  const connection = o.connection === null ? null : verifyShopifyConnection(o.connection);
  if ((connection === null) !== (o.counts === null) || (connection === null) !== (o.summary === null)) fail(true);
  let counts: ShopifyOverview['counts'] = null, summary: ShopifySummary | null = null;
  if (connection) {
    const c = closed(o.counts, ['products', 'variants', 'lowStock', 'orders'], true);
    counts = Object.freeze({ products: int(c.products, 0, 1e7), variants: int(c.variants, 0, 1e7), lowStock: int(c.lowStock, 0, 1e7), orders: int(c.orders, 0, 1e7) });
    const s = closed(o.summary, ['days', 'orders', 'sales', 'averageOrder', 'itemsSold', 'lineSales', 'coveredSales', 'estimatedGrossProfit', 'topProducts'], true);
    summary = Object.freeze({ days: int(s.days, 1, 366), orders: int(s.orders, 0, 1e7), sales: money(s.sales), averageOrder: money(s.averageOrder),
      itemsSold: int(s.itemsSold, 0, 1e9), lineSales: money(s.lineSales), coveredSales: money(s.coveredSales), estimatedGrossProfit: money(s.estimatedGrossProfit, true),
      topProducts: Object.freeze(arr(s.topProducts, 5).map(t => { const x = closed(t, ['title', 'quantity', 'sales'], true);
        return Object.freeze({ title: text(x.title, 255), quantity: int(x.quantity, 0, 1e9), sales: money(x.sales) }); })) });
    if (summary.coveredSales > summary.lineSales) fail(true);
  }
  return Object.freeze({ schoolId: id(o.schoolId, true), canManage: bool(o.canManage), connectEnabled: bool(o.connectEnabled), connection, counts, summary });
}

export interface ShopifyVariant {
  variantId: string; title: string; sku: string | null; barcode: string | null; price: number; compareAtPrice: number | null; unitCost: number | null;
  margin: number | null; marginPercent: number | null; tracked: boolean; inventoryQuantity: number | null; lowStock: boolean;
}
export interface ShopifyProduct {
  productId: string; title: string; status: 'ACTIVE' | 'DRAFT' | 'ARCHIVED' | 'UNLISTED'; vendor: string | null; productType: string | null; imageUrl: string | null;
  variants: readonly ShopifyVariant[];
}
export interface ShopifyCatalog { schoolId: string; currency: string | null; products: readonly ShopifyProduct[] }
const IMAGE = /^https:\/\/[a-z0-9.-]+\.(shopify\.com|shopifycdn\.net)\/[^\s"'<>\\]*$/;
export function verifyShopifyCatalog(v: unknown): ShopifyCatalog {
  const o = closed(v, ['schoolId', 'currency', 'products'], true);
  return Object.freeze({ schoolId: id(o.schoolId, true), currency: maybeCurrency(o.currency), products: Object.freeze(arr(o.products, 2000).map(p => {
    const x = closed(p, ['productId', 'title', 'status', 'vendor', 'productType', 'imageUrl', 'variants'], true);
    if (x.imageUrl !== null && (typeof x.imageUrl !== 'string' || x.imageUrl.length > 2048 || !IMAGE.test(x.imageUrl))) fail(true);
    return Object.freeze({ productId: shopifyId(x.productId), title: text(x.title, 255), status: oneOf(x.status, ['ACTIVE', 'DRAFT', 'ARCHIVED', 'UNLISTED'] as const),
      vendor: maybeText(x.vendor, 255), productType: maybeText(x.productType, 255), imageUrl: x.imageUrl as string | null,
      variants: Object.freeze(arr(x.variants, 100).map(w => {
        const y = closed(w, ['variantId', 'title', 'sku', 'barcode', 'price', 'compareAtPrice', 'unitCost', 'margin', 'marginPercent', 'tracked', 'inventoryQuantity', 'lowStock'], true);
        return Object.freeze({ variantId: shopifyId(y.variantId), title: text(y.title, 255), sku: maybeText(y.sku, 255), barcode: maybeText(y.barcode, 255),
          price: money(y.price), compareAtPrice: maybeMoney(y.compareAtPrice), unitCost: maybeMoney(y.unitCost), margin: maybeMoney(y.margin, true),
          marginPercent: y.marginPercent === null ? null : money(y.marginPercent, true), tracked: bool(y.tracked),
          inventoryQuantity: maybeInt(y.inventoryQuantity, -10_000_000, 10_000_000), lowStock: bool(y.lowStock) });
      })) });
  })) });
}

export interface ShopifyOrderLine { title: string; sku: string | null; variantId: string | null; quantity: number; unitPrice: number }
export interface ShopifyOrder {
  orderId: string; name: string; placedAt: string; cancelledAt: string | null; financialStatus: string | null; fulfillmentStatus: string | null;
  sourceName: string | null; currency: string; subtotal: number; discounts: number; tax: number; total: number; lines: readonly ShopifyOrderLine[];
}
export interface ShopifyOrders { schoolId: string; currency: string | null; orders: readonly ShopifyOrder[] }
export function verifyShopifyOrders(v: unknown): ShopifyOrders {
  const o = closed(v, ['schoolId', 'currency', 'orders'], true);
  return Object.freeze({ schoolId: id(o.schoolId, true), currency: maybeCurrency(o.currency), orders: Object.freeze(arr(o.orders, 200).map(r => {
    const x = closed(r, ['orderId', 'name', 'placedAt', 'cancelledAt', 'financialStatus', 'fulfillmentStatus', 'sourceName', 'currency', 'subtotal', 'discounts', 'tax', 'total', 'lines'], true);
    return Object.freeze({ orderId: shopifyId(x.orderId), name: text(x.name, 64), placedAt: iso(x.placedAt), cancelledAt: maybeIso(x.cancelledAt),
      financialStatus: word(x.financialStatus), fulfillmentStatus: word(x.fulfillmentStatus), sourceName: maybeText(x.sourceName, 64), currency: currency(x.currency),
      subtotal: money(x.subtotal), discounts: money(x.discounts), tax: money(x.tax), total: money(x.total),
      lines: Object.freeze(arr(x.lines, 50).map(l => { const y = closed(l, ['title', 'sku', 'variantId', 'quantity', 'unitPrice'], true);
        return Object.freeze({ title: text(y.title, 255), sku: maybeText(y.sku, 255), variantId: maybeShopifyId(y.variantId), quantity: int(y.quantity, 0, 100_000), unitPrice: money(y.unitPrice) }); })) });
  })) });
}

export interface ShopifyConnectStart { authorizeUrl: string; shopDomain: string; expiresAt: string }
export function verifyShopifyConnectStart(v: unknown): ShopifyConnectStart {
  const o = closed(v, ['authorizeUrl', 'shopDomain', 'expiresAt'], true);
  const domain = shop(o.shopDomain);
  if (typeof o.authorizeUrl !== 'string' || o.authorizeUrl.length > 2048) fail(true);
  // The real app sends the owner to Shopify's own approval screen. The fake (development only) sends the browser straight
  // back to HON's return page with a signed answer; the page checks that one is same-origin.
  const escaped = domain.replace(/[.]/g, '\\.');
  const shopify = new RegExp('^https://' + escaped + '/admin/oauth/authorize\\?[^\\s#]+$').test(o.authorizeUrl);
  const fake = /^https?:\/\/[a-z0-9.:[\]-]+\/staff\/billing\/shopify\/return\?[^\s#]+$/i.test(o.authorizeUrl);
  if (!shopify && !fake) fail(true);
  return Object.freeze({ authorizeUrl: o.authorizeUrl, shopDomain: domain, expiresAt: iso(o.expiresAt) });
}
export interface ShopifyConnectResult { connection: ShopifyConnection; firstSync: ShopifySyncResult | null }
export interface ShopifySyncResult {
  outcome: ShopifySyncOutcome; failureCode: string | null; productsSeen: number; variantsSeen: number; ordersSeen: number;
  removedProducts: number; removedVariants: number; connection: ShopifyConnection;
}
export function verifyShopifySyncResult(v: unknown): ShopifySyncResult {
  const o = closed(v, ['outcome', 'failureCode', 'productsSeen', 'variantsSeen', 'ordersSeen', 'removedProducts', 'removedVariants', 'connection'], true);
  const outcome = oneOf(o.outcome, SHOPIFY_SYNC_OUTCOMES), failureCode = word(o.failureCode);
  if ((outcome === 'SUCCEEDED') !== (failureCode === null)) fail(true);
  return Object.freeze({ outcome, failureCode, productsSeen: int(o.productsSeen, 0, 2000), variantsSeen: int(o.variantsSeen, 0, 200_000), ordersSeen: int(o.ordersSeen, 0, 1000),
    removedProducts: int(o.removedProducts, 0, 1e7), removedVariants: int(o.removedVariants, 0, 1e7), connection: verifyShopifyConnection(o.connection) });
}
export function verifyShopifyConnectResult(v: unknown): ShopifyConnectResult {
  const o = closed(v, ['connection', 'firstSync'], true);
  return Object.freeze({ connection: verifyShopifyConnection(o.connection), firstSync: o.firstSync === null ? null : verifyShopifySyncResult(o.firstSync) });
}
export interface ShopifyDisconnectResult { connection: ShopifyConnection }
export function verifyShopifyDisconnectResult(v: unknown): ShopifyDisconnectResult {
  const o = closed(v, ['connection'], true);
  const connection = verifyShopifyConnection(o.connection);
  if (connection.status !== 'DISCONNECTED') fail(true);
  return Object.freeze({ connection });
}
