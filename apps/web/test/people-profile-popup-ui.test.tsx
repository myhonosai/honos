import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { validatePersonRecord, verifySchoolContactCard } from '@hon/contracts';
import { NO_CONTACT_FILTERS } from '../src/components/people/contacts-http';
import { ContactCard } from '../src/components/people/contact-card';
import { CARD_COPY } from '../src/components/people/contact-card-copy';
import { Fold } from '../src/components/people/fold';
import { PeopleView, type PeopleViewProps } from '../src/components/people/view';
import { id, scope } from './account-status-fixtures';

// Owner, 2026-11-21: "make edit for profile up next to name and click to pop up" and "make each section ability to minimize".
beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const person = id(30);
const record = validatePersonRecord({ personId: person, schoolId: scope.schoolId, givenName: 'Ana', familyName: 'Rivera', email: 'ana@example.invalid',
  phoneE164: '+15555550100', version: 3, updatedAt: '2026-11-07T06:30:00.000Z', student: { birthDate: '2015-04-02', status: 'ACTIVE', version: 1 },
  consents: { EMAIL: 'NOT_RECORDED', SMS: 'NOT_RECORDED' }, canEdit: true });
const cardBody = { generatedAt: '2026-11-15T10:00:00.000Z',
  person: { personId: person, version: 3, givenName: 'Ana', familyName: 'Rivera', email: null, phoneE164: null, createdAt: '2026-08-01T10:00:00.000Z' },
  overview: { segment: 'STUDENT', planName: 'Kids monthly', programName: 'Little Tigers', membershipEndsAt: null, ranks: [], openLead: false },
  family: { allowed: false }, appointments: { allowed: false }, tasks: { allowed: false },
  membership: { allowed: true, items: [] }, billing: { allowed: true, open: [], invoices: [] }, messages: { allowed: false }, timeline: [] };
const card = { state: 'READY', card: verifySchoolContactCard(cardBody, person) } as const;
const base: PeopleViewProps = { language: 'en', waiting: false, concealed: false, hasSchool: true,
  list: { state: 'READY', filters: NO_CONTACT_FILTERS, counts: { ALL: 1, STUDENT: 1, TRIAL: 0, PROSPECT: 0, INACTIVE: 0, ARCHIVED: 0 }, nextCursor: null, more: 'IDLE',
    rows: [{ personId: person, version: 1, givenName: 'Ana', familyName: 'Rivera', email: null, phoneE164: null, segment: 'STUDENT', planName: null,
      planCode: null, programName: null, membershipEndsAt: null, membershipState: null, age: null, ranks: [] }] },
  filters: NO_CONTACT_FILTERS, options: null, record: { state: 'READY', record }, selectedId: person, outcome: null, locked: false, canRetry: false,
  onSaveContact: () => {}, onSaveBirth: () => {} };
const view = (over: Partial<PeopleViewProps> = {}) => renderToStaticMarkup(<PeopleView {...base} {...over}/>);

it('puts Edit profile beside the name and keeps the edit forms out of the page until it is pressed', () => {
  const html = view({ card });
  expect(html).toMatch(/<h2>Ana Rivera<\/h2><button[^>]*data-testid="contact-edit-profile"[^>]*aria-haspopup="dialog"/);
  expect(html).toContain('Edit profile');
  expect(html).not.toContain('name="givenName"');
  expect(html).not.toContain('Save birth date');
  expect(html).not.toContain('contact-profile-dialog');
});

it('keeps the edit forms inline when the card cannot be read, and shows neither while the card loads', () => {
  const inline = view({ card: { state: 'UNAVAILABLE' } });
  expect(inline).toContain('value="Ana"'); expect(inline).toContain('Save birth date'); expect(inline).not.toContain('contact-edit-profile');
  expect(view()).toContain('value="Ana"');
  const loading = view({ card: { state: 'LOADING' } });
  expect(loading).not.toContain('name="givenName"'); expect(loading).not.toContain('contact-edit-profile');
});

it('offers no Edit profile while the record is not chosen', () => {
  expect(view({ card, record: { state: 'NONE' } })).not.toContain('contact-edit-profile');
  expect(renderToStaticMarkup(<ContactCard language="en" card={card}/>)).not.toContain('contact-edit-profile');
});

it('makes every card section a labelled, minimizable fold that starts open', () => {
  const html = renderToStaticMarkup(<ContactCard language="en" card={card} initialTab="billing"/>);
  expect(html).toMatch(/<button type="button"[^>]*aria-expanded="true"[^>]*aria-controls="[^"]+"[^>]*>.*Invoices/);
  const membership = renderToStaticMarkup(<ContactCard language="en" card={card} initialTab="membership" membershipTools={() => <span>tools</span>}/>);
  expect(membership).toContain('New or renew'); expect(membership).toContain('Memberships');
  const fold = renderToStaticMarkup(<Fold id="x" title="Details" count={2}><p>inside</p></Fold>);
  expect(fold).toContain('data-open="true"'); expect(fold).toContain('<p>inside</p>'); expect(fold).not.toMatch(/ hidden(=|>| )/);
});

it('has the new words in every language and keeps minimized sections in this browser only', () => {
  for (const lang of ['en', 'ko', 'es'] as const) for (const k of ['editProfile', 'foldDetails', 'foldMemberships', 'foldStart', 'foldInvoices', 'foldEvents'] as const)
    expect(CARD_COPY[lang][k], `${lang} ${k}`).toBeTruthy();
  const src = readFileSync(new URL('../src/components/people/fold.tsx', import.meta.url), 'utf8');
  expect(src).toContain('localStorage'); expect(src).toMatch(/catch \{/); expect(src).not.toMatch(/fetch\(/);
});

it('puts Send agreement in the membership tab as its own fold, only when the page offers it', () => {
  const html = renderToStaticMarkup(<ContactCard language="en" card={card} initialTab="membership" agreementSlot={() => <span data-testid="agreement-panel">send</span>}/>);
  expect(html).toMatch(/aria-expanded="true"[^>]*>.*Membership agreement/);
  expect(html).toContain('data-testid="agreement-panel"');
  expect(html.indexOf('Memberships')).toBeLessThan(html.indexOf('Membership agreement'));
  expect(renderToStaticMarkup(<ContactCard language="en" card={card} initialTab="membership" agreementSlot={() => null}/>)).not.toContain('Membership agreement');
  expect(renderToStaticMarkup(<ContactCard language="ko" card={card} initialTab="membership" agreementSlot={() => <span>x</span>}/>)).toContain('회원 계약서');
});
