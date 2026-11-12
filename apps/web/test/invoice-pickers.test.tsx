import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SchoolMembershipListItem } from '@hon/contracts';
import { InvoicePickersView, dollarsToMinor, endOfSchoolDay, invoicePickLabel, loadInvoiceableMemberships } from '../src/components/invoice-pickers';
import { InvoiceWorkbench, shellInvoiceFields } from '../src/components/invoice-workbench';
import { MembershipListError, type MembershipListApi } from '../src/components/membership-list/http';
import { id, scope } from './account-status-fixtures';

beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const member = (n: number, over: Partial<SchoolMembershipListItem> = {}): SchoolMembershipListItem => ({ membershipId: id(300 + n), state: 'ACTIVE', version: 1, planCode: 'ADULT-MONTHLY',
  billingAccountId: id(400 + n), participant: { personId: id(500 + n), givenName: `Riley${n}`, familyName: 'Park' }, effectiveStatus: 'IN_EFFECT', datesConfirmed: true,
  currentPeriod: null, legacyStoredTerm: { termStartedAt: null, termEndsAt: null }, createdAt: '2026-11-10T18:00:00.000Z', ...over } as SchoolMembershipListItem);
const page = (items: SchoolMembershipListItem[], nextCursor: string | null = null) => ({ items, nextCursor, schoolTimezone: 'America/Los_Angeles', localToday: '2026-11-11' });

it('turns dollars and cents into minor units and refuses anything else', () => {
  expect(dollarsToMinor('49')).toBe('4900');
  expect(dollarsToMinor('49.5')).toBe('4950');
  expect(dollarsToMinor(' 0.05 ')).toBe('5');
  for (const bad of ['', '-1', '49.555', '1e3', '$49', '123456789', '49.']) expect(dollarsToMinor(bad)).toBeNull();
});

it('makes the due date the end of that day in the school timezone', () => {
  expect(endOfSchoolDay('2026-12-01', 'America/Los_Angeles')).toBe('2026-12-02T07:59:59.000Z');
  expect(endOfSchoolDay('2026-07-01', 'America/Los_Angeles')).toBe('2026-07-02T06:59:59.000Z');
  expect(endOfSchoolDay('2026-02-30', 'America/Los_Angeles')).toBeNull();
  expect(endOfSchoolDay('2026-12-01', 'Not/AZone')).toBeNull();
});

it('lists open memberships of the verified school through the existing list read, following the cursor up to 4 pages', async () => {
  const read = vi.fn<MembershipListApi['page']>(async (_s, _f, cursor) => cursor === null ? page([member(1), member(2, { state: 'CANCELLED' })], '2')
    : page([member(Number(cursor) + 1, { state: 'DRAFT' })], Number(cursor) < 9 ? String(Number(cursor) + 1) : null));
  const result = await loadInvoiceableMemberships({ page: read }, scope, new AbortController().signal, () => true);
  expect(read.mock.calls.map(call => call.slice(0, 3))).toEqual([[scope, null, null], [scope, null, '2'], [scope, null, '3'], [scope, null, '4']]);
  expect(result.items.map(item => item.membershipId)).toEqual([id(301), id(303), id(304), id(305)]);
  expect(result.schoolTimezone).toBe('America/Los_Angeles');
  await expect(loadInvoiceableMemberships({ page: async () => { throw new MembershipListError('DENIED'); } }, scope, new AbortController().signal, () => true)).rejects.toMatchObject({ kind: 'DENIED' });
});

it('labels choices by person, plan and state and shows plain states, never an ID', () => {
  expect(invoicePickLabel(member(1))).toBe('Riley1 Park · ADULT-MONTHLY · active');
  const html = renderToStaticMarkup(<InvoicePickersView state={{ state: 'READY', items: [member(1)], schoolTimezone: 'America/Los_Angeles' }} membershipId={id(301)} amount="49.00" dueDate="2026-12-01" disabled={false}/>);
  expect(html).toContain('>Who is this invoice for</label>');
  expect(html).toContain(`<option value="${id(301)}" selected="">Riley1 Park`);
  expect(html).toContain('America/Los_Angeles');
  expect(html).not.toContain(id(401));
  expect(renderToStaticMarkup(<InvoicePickersView state={{ state: 'READY', items: [], schoolTimezone: 'UTC' }} membershipId="" amount="" dueDate="" disabled={false}/>)).toContain('No memberships can be invoiced yet');
  expect(renderToStaticMarkup(<InvoicePickersView state={{ state: 'DENIED' }} membershipId="" amount="" dueDate="" disabled={false}/>)).toContain('does not include the membership list');
});

it('with a shell school the workbench shows pickers instead of UUID, minor-unit and timestamp boxes', () => {
  const html = renderToStaticMarkup(<InvoiceWorkbench shellScope={scope}/>);
  expect(html).toContain('Amount (dollars and cents)');
  expect(html).toContain('Due date');
  expect(html).not.toMatch(/Organization UUID|School UUID|billing account UUID|minor-unit integer|ISO timestamp/);
  expect(renderToStaticMarkup(<InvoiceWorkbench/>)).toContain('Organization UUID');
});

it('takes the school from the shell, defaults USD and drops a pick made at another school', () => {
  const base = { organizationId: '', schoolId: '', billingAccountId: '', membershipId: '', currency: '', subtotalMinor: '', dueAt: '', amountText: '', dueDate: '' };
  const picked = { ...base, ...scope, billingAccountId: id(401), membershipId: id(301), currency: 'USD', subtotalMinor: '4900', dueAt: '2026-12-02T07:59:59.000Z', amountText: '49', dueDate: '2026-12-01' };
  expect(shellInvoiceFields(base, scope)).toMatchObject({ ...scope, currency: 'USD' });
  expect(shellInvoiceFields(picked, scope)).toEqual(picked);
  const other = { organizationId: scope.organizationId, schoolId: id(999) };
  expect(shellInvoiceFields(picked, other)).toMatchObject({ schoolId: id(999), billingAccountId: '', membershipId: '', dueAt: '', dueDate: '', subtotalMinor: '4900' });
  expect(shellInvoiceFields(picked, null)).toEqual(picked);
});
