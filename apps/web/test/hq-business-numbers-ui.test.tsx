import React from 'react';
import { existsSync, readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { businessApi, BusinessError } from '../src/components/hq-business-numbers/http';
import { businessText } from '../src/components/hq-business-numbers/copy';
import { HqBusinessNumbersView, type BusinessState } from '../src/components/hq-business-numbers/hq-business-numbers';
import { HQ_NAV_GROUPS, hqPageLabel } from '../src/components/hq-modern/catalog';

const yes = () => true;
beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const T = '2026-11-13T00:00:00.000Z';
const current = (patch: Record<string, unknown> = {}) => ({ mrrMinor: 63701, arrMinor: 764412, payingSchools: 3, payingByInterval: { MONTHLY: 2, ANNUAL: 1 },
  payingBySource: { SCHEDULE_BINDING: 2, V1_SUBSCRIPTION: 1 }, unpricedActiveRecords: 1, lifetimeSchools: 4, bindingsNeedingReview: 5, suspendedSubscriptions: 6,
  activeTrials: 7, ...patch });
const month = (m: string, last: boolean, patch: Record<string, unknown> = {}) => ({ month: m, monthToDate: last, newSchools: 11, publicSignups: 12, trialsStarted: 13,
  newPayingSchools: 14, trialConversions: 9, stoppedPayingSchools: 15, ...patch });
const numbers = (n = 3, patch: Record<string, unknown> = {}) => ({ current: current(),
  months: Array.from({ length: n }, (_, i) => month(new Date(Date.UTC(2026, 10 - (n - 1) + i, 1)).toISOString().slice(0, 7), i === n - 1)),
  monthsRequested: n, currency: 'USD', chargesEnabled: false, churnRateAvailable: false, asOf: T, ...patch });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const stub = (...answers: Response[]) => { const f = vi.fn(async () => answers.shift() ?? json({}, 500)); vi.stubGlobal('fetch', f); return f; };
const view = (state: BusinessState, extra: Partial<{ concealed: boolean; language: string; months: number }> = {}) => renderToStaticMarkup(
  <HqBusinessNumbersView language={extra.language ?? 'en'} formattingLocale="en-US" concealed={extra.concealed ?? false} state={state} months={extra.months ?? 3}
    onRefresh={() => {}} onReveal={() => {}} onMonths={() => {}}/>);

it('reads the numbers with one plain same-origin GET for the asked month count', async () => {
  const f = stub(json({ data: numbers(6) }));
  expect((await businessApi.numbers(6, new AbortController().signal, yes)).current.mrrMinor).toBe(63701);
  const [url, init] = (f.mock.calls as unknown as [string, RequestInit][])[0]!;
  expect(url).toBe('/api/v1/hq/saas/business-numbers?months=6');
  expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error' });
  expect(init.body).toBeUndefined();
});

it('refuses bad month counts before calling and every drifted or mismatched answer after', async () => {
  const f = stub();
  for (const bad of [0, 13, 1.5]) await expect(businessApi.numbers(bad, new AbortController().signal, yes)).rejects.toMatchObject({ kind: 'INVALID' });
  expect(f).not.toHaveBeenCalled();
  const kind = async (r: Response) => { stub(r); try { await businessApi.numbers(3, new AbortController().signal, yes); return 'OK'; } catch (e) { return (e as BusinessError).kind; } };
  expect(await kind(json({ data: numbers(6) }))).toBe('UNKNOWN'); // answer for another month count
  expect(await kind(json({ data: numbers(3, { chargesEnabled: true }) }))).toBe('UNKNOWN');
  expect(await kind(json({ data: { ...numbers(3), current: current({ arrMinor: 1 }) } }))).toBe('UNKNOWN');
  expect(await kind(json({ data: numbers(3), extra: 1 }))).toBe('UNKNOWN');
  expect(await kind(new Response('{}', { status: 200, headers: { 'Content-Type': 'text/html' } }))).toBe('UNKNOWN');
  expect(await kind(json({ code: 'SAAS_FORBIDDEN' }, 403))).toBe('DENIED');
  expect(await kind(json({}, 503))).toBe('UNKNOWN');
});

it('shows list-price money, every count, months newest first and the no-churn note', () => {
  const html = view({ state: 'READY', view: numbers(3) as never });
  expect(html).toContain('data-hq-business="ready"');
  expect(html).toContain('Charges are not enabled. Every amount is a recorded list price, not money collected.');
  expect(html).toContain('$637.01'); expect(html).toContain('$7,644.12');
  expect(html).toContain('2 monthly, 1 annual; 2 HON OS plan, 1 earlier subscription');
  for (const k of ['lifetime', 'unpriced', 'review', 'suspended', 'trials']) expect(html).toContain(`data-business-fact="${k}"`);
  const rows = [...html.matchAll(/data-business-month="([0-9-]+)"/g)].map(m => m[1]);
  expect(rows).toEqual(['2026-11', '2026-10', '2026-09']);
  expect(html).toContain('Nov 2026 (to date)');
  expect(html).toContain('No churn rate is shown.');
  expect(html).not.toMatch(/churn rate:|collected revenue/i);
  expect(html).toContain('aria-pressed="true"');
});

it('shows nothing but a notice while loading, denied, unavailable or concealed', () => {
  expect(view({ state: 'LOADING' })).toContain('Reading business numbers');
  expect(view({ state: 'DENIED' })).toContain('does not include business numbers');
  expect(view({ state: 'UNAVAILABLE' })).toContain('could not be read or checked');
  const hidden = view({ state: 'READY', view: numbers(3) as never }, { concealed: true });
  expect(hidden).toContain('data-hq-business="concealed"'); expect(hidden).not.toContain('$637.01');
});

it('words every key in three languages', () => {
  const en = readFileSync('src/components/hq-business-numbers/copy.ts', 'utf8');
  for (const lang of ['ko', 'es']) expect(businessText(lang, 'testMode')).not.toBe(businessText('en', 'testMode'));
  expect(businessText('ko', 'toDate', { month: 'X' })).toContain('X');
  expect(en).toContain('const ko: Record<Key, string>'); expect(en).toContain('const es: Record<Key, string>');
  expect(view({ state: 'READY', view: numbers(3) as never }, { language: 'es' })).toContain('Los cobros no están activados');
});

it('is in the Revenue navigation group and the route manifest', () => {
  expect(HQ_NAV_GROUPS['/hq/revenue']?.children.map(c => c.path)).toContain('/hq/revenue/business-numbers');
  expect(hqPageLabel('/hq/revenue/business-numbers')).toBe('Business Numbers');
  expect(existsSync('src/app/hq/revenue/business-numbers/page.tsx')).toBe(true);
  const manifest = JSON.parse(readFileSync('public/manus-routes.json', 'utf8')) as { routes: { path: string }[] };
  expect(manifest.routes.filter(r => r.path === '/hq/revenue/business-numbers')).toHaveLength(1);
});
