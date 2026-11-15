import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { contactsApi, contactQuery, NO_CONTACT_FILTERS } from '../src/components/people/contacts-http';
import { ContactsList, activeFilterCount, endBadge, type ContactsListProps } from '../src/components/people/contacts-list';
import { CONTACTS_COPY } from '../src/components/people/contacts-copy';
import { id, scope } from './account-status-fixtures';

// C1 (0373): the contacts list on the People page.
beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const stub = (...answers: Response[]) => { const fetch = vi.fn(async () => answers.shift()!); vi.stubGlobal('fetch', fetch); return fetch; };
const signal = () => new AbortController().signal;
const counts = { ALL: 62, STUDENT: 2, TRIAL: 1, PROSPECT: 2, INACTIVE: 1 };
const soon = new Date(Date.now() + 10 * 86_400_000).toISOString(), later = new Date(Date.now() + 80 * 86_400_000).toISOString();
const row = (n: number, over: Record<string, unknown> = {}) => ({ personId: id(400 + n), version: 1, givenName: `Avery${n}`, familyName: 'Able', email: null, phoneE164: null,
  segment: 'STUDENT', planName: 'Kids monthly', planCode: 'KIDS', programName: 'Little Tigers', membershipEndsAt: soon, ranks: [{ rank: 'White', color: '#ffffff' }], ...over });
const page = (over: Record<string, unknown> = {}) => ({ generatedAt: '2026-11-15T10:00:00.000Z', segment: 'ALL', counts, rows: [row(1)], hasMore: true, options: null, nextCursor: 'c1', ...over });

it('sends only the closed query: empty filters are left out, the cursor rides along', async () => {
  expect(contactQuery(NO_CONTACT_FILTERS, false)).toEqual({});
  expect(contactQuery({ ...NO_CONTACT_FILTERS, segment: 'STUDENT', query: '  ann ', endsWithinDays: '30', planId: id(5) }, true))
    .toEqual({ segment: 'STUDENT', query: 'ann', endsWithinDays: 30, planId: id(5), options: true });
  const fetch = stub(json({ data: page({ segment: 'STUDENT' }), meta: {} }));
  const list = await contactsApi.list(scope, { ...NO_CONTACT_FILTERS, segment: 'STUDENT', endsWithinDays: '30' }, 'abc', false, signal());
  expect((fetch.mock.calls[0] as unknown as [string])[0])
    .toBe(`/api/v1/organizations/${scope.organizationId}/schools/${scope.schoolId}/contacts?segment=STUDENT&endsWithinDays=30&cursor=abc`);
  expect(list.nextCursor).toBe('c1'); expect(list.rows[0]!.planName).toBe('Kids monthly');
});

it('refuses a page that does not match what was asked or carries an inconsistent cursor', async () => {
  for (const body of [page({ segment: 'TRIAL' }), page({ nextCursor: null }), page({ hasMore: false }), page({ rows: [row(1, { segment: 'BOSS' })] }),
    page({ options: { ranks: [], programs: [], plans: [] } }), (({ nextCursor: _, ...rest }) => rest)(page())]) {
    stub(json({ data: body, meta: {} }));
    await expect(contactsApi.list(scope, NO_CONTACT_FILTERS, null, false, signal())).rejects.toMatchObject({ kind: 'UNKNOWN' });
  }
  stub(json({ code: 'SCHOOL_CONTACTS_FORBIDDEN' }, 403));
  await expect(contactsApi.list(scope, NO_CONTACT_FILTERS, null, false, signal())).rejects.toMatchObject({ kind: 'DENIED' });
});

it('labels end dates as soon, later or ended', () => {
  const now = Date.parse('2026-11-15T12:00:00Z');
  expect(endBadge('en', '2026-11-20T08:00:00.000Z', now)?.tone).toBe('soon');
  expect(endBadge('en', '2027-02-01T08:00:00.000Z', now)?.tone).toBe('later');
  expect(endBadge('en', '2026-11-01T08:00:00.000Z', now)).toMatchObject({ tone: 'ended', text: expect.stringMatching(/^Ended /) });
  expect(endBadge('en', null, now)).toBeNull();
  expect(activeFilterCount({ ...NO_CONTACT_FILTERS, query: 'x', segment: 'TRIAL' })).toBe(0);
  expect(activeFilterCount({ ...NO_CONTACT_FILTERS, rankId: id(1), endsWithinDays: '7' })).toBe(2);
});

const base: ContactsListProps = { language: 'en', filters: NO_CONTACT_FILTERS, options: null, selectedId: null,
  pt: (key) => ({ searchLabel: 'Search by name, email or phone', searchButton: 'Search', listLoading: 'Reading people…', listDenied: 'denied', listUnavailable: 'unavailable', noEmail: 'No email', noPhone: 'No phone' })[key],
  list: { state: 'READY', filters: NO_CONTACT_FILTERS, counts, nextCursor: 'c1', more: 'IDLE',
    rows: [row(1) as never, row(2, { segment: 'TRIAL', planName: null, programName: null, membershipEndsAt: null, ranks: [] }) as never,
      row(3, { membershipEndsAt: later, planName: null, programName: null, ranks: [{ rank: 'Yellow', color: null }] }) as never] } };
const view = (over: Partial<ContactsListProps> = {}) => renderToStaticMarkup(<ContactsList {...base} {...over}/>);

it('shows segment chips with counts, row facts for students only and a Show more button', () => {
  const html = view();
  for (const [label, n] of [['All', 62], ['Students', 2], ['Trial', 1], ['Prospects', 2], ['Inactive', 1]]) expect(html).toMatch(new RegExp(`${label}<span[^>]*>${n}</span>`));
  expect(html).toMatch(/aria-pressed="true"[^>]*data-segment="ALL"/);
  expect(html).toContain('Kids monthly · Little Tigers'); expect(html).toContain('data-tone="soon"'); expect(html).toContain('data-tone="later"');
  expect(html).toContain('Trial booked'); expect(html).toContain('No plan on file');
  expect(html).toContain('background:#ffffff');
  expect(html).toContain('Showing 3 of 62'); expect(html).toContain('Show more');
});

it('shows the filter count, keeps filters open and offers Clear; an empty page says so', () => {
  const filters = { ...NO_CONTACT_FILTERS, segment: 'STUDENT' as const, endsWithinDays: '30' as const, planId: id(5) };
  const options = { ranks: [{ rankId: id(6), curriculum: 'Karate', rank: 'White' }], programs: [], plans: [{ planId: id(5), name: 'Kids monthly' }] };
  const html = view({ filters, options, list: { state: 'READY', filters, counts: { ...counts, STUDENT: 0 }, rows: [], nextCursor: null, more: 'IDLE' } });
  expect(html).toContain('Filters (2)'); expect(html).toMatch(/<details[^>]*open=""/); expect(html).toContain('Clear filters');
  expect(html).toContain('Karate: White'); expect(html).toMatch(/<option value="[^"]+" selected="">Kids monthly<\/option>/);
  expect(html).toContain('No one matches'); expect(html).not.toContain('Show more');
  expect(view({ list: { ...base.list, more: 'FAILED' } as never })).toContain('More contacts could not be loaded.');
  expect(view({ list: { state: 'DENIED' } })).toContain('denied');
});

it('has the same wording keys in every language', () => {
  const keys = Object.keys(CONTACTS_COPY.en).sort();
  expect(Object.keys(CONTACTS_COPY.ko).sort()).toEqual(keys); expect(Object.keys(CONTACTS_COPY.es).sort()).toEqual(keys);
});
