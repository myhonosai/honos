import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ShopifyCatalog, ShopifyConnection, ShopifyOrders, ShopifyOverview, ShopifySyncResult } from '@hon/contracts';
import { SHOPIFY_LANGUAGES, shopifyText } from '../src/components/school-shopify/copy';
import { ShopifyError, shopifyApi, shopifyErrorFor } from '../src/components/school-shopify/http';
import { ShopifyReturnView, ShopifyView, matchesProduct, orderMatches, orderToFulfill, shopifyAdminUrl, type ShopifyViewProps } from '../src/components/school-shopify/view';
import { SCHOOL_SHELL_NAV, SCHOOL_SHELL_UNLISTED_ROUTES, schoolShellActiveRoute } from '../src/components/school-shell/catalog';
import { id } from './account-status-fixtures';

beforeEach(() => { vi.stubGlobal('window', new EventTarget()); vi.stubGlobal('location', { origin: 'https://app.hon.test' }); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const school = id(2), cid = id(40), at = '2026-11-16T05:00:00.000Z', SHOP = 'ima-test.myshopify.com';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const stub = (response: Response) => { const f = vi.fn(async () => response); vi.stubGlobal('fetch', f); return f; };
const signal = () => new AbortController().signal;
const fails = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as ShopifyError; } throw new Error('expected a failure'); };
const connection = (over: Partial<ShopifyConnection> = {}): ShopifyConnection => ({ connectionId: cid, shopDomain: SHOP, shopName: 'Synthetic Dojo Store', currency: 'USD',
  status: 'CONNECTED', version: 2, connectedAt: at, endedAt: null, lastSyncAt: at, lastSyncOutcome: 'SUCCEEDED', syncRunning: false, ...over });
const overview = (over: Partial<ShopifyOverview> = {}): ShopifyOverview => ({ schoolId: school, canManage: true, connectEnabled: true, autoSync: false, connection: connection(),
  counts: { products: 3, variants: 6, lowStock: 2, orders: 3 },
  summary: { days: 30, orders: 2, sales: 290.73, averageOrder: 145.37, itemsSold: 4, lineSales: 310, coveredSales: 175, estimatedGrossProfit: 99.75,
    topProducts: [{ title: 'Student uniform', quantity: 2, sales: 130 }] }, ...over });
const empty = (over: Partial<ShopifyOverview> = {}) => overview({ connection: null, counts: null, summary: null, ...over });
const catalog = (): ShopifyCatalog => ({ schoolId: school, currency: 'USD', products: [{ productId: '9100000001', title: 'Student uniform', status: 'ACTIVE', vendor: null, productType: 'Uniform', imageUrl: null,
  variants: [{ variantId: '9200000012', title: 'Size 2', sku: 'UNI-2', barcode: null, price: 65, compareAtPrice: null, unitCost: 28, margin: 37, marginPercent: 56.9, tracked: true, inventoryQuantity: 2, lowStock: true },
    { variantId: '9200000013', title: 'Size 3', sku: 'UNI-3', barcode: null, price: 70, compareAtPrice: null, unitCost: null, margin: null, marginPercent: null, tracked: false, inventoryQuantity: null, lowStock: false }] }] });
const orders = (): ShopifyOrders => ({ schoolId: school, currency: 'USD', orders: [
  { orderId: '9300000001', name: '#1001', placedAt: at, cancelledAt: null, financialStatus: 'PAID', fulfillmentStatus: 'UNFULFILLED', sourceName: 'web', currency: 'USD',
    subtotal: 130, discounts: 10, tax: 9.6, total: 129.6, lines: [{ title: 'Student uniform', sku: 'UNI-2', variantId: '9200000012', quantity: 2, unitPrice: 65 }] },
  { orderId: '9300000002', name: '#1002', placedAt: at, cancelledAt: null, financialStatus: 'REFUNDED', fulfillmentStatus: 'FULFILLED', sourceName: 'pos', currency: 'USD',
    subtotal: 25, discounts: 0, tax: 0, total: 25, lines: [{ title: 'Belt', sku: null, variantId: null, quantity: 1, unitPrice: 25 }] },
  { orderId: '9300000003', name: '#1003', placedAt: at, cancelledAt: at, financialStatus: 'VOIDED', fulfillmentStatus: 'SOMETHING_NEW', sourceName: null, currency: 'USD',
    subtotal: 5, discounts: 0, tax: 0, total: 5, lines: [{ title: 'Sticker', sku: null, variantId: null, quantity: 1, unitPrice: 5 }] }] });
const sync = (over: Partial<ShopifySyncResult> = {}): ShopifySyncResult => ({ outcome: 'SUCCEEDED', failureCode: null, productsSeen: 3, variantsSeen: 6, ordersSeen: 3,
  removedProducts: 0, removedVariants: 0, connection: connection(), ...over });

it('reads with plain same-origin GETs and sends each command with the Shopify command header and no token', async () => {
  const f = stub(json({ data: overview() }));
  expect((await shopifyApi.overview(school.toUpperCase(), signal(), () => true)).counts?.products).toBe(3);
  const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe(`/api/v1/school/schools/${school}/shopify`);
  expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error' });
  expect(Object.keys(init.headers as object).some(k => /^x-hon|idempotency/i.test(k))).toBe(false);
  stub(json({ data: overview({ schoolId: id(3) }) }));
  expect((await fails(shopifyApi.overview(school, signal(), () => true))).kind).toBe('UNKNOWN');
  const g = stub(json({ data: { authorizeUrl: `https://${SHOP}/admin/oauth/authorize?client_id=x&state=y`, shopDomain: SHOP, expiresAt: at } }));
  expect((await shopifyApi.connect(school, 'IMA-Test', signal(), () => true)).shopDomain).toBe(SHOP);
  const [cpath, cinit] = g.mock.calls[0] as unknown as [string, RequestInit];
  expect(cpath).toBe('/api/v1/school/shopify/connect');
  expect(cinit.headers).toMatchObject({ 'X-HON-Human-Command': 'school-shopify' });
  expect(JSON.parse(cinit.body as string)).toEqual({ schoolId: school, shopDomain: SHOP });
  // Only Shopify's own approval page for that shop, or HON's own return page.
  stub(json({ data: { authorizeUrl: `https://other.myshopify.com/admin/oauth/authorize?x=1`, shopDomain: SHOP, expiresAt: at } }));
  expect((await fails(shopifyApi.connect(school, SHOP, signal(), () => true))).kind).toBe('UNKNOWN');
  stub(json({ data: { authorizeUrl: `https://evil.test/staff/billing/shopify/return?x=1`, shopDomain: SHOP, expiresAt: at } }));
  expect((await fails(shopifyApi.connect(school, SHOP, signal(), () => true))).kind).toBe('UNKNOWN');
  stub(json({ data: { authorizeUrl: `https://app.hon.test/staff/billing/shopify/return?code=1&state=y`, shopDomain: SHOP, expiresAt: at } }));
  expect((await shopifyApi.connect(school, SHOP, signal(), () => true)).authorizeUrl).toContain('/staff/billing/shopify/return?');
  const h = stub(json({ data: { connection: connection(), firstSync: sync() } }));
  await shopifyApi.complete(school, 'code=a&hmac=b&shop=c&state=d&timestamp=1', signal(), () => true);
  expect(JSON.parse((h.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toEqual({ schoolId: school, query: 'code=a&hmac=b&shop=c&state=d&timestamp=1' });
  stub(json({ data: { connection: connection({ status: 'DISCONNECTED', endedAt: at, version: 3 }) } }));
  expect((await shopifyApi.disconnect(school, cid, 2, signal(), () => true)).connection.status).toBe('DISCONNECTED');
  const none = stub(json({}));
  expect((await fails(shopifyApi.connect(school, 'shop.example.com', signal(), () => true))).kind).toBe('INVALID');
  expect((await fails(shopifyApi.complete(school, '?leading', signal(), () => true))).kind).toBe('INVALID');
  expect((await fails(shopifyApi.disconnect(school, cid, 0, signal(), () => true))).kind).toBe('INVALID');
  expect(none).not.toHaveBeenCalled();
});

it('maps refusals to closed kinds', () => {
  expect(shopifyErrorFor(403, 'SHOPIFY_FORBIDDEN').kind).toBe('DENIED');
  expect(shopifyErrorFor(400, 'SHOPIFY_CONNECT_STATE_EXPIRED').kind).toBe('STATE');
  expect(shopifyErrorFor(400, 'SHOPIFY_SCOPES_MISSING').kind).toBe('SCOPES');
  expect(shopifyErrorFor(409, 'SHOPIFY_SHOP_TAKEN').kind).toBe('TAKEN');
  expect(shopifyErrorFor(409, 'SHOPIFY_SYNC_RUNNING').kind).toBe('BUSY');
  expect(shopifyErrorFor(409, 'SHOPIFY_VERSION_CONFLICT').kind).toBe('STALE');
  expect(shopifyErrorFor(429, 'SHOPIFY_RATE_LIMITED').kind).toBe('LIMIT');
  expect(shopifyErrorFor(503, 'SHOPIFY_CONNECT_OFF').kind).toBe('NOT_ENABLED');
  expect(shopifyErrorFor(503, 'SHOPIFY_UNAVAILABLE').kind).toBe('UNKNOWN');
  expect(shopifyErrorFor(409, 'SHOPIFY_SYNC_NOT_RUNNING').kind).toBe('UNKNOWN');
});

const props = (over: Partial<ShopifyViewProps> = {}): ShopifyViewProps => ({ language: 'en', locale: 'en-US', waiting: false, concealed: false, hasSchool: true,
  overview: { state: 'READY', read: overview() }, section: 'products', catalog: { state: 'READY', value: catalog() }, orders: { state: 'READY', value: orders() }, shop: SHOP, confirming: false, outcome: null, locked: false, ...over });

it('shows the store, the 30-day summary with honest profit coverage, stock and margins', () => {
  const html = renderToStaticMarkup(<ShopifyView {...props({ section: 'overview' })} />) + renderToStaticMarkup(<ShopifyView {...props()} />);
  expect(html).toContain('Synthetic Dojo Store'); expect(html).toContain('$290.73'); expect(html).toContain('$99.75');
  expect(html).toContain('covers $175.00 of $310.00'); expect(html).toContain('Low stock (3 or fewer)');
  expect(html).toContain('56.9%'); expect(html).toContain('Not tracked'); expect(html).toContain('Sync now'); expect(html).not.toContain('Connect Shopify');
  const noCost = renderToStaticMarkup(<ShopifyView {...props({ section: 'overview', overview: { state: 'READY', read: overview({ summary: { ...overview().summary!, coveredSales: 0, estimatedGrossProfit: 0 } }) } })} />);
  expect(noCost).toContain('Add the cost per item in Shopify');
  const reader = renderToStaticMarkup(<ShopifyView {...props({ section: 'settings', overview: { state: 'READY', read: overview({ canManage: false }) } })} />);
  expect(reader).not.toContain('Sync now'); expect(reader).not.toContain('Disconnect');
  expect(renderToStaticMarkup(<ShopifyView {...props({ section: 'settings', confirming: true })} />)).toContain('Yes, disconnect');
});

it('says HON syncs on its own only when background sync is on and the store is connected', () => {
  expect(renderToStaticMarkup(<ShopifyView {...props({ section: 'settings' })} />)).not.toContain('data-shopify-auto-sync');
  expect(renderToStaticMarkup(<ShopifyView {...props({ section: 'settings', overview: { state: 'READY', read: overview({ autoSync: true }) } })} />)).toContain('fully every six hours');
  const ended = overview({ autoSync: true, connection: { ...connection(), status: 'NEEDS_RECONNECT', endedAt: connection().connectedAt } });
  expect(renderToStaticMarkup(<ShopifyView {...props({ section: 'settings', overview: { state: 'READY', read: ended } })} />)).not.toContain('data-shopify-auto-sync');
});

it('connect form only for managers and only when connecting is turned on; reconnect when Shopify refused access', () => {
  let html = renderToStaticMarkup(<ShopifyView {...props({ overview: { state: 'READY', read: empty() }, shop: '' })} />);
  expect(html).toContain('Connect Shopify'); expect(html).not.toContain('data-shopify-workspace');
  html = renderToStaticMarkup(<ShopifyView {...props({ overview: { state: 'READY', read: empty({ connectEnabled: false }) } })} />);
  expect(html).toContain('not turned on for HON yet'); expect(html).not.toContain('Connect Shopify');
  html = renderToStaticMarkup(<ShopifyView {...props({ overview: { state: 'READY', read: empty({ canManage: false }) } })} />);
  expect(html).toContain('Only someone who can manage Shopify');
  html = renderToStaticMarkup(<ShopifyView {...props({ section: 'settings', overview: { state: 'READY', read: overview({ connection: connection({ status: 'NEEDS_RECONNECT', endedAt: at, lastSyncOutcome: 'NEEDS_RECONNECT' }) }) } })} />);
  expect(html).toContain('Needs reconnecting'); expect(html).toContain('Reconnect'); expect(html).not.toContain('Sync now');
  html = renderToStaticMarkup(<ShopifyView {...props({ outcome: { kind: 'DONE', action: 'sync', sync: sync({ outcome: 'FAILED', failureCode: 'CATALOG_TOO_LARGE' }) } })} />);
  expect(html).toContain('more products than HON reads today');
  html = renderToStaticMarkup(<ShopifyView {...props({ outcome: { kind: 'TAKEN', action: 'connect' } })} />);
  expect(html).toContain('already connected to another school');
  for (const state of ['LOADING', 'DENIED', 'UNAVAILABLE'] as const) expect(renderToStaticMarkup(<ShopifyView {...props({ overview: { state } })} />)).not.toContain('Synthetic Dojo Store');
  expect(renderToStaticMarkup(<ShopifyView {...props({ concealed: true })} />)).not.toContain('Synthetic Dojo Store');
});

it('Commerce Workspace: five sections, needs-attention counts from real data, and honest loading', () => {
  const html = renderToStaticMarkup(<ShopifyView {...props({ section: 'overview' })} />);
  for (const s of ['overview', 'products', 'orders', 'inventory', 'settings']) expect(html).toContain(`data-nav="${s}"`);
  expect(html).toContain('aria-current="page"'); expect(html).toContain('Needs attention');
  // one order to fulfill (#1001; #1002 fulfilled, #1003 cancelled), two low/costless counts from the catalog
  expect(html).toMatch(/data-attention="toFulfill">.*?<strong>1<\/strong>/); expect(html).toMatch(/data-attention="noCost">.*?<strong>1<\/strong>/);
  expect(html).toContain('#1001'); expect(html).toContain('Recent orders');
  const loading = renderToStaticMarkup(<ShopifyView {...props({ section: 'overview', orders: { state: 'LOADING' }, catalog: { state: 'UNAVAILABLE' } })} />);
  expect(loading).toContain('Reading…'); expect(loading).not.toContain('data-attention="toFulfill"'); expect(loading).toContain('This list could not be loaded.');
  expect(renderToStaticMarkup(<ShopifyView {...props({ section: 'products', catalog: { state: 'UNAVAILABLE' } })} />)).toContain('This list could not be loaded.');
});

it('products, orders and inventory sections read the mirror and link to the same record in Shopify', () => {
  const products = renderToStaticMarkup(<ShopifyView {...props({ section: 'products' })} />);
  expect(products).toContain('Showing 1 of 1'); expect(products).toContain('Variants: 2'); expect(products).toContain('$65.00 – $70.00');
  expect(products).toContain('https://admin.shopify.com/store/ima-test/products/9100000001'); expect(products).toContain('rel="noopener noreferrer"');
  const o = renderToStaticMarkup(<ShopifyView {...props({ section: 'orders' })} />);
  expect(o).toContain('Not fulfilled'); expect(o).toContain('Refunded'); expect(o).toContain('Cancelled'); expect(o).toContain('−$10.00');
  expect(o).toContain('https://admin.shopify.com/store/ima-test/orders/9300000001'); expect(o).toContain('HON keeps the last 60 days of orders.');
  const inv = renderToStaticMarkup(<ShopifyView {...props({ section: 'inventory' })} />);
  expect(inv).toContain('Units in stock'); expect(inv).toContain('$56.00'); expect(inv).toContain('Counts 2 of 2 units'); expect(inv).toContain('UNI-2');
  const settings = renderToStaticMarkup(<ShopifyView {...props({ section: 'settings' })} />);
  expect(settings).toContain('cannot change anything in your store yet'); expect(settings).toContain('https://admin.shopify.com/store/ima-test');
  expect(shopifyAdminUrl('a-b.myshopify.com', 'orders', '12')).toBe('https://admin.shopify.com/store/a-b/orders/12');
});

it('filters: search matches title, type and SKU; order filters follow Shopify\'s statuses; unknown status words are shown as words', () => {
  const p = catalog().products[0]!;
  expect(matchesProduct(p, 'uni-3')).toBe(true); expect(matchesProduct(p, 'uniform')).toBe(true); expect(matchesProduct(p, 'hoodie')).toBe(false);
  const [a, b, c] = orders().orders;
  expect([a!, b!, c!].map(orderToFulfill)).toEqual([true, false, false]);
  expect(orderMatches(a!, 'paid', '')).toBe(true); expect(orderMatches(b!, 'refunded', '')).toBe(true); expect(orderMatches(c!, 'cancelled', '')).toBe(true);
  expect(orderMatches(a!, 'all', 'belt')).toBe(false); expect(orderMatches(b!, 'all', 'belt')).toBe(true); expect(orderMatches(c!, 'paid', '')).toBe(false);
  expect(renderToStaticMarkup(<ShopifyView {...props({ section: 'orders' })} />)).not.toContain('Something new');
  const uncancelled = { ...orders(), orders: [{ ...c!, cancelledAt: null }] };
  expect(renderToStaticMarkup(<ShopifyView {...props({ section: 'orders', orders: { state: 'READY', value: uncancelled } })} />)).toContain('Something new');
  expect(shopifyText('en', 'done_sync', { products: '17', orders: '1' })).toBe('Sync finished. Products: 17. Orders: 1.');
});

it('return page reports the first sync and the reason for a refusal', () => {
  expect(renderToStaticMarkup(<ShopifyReturnView language="en" waiting={false} state={{ state: 'DONE', result: { connection: connection(), firstSync: sync() } }} />)).toContain('Products read: 3. Orders read: 3.');
  expect(renderToStaticMarkup(<ShopifyReturnView language="en" waiting={false} state={{ state: 'DONE', result: { connection: connection(), firstSync: null } }} />)).toContain('use Sync now');
  expect(renderToStaticMarkup(<ShopifyReturnView language="es" waiting={false} state={{ state: 'FAILED', kind: 'STATE' }} />)).toContain('10 minutos');
  expect(renderToStaticMarkup(<ShopifyReturnView language="ko" waiting={false} state={{ state: 'MISSING' }} />)).toContain('다시 시작하세요');
  expect(renderToStaticMarkup(<ShopifyReturnView language="en" waiting={false} hasSchool={false} state={{ state: 'FAILED', kind: 'UNKNOWN' }} />)).toContain('Choose a school');
});

it('has every phrase in Korean and Spanish and is its own Finance page with its return page unlisted', () => {
  for (const language of ['ko', 'es'] as const) for (const k of Object.keys(SHOPIFY_LANGUAGES.en)) {
    expect(SHOPIFY_LANGUAGES[language][k as keyof typeof SHOPIFY_LANGUAGES.en], `${language}:${k}`).not.toBe('');
  }
  expect(shopifyText('ko', 'done_sync', { products: '3', orders: '2' })).toContain('3');
  const shopify = SCHOOL_SHELL_NAV.find(g => g.key === 'shopify');
  expect(shopify?.section).toBe('finance');
  expect(shopify?.routes.map(r => r.href)).toEqual(['/staff/billing/shopify']);
  expect(SCHOOL_SHELL_UNLISTED_ROUTES).toContain('/staff/billing/shopify/return');
  expect(schoolShellActiveRoute('/staff/billing/shopify/return')?.href).toBe('/staff/billing/shopify');
});
