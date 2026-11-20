import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ShopifyConnection, ShopifyOverview, ShopifyStorefront, ShopifyStorefrontSettings } from '@hon/contracts';
import { ShopifyError, shopifyApi } from '../src/components/school-shopify/http';
import { storefrontColor } from '../src/components/school-shopify/storefront';
import { ShopifyView, type ShopifyViewProps } from '../src/components/school-shopify/view';
import { id } from './account-status-fixtures';

// TB2 (0609): the Storefront section saves settings in HON, publishes one saved version, and links to Shopify's theme editor.
beforeEach(() => { vi.stubGlobal('window', new EventTarget()); vi.stubGlobal('location', { origin: 'https://app.hon.test' }); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const school = id(2), cid = id(40), at = '2026-11-20T05:00:00.000Z', SHOP = 'ima-test.myshopify.com';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const stub = (response: Response) => { const f = vi.fn(async () => response); vi.stubGlobal('fetch', f); return f; };
const signal = () => new AbortController().signal;
const fails = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as ShopifyError; } throw new Error('expected a failure'); };
const connection = (): ShopifyConnection => ({ connectionId: cid, shopDomain: SHOP, shopName: 'Synthetic Dojo Store', currency: 'USD',
  status: 'CONNECTED', version: 2, connectedAt: at, endedAt: null, lastSyncAt: at, lastSyncOutcome: 'SUCCEEDED', syncRunning: false });
const overview = (over: Partial<ShopifyOverview> = {}): ShopifyOverview => ({ schoolId: school, canManage: true, connectEnabled: true, autoSync: false, connection: connection(),
  counts: { products: 0, variants: 0, lowStock: 0, orders: 0 },
  summary: { days: 30, orders: 0, sales: 0, averageOrder: 0, itemsSold: 0, lineSales: 0, coveredSales: 0, estimatedGrossProfit: 0, topProducts: [] }, ...over });
const SETTINGS: ShopifyStorefrontSettings = { primaryColor: '#C8102E', accentColor: null, sizeGuideTitle: null, sizeGuideText: 'Size 0: 100-110 cm', pickupNote: 'Front desk' };
const editor = `https://${SHOP}/admin/themes/current/editor?`;
const links = { colors: `${editor}context=apps&template=index&activateAppId=app/school-colors`, sizeGuide: `${editor}template=product&addAppBlockId=app/size-guide&target=mainSection`,
  pickupNote: `${editor}template=cart&addAppBlockId=app/pickup-note&target=newAppsSection`, pickupBanner: `${editor}context=apps&template=cart&activateAppId=app/pickup-note-banner` };
const storefront = (over: Partial<ShopifyStorefront> = {}): ShopifyStorefront => ({ schoolId: school, connected: true, shopDomain: SHOP, settings: SETTINGS, settingsVersion: 2,
  savedAt: at, publishedVersion: 1, publishedAt: at, publishStatus: 'PUBLISHED', failureCode: null, busy: false, links, ...over });
const props = (over: Partial<ShopifyViewProps> = {}): ShopifyViewProps => ({ language: 'en', locale: 'en-US', waiting: false, concealed: false, hasSchool: true,
  overview: { state: 'READY', read: overview() }, section: 'theme', catalog: { state: 'LOADING' }, orders: { state: 'LOADING' }, shop: SHOP, confirming: false, outcome: null,
  locked: false, storefront: { state: 'READY', value: storefront() }, ...over });
const render = (over: Partial<ShopifyViewProps> = {}) => renderToStaticMarkup(<ShopifyView {...props(over)} />);

it('reads with a GET, saves and publishes once each with the command header, and distrusts odd answers', async () => {
  const f = stub(json({ data: storefront() }));
  expect((await shopifyApi.storefront(school, signal(), () => true)).settingsVersion).toBe(2);
  expect((f.mock.calls[0] as unknown as [string])[0]).toBe(`/api/v1/school/schools/${school}/shopify/storefront`);
  const g = stub(json({ data: storefront({ settingsVersion: 3 }) }));
  await shopifyApi.saveStorefront(school, 2, SETTINGS, signal(), () => true);
  const [path, init] = g.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe('/api/v1/school/shopify/storefront');
  expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin', redirect: 'error' });
  expect((init.headers as Record<string, string>)['X-HON-Human-Command']).toBeTruthy();
  expect(JSON.parse(init.body as string)).toEqual({ schoolId: school, expectedVersion: 2, settings: SETTINGS });
  // A save that did not move the version, or an answer for another school, is not trusted.
  stub(json({ data: storefront({ settingsVersion: 2 }) }));
  expect((await fails(shopifyApi.saveStorefront(school, 2, SETTINGS, signal(), () => true))).kind).toBe('UNKNOWN');
  stub(json({ data: storefront({ schoolId: id(3) }) }));
  expect((await fails(shopifyApi.storefront(school, signal(), () => true))).kind).toBe('UNKNOWN');
  // Refused settings never leave the browser.
  const n = stub(json({}));
  expect((await fails(shopifyApi.saveStorefront(school, 2, { ...SETTINGS, primaryColor: 'red' }, signal(), () => true))).kind).toBe('INVALID');
  expect(n).not.toHaveBeenCalled();
  const p = stub(json({ data: { outcome: 'PUBLISHED', failureCode: null, storefront: storefront({ publishedVersion: 2 }) } }));
  expect((await shopifyApi.publishStorefront(school, 2, signal(), () => true)).outcome).toBe('PUBLISHED');
  expect(JSON.parse((p.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toEqual({ schoolId: school, settingsVersion: 2 });
  for (const [code, status, kind] of [['SHOPIFY_STOREFRONT_BUSY', 409, 'STOREFRONT_BUSY'], ['SHOPIFY_STOREFRONT_LIMIT', 429, 'STOREFRONT_LIMIT'],
    ['SHOPIFY_STOREFRONT_NOT_LEASED', 409, 'STOREFRONT_DONE'], ['SHOPIFY_VERSION_CONFLICT', 409, 'STALE']] as const) {
    stub(json({ code }, status));
    expect((await fails(shopifyApi.publishStorefront(school, 2, signal(), () => true))).kind).toBe(kind);
  }
  // Theme links that leave the store's own admin are refused.
  stub(json({ data: { ...storefront(), links: { ...links, colors: 'https://evil.example/admin/themes/current/editor?x=1' } } }));
  expect((await fails(shopifyApi.storefront(school, signal(), () => true))).kind).toBe('UNKNOWN');
});

it('shows the three steps: settings, publish status, and theme editor links', () => {
  const html = render();
  expect(html).toContain('data-nav="theme"');
  expect(html).toContain('Storefront');
  expect(html).toContain('data-storefront-status="PUBLISHED"');
  expect(html).toContain('data-storefront-behind');
  for (const k of ['colors', 'sizeGuide', 'pickupNote', 'pickupBanner']) expect(html).toContain(`data-storefront-link="${k}"`);
  expect(html).toContain(`href="${links.sizeGuide.replace(/&/g, '&amp;')}"`);
  expect(html).not.toMatch(/write_themes|draft copy/i);
  // Nothing changed since the save, so Save is off and Publish is on.
  expect(html).toMatch(/disabled=""[^>]*data-storefront-action="save"/);
  expect(html).not.toMatch(/disabled=""[^>]*data-storefront-action="publish"/);
});

it('before any save Publish is off; non-managers and disconnected stores see only a note', () => {
  const fresh = render({ storefront: { state: 'READY', value: storefront({ settings: null, settingsVersion: null, savedAt: null, publishedVersion: null, publishedAt: null, publishStatus: 'NEVER' }) } });
  expect(fresh).toMatch(/disabled=""[^>]*data-storefront-action="publish"/);
  expect(fresh).toContain('Save your settings first.');
  expect(render({ overview: { state: 'READY', read: overview({ canManage: false }) } })).toContain('Only someone who can manage Shopify');
});

it('outcomes: published, not sure (publish again is safe), and busy', () => {
  const cmd = { kind: 'PUBLISH' } as const;
  expect(render({ storefrontOutcome: { kind: 'PUBLISHED', command: cmd, result: { outcome: 'PUBLISHED', failureCode: null, storefront: storefront() } } })).toContain('data-storefront-outcome="PUBLISHED"');
  expect(render({ storefrontOutcome: { kind: 'PUBLISHED', command: cmd, result: { outcome: 'UNKNOWN', failureCode: 'SHOPIFY_UNAVAILABLE', storefront: storefront({ publishStatus: 'UNKNOWN', failureCode: 'SHOPIFY_UNAVAILABLE' }) } } }))
    .toContain('publishing the same settings twice is safe');
  expect(render({ storefrontOutcome: { kind: 'ERROR', command: cmd, error: 'STOREFRONT_BUSY' } })).toContain('already publishing');
});

it('colors', () => {
  expect(storefrontColor('#c8102e')).toBe('#C8102E');
  expect(storefrontColor('#abc')).toBe('#AABBCC');
  expect(storefrontColor('red')).toBe('#121212');
});
