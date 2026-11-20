import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ShopifyConnection, ShopifyOverview, ShopifyThemeWorkResult, ShopifyThemeWorkspace } from '@hon/contracts';
import { ShopifyError, shopifyApi } from '../src/components/school-shopify/http';
import { lineDiff, themeColor } from '../src/components/school-shopify/theme';
import { ShopifyView, type ShopifyViewProps } from '../src/components/school-shopify/view';
import { id } from './account-status-fixtures';

// TB1 (0595): the Theme section previews a ready-made change, writes it only to HON's unpublished copy, and can undo it.
beforeEach(() => { vi.stubGlobal('window', new EventTarget()); vi.stubGlobal('location', { origin: 'https://app.hon.test' }); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const school = id(2), cid = id(40), edit = id(41), at = '2026-11-19T05:00:00.000Z', SHOP = 'ima-test.myshopify.com';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const stub = (response: Response) => { const f = vi.fn(async () => response); vi.stubGlobal('fetch', f); return f; };
const signal = () => new AbortController().signal;
const fails = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as ShopifyError; } throw new Error('expected a failure'); };
const connection = (): ShopifyConnection => ({ connectionId: cid, shopDomain: SHOP, shopName: 'Synthetic Dojo Store', currency: 'USD',
  status: 'CONNECTED', version: 2, connectedAt: at, endedAt: null, lastSyncAt: at, lastSyncOutcome: 'SUCCEEDED', syncRunning: false });
const overview = (over: Partial<ShopifyOverview> = {}): ShopifyOverview => ({ schoolId: school, canManage: true, connectEnabled: true, autoSync: false, connection: connection(),
  counts: { products: 0, variants: 0, lowStock: 0, orders: 0 },
  summary: { days: 30, orders: 0, sales: 0, averageOrder: 0, itemsSold: 0, lineSales: 0, coveredSales: 0, estimatedGrossProfit: 0, topProducts: [] }, ...over });
const workspace = (over: Partial<ShopifyThemeWorkspace> = {}): ShopifyThemeWorkspace => ({ schoolId: school, connected: true, themesAllowed: true,
  baseTheme: { id: '140000000001', name: 'Dawn' }, draftTheme: { id: '140000000002', name: 'HON draft - Dawn' }, busy: false,
  edits: [{ id: edit, kind: 'APPLY', recipe: 'PICKUP_NOTE', inputs: { text: 'Front desk' }, undoOf: null, status: 'APPLIED', failureCode: null,
    draftThemeId: '140000000002', requestedAt: at, finishedAt: at, files: ['templates/cart.json'], undoable: true }], ...over });
const props = (over: Partial<ShopifyViewProps> = {}): ShopifyViewProps => ({ language: 'en', locale: 'en-US', waiting: false, concealed: false, hasSchool: true,
  overview: { state: 'READY', read: overview() }, section: 'theme', catalog: { state: 'LOADING' }, orders: { state: 'LOADING' }, shop: SHOP, confirming: false, outcome: null,
  locked: false, theme: { state: 'READY', value: workspace() }, ...over });
const render = (over: Partial<ShopifyViewProps> = {}) => renderToStaticMarkup(<ShopifyView {...props(over)} />);
const preview: ShopifyThemeWorkResult = { outcome: 'DONE', failureCode: null, workspace: workspace(),
  preview: { schoolId: school, recipe: 'SCHOOL_COLORS', target: { id: '140000000002', name: 'HON draft - Dawn' },
    files: [{ filename: 'config/settings_data.json', before: '{\n  "button": "#121212"\n}', after: '{\n  "button": "#C8102E"\n}', changed: true }] } };

it('reads the workspace with a GET and sends each theme command once, with its own command header', async () => {
  const f = stub(json({ data: workspace() }));
  expect((await shopifyApi.theme(school, signal(), () => true)).draftTheme?.name).toBe('HON draft - Dawn');
  expect((f.mock.calls[0] as unknown as [string])[0]).toBe(`/api/v1/school/schools/${school}/shopify/theme`);
  const g = stub(json({ data: preview }));
  const cmd = { purpose: 'PREVIEW', recipe: 'SCHOOL_COLORS', inputs: { primary: '#C8102E', secondary: null }, undoOf: null } as const;
  expect((await shopifyApi.themeWork(school, cmd, signal(), () => true)).preview?.files[0]?.changed).toBe(true);
  const [path, init] = g.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe('/api/v1/school/shopify/theme');
  expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin', redirect: 'error' });
  expect((init.headers as Record<string, string>)['X-HON-Human-Command']).toBeTruthy();
  expect(JSON.parse(init.body as string)).toEqual({ schoolId: school, ...cmd });
  // Refused inputs never leave the browser; refusals map to their own kinds; an answer for another school is not trusted.
  expect((await fails(shopifyApi.themeWork(school, { ...cmd, inputs: { primary: 'red', secondary: null } } as never, signal(), () => true))).kind).toBe('INVALID');
  stub(json({ code: 'SHOPIFY_THEMES_NOT_ALLOWED' }, 409));
  expect((await fails(shopifyApi.themeWork(school, cmd, signal(), () => true))).kind).toBe('THEMES_OFF');
  stub(json({ code: 'SHOPIFY_THEME_BUSY' }, 409));
  expect((await fails(shopifyApi.themeWork(school, cmd, signal(), () => true))).kind).toBe('THEME_BUSY');
  stub(json({ data: { ...preview, workspace: workspace({ schoolId: id(3) }) } }));
  expect((await fails(shopifyApi.themeWork(school, cmd, signal(), () => true))).kind).toBe('UNKNOWN');
  // Allow theme editing asks for the theme scopes along with what the store already allows.
  const c = stub(json({ data: { authorizeUrl: `https://${SHOP}/admin/oauth/authorize?state=y`, shopDomain: SHOP, expiresAt: at } }));
  await shopifyApi.connect(school, SHOP, signal(), () => true, true, false, true);
  expect(JSON.parse((c.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toEqual({ schoolId: school, shopDomain: SHOP, allowEditing: true, allowFinance: false, allowThemes: true });
});

it('shows the live theme, the draft copy with preview and editor links, the recipes and the undoable history', () => {
  const html = render();
  expect(html).toContain('data-nav="theme"');
  expect(html).toMatch(/data-theme-live.*Dawn/);
  expect(html).toContain(`href="https://${SHOP}/?preview_theme_id=140000000002"`);
  expect(html).toContain('href="https://admin.shopify.com/store/ima-test/themes/140000000002/editor"');
  for (const r of ['SCHOOL_COLORS', 'SIZE_GUIDE', 'PICKUP_NOTE']) expect(html).toContain(`data-recipe="${r}"`);
  expect(html).toMatch(/data-theme-action="apply"[^>]*disabled|disabled[^>]*data-theme-action="apply"/);
  expect(html).toContain(`data-theme-undo="${edit}"`);
  expect(html).not.toMatch(/publish this|Publish theme/i);
});

it('asks for theme editing when the store has not allowed it, and hides the section from non-managers', () => {
  expect(render({ theme: { state: 'READY', value: workspace({ themesAllowed: false, baseTheme: null, draftTheme: null, edits: [] }) } })).toContain('Allow theme editing');
  expect(render({ overview: { state: 'READY', read: overview({ canManage: false }) } })).toContain('Only someone who can manage Shopify');
});

it('a verified preview shows a line diff and enables writing to the draft copy', () => {
  const html = render({ themeOutcome: { kind: 'DONE', command: { purpose: 'PREVIEW', recipe: 'SCHOOL_COLORS', inputs: { primary: '#121212', secondary: null }, undoOf: null }, result: preview } });
  expect(html).toContain('data-theme-preview');
  expect(html).toContain('data-diff="add"');
  expect(html).toContain('#C8102E');
  expect(html).not.toMatch(/data-theme-action="apply"[^>]*disabled/);
  const unknown = render({ themeOutcome: { kind: 'DONE', command: { purpose: 'APPLY', recipe: 'PICKUP_NOTE', inputs: { text: 'x' }, undoOf: null },
    result: { outcome: 'UNKNOWN', failureCode: 'SHOPIFY_UNAVAILABLE', preview: null, workspace: workspace() } } });
  expect(unknown).toContain('could not tell whether Shopify saved this');
});

it('line diffs and colors', () => {
  expect(lineDiff('a\nb\nc', 'a\nB\nc').map(x => x.kind)).toEqual(['same', 'del', 'add', 'same']);
  expect(themeColor('#c8102e')).toBe('#C8102E');
  expect(themeColor('#abc')).toBe('#AABBCC');
  expect(themeColor('red')).toBe('#121212');
});
