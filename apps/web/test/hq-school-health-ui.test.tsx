import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { validateHqSchoolsNeedingAttention } from '@hon/contracts';
import { healthApi } from '../src/components/hq-school-health/http';
import { healthText } from '../src/components/hq-school-health/copy';
import { HealthSignals, HealthTable, HqSchoolHealthCard } from '../src/components/hq-school-health/parts';
import { HqSchoolsAttentionView, type AttentionState } from '../src/components/hq-school-health/hq-schools-attention';
import { HqSchoolDetailView } from '../src/components/hq-school-detail/view';
import { HQ_NAV_GROUPS, hqPageLabel } from '../src/components/hq-modern/catalog';

const yes = () => true;
beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const T = '2026-11-09T00:00:00.000Z';
const facts = (patch: Record<string, unknown> = {}) => ({
  attendance: { last30Days: 3, previous30Days: 12, lastRecordedAt: T }, classes: { heldLast30Days: 4, scheduledNext14Days: 1 }, bookingsLast30Days: 6,
  leads: { newLast30Days: 1, newPrevious30Days: 2, wonLast30Days: 1, open: 2 }, activeStudents: 9, openSupportCases: 0, signals: ['ATTENDANCE_DOWN'], ...patch });
const quiet = () => facts({ attendance: { last30Days: 0, previous30Days: 0, lastRecordedAt: null }, classes: { heldLast30Days: 0, scheduledNext14Days: 0 },
  leads: { newLast30Days: 0, newPrevious30Days: 0, wonLast30Days: 0, open: 0 }, activeStudents: 0, openSupportCases: 1,
  signals: ['NO_ACTIVE_STUDENTS', 'NO_CLASSES_NEXT_14_DAYS', 'NO_NEW_LEADS_30_DAYS', 'OPEN_SUPPORT_CASES'] });
const school = (n = 1, h = facts()) => ({ schoolId: id(n), health: h, asOf: T });
const attention = (patch: Record<string, unknown> = {}) => ({ schools: [
  { schoolId: id(1), schoolDisplayName: 'Synthetic Quiet', organizationId: id(9), organizationDisplayName: 'Synthetic Org', health: quiet() },
  { schoolId: id(2), schoolDisplayName: 'Synthetic Busy', organizationId: id(9), organizationDisplayName: 'Synthetic Org', health: facts() }],
  checked: 7, flagged: 2, truncated: false, limit: 50, asOf: T, ...patch });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const stub = (...answers: Response[]) => { const f = vi.fn(async () => answers.shift() ?? json({}, 500)); vi.stubGlobal('fetch', f); return f; };
const view = (state: AttentionState, extra: Partial<{ concealed: boolean; language: string }> = {}) => renderToStaticMarkup(
  <HqSchoolsAttentionView language={extra.language ?? 'en'} formattingLocale="en-US" concealed={extra.concealed ?? false} state={state}
    onRefresh={() => {}} onReveal={() => {}} onShowMore={() => {}}/>);

it('reads one school health and the attention list with plain same-origin GETs', async () => {
  const f = stub(json({ data: school() }), json({ data: attention() }));
  expect((await healthApi.school(id(1).toUpperCase(), new AbortController().signal, yes)).health.signals).toEqual(['ATTENDANCE_DOWN']);
  expect((await healthApi.attention(50, new AbortController().signal, yes)).flagged).toBe(2);
  const calls = f.mock.calls as unknown as [string, RequestInit][];
  expect(calls.map(c => c[0])).toEqual([`/api/v1/hq/saas/schools/${id(1)}/health`, '/api/v1/hq/saas/schools/needing-attention?limit=50']);
  for (const [, init] of calls) {
    expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer' });
    expect(init.body).toBeUndefined(); expect(Object.keys(init.headers as object)).toEqual(['Accept']);
  }
  for (const bad of ['', 'nope', `${id(1)}/../x`]) await expect(healthApi.school(bad, new AbortController().signal, yes)).rejects.toMatchObject({ kind: 'INVALID' });
  for (const bad of [0, 201, 1.5]) await expect(healthApi.attention(bad, new AbortController().signal, yes)).rejects.toMatchObject({ kind: 'INVALID' });
  expect(f).toHaveBeenCalledTimes(2);
});

it('maps refusals and never shows a drifted, mismatched or inconsistent answer', async () => {
  const cases: [() => Promise<unknown>, Response, string][] = [
    [() => healthApi.school(id(1), new AbortController().signal, yes), json({ code: 'SAAS_FORBIDDEN' }, 403), 'DENIED'],
    [() => healthApi.school(id(1), new AbortController().signal, yes), json({ code: 'SAAS_UNAVAILABLE' }, 404), 'GONE'],
    [() => healthApi.school(id(1), new AbortController().signal, yes), json({ data: school(3) }), 'UNKNOWN'],
    [() => healthApi.school(id(1), new AbortController().signal, yes), json({ data: school(1, facts({ signals: [] })) }), 'UNKNOWN'],
    [() => healthApi.school(id(1), new AbortController().signal, yes), json({ data: school(1, facts({ studentNames: ['A'] })) }), 'UNKNOWN'],
    [() => healthApi.school(id(1), new AbortController().signal, yes), json({ data: school(), extra: 1 }), 'UNKNOWN'],
    [() => healthApi.attention(50, new AbortController().signal, yes), json({ data: attention({ limit: 200 }) }), 'UNKNOWN'],
    [() => healthApi.attention(50, new AbortController().signal, yes), json({ data: { ...attention(), schools: [...attention().schools].reverse() } }), 'UNKNOWN'],
    [() => healthApi.attention(50, new AbortController().signal, yes), json({ code: 'SAAS_UNAVAILABLE' }, 503), 'UNKNOWN'],
  ];
  for (const [call, answer, kind] of cases) { stub(answer); await expect(call()).rejects.toMatchObject({ kind }); }
  stub(json({}, 401)); await expect(healthApi.attention(50, new AbortController().signal, yes)).rejects.toMatchObject({ kind: 'SESSION' });
});

it('shows signals as words, counts side by side, and the last visit or none', () => {
  const html = renderToStaticMarkup(<><HealthSignals language="en" signals={quiet().signals as string[]}/>
    <HealthTable language="en" formattingLocale="en-US" health={facts() as never} id="x"/></>);
  for (const k of ['NO_ACTIVE_STUDENTS', 'NO_CLASSES_NEXT_14_DAYS', 'NO_NEW_LEADS_30_DAYS', 'OPEN_SUPPORT_CASES'] as const) expect(html).toContain(healthText('en', k));
  expect(html).toContain('<th scope="row">Visits (present, late, make-up)</th><td>3</td><td>12</td>');
  expect(html).toContain('<dt>Active students</dt><dd>9</dd>');
  expect(html).toContain('Nov 9, 2026 UTC');
  expect(renderToStaticMarkup(<HealthTable language="en" formattingLocale="en-US" health={quiet() as never} id="y"/>)).toContain(healthText('en', 'never'));
  expect(renderToStaticMarkup(<HealthSignals language="ko" signals={[]}/>)).toContain(healthText('ko', 'noSignals'));
});

it('lists flagged schools with counts and onward links, says when more exist, and hides everything when concealed or refused', () => {
  const ready = view({ state: 'READY', view: validateHqSchoolsNeedingAttention(attention()) });
  expect(ready).toContain('2 of 7 active schools have signals.');
  expect(ready.indexOf('Synthetic Quiet')).toBeLessThan(ready.indexOf('Synthetic Busy'));
  expect(ready).toContain(`href="/hq/schools/${id(1)}"`); expect(ready).toContain('href="/hq/support"');
  expect(ready.match(/href="\/hq\/support"/g)).toHaveLength(1);
  expect(ready).not.toContain(healthText('en', 'truncated', { limit: '50' }));
  const more = view({ state: 'READY', view: validateHqSchoolsNeedingAttention(attention({ flagged: 60, checked: 100, truncated: true, limit: 2 })) });
  expect(more).toContain(healthText('en', 'truncated', { limit: '2' })); expect(more).toContain(healthText('en', 'showMore', { limit: '200' }));
  const empty = view({ state: 'READY', view: validateHqSchoolsNeedingAttention(attention({ schools: [], flagged: 0 })) });
  expect(empty).toContain(healthText('en', 'none'));
  for (const [state, key] of [['LOADING', 'loading'], ['DENIED', 'denied'], ['UNAVAILABLE', 'unavailable']] as const) {
    const html = view({ state } as AttentionState); expect(html).toContain(healthText('en', key)); expect(html).not.toContain('Synthetic');
  }
  const hidden = view({ state: 'READY', view: validateHqSchoolsNeedingAttention(attention()) }, { concealed: true });
  expect(hidden).toContain(healthText('en', 'concealed')); expect(hidden).not.toContain('Synthetic');
  expect(view({ state: 'READY', view: validateHqSchoolsNeedingAttention(attention()) }, { language: 'es' })).toContain(healthText('es', 'NO_ACTIVE_STUDENTS'));
});

it('the detail page shows the health card only beside a ready detail; it starts by reading', () => {
  const card = renderToStaticMarkup(<HqSchoolHealthCard schoolId={id(1)} language="en" formattingLocale="en-US" api={healthApi}/>);
  expect(card).toContain('data-hq-school-health="loading"'); expect(card).toContain(healthText('en', 'loading'));
  const loading = renderToStaticMarkup(<HqSchoolDetailView language="en" formattingLocale="en-US" concealed={false} state={{ state: 'LOADING' }} busy={false}
    onRefresh={() => {}} onReveal={() => {}} health={<p>HEALTH-SLOT</p>}/>);
  expect(loading).not.toContain('HEALTH-SLOT');
  const container = readFileSync('src/components/hq-school-detail/hq-school-detail.tsx', 'utf8');
  expect(container).toContain("health={state.state === 'READY' && !concealed ? <HqSchoolHealthCard key={refresh}");
});

it('route, label, nav and manifest are wired; the client has no storage or command path', () => {
  const route = readFileSync('src/app/hq/schools/attention/page.tsx', 'utf8');
  expect(route).toContain("'force-dynamic'"); expect(route).toContain('index: false'); expect(route).not.toMatch(/fetch\(|process\.env/);
  expect(hqPageLabel('/hq/schools/attention')).toBe('Needs Attention');
  expect(HQ_NAV_GROUPS['/hq/schools']?.children.map(c => c.path)).toContain('/hq/schools/attention');
  const manifest = JSON.parse(readFileSync('public/manus-routes.json', 'utf8'));
  expect(manifest.routes.filter((r: { path: string }) => r.path === '/hq/schools/attention')).toHaveLength(1);
  for (const file of ['http.ts', 'parts.tsx', 'hq-schools-attention.tsx', 'copy.ts']) {
    const source = readFileSync(`src/components/hq-school-health/${file}`, 'utf8');
    expect(source).not.toMatch(/localStorage|sessionStorage|dangerouslySetInnerHTML|method: 'POST'|Idempotency-Key/);
  }
});
