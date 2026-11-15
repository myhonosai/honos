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

// C2 (0374): the contact card.
import { ContactCard, formatMinor, type CardTab } from '../src/components/people/contact-card';
import { CARD_COPY } from '../src/components/people/contact-card-copy';
const person = id(410);
const cardBody = (over: Record<string, unknown> = {}) => ({ generatedAt: '2026-11-15T10:00:00.000Z',
  person: { personId: person, version: 1, givenName: 'Avery', familyName: 'Able', email: null, phoneE164: null, createdAt: '2026-08-01T10:00:00.000Z' },
  overview: { segment: 'STUDENT', planName: 'Kids monthly', programName: 'Little Tigers', membershipEndsAt: soon, ranks: [{ curriculum: 'Karate', rank: 'White', color: '#ffffff' }], openLead: false },
  family: { allowed: true, families: [{ familyId: id(411), name: 'Able family', members: [{ personId: id(412), givenName: 'Gale', familyName: 'Able', role: 'GUARDIAN', billingContact: true }] }] },
  appointments: { allowed: false }, tasks: { allowed: true, items: [{ title: 'Call about the belt test', status: 'OPEN', priority: 'HIGH', dueAt: '2026-12-01T17:00:00.000Z' }] },
  membership: { allowed: false }, billing: { allowed: true, open: [{ currency: 'USD', dueMinor: 7900 }], invoices: [{ status: 'ISSUED', currency: 'USD', totalMinor: 12900, paidMinor: 5000, dueAt: '2026-10-08T16:00:00.000Z', createdAt: '2026-10-01T16:00:00.000Z' }] },
  messages: { allowed: true, direct: 1, family: 3 }, timeline: [{ kind: 'PAYMENT', at: '2026-10-05T00:00:00.000Z', detail: 'USD 5000' }, { kind: 'PERSON_ADDED', at: '2026-08-01T10:00:00.000Z', detail: null }], ...over });

it('reads one card by path and refuses a card for another person or with an unknown section', async () => {
  const fetch = stub(json({ data: cardBody(), meta: {} }));
  const card = await contactsApi.card(scope, person, signal());
  expect((fetch.mock.calls[0] as unknown as [string])[0]).toBe(`/api/v1/organizations/${scope.organizationId}/schools/${scope.schoolId}/contacts/${person}`);
  expect(card.billing).toMatchObject({ allowed: true });
  for (const body of [cardBody({ person: { ...cardBody().person, personId: id(499) } }), cardBody({ notes: [] }), cardBody({ family: { allowed: false, families: [] } })]) {
    stub(json({ data: body, meta: {} }));
    await expect(contactsApi.card(scope, person, signal())).rejects.toMatchObject({ kind: 'UNKNOWN' });
  }
  stub(json({ code: 'SCHOOL_CONTACT_NOT_FOUND' }, 404));
  await expect(contactsApi.card(scope, person, signal())).rejects.toMatchObject({ kind: 'UNKNOWN' });
});

it('shows each tab, says when the role does not include one, and formats money in the currency', async () => {
  const { verifySchoolContactCard } = await import('@hon/contracts');
  const card = { state: 'READY', card: verifySchoolContactCard(cardBody(), person) } as const;
  const tab = (initialTab: CardTab) => renderToStaticMarkup(<ContactCard language="en" card={card} initialTab={initialTab}/>);
  const overview = tab('overview');
  expect(overview).toContain('Kids monthly · Little Tigers'); expect(overview).toContain('Karate: White'); expect(overview).toContain('data-tone="soon"');
  expect(overview).toMatch(/data-tab="appointments" data-allowed="false"/); expect(overview).toMatch(/Messages<span[^>]*>4<\/span>/);
  expect(tab('appointments')).toContain('Your role doesn’t include this.'); expect(tab('membership')).toContain('Your role doesn’t include this.');
  expect(tab('family')).toContain('Gale Able'); expect(tab('family')).toContain('billing contact');
  expect(tab('tasks')).toContain('Call about the belt test');
  const billing = tab('billing');
  expect(billing).toContain('$79.00'); expect(billing).toContain('$50.00 paid of $129.00');
  expect(tab('timeline')).toContain('Payment recorded'); expect(tab('timeline')).not.toContain('5000');
  expect(overview).toContain('<h2>Avery Able</h2>'); expect(overview).toContain('In your records');
  expect(formatMinor('en', 'JPY', 500)).toBe('¥500');
  expect(renderToStaticMarkup(<ContactCard language="en" card={{ state: 'UNAVAILABLE' }}/>)).toContain('could not be loaded');
  expect(renderToStaticMarkup(<ContactCard language="en" card={{ state: 'NONE' }}/>)).toBe('');
});

it('a membership-only role sees memberships but a not-allowed billing tab and no family-thread count', async () => {
  const { verifySchoolContactCard } = await import('@hon/contracts');
  const body = cardBody({ membership: { allowed: true, items: [] }, billing: { allowed: false }, messages: { allowed: true, direct: 2, family: null }, timeline: [] });
  const card = { state: 'READY', card: verifySchoolContactCard(body, person) } as const;
  const tab = (initialTab: CardTab) => renderToStaticMarkup(<ContactCard language="en" card={card} initialTab={initialTab}/>);
  expect(tab('billing')).toContain('Your role doesn’t include this.'); expect(tab('billing')).not.toContain('$');
  expect(tab('overview')).toMatch(/data-tab="billing" data-allowed="false"/); expect(tab('overview')).toMatch(/Messages<span[^>]*>2<\/span>/);
  const messages = tab('messages');
  expect(messages).toContain('2'); expect(messages.match(/<li>/g)).toHaveLength(1);
});

it('has the same card wording keys in every language', () => {
  const keys = Object.keys(CARD_COPY.en).sort();
  expect(Object.keys(CARD_COPY.ko).sort()).toEqual(keys); expect(Object.keys(CARD_COPY.es).sort()).toEqual(keys);
});
