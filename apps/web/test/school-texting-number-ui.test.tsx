import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AvailableSchoolNumber, SchoolNumberOrder } from '@hon/contracts';
import { NUMBER_LANGUAGES } from '../src/components/school-texting-number/copy';
import { NumberError, formatPhone, keepForRetry, numberApi, numberErrorFor, openOrderOf, searchQuery } from '../src/components/school-texting-number/http';
import { EMPTY_SEARCH, NumberView, type NumberViewProps } from '../src/components/school-texting-number/view';
import { SCHOOL_SHELL_NAV, schoolShellActiveRoute } from '../src/components/school-shell/catalog';
import { id } from './account-status-fixtures';

beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const org = id(1), school = id(2), key = id(77), oid = id(40), scope = { organizationId: org, schoolId: school };
const meta = { requestId: id(5) };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const stub = (response: Response) => { const f = vi.fn(async () => response); vi.stubGlobal('fetch', f); return f; };
const signal = () => new AbortController().signal;
const fails = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as NumberError; } throw new Error('expected a failure'); };
const order = (over: Partial<SchoolNumberOrder> = {}): SchoolNumberOrder => ({ orderId: oid, schoolId: school, phoneE164: '+15125550101', locality: 'Austin', region: 'TX',
  monthlyPriceMicrounits: 1150000, status: 'REQUESTED', decisionNote: null, decidedAt: null, failureCode: null, outcomeUnknown: false, version: 1,
  createdAt: '2026-11-15T07:00:00.000Z', updatedAt: '2026-11-15T07:00:00.000Z', ...over });
const avail: AvailableSchoolNumber = { phoneE164: '+15125550199', locality: 'Austin', region: 'TX', monthlyPriceMicrounits: 1150000 };

it('reads with plain GETs and sends each command with its own name and key; the price never comes from the browser', async () => {
  const f = stub(json({ data: { orders: [order()] }, meta }));
  expect(await numberApi.orders({ organizationId: org.toUpperCase(), schoolId: school }, signal(), () => true)).toHaveLength(1);
  const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe(`/api/v1/organizations/${org}/schools/${school}/communications/numbers/orders`);
  expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error' });
  expect(Object.keys(init.headers as object).some(k => /^x-hon|idempotency/i.test(k))).toBe(false);
  const s = stub(json({ data: { numbers: [avail], openOrder: null, hasOwnNumber: false }, meta }));
  expect((await numberApi.search(scope, { city: 'San Antonio', region: 'TX' }, signal(), () => true)).numbers).toHaveLength(1);
  expect((s.mock.calls[0] as unknown as [string])[0]).toBe(`/api/v1/organizations/${org}/schools/${school}/communications/numbers/search?city=San+Antonio&region=TX`);
  const g = stub(json({ data: order({ phoneE164: avail.phoneE164 }), meta }));
  await numberApi.order(scope, avail.phoneE164, key, signal(), () => true);
  const gi = (g.mock.calls[0] as unknown as [string, RequestInit])[1];
  expect(gi.headers).toMatchObject({ 'X-HON-Human-Command': 'communication.number.order', 'Idempotency-Key': key });
  expect(JSON.parse(gi.body as string)).toEqual({ phoneE164: avail.phoneE164 });
  const h = stub(json({ data: order({ status: 'CANCELLED', version: 2 }), meta }));
  await numberApi.cancel(scope, oid.toUpperCase(), 1, key, signal(), () => true);
  expect((h.mock.calls[0] as unknown as [string])[0]).toBe(`/api/v1/organizations/${org}/schools/${school}/communications/numbers/orders/${oid}/cancel`);
  expect((h.mock.calls[0] as unknown as [string, RequestInit])[1]).toMatchObject({ headers: { 'X-HON-Human-Command': 'communication.number.cancel' }, body: '{"expectedVersion":1}' });
  // An answer for another number or another school is not trusted.
  stub(json({ data: order({ phoneE164: '+15125550123' }), meta }));
  expect((await fails(numberApi.order(scope, avail.phoneE164, key, signal(), () => true))).kind).toBe('UNKNOWN');
  stub(json({ data: order({ schoolId: id(3), phoneE164: avail.phoneE164 }), meta }));
  expect((await fails(numberApi.order(scope, avail.phoneE164, key, signal(), () => true))).kind).toBe('UNKNOWN');
  stub(json({ data: { numbers: [{ ...avail, extra: 1 }], openOrder: null, hasOwnNumber: false }, meta }));
  expect((await fails(numberApi.search(scope, { areaCode: '512' }, signal(), () => true))).kind).toBe('UNKNOWN');
  const none = stub(json({}));
  expect((await fails(numberApi.order(scope, '+1512555', key, signal(), () => true))).kind).toBe('INVALID');
  expect((await fails(numberApi.order(scope, avail.phoneE164, 'nope', signal(), () => true))).kind).toBe('INVALID');
  expect((await fails(numberApi.cancel(scope, oid, 0, key, signal(), () => true))).kind).toBe('INVALID');
  expect(none).not.toHaveBeenCalled();
});

it('maps the server answers, keeps only unknown outcomes for retry, and builds only valid searches', () => {
  expect(numberErrorFor(503, 'NUMBER_PROVISIONING_OFF').kind).toBe('OFF'); expect(numberErrorFor(503, 'NUMBER_ORDER_UNAVAILABLE').kind).toBe('UNKNOWN');
  expect(numberErrorFor(409, 'NUMBER_UNAVAILABLE').kind).toBe('TAKEN'); expect(numberErrorFor(409, 'NUMBER_ORDER_UNSETTLED').kind).toBe('CONFLICT');
  expect(numberErrorFor(409, 'IDEMPOTENCY_IN_PROGRESS').kind).toBe('UNKNOWN'); expect(numberErrorFor(403, 'SENDER_MANAGE_FORBIDDEN').kind).toBe('DENIED');
  expect(keepForRetry(new NumberError('UNKNOWN'))).toBe(true); expect(keepForRetry(new NumberError('TAKEN'))).toBe(false);
  expect(searchQuery({ ...EMPTY_SEARCH, areaCode: '512' })).toEqual({ areaCode: '512' }); expect(searchQuery({ ...EMPTY_SEARCH, areaCode: '112' })).toBeNull();
  expect(searchQuery({ mode: 'CITY', areaCode: '', city: ' Austin ', region: 'tx' })).toEqual({ city: 'Austin', region: 'TX' });
  expect(searchQuery({ mode: 'CITY', areaCode: '', city: 'Austin', region: 'T' })).toBeNull();
  expect(formatPhone('+15125550101')).toBe('(512) 555-0101');
  expect(openOrderOf([order({ status: 'CANCELLED' }), order({ orderId: id(41), status: 'FAILED', outcomeUnknown: true })])?.orderId).toBe(id(41));
  expect(openOrderOf([order({ status: 'FAILED', outcomeUnknown: false })])).toBeNull();
});

const base = (over: Partial<NumberViewProps> = {}): NumberViewProps => ({ language: 'en', locale: 'en-US', waiting: false, concealed: false, hasSchool: true,
  orders: { state: 'READY', orders: [] }, search: { state: 'IDLE' }, draft: EMPTY_SEARCH, picked: null, confirmCancel: false, outcome: null, locked: false, canRetry: false, ...over });

it('shows nothing from the school while waiting, hidden, with no school, or refused', () => {
  for (const over of [{ waiting: true }, { concealed: true }, { hasSchool: false }, { orders: { state: 'DENIED' as const } }, { orders: { state: 'UNAVAILABLE' as const } }]) {
    const html = renderToStaticMarkup(<NumberView {...base({ ...over, orders: 'orders' in over ? over.orders : { state: 'READY', orders: [order()] } })} />);
    expect(html).not.toContain('(512) 555-0101'); expect(html).not.toContain('data-number-search');
  }
  expect(renderToStaticMarkup(<NumberView {...base({ orders: { state: 'DENIED' } })} />)).toContain('Only the school owner');
});

it('searches, then confirms the quoted monthly price before ordering, and says nothing is charged today', () => {
  let html = renderToStaticMarkup(<NumberView {...base()} />);
  expect(html).toContain('data-number-search'); expect(html).toMatch(/<button type="submit"[^>]*disabled/);
  html = renderToStaticMarkup(<NumberView {...base({ search: { state: 'READY', numbers: [avail], hasOwnNumber: false } })} />);
  expect(html).toContain('(512) 555-0199'); expect(html).toContain('$1.15 a month'); expect(html).toContain('Pick (512) 555-0199');
  html = renderToStaticMarkup(<NumberView {...base({ picked: avail })} />);
  expect(html).toContain('Order this number?'); expect(html).toContain('$1.15 a month, billed to your school once billing for numbers is switched on. Texting is included.');
  expect(html).toContain('Nothing is charged today'); expect(html).toContain('Order (512) 555-0199');
  expect(renderToStaticMarkup(<NumberView {...base({ search: { state: 'OFF' } })} />)).toContain('not switched on yet');
  expect(renderToStaticMarkup(<NumberView {...base({ search: { state: 'READY', numbers: [], hasOwnNumber: false } })} />)).toContain('No numbers found');
});

it('shows an open order with cancel only before buying, an unsettled order as held, and a bought number', () => {
  let html = renderToStaticMarkup(<NumberView {...base({ orders: { state: 'READY', orders: [order()] } })} />);
  expect(html).toContain('Waiting for HON review'); expect(html).toContain('Cancel this order'); expect(html).not.toContain('data-number-search');
  html = renderToStaticMarkup(<NumberView {...base({ orders: { state: 'READY', orders: [order({ status: 'PURCHASING' })] } })} />);
  expect(html).toContain('Buying now'); expect(html).not.toContain('Cancel this order');
  html = renderToStaticMarkup(<NumberView {...base({ orders: { state: 'READY', orders: [order({ status: 'FAILED', outcomeUnknown: true, failureCode: 'RECONCILE_REQUIRED' })] } })} />);
  expect(html).toContain('HON is checking this order with Twilio'); expect(html).not.toContain('Cancel this order'); expect(html).not.toContain('data-number-search');
  html = renderToStaticMarkup(<NumberView {...base({ orders: { state: 'READY', orders: [order({ status: 'REJECTED', decisionNote: 'Pick a local number' }), order({ orderId: id(41), status: 'PURCHASED' })] } })} />);
  expect(html).toContain('is your school&#x27;s own number'); expect(html).toContain('A2P'); expect(html).toContain('HON said: Pick a local number');
  expect(renderToStaticMarkup(<NumberView {...base({ orders: { state: 'READY', orders: [order()] }, confirmCancel: true })} />)).toContain('Yes, cancel it');
});

it('reports outcomes plainly, with Try again only for an unknown outcome', () => {
  expect(renderToStaticMarkup(<NumberView {...base({ outcome: { kind: 'DONE', action: 'order' } })} />)).toContain('HON will review it before anything is bought');
  expect(renderToStaticMarkup(<NumberView {...base({ outcome: { kind: 'TAKEN', action: 'order' } })} />)).toContain('just taken');
  const unknown = renderToStaticMarkup(<NumberView {...base({ outcome: { kind: 'UNKNOWN', action: 'order' }, canRetry: true, locked: true })} />);
  expect(unknown).toContain('Try again'); expect(unknown).toContain('cannot happen twice');
});

it('has every wording in English, Korean and Spanish, a settings route, and conceals on privacy events', () => {
  const keys = Object.keys(NUMBER_LANGUAGES.en).sort();
  expect(Object.keys(NUMBER_LANGUAGES.ko).sort()).toEqual(keys); expect(Object.keys(NUMBER_LANGUAGES.es).sort()).toEqual(keys);
  for (const table of Object.values(NUMBER_LANGUAGES)) expect(Object.values(table).every(v => v.trim().length > 0)).toBe(true);
  expect(SCHOOL_SHELL_NAV.flatMap(g => g.routes.map(r => r.href))).toContain('/staff/settings/texting-number');
  expect(schoolShellActiveRoute('/staff/settings/texting-number')?.href).toBe('/staff/settings/texting-number');
  expect(readFileSync('src/app/staff/settings/texting-number/page.tsx', 'utf8')).toContain('await requireVerifiedWebSession()');
  expect(readFileSync('public/manus-routes.json', 'utf8')).toContain('"/staff/settings/texting-number"');
  const controller = readFileSync('src/components/school-texting-number/texting-number.tsx', 'utf8');
  expect(controller).toContain('data-shell-private'); expect(controller).toContain('onShellPrivacyEvent');
});
