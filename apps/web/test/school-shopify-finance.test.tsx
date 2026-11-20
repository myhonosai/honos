import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ShopifyConnection, ShopifyFinanceView, ShopifyOverview } from '@hon/contracts';
import { SHOPIFY_LANGUAGES } from '../src/components/school-shopify/copy';
import { ShopifyError, shopifyApi } from '../src/components/school-shopify/http';
import { ShopifyView, type ShopifyViewProps } from '../src/components/school-shopify/view';
import { id } from './account-status-fixtures';

// SH-F1 (0597): the Finance section shows what Shopify Payments holds, its payouts and recent transactions; read-only.
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
  counts: { products: 0, variants: 0, lowStock: 0, orders: 0 },
  summary: { days: 30, orders: 0, sales: 0, averageOrder: 0, itemsSold: 0, lineSales: 0, coveredSales: 0, estimatedGrossProfit: 0, topProducts: [] }, ...over });
const view = (over: Partial<ShopifyFinanceView> = {}): ShopifyFinanceView => ({ schoolId: school, connected: true, financeAllowed: true, currency: 'USD',
  finance: { paymentsActive: true, readAt: at, balances: [{ currency: 'USD', amount: '245.18' }],
    payouts: [{ id: '9400000002', status: 'SCHEDULED', direction: 'DEPOSIT', issuedAt: at, currency: 'USD', net: '136.04' },
      { id: '9400000003', status: 'PAID', direction: 'WITHDRAWAL', issuedAt: at, currency: 'USD', net: '-12.50' }],
    transactions: [{ id: '9450000003', type: 'CHARGE', at, currency: 'USD', amount: '140.73', fee: '4.38', net: '136.35', test: true, payoutId: '9400000002' },
      { id: '9450000004', type: 'SOMETHING_NEW', at, currency: 'USD', amount: '-0.31', fee: '0', net: '-0.31', test: false, payoutId: null }] }, ...over });
const props = (over: Partial<ShopifyViewProps> = {}): ShopifyViewProps => ({ language: 'en', locale: 'en-US', waiting: false, concealed: false, hasSchool: true,
  overview: { state: 'READY', read: overview() }, section: 'finance', catalog: { state: 'LOADING' }, orders: { state: 'LOADING' }, shop: SHOP, confirming: false, outcome: null,
  locked: false, finance: { state: 'READY', value: view() }, ...over });
const render = (over: Partial<ShopifyViewProps> = {}) => renderToStaticMarkup(<ShopifyView {...props(over)} />);

it('reads finance with a plain same-origin GET and asks for it only with Allow finance', async () => {
  const f = stub(json({ data: view() }));
  expect((await shopifyApi.finance(school.toUpperCase(), signal(), () => true)).finance?.balances).toEqual([{ currency: 'USD', amount: '245.18' }]);
  const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe(`/api/v1/school/schools/${school}/shopify/finance`);
  expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error' });
  stub(json({ data: view({ schoolId: id(3) }) }));
  expect((await fails(shopifyApi.finance(school, signal(), () => true))).kind).toBe('UNKNOWN');
  stub(json({ data: { ...view(), bank: '1234' } }));
  expect((await fails(shopifyApi.finance(school, signal(), () => true))).kind).toBe('UNKNOWN');
  stub(json({ code: 'SHOPIFY_FORBIDDEN' }, 403));
  expect((await fails(shopifyApi.finance(school, signal(), () => true))).kind).toBe('DENIED');
  const g = stub(json({ data: { authorizeUrl: `https://${SHOP}/admin/oauth/authorize?client_id=x&state=y`, shopDomain: SHOP, expiresAt: at } }));
  await shopifyApi.connect(school, SHOP, signal(), () => true, true, true);
  expect(JSON.parse((g.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toEqual({ schoolId: school, shopDomain: SHOP, allowEditing: true, allowFinance: true, allowThemes: false });
});

it('shows the balance, payouts and recent transactions in the store currency, with Shopify admin links for payouts and Capital', () => {
  const html = render();
  expect(html).toContain('data-nav="finance"');
  expect(html).toContain('data-shopify-finance="ready"');
  expect(html).toContain('$245.18');
  expect(html).toMatch(/data-payout="9400000002".*?Scheduled.*?\$136\.04/);
  expect(html).toMatch(/data-payout="9400000003".*?Paid.*?−\$12\.50/);
  expect(html).toMatch(/data-transaction="9450000003".*?Sale.*?Test.*?\$140\.73.*?\$4\.38.*?\$136\.35/);
  expect(html).toMatch(/data-transaction="9450000004".*?Other.*?-\$0\.31/);
  expect(html).toContain('href="https://admin.shopify.com/store/ima-test/finance"');
  expect(html).toContain('href="https://admin.shopify.com/store/ima-test/credit"');
  expect(html).toContain('Shopify does not share them with apps');
  expect(html).not.toMatch(/capital[^<]*\$\d/i);
});

it('asks to allow finance, says when it was not read yet or Payments is off, and stays manager-only', () => {
  const notAllowed = render({ finance: { state: 'READY', value: view({ financeAllowed: false, finance: null }) } });
  expect(notAllowed).toContain('data-shopify-finance="not-allowed"'); expect(notAllowed).toContain('Allow finance');
  expect(render({ finance: { state: 'READY', value: view({ financeAllowed: false, finance: null }) }, overview: { state: 'READY', read: overview({ connection: connection({ status: 'NEEDS_RECONNECT', endedAt: at }) }) } }))
    .not.toContain('>Allow finance<');
  expect(render({ finance: { state: 'READY', value: view({ finance: null }) } })).toContain('data-shopify-finance="not-read"');
  const off = render({ finance: { state: 'READY', value: view({ finance: { paymentsActive: false, balances: [], payouts: [], transactions: [], readAt: at } }) } });
  expect(off).toContain('data-shopify-finance="payments-off"'); expect(off).toContain('Shopify Payments is not set up');
  const reader = render({ overview: { state: 'READY', read: overview({ canManage: false }) }, finance: undefined });
  expect(reader).toContain('Only someone who can manage Shopify'); expect(reader).not.toContain('$245.18');
  expect(render({ finance: { state: 'UNAVAILABLE' } })).toContain('This list could not be loaded.');
  expect(render({ section: 'settings' })).toContain('data-perm="finance"');
  expect(render({ section: 'settings', finance: { state: 'READY', value: view({ financeAllowed: false, finance: null }) } })).not.toContain('data-perm="finance"');
});

it('has every finance phrase in Korean and Spanish', () => {
  const keys = Object.keys(SHOPIFY_LANGUAGES.en).filter(k => /^(fin_|po_|tx_|nav_finance|perm_finance)/.test(k));
  expect(keys.length).toBeGreaterThan(30);
  for (const lang of ['ko', 'es'] as const) for (const k of keys) expect((SHOPIFY_LANGUAGES[lang] as Record<string, string>)[k], `${lang}.${k}`).toBeTruthy();
});
