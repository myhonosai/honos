import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MEMBERSHIP_ACTIVATION_CONFIRMATION, MEMBERSHIP_ACTIVATION_OVERRIDE_CONFIRMATION, verifySchoolContactCard, type MembershipActivationPreview } from '@hon/contracts';
import { ContactCard } from '../src/components/people/contact-card';
import { cardMembershipButton } from '../src/components/people/membership-panel';
import { START_COPY, startBody, StartMembershipView, type StartMembershipViewProps } from '../src/components/people/start-membership';
import { MembershipChangesView, type MembershipChangesViewProps } from '../src/components/membership-changes/view';
import { MembershipListView } from '../src/components/membership-list/view';
import { cardLink, initialCardTarget } from '../src/components/people/card-link';
import { id } from './account-status-fixtures';

// Memberships on the contact card (slice A of docs/architecture/MEMBERSHIP_ON_CONTACT_CARD_SPEC.md).
beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const person = id(410), member = id(30), draft = id(31);
const cardBody = (items: unknown[]) => ({ generatedAt: '2026-11-15T10:00:00.000Z',
  person: { personId: person, version: 1, givenName: 'Avery', familyName: 'Able', email: null, phoneE164: null, createdAt: '2026-08-01T10:00:00.000Z' },
  overview: { segment: 'STUDENT', planName: 'Kids monthly', programName: 'Little Tigers', membershipEndsAt: null, ranks: [], openLead: false },
  family: { allowed: false }, appointments: { allowed: false }, tasks: { allowed: false },
  membership: { allowed: true, items }, billing: { allowed: false }, messages: { allowed: false }, timeline: [] });
const item = (membershipId: string, state: string) => ({ membershipId, state, planCode: 'KIDS', planName: 'Kids monthly', startedAt: '2026-10-01T07:00:00.000Z', endsAt: null });

it('shows each membership with the slot the People page gives it, and nothing extra when no slot is given', () => {
  const card = { state: 'READY', card: verifySchoolContactCard(cardBody([item(member, 'ACTIVE'), item(draft, 'DRAFT')]), person) } as const;
  const html = renderToStaticMarkup(<ContactCard language="en" card={card} initialTab="membership"
    membershipSlot={m => <span data-testid={`slot-${m.membershipId}`}>{m.state}</span>}/>);
  expect(html).toContain(`data-testid="slot-${member}"`);
  expect(html).toContain(`data-testid="slot-${draft}"`);
  expect(renderToStaticMarkup(<ContactCard language="en" card={card} initialTab="membership"/>)).not.toContain('data-testid="slot-');
});

it('gives each membership state one plain button, and never the word activation', () => {
  expect(cardMembershipButton('DRAFT')).toEqual({ action: 'start', label: 'finishStarting' });
  expect(cardMembershipButton('ACTIVE')).toEqual({ action: 'manage', label: 'pauseOrCancel' });
  expect(cardMembershipButton('FROZEN')).toEqual({ action: 'manage', label: 'resumeOrCancel' });
  expect(cardMembershipButton('CANCELLED')).toEqual({ action: 'manage', label: 'refundsAndHistory' });
  expect(cardMembershipButton('EXPIRED')).toEqual({ action: 'manage', label: 'history' });
  expect(cardMembershipButton('CANCELLATION_PENDING')).toEqual({ action: 'manage', label: 'history' });
  for (const lang of Object.keys(START_COPY)) for (const text of Object.values(START_COPY[lang as keyof typeof START_COPY]))
    expect(text).not.toMatch(/activat|draft|activación|borrador|활성화|초안/i);
});

const changesProps = (over: Partial<MembershipChangesViewProps> = {}): MembershipChangesViewProps => ({
  language: 'en', waiting: false, concealed: false, hasSchool: true,
  policy: { state: 'READY', read: { policy: { version: 1, pausesAllowed: true, maxPauseDays: 30, maxPausedDaysPerYear: 60, holdFee: null, createdAt: '2026-11-01T10:00:00.000Z' }, localToday: '2026-11-15' } },
  list: { state: 'LOADING' }, filter: 'ACTIVE', selected: member, selectedLabel: 'Kids monthly',
  history: { state: 'READY', view: { membershipId: member, state: 'ACTIVE', version: 4, localToday: '2026-11-15', pauses: [], refunds: [] } },
  form: null, outcome: null, locked: false, canRetry: false, ...over });

it('embedded on the card, pause and cancel show only this membership: no pause-rules editor and no membership picker', () => {
  const html = renderToStaticMarkup(<MembershipChangesView {...changesProps({ embedded: true })}/>);
  expect(html).toContain('data-testid="membership-actions"');
  expect(html).not.toContain('data-testid="pause-rules"');
  expect(html).not.toContain('data-testid="membership-select"');
  expect(html).not.toContain('<h1');
  // The full page still has both.
  const page = renderToStaticMarkup(<MembershipChangesView {...changesProps({ list: { state: 'READY', filter: 'ACTIVE', items: [], nextCursor: null, more: 'IDLE' } })}/>);
  expect(page).toContain('data-testid="pause-rules"');
});

const preview = (over: Partial<MembershipActivationPreview> = {}): MembershipActivationPreview => ({
  membershipId: draft, state: 'DRAFT', version: 1, billingAccountId: id(32), participantPersonId: person, participantDisplayName: 'Avery Able', planCode: 'KIDS',
  source: 'CRM_ADULT_PLAN', plan: { membershipPlanId: id(33), membershipPlanVersion: 2, terms: { displayName: 'Kids monthly' } },
  existingTerm: { termStartedAt: null, termEndsAt: null }, schoolTimezone: 'America/Los_Angeles', localToday: '2026-11-15', birthDateRecorded: true, knownMinor: false,
  suggestedDates: { startDate: '2026-11-15', endDate: null, startBasis: 'TODAY_IN_SCHOOL_TIMEZONE', endBasis: 'PLAN_OPEN_ENDED' },
  proposedDates: { startDate: '2026-11-15', endDate: null, dateSource: 'SUGGESTED' }, projection: { termStartedAt: '2026-11-15T08:00:00.000Z', termEndsAt: null },
  effectiveStatusIfConfirmedNow: 'IN_EFFECT', warnings: [], overridableWarnings: [], availableOverrides: [], blocks: [], canConfirm: true,
  requirementsNotEvaluated: ['AGREEMENT', 'PAYMENT', 'RECURRING_PAYMENT_AUTHORIZATION', 'FINANCIAL_RESPONSIBILITY', 'SCHOOL_ACTIVATION_POLICY'],
  previewDigest: 'a'.repeat(64), confirmation: MEMBERSHIP_ACTIVATION_CONFIRMATION, ...over });

it('builds the start request from the server preview: suggested dates, every warning checked, routine reason', () => {
  expect(startBody(preview(), { checked: [], note: '', overrideReason: '' })).toEqual({ expectedVersion: 1, previewDigest: 'a'.repeat(64), startDate: '2026-11-15', endDate: null,
    dateSource: 'SUGGESTED', acknowledgedWarnings: [], overrides: [], reasonCode: 'ROUTINE_ENROLLMENT', confirmation: MEMBERSHIP_ACTIVATION_CONFIRMATION });
  const warned = preview({ warnings: [{ code: 'BIRTH_DATE_MISSING' }, { code: 'START_DATE_IN_FUTURE', days: 3 }] });
  expect(startBody(warned, { checked: ['BIRTH_DATE_MISSING'], note: '', overrideReason: '' })).toBe('UNCHECKED');
  expect(startBody(warned, { checked: ['BIRTH_DATE_MISSING', 'START_DATE_IN_FUTURE'], note: '', overrideReason: '' })).toMatchObject({ acknowledgedWarnings: ['BIRTH_DATE_MISSING', 'START_DATE_IN_FUTURE'] });
});

it('asks for a note when staff moved the dates or the start is in the past, and for a reason when a review must be overridden', () => {
  const moved = preview({ proposedDates: { startDate: '2026-11-20', endDate: null, dateSource: 'STAFF_ADJUSTED' } });
  expect(startBody(moved, { checked: [], note: ' ', overrideReason: '' })).toBe('NOTE_REQUIRED');
  expect(startBody(moved, { checked: [], note: 'Starts after the holiday', overrideReason: '' })).toMatchObject({ startDate: '2026-11-20', dateSource: 'STAFF_ADJUSTED',
    dateAdjustmentReason: 'Starts after the holiday', reasonText: 'Starts after the holiday' });
  const back = preview({ warnings: [{ code: 'START_DATE_BACKDATED', days: 5 }] });
  expect(startBody(back, { checked: ['START_DATE_BACKDATED'], note: '', overrideReason: '' })).toBe('NOTE_REQUIRED');
  const review = preview({ warnings: [{ code: 'CRM_IDENTITY_REVIEW_PENDING' }], overridableWarnings: ['CRM_IDENTITY_REVIEW_PENDING'], availableOverrides: [] });
  expect(startBody(review, { checked: ['CRM_IDENTITY_REVIEW_PENDING'], note: '', overrideReason: 'Checked the ID in person today' })).toBe('NOT_ALLOWED');
  const allowed = { ...review, availableOverrides: ['CRM_IDENTITY_REVIEW_PENDING' as const] };
  expect(startBody(allowed, { checked: ['CRM_IDENTITY_REVIEW_PENDING'], note: '', overrideReason: 'short' })).toBe('OVERRIDE_REASON_REQUIRED');
  expect(startBody(allowed, { checked: ['CRM_IDENTITY_REVIEW_PENDING'], note: '', overrideReason: 'Checked the ID in person today' })).toMatchObject({
    overrides: [{ code: 'CRM_IDENTITY_REVIEW_PENDING', reason: 'Checked the ID in person today', confirmation: MEMBERSHIP_ACTIVATION_OVERRIDE_CONFIRMATION }] });
  expect(startBody(preview({ canConfirm: false, blocks: [{ code: 'MINOR_GUARDIAN_OF_RECORD_REQUIRED' }] }), { checked: [], note: '', overrideReason: '' })).toBe('BLOCKED');
});

const startProps = (over: Partial<StartMembershipViewProps> = {}): StartMembershipViewProps => ({
  language: 'en', state: { kind: 'READY', preview: preview() }, dates: { startDate: '2026-11-15', endDate: null }, checked: [], note: '', overrideReason: '', problem: null, busy: false,
  canRetry: false, ...over });

it('shows one plain review with a single Start membership button', () => {
  const html = renderToStaticMarkup(<StartMembershipView {...startProps()}/>);
  expect(html).toContain('Start membership');
  expect(html).toContain('Kids monthly');
  expect(html).not.toMatch(/activat|DRAFT|digest/i);
  expect(html).toMatch(/data-testid="start-membership-submit"[^>]*>/);
  expect(html).not.toMatch(/data-testid="start-membership-submit"[^>]*disabled/);
});

it('keeps Start membership off until every warning is ticked, and explains a block in plain words', () => {
  const warned = startProps({ state: { kind: 'READY', preview: preview({ warnings: [{ code: 'BIRTH_DATE_MISSING' }] }) } });
  expect(renderToStaticMarkup(<StartMembershipView {...warned}/>)).toMatch(/data-testid="start-membership-submit"[^>]*disabled/);
  expect(renderToStaticMarkup(<StartMembershipView {...warned}/>)).toContain('birth date');
  const ticked = { ...warned, checked: ['BIRTH_DATE_MISSING'] };
  expect(renderToStaticMarkup(<StartMembershipView {...ticked}/>)).not.toMatch(/data-testid="start-membership-submit"[^>]*disabled/);
  const blocked = startProps({ state: { kind: 'READY', preview: preview({ canConfirm: false, blocks: [{ code: 'MINOR_GUARDIAN_OF_RECORD_REQUIRED' }] }) } });
  const html = renderToStaticMarkup(<StartMembershipView {...blocked}/>);
  expect(html).toContain('guardian');
  expect(html).toMatch(/data-testid="start-membership-submit"[^>]*disabled/);
});

it('says when the membership started or starts later, and offers Try again only for an unknown outcome', () => {
  const done = renderToStaticMarkup(<StartMembershipView {...startProps({ state: { kind: 'DONE', status: 'SCHEDULED', startDate: '2026-12-01' } })}/>);
  expect(done).toContain('starts on');
  expect(renderToStaticMarkup(<StartMembershipView {...startProps({ state: { kind: 'DONE', status: 'IN_EFFECT', startDate: '2026-11-15' } })}/>)).toContain('has started');
  expect(renderToStaticMarkup(<StartMembershipView {...startProps({ problem: 'UNKNOWN', canRetry: true })}/>)).toContain('Try again');
  expect(renderToStaticMarkup(<StartMembershipView {...startProps({ problem: 'STALE' })}/>)).not.toContain('Try again');
});

it('links each membership report row to the person’s card and drops the Activate link', () => {
  const html = renderToStaticMarkup(<MembershipListView language="en" timeZone="UTC" waiting={false} concealed={false} scope={{ organizationId: id(1), schoolId: id(2) }} filter={null}
    list={{ state: 'READY', filter: null, items: [{ membershipId: member, state: 'ACTIVE', version: 4, planCode: 'KIDS', billingAccountId: id(31),
      participant: { personId: person, givenName: 'Avery', familyName: 'Able' }, effectiveStatus: 'IN_EFFECT', datesConfirmed: true,
      currentPeriod: { periodVersion: 1, changeKind: 'ACTIVATION', startDate: '2026-10-01', endDate: null }, legacyStoredTerm: null, createdAt: '2026-10-01T10:00:00.000Z' }],
      nextCursor: null, schoolTimezone: 'America/Los_Angeles', localToday: '2026-11-15', more: 'IDLE', restarted: false }}/>);
  expect(html).toContain(`href="${cardLink(person).replaceAll('&', '&amp;')}"`);
  expect(html).not.toContain('href="/staff/billing/memberships"');
});

it('opens a card from a link only for a well-formed person id and a known tab', () => {
  expect(cardLink(person)).toBe(`/staff/people?person=${person}&tab=membership`);
  expect(initialCardTarget(`?person=${person.toUpperCase()}&tab=membership`)).toEqual({ personId: person, tab: 'membership' });
  expect(initialCardTarget(`?person=${person}`)).toEqual({ personId: person, tab: 'overview' });
  expect(initialCardTarget(`?person=${person}&tab=secret`)).toEqual({ personId: person, tab: 'overview' });
  expect(initialCardTarget('?person=../x')).toBeNull();
  expect(initialCardTarget('')).toBeNull();
});
