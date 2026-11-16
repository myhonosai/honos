import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { validatePersonRecord, verifySchoolContactCard, type FamilyMessageInbox } from '@hon/contracts';
import { NO_CONTACT_FILTERS } from '../src/components/people/contacts-http';
import { PeopleView, type PeopleViewProps } from '../src/components/people/view';
import { ContactCard, CARD_TABS } from '../src/components/people/contact-card';
import { CARD_MODE_KEY, cardUrl, readCardMode, writeCardMode } from '../src/components/people/card-panel';
import { PANEL_COPY } from '../src/components/people/panel-copy';
import { familyThreads, CardFamilyMessagesView } from '../src/components/people/card-family-messages';
import { familyInvitations } from '../src/components/people/card-family-access';
import { SCHOOL_SHELL_NAV } from '../src/components/school-shell/catalog';
import { id, scope } from './account-status-fixtures';

// Contacts on one page (docs/architecture/CONTACTS_ONE_PAGE_SPEC.md, slice A).
beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const person = id(30), famA = id(40), famB = id(41);
const record = validatePersonRecord({ personId: person, schoolId: scope.schoolId, givenName: 'Ana', familyName: 'Rivera', email: 'ana@example.invalid',
  phoneE164: '+15555550100', version: 3, updatedAt: '2026-11-07T06:30:00.000Z', student: null, consents: { EMAIL: 'NOT_RECORDED', SMS: 'NOT_RECORDED' }, canEdit: true });
const card = verifySchoolContactCard({ generatedAt: '2026-11-15T10:00:00.000Z',
  person: { personId: person, version: 3, givenName: 'Ana', familyName: 'Rivera', email: null, phoneE164: null, createdAt: '2026-08-01T10:00:00.000Z' },
  overview: { segment: 'STUDENT', planName: null, programName: null, membershipEndsAt: null, ranks: [], openLead: false },
  family: { allowed: true, families: [{ familyId: famA, name: 'Rivera family', members: [{ personId: person, givenName: 'Ana', familyName: 'Rivera', role: 'STUDENT', billingContact: false }] }] },
  appointments: { allowed: false }, tasks: { allowed: false }, membership: { allowed: false }, billing: { allowed: false },
  messages: { allowed: true, direct: 2, family: 1 }, timeline: [] }, person);
const base: PeopleViewProps = { language: 'en', waiting: false, concealed: false, hasSchool: true,
  list: { state: 'READY', filters: NO_CONTACT_FILTERS, counts: { ALL: 1, STUDENT: 1, LEAD: 0, FAMILY: 0, FORMER: 0, OTHER: 0, ARCHIVED: 0 } as never, rows: [], nextCursor: null, more: 'IDLE' },
  record: { state: 'READY', record }, selectedId: person, outcome: null, locked: false, canRetry: false, filters: NO_CONTACT_FILTERS, options: null,
  card: { state: 'READY', card }, cardMode: 'SIDE' };
const view = (over: Partial<PeopleViewProps> = {}) => renderToStaticMarkup(<PeopleView {...base} {...over}/>);

it('opens the card in a side panel beside the list, with full screen and close buttons', () => {
  const html = view();
  expect(html).toContain('data-card-mode="SIDE"');
  expect(html).toContain('data-testid="contact-panel"');
  expect(html).toContain('data-testid="people-list"');
  expect(html).toContain('>Full screen<');
  expect(html).toContain('>Close<');
  expect(html).not.toContain('>Keep at side<');
});

it('full screen hides the list behind the card and offers to keep it at the side', () => {
  const html = view({ cardMode: 'FULL' });
  expect(html).toContain('data-card-mode="FULL"');
  expect(html).toMatch(/data-testid="people-list"[^>]*hidden=""|hidden=""[^>]*data-testid="people-list"/);
  expect(html).toContain('>Keep at side<');
});

it('with nobody open there is no panel and the list is the whole page', () => {
  const html = view({ selectedId: null, record: { state: 'NONE' }, card: { state: 'NONE' } });
  expect(html).toContain('data-card-mode="CLOSED"');
  expect(html).not.toContain('data-testid="contact-panel"');
});

it('keeps the editable details, consents and actions inside the card on a Details tab', () => {
  const overview = view();
  expect(overview).not.toContain('data-testid="person-details"');
  const details = view({ cardTab: 'details', actionsSlot: () => <div data-testid="actions-slot"/>, consentSlot: () => <div data-testid="consent-slot"/> });
  expect(details).toContain('data-testid="contact-tab-details"');
  expect(details).toContain('data-testid="person-details"');
  expect(details).toContain('data-testid="actions-slot"');
  expect(details).toContain('data-testid="consent-slot"');
  // The notice from a delete or merge stays above the tabs.
  expect(view({ actionNotice: 'Merged.' })).toContain('data-testid="contact-action-done"');
});

it('still lets staff correct details when the card itself could not be read', () => {
  const html = view({ card: { state: 'UNAVAILABLE' } });
  expect(html).toContain('data-testid="contact-panel"');
  expect(html).toContain('data-testid="person-details"');
});

it('links to the shared inboxes for unanswered messages', () => {
  const html = view({ selectedId: null, record: { state: 'NONE' }, card: { state: 'NONE' } });
  expect(html).toContain('href="/staff/conversations"');
  expect(html).toContain('href="/staff/family-messages"');
});

it('puts family app access under each family and both message kinds under Messages', () => {
  const family = renderToStaticMarkup(<ContactCard language="en" card={{ state: 'READY', card }} initialTab="family"
    familySlot={f => <div data-testid={`fa-${f.familyId}`}/>}/>);
  expect(family).toContain(`data-testid="fa-${famA}"`);
  const messages = renderToStaticMarkup(<ContactCard language="en" card={{ state: 'READY', card }} initialTab="messages"
    messagesSlot={c => <div data-testid={`msg-${c.person.personId}`}/>}/>);
  expect(messages).toContain(`data-testid="msg-${person}"`);
  expect(CARD_TABS).toContain('details');
});

it('remembers side or full screen in this browser only, and falls back to side when storage fails', () => {
  const store = new Map<string, string>();
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } };
  expect(readCardMode(storage)).toBe('SIDE');
  writeCardMode('FULL', storage);
  expect(store.get(CARD_MODE_KEY)).toBe('FULL');
  expect(readCardMode(storage)).toBe('FULL');
  store.set(CARD_MODE_KEY, 'SOMETHING');
  expect(readCardMode(storage)).toBe('SIDE');
  const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
  expect(readCardMode(broken)).toBe('SIDE');
  expect(() => writeCardMode('FULL', broken)).not.toThrow();
  expect(readCardMode(null)).toBe('SIDE');
});

it('writes the open card into the address and removes it on close, keeping other parameters', () => {
  expect(cardUrl('/staff/people', '?x=1', { personId: person.toUpperCase(), tab: 'messages' })).toBe(`/staff/people?x=1&person=${person}&tab=messages`);
  expect(cardUrl('/staff/people', `?person=${person}&tab=family&x=1`, null)).toBe('/staff/people?x=1');
  expect(cardUrl('/staff/people', '', null)).toBe('/staff/people');
  expect(() => cardUrl('/staff/people', '', { personId: 'not-an-id', tab: 'overview' })).toThrow();
});

it('shows only the threads of this person\'s families', () => {
  const thread = (threadId: string, familyId: string) => ({ threadId, familyId, familyName: 'F', lastMessageAt: '2026-11-15T10:00:00.000Z', lastFrom: 'FAMILY' as const,
    messageCount: 1, unreadCount: 1, version: 1 });
  const inbox: FamilyMessageInbox = { threads: [thread(id(50), famA), thread(id(51), famB), thread(id(52), id(42))], unreadThreads: 3 };
  expect(familyThreads(inbox, [famA, famB]).map(t => t.threadId)).toEqual([id(50), id(51)]);
  expect(familyThreads(inbox, [])).toEqual([]);
  const html = renderToStaticMarkup(<CardFamilyMessagesView language="en" state={{ state: 'READY', threads: familyThreads(inbox, [famA]) }} open={null}/>);
  expect(html).toContain('data-testid="card-family-thread"');
  expect(html.match(/data-testid="card-family-thread"/g)).toHaveLength(1);
});

it('shows only the invitations of the family the card names', () => {
  const inv = (invitationId: string, familyId: string) => ({ invitationId, familyId }) as never;
  expect(familyInvitations([inv(id(60), famA), inv(id(61), famB)], famA).map((i: { invitationId: string }) => i.invitationId)).toEqual([id(60)]);
});

it('words every panel label in all three languages', () => {
  const keys = Object.keys(PANEL_COPY.en);
  for (const lang of ['ko', 'es'] as const) expect(Object.keys(PANEL_COPY[lang]).sort()).toEqual([...keys].sort());
  for (const lang of ['en', 'ko', 'es'] as const) for (const text of Object.values(PANEL_COPY[lang])) expect(text.trim()).not.toBe('');
});

it('takes Search, Family access, Conversations and Family messages out of the Contacts tabs but keeps their pages', () => {
  const contacts = SCHOOL_SHELL_NAV.find(item => item.key === 'students')!;
  for (const href of ['/staff/search', '/staff/family-access', '/staff/conversations', '/staff/family-messages']) {
    const route = contacts.routes.find(r => r.href === href);
    expect(route, href).toBeDefined();
    expect(route!.hidden, href).toBe(true);
  }
  expect(contacts.routes.find(r => r.href === '/staff/people')!.hidden).toBeFalsy();
});
