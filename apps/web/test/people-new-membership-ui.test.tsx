import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  PERSON_MEMBERSHIP_START_BLOCKERS, PERSON_MEMBERSHIP_START_COMMAND, PERSON_MEMBERSHIP_START_CONFIRMATION, verifyPersonMembershipStartOptions, verifySchoolContactCard,
  type MembershipPlanListing,
} from '@hon/contracts';
import { ContactCard } from '../src/components/people/contact-card';
import {
  NEW_COPY, NewMembershipToolsView, NewMembershipView, initialForm, newMembershipBody, plansFor, problemKeys, renewTargets, type NewMembershipViewProps, type NewMode,
} from '../src/components/people/new-membership';
import { NewMembershipError, prepareNewMembership, readNewMembershipOptions, sendNewMembership } from '../src/components/people/new-membership-http';
import { id } from './account-status-fixtures';

// New membership and Renew on the contact card (slice B, 0531).
beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const org = id(1), school = id(2), person = id(410), guardian = id(411), current = id(30), program = id(50), other = id(51);
const scope = { organizationId: org, schoolId: school, personId: person };
const plan = (n: number, programId: string | null, over: Partial<MembershipPlanListing> = {}): MembershipPlanListing => ({ planId: id(60 + n), planCode: `P${n}`, version: 2,
  displayName: `Plan ${n}`, description: null, programId, availability: 'AVAILABLE', currency: 'USD', priceMinor: 15000, billingFrequency: 'MONTHLY',
  termKind: 'FIXED_MONTHS', termMonths: 12, publishedAt: '2026-10-01T00:00:00.000Z', programName: programId ? 'Little Tigers' : null, ...over } as MembershipPlanListing);
const plans = [plan(1, program, { planCode: 'TKD-12' }), plan(2, program), plan(3, other), plan(4, null, { termKind: 'OPEN_ENDED', termMonths: null })];
const rawOptions = (over: Record<string, unknown> = {}) => ({ personId: person, schoolToday: '2026-11-16', schoolTimezone: 'America/Los_Angeles', minor: false, blockers: [],
  payers: [{ personId: person, givenName: 'Avery', familyName: 'Able', relation: 'SELF', billingContact: false },
    { personId: guardian, givenName: 'Gale', familyName: 'Able', relation: 'GUARDIAN', billingContact: true }],
  defaultPayerPersonId: person, payerProblem: null,
  memberships: [{ membershipId: current, state: 'ACTIVE', planCode: 'TKD-12', programId: program, startDate: '2025-12-01', endDate: '2026-11-30', renewable: true, renewStartDate: '2026-12-01' },
    { membershipId: id(31), state: 'CANCELLED', planCode: 'OLD', programId: null, startDate: '2025-01-01', endDate: '2025-02-01', renewable: false, renewStartDate: '2025-02-02' }], ...over });
const options = (over: Record<string, unknown> = {}) => verifyPersonMembershipStartOptions(rawOptions(over), person);
const items = [{ membershipId: current, state: 'ACTIVE', planCode: 'TKD-12', planName: 'Taekwondo yearly', startedAt: '2025-12-01T08:00:00.000Z', endsAt: '2026-12-01T08:00:00.000Z' }] as never;
const renew: NewMode = { kind: 'RENEW', target: { membershipId: current, programId: program, planCode: 'TKD-12', label: 'Taekwondo yearly', endDate: '2026-11-30', renewStartDate: '2026-12-01' } };

it('a renewal offers only plans in the same program, starts the day after, keeps the plan code; plans without a program are one group', () => {
  expect(plansFor(plans, { kind: 'NEW' })).toHaveLength(4);
  expect(plansFor(plans, renew).map(p => p.planCode)).toEqual(['TKD-12', 'P2']);
  expect(plansFor(plans, { kind: 'RENEW', target: { ...(renew as Extract<NewMode, { kind: 'RENEW' }>).target, programId: null } }).map(p => p.planCode)).toEqual(['P4']);
  expect(initialForm(options(), plans, renew)).toEqual({ planId: id(61), startDate: '2026-12-01', payerPersonId: person });
  expect(initialForm(options(), plans, { kind: 'NEW' })).toEqual({ planId: '', startDate: '2026-11-16', payerPersonId: person });
  expect(renewTargets(options(), items)).toEqual([(renew as Extract<NewMode, { kind: 'RENEW' }>).target]);
});

it('sends the exact plan version picked and the renewed membership; asks for what is missing', () => {
  expect(newMembershipBody({ planId: '', startDate: '2026-11-16', payerPersonId: null }, plans, { kind: 'NEW' })).toBe('p_PLAN');
  expect(newMembershipBody({ planId: id(63), startDate: '', payerPersonId: null }, plans, { kind: 'NEW' })).toBe('p_DATE');
  expect(newMembershipBody({ planId: id(63), startDate: '2026-12-01', payerPersonId: null }, plans, renew)).toBe('p_PLAN');
  expect(newMembershipBody({ planId: id(61), startDate: '2026-12-01', payerPersonId: guardian }, plans, renew)).toEqual({ membershipPlanId: id(61), membershipPlanVersion: 2,
    kind: 'RENEW', renewsMembershipId: current, startDate: '2026-12-01', payerPersonId: guardian, confirmation: PERSON_MEMBERSHIP_START_CONFIRMATION });
});

it('says each server refusal in plain words; an unknown outcome is its own answer', () => {
  expect(problemKeys(new NewMembershipError('BLOCKED', 409, ['DRAFT_IN_PROGRAM', 'OVERLAPS_CURRENT_MEMBERSHIP']))).toEqual(['b_DRAFT_IN_PROGRAM', 'b_OVERLAPS_CURRENT_MEMBERSHIP']);
  expect(problemKeys(new NewMembershipError('BLOCKED', 409, []))).toEqual(['p_REFUSED']);
  expect(problemKeys(new NewMembershipError('STALE', 409))).toEqual(['p_STALE']);
  expect(problemKeys(new Error('x'))).toEqual(['p_UNKNOWN']);
  for (const b of PERSON_MEMBERSHIP_START_BLOCKERS) expect(NEW_COPY.en[`b_${b}`]).toBeTruthy();
});

const viewProps = (over: Partial<NewMembershipViewProps> = {}): NewMembershipViewProps => ({ language: 'en', mode: { kind: 'NEW' }, options: options(),
  load: { kind: 'READY', plans }, form: { planId: id(61), startDate: '2026-11-16', payerPersonId: person }, notices: [], busy: false, canRetry: false, onClose: () => {}, ...over });

it('the form shows the plan terms, who pays, the one-per-program rule, and never mentions activation or drafts', () => {
  const html = renderToStaticMarkup(<NewMembershipView {...viewProps()}/>);
  expect(html).toContain('New membership');
  expect(html).toContain('data-testid="new-membership-terms"');
  expect(html).toContain('12 months');
  expect(html).toContain('Little Tigers');
  expect(html).toContain('Gale Able (guardian, billing contact)');
  expect(html).toContain('one membership per program');
  expect(html).not.toMatch(/activat|draft/i);
  const renewing = renderToStaticMarkup(<NewMembershipView {...viewProps({ mode: renew })}/>);
  expect(renewing).toContain('Renew membership');
  expect(renewing).toContain('Follows Taekwondo yearly');
  expect(renewing).not.toContain('Plan 3');
  expect(renderToStaticMarkup(<NewMembershipView {...viewProps({ mode: renew, load: { kind: 'READY', plans: [plans[2]!] } })}/>)).toContain('No plan for sale in the same program');
  expect(renderToStaticMarkup(<NewMembershipView {...viewProps({ load: { kind: 'READY', plans: [] } })}/>)).toContain('There are no plans for sale yet');
  expect(renderToStaticMarkup(<NewMembershipView {...viewProps({ load: { kind: 'DENIED' } })}/>)).toContain('Your role cannot add memberships');
  const blocked = renderToStaticMarkup(<NewMembershipView {...viewProps({ notices: ['p_UNKNOWN'], canRetry: true, onRetry: () => {} })}/>);
  expect(blocked).toContain('it won’t be added twice');
  expect(blocked).toContain('Try again');
  const noPayer = renderToStaticMarkup(<NewMembershipView {...viewProps({ options: options({ minor: true, payers: [], defaultPayerPersonId: null, payerProblem: 'NO_GUARDIAN' }),
    form: { planId: id(61), startDate: '2026-11-16', payerPersonId: null } })}/>);
  expect(noPayer).toContain('Add one in the Family tab first');
  for (const table of Object.values(NEW_COPY)) {
    expect(Object.keys(table).sort()).toEqual(Object.keys(NEW_COPY.en).sort());
    for (const text of Object.values(table)) expect(text).not.toMatch(/activat|draft|activación|borrador|활성화|초안/i);
  }
});

it('the tab top offers New membership and one Renew per renewable membership, or says why not', () => {
  const ready = renderToStaticMarkup(<NewMembershipToolsView language="en" state={{ kind: 'READY', options: options() }} items={items} opened={false}/>);
  expect(ready).toContain('data-testid="new-membership-open"');
  expect(ready).toContain(`data-testid="renew-${current}"`);
  expect(ready).toContain('Renew: Taekwondo yearly');
  expect(ready).not.toContain(`renew-${id(31)}`);
  const lead = renderToStaticMarkup(<NewMembershipToolsView language="en" state={{ kind: 'READY', options: options({ blockers: ['NO_STUDENT_RECORD'] }) }} items={[]} opened={false}/>);
  expect(lead).toContain('isn’t a student yet');
  expect(lead).not.toContain('new-membership-open');
  expect(renderToStaticMarkup(<NewMembershipToolsView language="ko" state={{ kind: 'DENIED' }} items={[]} opened={false}/>)).toContain('회원권을 추가할 수 없습니다');
  expect(renderToStaticMarkup(<NewMembershipToolsView language="en" state={{ kind: 'READY', options: options() }} items={items} opened/>)).toBe('');
});

it('the card shows the tools on the membership tab even before the first membership, and not when the role cannot see memberships', () => {
  const body = (membership: unknown) => ({ generatedAt: '2026-11-15T10:00:00.000Z',
    person: { personId: person, version: 1, givenName: 'Avery', familyName: 'Able', email: null, phoneE164: null, createdAt: '2026-08-01T10:00:00.000Z' },
    overview: { segment: 'STUDENT', planName: null, programName: null, membershipEndsAt: null, ranks: [], openLead: false },
    family: { allowed: false }, appointments: { allowed: false }, tasks: { allowed: false }, membership, billing: { allowed: false }, messages: { allowed: false }, timeline: [] });
  const tools = () => <span data-testid="tools"/>;
  const empty = { state: 'READY', card: verifySchoolContactCard(body({ allowed: true, items: [] }), person) } as const;
  const html = renderToStaticMarkup(<ContactCard language="en" card={empty} initialTab="membership" membershipTools={tools}/>);
  expect(html).toContain('data-testid="tools"');
  const denied = { state: 'READY', card: verifySchoolContactCard(body({ allowed: false }), person) } as const;
  expect(renderToStaticMarkup(<ContactCard language="en" card={denied} initialTab="membership" membershipTools={tools}/>)).not.toContain('data-testid="tools"');
});

const json = (status: number, payload: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(payload), { status,
  headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store', ...headers } });
const requestId = '77777777-7777-4777-8777-777777777777';

it('HTTP: reads options for the route person, sends one human command with its key, keeps only known blockers, and never trusts an unverified answer', async () => {
  const fetch = vi.fn(async () => json(200, { data: rawOptions(), meta: { requestId } }));
  vi.stubGlobal('fetch', fetch);
  expect((await readNewMembershipOptions(scope)).memberships[0]!.renewStartDate).toBe('2026-12-01');
  expect((fetch.mock.calls[0] as unknown as [string])[0]).toBe(`/api/v1/organizations/${org}/schools/${school}/billing/people/${person}/membership-start`);
  fetch.mockImplementationOnce(async () => json(200, { data: rawOptions({ personId: guardian }), meta: { requestId } }));
  await expect(readNewMembershipOptions(scope)).rejects.toThrow();

  const body = newMembershipBody({ planId: id(61), startDate: '2026-12-01', payerPersonId: null }, plans, { kind: 'NEW' });
  if (typeof body === 'string') throw new Error(body);
  const key = '88888888-8888-4888-8888-888888888888';
  const request = prepareNewMembership(scope, body, key);
  expect(JSON.parse(request.body)).not.toHaveProperty('personId');
  const receipt = { membershipId: id(90), state: 'DRAFT', personId: person, kind: 'NEW', renewsMembershipId: null, membershipPlanId: id(61), membershipPlanVersion: 2,
    planCode: 'TKD-12', programId: program, payerPersonId: person, billingAccountId: id(91), startDate: '2026-12-01', endDate: '2027-11-30',
    termStartedAt: '2026-12-01T08:00:00.000Z', termEndsAt: '2027-12-01T08:00:00.000Z', recordedAt: '2026-11-16T08:00:00.000Z' };
  fetch.mockImplementationOnce(async () => json(201, { data: receipt, meta: { requestId, replayed: false } }));
  expect((await sendNewMembership(request)).receipt.membershipId).toBe(id(90));
  const sent = fetch.mock.calls.at(-1) as unknown as [string, RequestInit];
  expect(sent[0]).toBe(`/api/v1/organizations/${org}/schools/${school}/billing/people/${person}/memberships/from-plan`);
  expect(sent[1].headers).toMatchObject({ 'X-HON-Human-Command': PERSON_MEMBERSHIP_START_COMMAND, 'Idempotency-Key': key });

  fetch.mockImplementationOnce(async () => json(409, { code: 'PERSON_MEMBERSHIP_BLOCKED', blockers: ['DRAFT_IN_PROGRAM', '<script>'] }));
  await expect(sendNewMembership(request)).rejects.toMatchObject({ problem: 'BLOCKED', blockers: ['DRAFT_IN_PROGRAM'] });
  fetch.mockImplementationOnce(async () => json(201, { data: { ...receipt, startDate: '2026-12-02' }, meta: { requestId, replayed: false } }));
  await expect(sendNewMembership(request)).rejects.toMatchObject({ problem: 'UNKNOWN' });
  fetch.mockImplementationOnce(async () => { throw new TypeError('network'); });
  await expect(sendNewMembership(request)).rejects.toMatchObject({ problem: 'UNKNOWN' });
  fetch.mockImplementationOnce(async () => json(403, { code: 'PERSON_MEMBERSHIP_FORBIDDEN' }));
  await expect(sendNewMembership(request)).rejects.toMatchObject({ problem: 'DENIED' });
});
