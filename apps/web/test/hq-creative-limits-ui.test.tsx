import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import { validateCreativeLimitsHqView, type CreativeLimitsHqView } from '@hon/contracts';
import { HQ_AI } from '../src/components/hq-modern/catalog';
import { MarketingError } from '../src/components/hq-marketing/http';
import { limitsApi } from '../src/components/hq-creative-limits/http';
import { capsFor, dollarsFromMicros, microsFromDollars, providerInputFrom, schoolInputFrom, usedShare } from '../src/components/hq-creative-limits/model';
import { CreativeLimitsView, type LimitsViewProps } from '../src/components/hq-creative-limits/view';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const school = '11111111-1111-4111-8111-111111111111', school2 = '22222222-2222-4222-8222-222222222222';
const key = '33333333-3333-4333-8333-333333333333';
const raw = (over: Partial<CreativeLimitsHqView> = {}): CreativeLimitsHqView => ({
  providers: [
    { providerId: 'HEYGEN', dailyLimitMicros: null, version: 0, reason: null, committedTodayMicros: 0, openJobs: 0, overdueJobs: 0 },
    { providerId: 'HIGGSFIELD', dailyLimitMicros: 25_000_000, version: 2, reason: 'Pilot budget for the first week', committedTodayMicros: 6_250_000, openJobs: 2, overdueJobs: 1 },
  ],
  requesterUnavailable: [], defaultSchoolCaps: { images: 50, videos: 12, avatarVideos: 10 },
  schoolCaps: [{ schoolId: school, images: 5, videos: 1, avatarVideos: 0, reason: 'Pilot school starts small', version: 3 }],
  day: { start: '2026-11-15T00:00:00.000Z', end: '2026-11-16T00:00:00.000Z' }, ...over,
});
const live = () => validateCreativeLimitsHqView(raw());
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const stub = (response: Response) => { const f = vi.fn(async () => response); vi.stubGlobal('fetch', f); return f; };
const signal = () => new AbortController().signal;
const fails = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as MarketingError; } throw new Error('expected a failure'); };
const noop = () => {};
const render = (over: Partial<LimitsViewProps> = {}) => renderToStaticMarkup(<CreativeLimitsView language="en" formattingLocale="en-US" concealed={false}
  state={{ state: 'READY', view: live() }} schools={new Map([[school, 'Tiger Kids Dojo'], [school2, 'Dragon Academy']])} outcome={null} locked={false}
  canRetry={false} editing={null} onRefresh={noop} onReveal={noop} onEdit={noop} onProvider={noop} onSchool={noop} onTryAgain={noop} {...over}/>);
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, '\'').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

it('turns typed dollars into exact micro-USD and back, refusing anything over $10,000 or with sub-cents', () => {
  expect(microsFromDollars('25')).toBe(25_000_000);
  expect(microsFromDollars(' 1,000.5 ')).toBe(1_000_500_000);
  expect(microsFromDollars('0')).toBe(0);
  expect(microsFromDollars('10000')).toBe(10_000_000_000);
  for (const bad of ['10000.01', '1.234', '-1', '', 'ten', '1e3']) expect(microsFromDollars(bad)).toBeNull();
  expect(dollarsFromMicros(25_000_000)).toBe('25');
  expect(dollarsFromMicros(1_000_500_000)).toBe('1000.50');
});

it('builds closed commands against the version that was read', () => {
  const v = live(), higgs = v.providers[1]!;
  expect(providerInputFrom({ dollars: '40', reason: '  Raising   for launch week ' }, higgs))
    .toEqual({ providerId: 'HIGGSFIELD', dailyLimitMicros: 40_000_000, reason: 'Raising for launch week', expectedVersion: 2 });
  expect(providerInputFrom({ dollars: '40', reason: 'short' }, higgs)).toBeNull();
  // A school with its own caps carries its version; one on the defaults starts at version 0.
  expect(capsFor(v, school.toUpperCase())).toEqual({ images: 5, videos: 1, avatarVideos: 0, version: 3, custom: true });
  expect(capsFor(v, school2)).toEqual({ images: 50, videos: 12, avatarVideos: 10, version: 0, custom: false });
  expect(schoolInputFrom({ schoolId: school2.toUpperCase(), images: '20', videos: '4', avatarVideos: '2', reason: 'Bigger school, more posts' }, v))
    .toEqual({ schoolId: school2, images: 20, videos: 4, avatarVideos: 2, reason: 'Bigger school, more posts', expectedVersion: 0 });
  expect(schoolInputFrom({ schoolId: school, images: '1001', videos: '1', avatarVideos: '1', reason: 'Too many images today' }, v)).toBeNull();
  expect(schoolInputFrom({ schoolId: '', images: '1', videos: '1', avatarVideos: '1', reason: 'No school was chosen' }, v)).toBeNull();
  expect(usedShare(v.providers[1]!)).toBe(0.25);
  expect(usedShare(v.providers[0]!)).toBeNull();
});

it('reads as a plain GET and sends each change once with the human-command marker and an idempotency key', async () => {
  const read = stub(json({ data: raw() }));
  expect((await limitsApi.read(signal(), () => true)).providers).toHaveLength(2);
  const [path, init] = read.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe('/api/v1/hq/creative/limits');
  expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
  expect(init.body).toBeUndefined();
  // A provider list out of order, or a changed default, is not trusted.
  stub(json({ data: raw({ providers: [...raw().providers].reverse() }) }));
  expect((await fails(limitsApi.read(signal(), () => true))).kind).toBe('UNKNOWN');
  stub(json({ code: 'SAAS_FORBIDDEN' }, 403));
  expect((await fails(limitsApi.read(signal(), () => true))).kind).toBe('DENIED');

  const set = stub(json({ data: { providerId: 'HIGGSFIELD', dailyLimitMicros: 40_000_000, version: 3, replayed: false } }));
  const input = { providerId: 'HIGGSFIELD' as const, dailyLimitMicros: 40_000_000, reason: 'Raising for launch week', expectedVersion: 2 };
  expect((await limitsApi.setProvider(input, key, signal(), () => true)).version).toBe(3);
  const [p2, i2] = set.mock.calls[0] as unknown as [string, RequestInit];
  expect(p2).toBe('/api/v1/hq/creative/limits/providers');
  expect(i2.headers).toMatchObject({ 'X-HON-Human-Command': 'saas-creative-provider-daily-limit', 'Idempotency-Key': key, 'Content-Type': 'application/json' });
  expect(JSON.parse(String(i2.body))).toEqual(input);
  // An answer for another amount is not taken as saved.
  stub(json({ data: { providerId: 'HIGGSFIELD', dailyLimitMicros: 1, version: 3, replayed: false } }));
  expect((await fails(limitsApi.setProvider(input, key, signal(), () => true))).kind).toBe('UNKNOWN');
  stub(json({ code: 'SAAS_VERSION_CONFLICT' }, 409));
  expect((await fails(limitsApi.setProvider(input, key, signal(), () => true))).kind).toBe('CHANGED');
  stub(json({ code: 'SAAS_FORBIDDEN' }, 403));
  expect((await fails(limitsApi.setProvider(input, key, signal(), () => true))).kind).toBe('DENIED');
  const none = stub(json({}));
  expect((await fails(limitsApi.setProvider({ ...input, dailyLimitMicros: 10_000_000_001 }, key, signal(), () => true))).kind).toBe('INVALID');
  expect(none).not.toHaveBeenCalled();

  const caps = { schoolId: school, images: 20, videos: 4, avatarVideos: 2, reason: 'Bigger school, more posts', expectedVersion: 3 };
  const sc = stub(json({ data: { ...caps, reason: undefined, expectedVersion: undefined, version: 4, replayed: true } }));
  expect((await limitsApi.setSchool(caps, key, signal(), () => true)).replayed).toBe(true);
  const [p3, i3] = sc.mock.calls[0] as unknown as [string, RequestInit];
  expect(p3).toBe('/api/v1/hq/creative/limits/schools');
  expect(i3.headers).toMatchObject({ 'X-HON-Human-Command': 'saas-creative-school-daily-caps' });
  stub(json({ data: { schoolId: school2, images: 20, videos: 4, avatarVideos: 2, version: 4, replayed: false } }));
  expect((await fails(limitsApi.setSchool(caps, key, signal(), () => true))).kind).toBe('UNKNOWN');
});

it('shows each provider in dollars with what is committed today, and says plainly when no limit is set', () => {
  const html = render(), t = text(html);
  expect(t).toContain('Higgsfield (images and video)');
  expect(t).toContain('$25.00');
  expect(t).toContain('$6.25');
  expect(t).toContain('Pilot budget for the first week');
  expect(t).toContain('Overdue requests count at their worst-case cost');
  expect(html).toContain('data-limits-unset=""');
  expect(t).toContain('Every real request to this provider is refused until the HQ owner sets one.');
  expect(t).toContain('never a charge to a school');
  expect(t).toContain('Only a human HQ owner can change these.');
  // Per-school caps use the school's name, and the form lists every school HQ can name.
  expect(t).toContain('Tiger Kids Dojo');
  expect(t).toContain('Pilot school starts small');
  expect(t).toContain('Defaults: 50 images, 12 videos and 10 avatar videos');
  expect(html).toContain(`value="${school2}"`);
  // No form is open until Change is pressed; the school form cannot be saved before a school is chosen.
  expect(html).not.toContain('data-limits-provider-form');
  expect(html).toMatch(/<button type="submit"[^>]*disabled=""[^>]*>Save caps/);
});

it('opens the provider form with the current limit, and shows outcomes without claiming a save it cannot confirm', () => {
  const open = render({ editing: 'HIGGSFIELD' });
  expect(open).toContain('data-limits-provider-form="HIGGSFIELD"');
  expect(open).toContain('value="25"');
  expect(text(render({ outcome: { kind: 'UNKNOWN' }, canRetry: true }))).toContain('Try again');
  expect(text(render({ outcome: { kind: 'DENIED' } }))).toContain('Only a human HQ owner can change creative spend limits.');
  expect(text(render({ outcome: { kind: 'CHANGED' } }))).toContain('Someone changed this since it was read.');
  expect(text(render({ outcome: { kind: 'DONE', receipt: { providerId: 'HIGGSFIELD', dailyLimitMicros: 40_000_000, version: 3, replayed: false } } }))).toContain('Saved.');
  // Hidden, loading, denied and unavailable show no numbers.
  for (const state of [{ state: 'LOADING' as const }, { state: 'DENIED' as const }, { state: 'UNAVAILABLE' as const }]) expect(text(render({ state }))).not.toContain('$');
  expect(text(render({ concealed: true }))).toContain('Show again');
  expect(text(render({ concealed: true }))).not.toContain('$25.00');
});

it('shows provider answers kept for HQ and is wired into HQ navigation and the route list', () => {
  const kept = validateCreativeLimitsHqView(raw({ requesterUnavailable: [{ jobId: key, schoolId: school, reservationId: school2, providerId: 'HEYGEN',
    closedAt: '2026-11-15T03:00:00.000Z', providerResult: null }] }));
  expect(text(render({ state: { state: 'READY', view: kept } }))).toContain('HeyGen (talking avatar video) · Tiger Kids Dojo · Closed');
  for (const language of ['ko', 'es']) expect(text(render({ language }))).not.toContain('Provider daily limits');
  expect(HQ_AI.some(e => e.path === '/hq/creative-limits')).toBe(true);
  const manifest = JSON.parse(readFileSync('public/manus-routes.json', 'utf8')) as { routes: { path: string }[] };
  expect(manifest.routes.filter(r => r.path === '/hq/creative-limits')).toHaveLength(1);
  expect(readFileSync('src/app/hq/creative-limits/page.tsx', 'utf8')).toContain('HqCreativeLimits');
});
