import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SchoolMembershipListItem } from '@hon/contracts';
import { MEMBERSHIP_LIST_LANGUAGES, membershipListText } from '../src/components/membership-list/copy';
import { MembershipListError, membershipCounts, membershipListApi, verifyMembershipListPage } from '../src/components/membership-list/http';
import { MembershipListView, type MembershipListViewProps } from '../src/components/membership-list/view';
import { SCHOOL_SHELL_NAV, schoolShellActiveRoute } from '../src/components/school-shell/catalog';
import { HON_SESSION_INVALIDATED_EVENT } from '../src/components/session-invalidation';
import { id, scope } from './account-status-fixtures';

beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const confirmed = (startDate = '2026-11-01', endDate: string | null = '2026-12-01') => ({ currentPeriod: { periodVersion: 1, changeKind: 'INITIAL', startDate, endDate }, legacyStoredTerm: null, datesConfirmed: true });
const undated = (termStartedAt: string | null = null) => ({ currentPeriod: null, legacyStoredTerm: { termStartedAt, termEndsAt: null }, datesConfirmed: false });
const member = (n: number, over: Record<string, unknown> = {}): SchoolMembershipListItem => ({ membershipId: id(300 + n), state: 'ACTIVE', version: 1, planCode: 'ADULT-MONTHLY',
  billingAccountId: id(400 + n), participant: { personId: id(500 + n), givenName: `Mina${n}`, familyName: 'Park' }, effectiveStatus: 'IN_EFFECT', ...confirmed(),
  createdAt: `2026-11-${String(28 - (n % 27)).padStart(2, '0')}T10:00:00.000Z`, ...over } as SchoolMembershipListItem);
const draft = (n: number) => member(n, { state: 'DRAFT', effectiveStatus: 'DRAFT', ...undated() });
const meta = (over: Record<string, unknown> = {}) => ({ requestId: id(5), correlationId: id(5), limit: 50, nextCursor: null, schoolTimezone: 'America/Los_Angeles', localToday: '2026-11-08', ...over });
const page = (data: unknown[], over: Record<string, unknown> = {}) => ({ data, meta: meta(over) });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const stub = (response: Response) => { const f = vi.fn(async () => response); vi.stubGlobal('fetch', f); return f; };
const signal = () => new AbortController().signal;
const ready = (items: SchoolMembershipListItem[], over: Record<string, unknown> = {}) => ({ state: 'READY', filter: null, items, nextCursor: null,
  schoolTimezone: 'America/Los_Angeles', localToday: '2026-11-08', more: 'IDLE', restarted: false, ...over }) as MembershipListViewProps['list'];
const props = (over: Partial<MembershipListViewProps> = {}): MembershipListViewProps => ({ language: 'en', timeZone: 'UTC', waiting: false, concealed: false, scope, filter: null,
  list: ready([member(1), draft(2)]), ...over });
const render = (over: Partial<MembershipListViewProps> = {}) => renderToStaticMarkup(<MembershipListView {...props(over)}/>);

it('reads one page with only limit, the state filter and the cursor, as a plain same-origin GET', async () => {
  const f = stub(json(page([member(1)])));
  await expect(membershipListApi.page({ organizationId: scope.organizationId.toUpperCase(), schoolId: scope.schoolId }, null, null, signal(), () => true)).resolves.toMatchObject({ nextCursor: null, localToday: '2026-11-08' });
  const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe(`/api/v1/organizations/${scope.organizationId}/schools/${scope.schoolId}/billing/memberships?limit=50`);
  expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', headers: { Accept: 'application/json' } });
  expect(init.headers).not.toHaveProperty('X-HON-Source');
  const g = stub(json(page([draft(1)])));
  await membershipListApi.page(scope, 'DRAFT', 'abc.def', signal(), () => true);
  expect((g.mock.calls[0] as unknown as [string])[0]).toMatch(/\/billing\/memberships\?limit=50&state=DRAFT&cursor=abc.def$/);
});

it('maps refusals exactly; drift is unavailable, never an empty list', async () => {
  for (const [response, kind] of [[json({ code: 'MEMBERSHIP_LIST_FORBIDDEN' }, 403), 'DENIED'], [json({ code: 'HUMAN_UI_REQUIRED' }, 403), 'DENIED'],
    [json({ code: 'INVALID_CURSOR' }, 400), 'CURSOR'], [json({ code: 'VALIDATION_FAILED' }, 400), 'UNAVAILABLE'], [json({ code: 'SCHOOL_TIMEZONE_INVALID' }, 409), 'TIMEZONE'],
    [json({ code: 'MEMBERSHIP_LIST_TIMEOUT' }, 503), 'UNAVAILABLE'], [json({ data: [] }), 'UNAVAILABLE']] as const) {
    stub(response);
    await expect(membershipListApi.page(scope, null, null, signal(), () => true)).rejects.toMatchObject({ kind });
  }
  for (const bad of [page([member(1)], { session: 1 }), page([member(1), member(1)]), page([member(1, { amountCents: 100 })]), page([member(1, { effectiveStatus: 'DRAFT' })]),
    page([member(1, { state: 'FROZEN', effectiveStatus: 'IN_EFFECT' })]), page([member(1, { effectiveStatus: 'UNDATED' })]), page([member(1, { ...undated() })]),
    page([member(1, { currentPeriod: null })]), page([member(1, confirmed('2026-12-01', '2026-11-01'))]), page([member(1, { participant: { personId: id(9), givenName: 'A' } })]),
    page([member(5), member(1)]), page([member(1)], { nextCursor: 'x' }), page([member(1)], { limit: 100 }), page([member(1)], { localToday: '11/08/2026' }),
    page(Array.from({ length: 51 }, (_, n) => member(n)))]) {
    expect(() => verifyMembershipListPage(bad, null)).toThrow();
  }
  expect(() => verifyMembershipListPage(page([member(1)]), 'DRAFT')).toThrow();
  expect(verifyMembershipListPage(page([member(1), member(2, { effectiveStatus: 'UNDATED', ...undated('2026-10-01T00:00:00.000Z') }), draft(3), member(4, { participant: null })]), null).items).toHaveLength(4);
  expect(verifyMembershipListPage(page([]), 'EXPIRED').items).toEqual([]);
});

it('a 401 for a retired read never ends the session; a current one does', async () => {
  const seen = vi.fn(); (window as unknown as EventTarget).addEventListener(HON_SESSION_INVALIDATED_EVENT, seen);
  stub(json({ code: 'SIGN_IN_REQUIRED' }, 401));
  await expect(membershipListApi.page(scope, null, null, signal(), () => false)).rejects.toBeInstanceOf(MembershipListError);
  expect(seen).not.toHaveBeenCalled();
  stub(json({ code: 'SIGN_IN_REQUIRED' }, 401));
  await expect(membershipListApi.page(scope, null, null, signal(), () => true)).rejects.toMatchObject({ kind: 'SESSION' });
  expect(seen).toHaveBeenCalledTimes(1);
});

it('counts only the rows read, by reporting status', () => {
  expect(membershipCounts([member(1), member(2, { effectiveStatus: 'SCHEDULED' }), member(3, { effectiveStatus: 'UNDATED', ...undated() }), draft(4), draft(5),
    member(6, { state: 'FROZEN', effectiveStatus: 'FROZEN' }), member(7, { effectiveStatus: 'ENDED' })])).toEqual({ inEffect: 1, scheduled: 1, undated: 1, draft: 2, other: 2 });
});

it('shows nothing private before the shell verifies the school, while concealed, or with no school', () => {
  for (const over of [{ waiting: true }, { concealed: true }, { scope: null }]) {
    const html = render(over);
    expect(html).not.toContain('Mina1'); expect(html).not.toContain('membership-table'); expect(html).not.toContain('ADULT-MONTHLY');
  }
  expect(render({ concealed: true })).toContain('Memberships are hidden');
});

it('shows rows, school dates, counts, a partial note and links; dates are school dates, not shifted by the viewer', () => {
  const html = render({ timeZone: 'Pacific/Kiritimati', list: ready([member(1), member(2, { effectiveStatus: 'UNDATED', ...undated('2026-10-01T12:00:00.000Z') }), draft(3), member(4, { participant: null, ...confirmed('2026-11-01', null) })], { nextCursor: 'c' }) });
  expect(html).toContain('Mina1 Park'); expect(html).toContain('In effect'); expect(html).toContain('Nov 1, 2026 to Dec 1, 2026');
  expect(html).toContain('Active, dates not confirmed'); expect(html).toContain('Recorded start (not confirmed)'); expect(html).toContain('From Nov 1, 2026, no end date');
  expect(html).toContain('Person not visible here'); expect(html).toContain('Draft');
  expect(html).toContain('Dates are school dates (America/Los_Angeles). Today at the school is Nov 8, 2026.');
  expect(html).toContain('data-testid="membership-counts"'); expect(html).toContain('Counts cover the 4 memberships shown'); expect(html).toContain('>Show more</button>');
  expect(html).toContain('href="/staff/billing/memberships"'); expect(html).toContain('href="/staff/billing/membership-dates"');
  expect(html).toContain('It shows no payments, invoices, payers or agreements');
  expect(html).not.toMatch(/<form|method="post"|\$\d/i);
  // Instants fall on the school's day (America/Los_Angeles), not the viewer's: 2026-11-28T05:00Z is Nov 27 at the school.
  expect(render({ timeZone: 'Pacific/Kiritimati', list: ready([member(1, { createdAt: '2026-11-28T05:00:00.000Z' })]) })).toContain('Nov 27, 2026');
});

it('the filter tabs mark the current filter; a page for another filter is never shown; list states are honest', () => {
  const html = render({ filter: 'DRAFT', list: ready([draft(1)], { filter: 'DRAFT' }) });
  expect(html).toMatch(/aria-pressed="true"[^>]*>Draft</); expect(html).not.toContain('membership-counts');
  expect(render({ filter: 'DRAFT', list: ready([member(1)]) })).not.toContain('Mina1');
  expect(render({ filter: 'EXPIRED', list: ready([], { filter: 'EXPIRED' }) })).toContain('No memberships in this state');
  expect(render({ list: ready([]) })).toContain('No memberships here');
  expect(render({ list: { state: 'DENIED' } })).toContain('does not include memberships');
  expect(render({ list: { state: 'TIMEZONE' } })).toContain('time zone is not set correctly');
  expect(render({ list: { state: 'UNAVAILABLE' } })).toContain('Nothing is shown');
  expect(render({ list: ready([member(1)], { restarted: true }) })).toContain('read again from the start');
});

it('has every phrase in Korean and Spanish; the page leads the Billing group and is in the route manifest', () => {
  for (const language of ['ko', 'es'] as const) expect(Object.keys(MEMBERSHIP_LIST_LANGUAGES[language]).sort()).toEqual(Object.keys(MEMBERSHIP_LIST_LANGUAGES.en).sort());
  expect(membershipListText('ko', 'title')).toBe('회원권'); expect(membershipListText('es', 'title')).toBe('Membresías');
  expect(SCHOOL_SHELL_NAV.find((g) => g.key === 'billing')?.routes[0]?.href).toBe('/staff/memberships');
  expect(schoolShellActiveRoute('/staff/billing/memberships')?.href).toBe('/staff/billing/memberships');
  const manifest = JSON.parse(readFileSync(new URL('../public/manus-routes.json', import.meta.url), 'utf8')) as { routes: { path: string; title: string }[] };
  expect(manifest.routes).toContainEqual({ path: '/staff/memberships', title: 'HON | Memberships' });
  expect(readFileSync(new URL('../src/app/staff/memberships/page.tsx', import.meta.url), 'utf8')).toContain('await requireVerifiedWebSession()');
});
