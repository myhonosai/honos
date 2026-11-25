import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { verifySchoolContactCard, verifySchoolContactMembershipDetails } from '@hon/contracts';
import { ContactCard } from '../src/components/people/contact-card';
import { MembershipFacts, factsText } from '../src/components/people/membership-facts';
import { membershipDetailsApi } from '../src/components/people/membership-details-http';
import { id } from './account-status-fixtures';

// 0659: price, next payment, payer and (receivables readers only) paid and due on the card's Membership tab.
beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const person = id(410), member = id(30), payer = id(411);
const schedule = { frequency: 'MONTHLY', amountMinor: 14900, currency: 'USD', nextChargeAt: '2026-12-01T08:00:00.000Z', autoRenew: true, status: 'ACTIVE' };
const detail = (over: Record<string, unknown> = {}) => ({ membershipId: member, payer: { personId: payer, givenName: 'Riley', familyName: 'Able' }, schedule,
  paid: [{ currency: 'USD', paidMinor: 29800, dueMinor: 14900 }], lastPaidOn: '2026-11-01', ...over });

it('accepts only the closed shape, and never paid amounts for a role without receivables', () => {
  expect(verifySchoolContactMembershipDetails({ allowed: false })).toEqual({ allowed: false });
  expect(() => verifySchoolContactMembershipDetails({ allowed: false, items: [] })).toThrow();
  expect(verifySchoolContactMembershipDetails({ allowed: true, money: true, items: [detail()] }).allowed).toBe(true);
  expect(() => verifySchoolContactMembershipDetails({ allowed: true, money: false, items: [detail()] })).toThrow();
  expect(verifySchoolContactMembershipDetails({ allowed: true, money: false, items: [detail({ paid: null, lastPaidOn: null })] })).toMatchObject({ money: false });
  expect(() => verifySchoolContactMembershipDetails({ allowed: true, money: true, items: [detail({ paid: null })] })).toThrow();
  expect(() => verifySchoolContactMembershipDetails({ allowed: true, money: true, items: [detail(), detail()] })).toThrow();
  expect(() => verifySchoolContactMembershipDetails({ allowed: true, money: true, items: [detail({ cardLast4: '4242' })] })).toThrow();
  expect(() => verifySchoolContactMembershipDetails({ allowed: true, money: true, items: [detail({ schedule: { ...schedule, frequency: 'DAILY' } })] })).toThrow();
  expect(() => verifySchoolContactMembershipDetails({ allowed: true, money: true, items: [detail({ schedule: { ...schedule, amountMinor: -1 } })] })).toThrow();
});

it('shows price per cadence, next payment, payer, paid, due and last paid for the matching membership', () => {
  const details = verifySchoolContactMembershipDetails({ allowed: true, money: true, items: [detail()] });
  const html = renderToStaticMarkup(<MembershipFacts language="en" details={{ state: 'READY', personId: person, details }} membershipId={member.toUpperCase()}/>);
  expect(html).toContain('$149.00 / month');
  expect(html).toContain('renews automatically');
  expect(html).toContain('Riley Able');
  expect(html).toContain('$298.00');
  expect(html).toContain('Still due');
  expect(html).toContain('Nov 1, 2026');
  expect(renderToStaticMarkup(<MembershipFacts language="en" details={{ state: 'READY', personId: person, details }} membershipId={id(99)}/>)).toBe('');
});

it('a role without receivables sees the price and payer but no amounts paid', () => {
  const details = verifySchoolContactMembershipDetails({ allowed: true, money: false, items: [detail({ paid: null, lastPaidOn: null })] });
  const html = renderToStaticMarkup(<MembershipFacts language="en" details={{ state: 'READY', personId: person, details }} membershipId={member}/>);
  expect(html).toContain('$149.00 / month');
  expect(html).not.toContain('Payments received');
  expect(html).not.toContain('Last paid');
  const paused = verifySchoolContactMembershipDetails({ allowed: true, money: false, items: [detail({ paid: null, lastPaidOn: null, schedule: { ...schedule, status: 'PAUSED' } })] });
  const p = renderToStaticMarkup(<MembershipFacts language="en" details={{ state: 'READY', personId: person, details: paused }} membershipId={member}/>);
  expect(p).toContain('payments paused');
  expect(p).not.toContain('Next payment');
});

it('says when the details are being read or could not be read, and has every label in ko and es', () => {
  expect(renderToStaticMarkup(<MembershipFacts language="en" details={{ state: 'LOADING' }} membershipId={member}/>)).toContain('Reading payment details');
  expect(renderToStaticMarkup(<MembershipFacts language="en" details={{ state: 'UNAVAILABLE' }} membershipId={member}/>)).toContain('could not be loaded');
  expect(renderToStaticMarkup(<MembershipFacts language="en" details={{ state: 'NONE' }} membershipId={member}/>)).toBe('');
  expect(factsText('ko', 'freq_MONTHLY', { amount: 'X' })).toBe('월 X');
  expect(factsText('es', 'nextPayment')).toBe('Próximo pago');
});

it('reads the same-origin membership details path and rejects an unexpected body', async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify({ data: { allowed: true, money: false, items: [] } }), { status: 200, headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', fetch);
  const scope = { organizationId: id(1), schoolId: id(2) };
  await expect(membershipDetailsApi.read(scope, person, new AbortController().signal)).resolves.toEqual({ allowed: true, money: false, items: [] });
  expect(String((fetch.mock.calls[0] as unknown[])[0])).toBe(`/api/v1/organizations/${id(1)}/schools/${id(2)}/contacts/${person}/memberships`);
  fetch.mockImplementationOnce(async () => new Response(JSON.stringify({ data: { allowed: true, money: false, items: [], extra: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } }));
  await expect(membershipDetailsApi.read(scope, person, new AbortController().signal)).rejects.toThrow();
});

it('keeps Send agreement on the tab even when the role cannot read memberships', () => {
  const body = { generatedAt: '2026-11-15T10:00:00.000Z',
    person: { personId: person, version: 1, givenName: 'Avery', familyName: 'Able', email: null, phoneE164: null, createdAt: '2026-08-01T10:00:00.000Z' },
    overview: { segment: 'STUDENT', planName: null, programName: null, membershipEndsAt: null, ranks: [], openLead: false },
    family: { allowed: false }, appointments: { allowed: false }, tasks: { allowed: false }, membership: { allowed: false },
    billing: { allowed: false }, messages: { allowed: false }, timeline: [] };
  const card = { state: 'READY', card: verifySchoolContactCard(body, person) } as const;
  const html = renderToStaticMarkup(<ContactCard language="en" card={card} initialTab="membership" agreementSlot={() => <span data-testid="sign">sign</span>}/>);
  expect(html).toContain('role="note"');
  expect(html).toContain('data-testid="sign"');
});
