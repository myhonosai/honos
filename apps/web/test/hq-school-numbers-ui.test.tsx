import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { HqSchoolNumberOrder } from '@hon/contracts';
import { HQ_NUMBER_LANGUAGES } from '../src/components/hq-school-numbers/copy';
import { HqNumberError, hqNumberApi, hqNumberErrorFor, noteOk } from '../src/components/hq-school-numbers/http';
import { HqSchoolNumbersView, formReady, type HqSchoolNumbersViewProps } from '../src/components/hq-school-numbers/hq-school-numbers';
import { id } from './account-status-fixtures';

beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const oid = id(40), school = id(2);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const stub = (response: Response) => { const f = vi.fn(async () => response); vi.stubGlobal('fetch', f); return f; };
const signal = () => new AbortController().signal;
const fails = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as HqNumberError; } throw new Error('expected a failure'); };
const row = (over: Partial<HqSchoolNumberOrder> = {}): HqSchoolNumberOrder => ({ orderId: oid, schoolId: school, phoneE164: '+15125550101', locality: 'Austin', region: 'TX',
  monthlyPriceMicrounits: 1150000, status: 'REQUESTED', decisionNote: null, decidedAt: null, failureCode: null, outcomeUnknown: false, version: 3,
  createdAt: '2026-11-15T07:00:00.000Z', updatedAt: '2026-11-15T07:00:00.000Z', schoolName: 'Austin Dojo', ...over });

it('lists through the SaaS read and sends approve, reject and settle as their own SaaS commands with the seen version', async () => {
  const f = stub(json({ data: { orders: [row()] } }));
  expect(await hqNumberApi.list('REQUESTED', signal(), () => true)).toHaveLength(1);
  const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe('/api/v1/hq/saas/school-number-orders?status=REQUESTED');
  expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error' });
  stub(json({ data: { orders: [row({ status: 'APPROVED' })] } }));
  expect((await fails(hqNumberApi.list('REQUESTED', signal(), () => true))).kind).toBe('UNKNOWN');
  const d = stub(json({ data: row({ status: 'APPROVED', version: 4 }) }));
  await hqNumberApi.decide(oid.toUpperCase(), 'APPROVE', '', 3, signal(), () => true);
  expect((d.mock.calls[0] as unknown as [string])[0]).toBe(`/api/v1/hq/saas/school-number-orders/${oid}/decision`);
  const di = (d.mock.calls[0] as unknown as [string, RequestInit])[1];
  expect(di.headers).toMatchObject({ 'X-HON-Human-Command': 'hq-school-number-order-decide', 'Content-Type': 'application/json' });
  expect(Object.keys(di.headers as object).some(k => /idempotency/i.test(k))).toBe(false);
  expect(JSON.parse(di.body as string)).toEqual({ decision: 'APPROVE', expectedVersion: 3 });
  const s = stub(json({ data: row({ status: 'APPROVED', outcomeUnknown: true, version: 9 }) }));
  await hqNumberApi.settle(oid, 'BOUGHT', 'Seen in console', 8, signal(), () => true);
  expect((s.mock.calls[0] as unknown as [string])[0]).toBe(`/api/v1/hq/saas/school-number-orders/${oid}/settle`);
  expect((s.mock.calls[0] as unknown as [string, RequestInit])[1].headers).toMatchObject({ 'X-HON-Human-Command': 'hq-school-number-order-settle' });
  expect(JSON.parse((s.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toEqual({ expectedVersion: 8, finding: 'BOUGHT', note: 'Seen in console' });
  stub(json({ data: row({ orderId: id(41) }) }));
  expect((await fails(hqNumberApi.decide(oid, 'APPROVE', '', 3, signal(), () => true))).kind).toBe('UNKNOWN');
  const none = stub(json({}));
  expect((await fails(hqNumberApi.decide(oid, 'REJECT', '', 3, signal(), () => true))).kind).toBe('INVALID');
  expect((await fails(hqNumberApi.settle(oid, 'NOT_BOUGHT', ' padded', 3, signal(), () => true))).kind).toBe('INVALID');
  expect((await fails(hqNumberApi.settle(oid, 'NOT_BOUGHT', 'ok', 0, signal(), () => true))).kind).toBe('INVALID');
  expect(none).not.toHaveBeenCalled();
  expect(hqNumberErrorFor(409, 'NUMBER_ORDER_NOT_UNSETTLED').kind).toBe('CONFLICT'); expect(hqNumberErrorFor(403, 'SAAS_FORBIDDEN').kind).toBe('DENIED');
  expect(hqNumberErrorFor(503, 'SAAS_UNAVAILABLE').kind).toBe('UNKNOWN'); expect(noteOk('x'.repeat(501))).toBe(false);
});

const base = (over: Partial<HqSchoolNumbersViewProps> = {}): HqSchoolNumbersViewProps => ({ language: 'en', formattingLocale: 'en-US', concealed: false,
  state: { state: 'READY', orders: [row()] }, filter: null, form: null, outcome: null, busy: false,
  onRefresh: () => {}, onReveal: () => {}, onFilter: () => {}, onForm: () => {}, onSubmit: () => {}, ...over });

it('shows orders with approve and reject only while waiting for review, and settle only for an unknown purchase result', () => {
  let html = renderToStaticMarkup(<HqSchoolNumbersView {...base()} />);
  expect(html).toContain('Austin Dojo'); expect(html).toContain('(512) 555-0101'); expect(html).toContain('$1.15/month'); expect(html).toContain('Needs review');
  expect(html).toContain('>Approve<'); expect(html).toContain('>Reject<'); expect(html).not.toContain('>Settle<'); expect(html).toContain('buys nothing until');
  html = renderToStaticMarkup(<HqSchoolNumbersView {...base({ state: { state: 'READY', orders: [row({ status: 'FAILED', outcomeUnknown: true, failureCode: 'RECONCILE_REQUIRED' })] } })} />);
  expect(html).toContain('Result unknown: settle'); expect(html).toContain('>Settle<'); expect(html).not.toContain('>Approve<'); expect(html).toContain('RECONCILE_REQUIRED');
  html = renderToStaticMarkup(<HqSchoolNumbersView {...base({ state: { state: 'READY', orders: [row({ status: 'FAILED', failureCode: 'SETTLED_NOT_BOUGHT' })] } })} />);
  expect(html).not.toContain('>Settle<');
  for (const state of [{ state: 'LOADING' as const }, { state: 'DENIED' as const }, { state: 'UNAVAILABLE' as const }]) expect(renderToStaticMarkup(<HqSchoolNumbersView {...base({ state })} />)).not.toContain('Austin Dojo');
  expect(renderToStaticMarkup(<HqSchoolNumbersView {...base({ concealed: true })} />)).not.toContain('Austin Dojo');
});

it('asks for a reason to reject, a finding and a note to settle, and enables Record only when the server would accept it', () => {
  expect(formReady({ orderId: oid, kind: 'APPROVE', finding: null, note: '' })).toBe(true);
  expect(formReady({ orderId: oid, kind: 'REJECT', finding: null, note: '' })).toBe(false);
  expect(formReady({ orderId: oid, kind: 'SETTLE', finding: null, note: 'Checked' })).toBe(false);
  expect(formReady({ orderId: oid, kind: 'SETTLE', finding: 'NOT_BOUGHT', note: 'Checked' })).toBe(true);
  const settle = renderToStaticMarkup(<HqSchoolNumbersView {...base({ state: { state: 'READY', orders: [row({ status: 'FAILED', outcomeUnknown: true })] },
    form: { orderId: oid, kind: 'SETTLE', finding: null, note: '' } })} />);
  expect(settle).toContain('Phone Numbers, Active numbers'); expect(settle).toContain('(512) 555-0101 is on the subaccount'); expect(settle).toContain('without buying it again');
  expect(settle).toMatch(/<button type="submit"[^>]*disabled/);
  const reject = renderToStaticMarkup(<HqSchoolNumbersView {...base({ form: { orderId: oid, kind: 'REJECT', finding: null, note: '' } })} />);
  expect(reject).toContain('The school owner sees this reason');
  expect(renderToStaticMarkup(<HqSchoolNumbersView {...base({ outcome: { kind: 'DONE', what: 'NOT_BOUGHT' } })} />)).toContain('The school can order again');
  expect(renderToStaticMarkup(<HqSchoolNumbersView {...base({ outcome: { kind: 'UNKNOWN', what: 'APPROVE' } })} />)).toContain('Refresh before trying again');
});

it('has every wording in English, Korean and Spanish and is reachable from Texts and email', () => {
  const keys = Object.keys(HQ_NUMBER_LANGUAGES.en).sort();
  expect(Object.keys(HQ_NUMBER_LANGUAGES.ko).sort()).toEqual(keys); expect(Object.keys(HQ_NUMBER_LANGUAGES.es).sort()).toEqual(keys);
  for (const table of Object.values(HQ_NUMBER_LANGUAGES)) expect(Object.values(table).every(v => v.trim().length > 0)).toBe(true);
  expect(readFileSync('src/components/hq-communications/view.tsx', 'utf8')).toContain('/hq/communications/numbers');
  expect(readFileSync('public/manus-routes.json', 'utf8')).toContain('"/hq/communications/numbers"');
});
