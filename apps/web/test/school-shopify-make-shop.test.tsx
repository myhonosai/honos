import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import type { HqShopifyStoreRequest, ShopifyStoreRequest } from '@hon/contracts';
import { ShopifyError } from '../src/components/school-shopify/http';
import { hqShopRequestsApi, makeShopApi, makeShopErrorFor, MakeShopError } from '../src/components/school-shopify/make-shop-http';
import { MAKE_SHOP_LANGUAGES } from '../src/components/school-shopify/make-shop-copy';
import { MakeShopView, type MakeShopViewProps } from '../src/components/school-shopify/make-shop';
import { HqShopRequestsView, type HqShopRequestsViewProps } from '../src/components/hq-shop-requests/view';
import { HQ_SCHOOLS, hqPageLabel } from '../src/components/hq-modern/catalog';

const school = '44444444-4444-4444-8444-444444444444', id = '55555555-5555-4555-8555-555555555555', at = '2026-11-22T20:00:00.000Z';
const request = (over: Partial<ShopifyStoreRequest> = {}): ShopifyStoreRequest => ({ requestId: id, shopName: 'Synthetic Dojo Pro Shop', ownerEmail: 'owner@example.test', note: null,
  status: 'REQUESTED', shopDomain: null, requestedAt: at, settledAt: null, version: 1, ...over });
const hq = (over: Partial<HqShopifyStoreRequest> = {}): HqShopifyStoreRequest => ({ ...request(), schoolId: school, schoolName: 'Synthetic Dojo', ...over });
const made = { status: 'CREATED' as const, shopDomain: 'synthetic-dojo.myshopify.com', settledAt: at, version: 2 };
const props = (over: Partial<MakeShopViewProps> = {}): MakeShopViewProps => ({ language: 'en', locale: 'en-US', state: { state: 'READY', request: null }, outcome: null, schoolName: 'Synthetic Dojo',
  onAsk: () => {}, onCancel: () => {}, onUseStore: () => {}, onRefresh: () => {}, ...over });
const hqProps = (over: Partial<HqShopRequestsViewProps> = {}): HqShopRequestsViewProps => ({ language: 'en', formattingLocale: 'en-US', concealed: false,
  state: { state: 'READY', view: { open: [hq()], settled: [hq({ ...made, requestId: '66666666-6666-4666-8666-666666666666' })] } }, outcome: null,
  onSettle: () => {}, onRefresh: () => {}, onReveal: () => {}, ...over });
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
afterEach(() => { vi.unstubAllGlobals(); });

it('school card: the form with the school name filled in, then waiting, then ready with the next steps', () => {
  let html = renderToStaticMarkup(<MakeShopView {...props()} />);
  expect(html).toContain('data-make-shop="FORM"'); expect(html).toContain('value="Synthetic Dojo"'); expect(html).toContain('HON makes it for you');
  expect(html).toContain('Shopify bills you'); expect(html).toContain('referral fee'); expect(html).toMatch(/data-make-shop-ask="true" disabled=""/);
  html = renderToStaticMarkup(<MakeShopView {...props({ state: { state: 'READY', request: request() } })} />);
  expect(html).toContain('data-make-shop="REQUESTED"'); expect(html).toContain('owner@example.test'); expect(html).toContain('data-make-shop-cancel'); expect(html).not.toContain('data-make-shop-ask');
  html = renderToStaticMarkup(<MakeShopView {...props({ state: { state: 'READY', request: request(made) } })} />);
  expect(html).toContain('data-make-shop="CREATED"'); expect(html).toContain('synthetic-dojo.myshopify.com'); expect(html).toContain('Connect this store');
  html = renderToStaticMarkup(<MakeShopView {...props({ state: { state: 'READY', request: request({ status: 'DECLINED', settledAt: at, version: 2 }) } })} />);
  expect(html).toContain('data-make-shop-last="DECLINED"'); expect(html).toContain('data-make-shop-ask');
  html = renderToStaticMarkup(<MakeShopView {...props({ state: { state: 'READY', request: request({ status: 'CANCELLED', settledAt: at, version: 2 }) } })} />);
  expect(html).toContain('data-make-shop-last="CANCELLED"');
  expect(renderToStaticMarkup(<MakeShopView {...props({ state: { state: 'UNAVAILABLE' } })} />)).toContain('could not be loaded');
  expect(renderToStaticMarkup(<MakeShopView {...props({ outcome: { kind: 'ERROR', error: 'LIMIT' } })} />)).toContain('five times in the last 30 days');
});

it('HQ page: the steps, each waiting school with the owner email, closed requests, and honest states', () => {
  let html = renderToStaticMarkup(<HqShopRequestsView {...hqProps()} />);
  expect(html).toContain('Create a client transfer store'); expect(html).toContain('Waiting for a store (1)'); expect(html).toContain('Synthetic Dojo');
  expect(html).toContain('owner@example.test'); expect(html).toContain('data-shop-request-made'); expect(html).toContain('synthetic-dojo.myshopify.com');
  html = renderToStaticMarkup(<HqShopRequestsView {...hqProps({ state: { state: 'READY', view: { open: [], settled: [] } } })} />);
  expect(html).toContain('No school is waiting'); expect(html).not.toContain('Recently closed');
  expect(renderToStaticMarkup(<HqShopRequestsView {...hqProps({ state: { state: 'DENIED' } })} />)).toContain('billing access');
  html = renderToStaticMarkup(<HqShopRequestsView {...hqProps({ concealed: true })} />);
  expect(html).toContain('Hidden while you were away'); expect(html).not.toContain('owner@example.test');
  expect(renderToStaticMarkup(<HqShopRequestsView {...hqProps({ outcome: { kind: 'DONE', outcome: 'CREATED' } })} />)).toContain('data-shop-request-outcome="CREATED"');
  expect(renderToStaticMarkup(<HqShopRequestsView {...hqProps({ outcome: { kind: 'ERROR', error: 'STALE' } })} />)).toContain('Someone else changed this');
  expect(HQ_SCHOOLS.some(x => x.path === '/hq/schools/shopify-stores')).toBe(true); expect(hqPageLabel('/hq/schools/shopify-stores')).toBe('Shopify Store Requests');
});

it('transport: same-origin, the Shopify command header on commands, checked inputs, and answers that must match what was asked', async () => {
  const calls: [string, RequestInit][] = [];
  const answers: Response[] = [reply(200, { data: { schoolId: school, request: null } }), reply(200, { data: { schoolId: school, request: request() } }),
    reply(200, { data: { schoolId: school, request: request({ status: 'CANCELLED', settledAt: at, version: 2 }) } }),
    reply(200, { data: { open: [hq()], settled: [] } }), reply(200, { data: hq(made) }), reply(200, { data: hq(made) })];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => { calls.push([url, init]); return answers.shift()!; }));
  const signal = () => AbortSignal.timeout(5000), owned = () => true;
  expect((await makeShopApi.read(school, signal(), owned)).request).toBeNull();
  expect(calls[0]![0]).toBe(`/api/v1/school/schools/${school}/shopify/store-request`); expect(calls[0]![1].method).toBe('GET');
  expect((await makeShopApi.ask(school, 'Synthetic Dojo Pro Shop', 'owner@example.test', null, signal(), owned)).request?.status).toBe('REQUESTED');
  expect(calls[1]![0]).toBe('/api/v1/school/shopify/store-request'); expect((calls[1]![1].headers as Record<string, string>)['X-HON-Human-Command']).toBeTruthy();
  expect(JSON.parse(calls[1]![1].body as string)).toEqual({ schoolId: school, shopName: 'Synthetic Dojo Pro Shop', ownerEmail: 'owner@example.test', note: null });
  await expect(makeShopApi.ask(school, 'Shop', 'Owner@Example.test', null, signal(), owned)).rejects.toMatchObject({ kind: 'INVALID' });
  expect(calls.length).toBe(2);
  expect((await makeShopApi.cancel(school, id, signal(), owned)).request?.status).toBe('CANCELLED');
  expect((await hqShopRequestsApi.list(signal(), owned)).open[0]!.schoolName).toBe('Synthetic Dojo');
  expect(calls[3]![0]).toBe('/api/v1/hq/shopify/store-requests');
  expect((await hqShopRequestsApi.settle(id, 1, 'CREATED', 'synthetic-dojo.myshopify.com', signal(), owned)).status).toBe('CREATED');
  expect(JSON.parse(calls[4]![1].body as string)).toEqual({ requestId: id, expectedVersion: 1, outcome: 'CREATED', shopDomain: 'synthetic-dojo.myshopify.com' });
  await expect(hqShopRequestsApi.settle(id, 1, 'DECLINED', null, signal(), owned)).rejects.toMatchObject({ kind: 'UNKNOWN' });
  await expect(hqShopRequestsApi.settle(id, 1, 'CREATED', 'synthetic-dojo.com', signal(), owned)).rejects.toMatchObject({ kind: 'INVALID' });
});

it('refusals map to closed kinds and every phrase exists in Korean and Spanish', () => {
  for (const [code, kind] of [['SHOPIFY_STORE_REQUEST_OPEN', 'OPEN'], ['SHOPIFY_STORE_REQUEST_SETTLED', 'DONE'], ['SHOPIFY_STORE_REQUEST_CONNECTED', 'CONNECTED'],
    ['SHOPIFY_STORE_REQUEST_LIMIT', 'LIMIT'], ['SHOPIFY_VERSION_CONFLICT', 'STALE'], ['SHOPIFY_NOT_FOUND', 'GONE'], ['SOMETHING_ELSE', 'UNKNOWN']] as const)
    expect(makeShopErrorFor(new ShopifyError(code === 'SHOPIFY_VERSION_CONFLICT' ? 'STALE' : 'UNKNOWN', code)).kind).toBe(kind);
  expect(makeShopErrorFor(new ShopifyError('DENIED', 'SHOPIFY_FORBIDDEN')).kind).toBe('DENIED'); expect(makeShopErrorFor(new Error('x')).kind).toBe('UNKNOWN');
  expect(makeShopErrorFor(new MakeShopError('LIMIT')).kind).toBe('LIMIT');
  const keys = Object.keys(MAKE_SHOP_LANGUAGES.en).sort();
  for (const lang of ['ko', 'es'] as const) {
    expect(Object.keys(MAKE_SHOP_LANGUAGES[lang]).sort()).toEqual(keys);
    for (const k of keys) expect(MAKE_SHOP_LANGUAGES[lang][k as keyof typeof MAKE_SHOP_LANGUAGES.en].length).toBeGreaterThan(0);
  }
});
