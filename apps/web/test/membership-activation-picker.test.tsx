import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SchoolMembershipListItem } from '@hon/contracts';
import { MembershipPickerView, loadDraftMemberships, pickerLabel, type PickerState } from '../src/components/membership-activation-picker';
import { activationText } from '../src/components/membership-activation-catalog';
import { MembershipListError, type MembershipListApi } from '../src/components/membership-list/http';
import { id, scope } from './account-status-fixtures';

beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const draft = (n: number, over: Partial<SchoolMembershipListItem> = {}): SchoolMembershipListItem => ({ membershipId: id(300 + n), state: 'DRAFT', version: 1, planCode: 'ADULT-MONTHLY',
  billingAccountId: id(400 + n), participant: { personId: id(500 + n), givenName: `Riley${n}`, familyName: 'Park' }, effectiveStatus: 'DRAFT', datesConfirmed: false,
  currentPeriod: null, legacyStoredTerm: { termStartedAt: null, termEndsAt: null }, createdAt: '2026-11-10T18:00:00.000Z', ...over } as SchoolMembershipListItem);
const t = (key: string, vars?: { date?: string }) => activationText('en', key as never, vars);
const render = (state: PickerState, value = '') => renderToStaticMarkup(<MembershipPickerView state={state} value={value} disabled={false} t={t} language="en"/>);

it('reads only DRAFT memberships of the verified school through the existing membership list read', async () => {
  const page = vi.fn<MembershipListApi['page']>(async () => ({ items: [draft(1)], nextCursor: null, schoolTimezone: 'America/Los_Angeles', localToday: '2026-11-11' }));
  const items = await loadDraftMemberships({ page }, scope, new AbortController().signal, () => true);
  expect(items).toHaveLength(1);
  expect(page.mock.calls[0]?.slice(0, 3)).toEqual([scope, 'DRAFT', null]);
  await expect(loadDraftMemberships({ page: async () => { throw new MembershipListError('DENIED'); } }, scope, new AbortController().signal, () => true)).rejects.toMatchObject({ kind: 'DENIED' });
});

it('labels each choice by person, plan and day added, never by an ID', () => {
  expect(pickerLabel(draft(1), 'en', t)).toBe('Riley1 Park · ADULT-MONTHLY · added Nov 10, 2026');
  expect(pickerLabel(draft(2, { participant: null }), 'en', t)).toContain('No participant recorded');
  expect(pickerLabel(draft(1), 'en', t)).not.toContain(id(301));
});

it('shows a labelled picker with no ID entry, and plain states for loading, none, denied and failure', () => {
  const html = render({ state: 'READY', items: [draft(1), draft(2)] }, id(302));
  expect(html).toContain('>Membership waiting for activation</label>');
  expect(html).toContain(`<option value="${id(302)}" selected="">Riley2 Park`);
  expect(html).not.toMatch(/Organization ID|School ID|membership ID/);
  expect(render({ state: 'READY', items: [] })).toContain('No memberships are waiting for activation');
  expect(render({ state: 'LOADING' })).toContain('Reading memberships waiting for activation');
  expect(render({ state: 'DENIED' })).toContain('does not include the membership list');
  expect(render({ state: 'UNAVAILABLE' })).toContain('could not be loaded');
});

it('has Korean and Spanish wording for every new caption', () => {
  for (const key of ['Membership waiting for activation', 'Choose a membership', 'No participant recorded', 'added {date}', 'Reading memberships waiting for activation…',
    'No memberships are waiting for activation. Create one from a lead in the CRM journey, then come back.', 'Your access does not include the membership list at this school. Nothing is shown.',
    'Memberships waiting for activation could not be loaded. Nothing is shown.', 'Choose a membership waiting for activation at your school. Every read and command checks your access again.', 'Reload list']) {
    expect(activationText('ko', key as never)).not.toBe(key);
    expect(activationText('es', key as never)).not.toBe(key);
  }
});
