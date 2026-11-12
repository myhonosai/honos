import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { LeadListItem } from '@hon/contracts';
import { ChadLeadPickerView, leadPickLabel, loadOpenLeads, matchesLeadSearch } from '../src/components/chad-lead-picker';
import { ChadFollowUpAssistantWorkbench } from '../src/components/chad-follow-up-assistant-workbench';
import { LeadsError, type LeadsApi } from '../src/components/leads/http';
import { id, scope } from './account-status-fixtures';

beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const lead = (n: number, over: Partial<LeadListItem> = {}): LeadListItem => ({ id: id(800 + n), status: 'OPEN', pipelineStageId: id(900), primaryPersonId: id(700 + n), version: n,
  createdAt: '2026-11-10T18:00:00.000Z', givenName: `Sam${n}`, familyName: 'Lee', email: `sam${n}@example.test`, ...over });

it('reads only OPEN leads of the verified school through the existing CRM lead list', async () => {
  const list = vi.fn<LeadsApi['list']>(async () => [lead(1), lead(2, { status: 'WON' })]);
  expect((await loadOpenLeads({ list }, scope, new AbortController().signal, () => true)).map(l => l.id)).toEqual([id(801)]);
  expect(list.mock.calls[0]?.slice(0, 2)).toEqual([scope, 'OPEN']);
  await expect(loadOpenLeads({ list: async () => { throw new LeadsError('DENIED'); } }, scope, new AbortController().signal, () => true)).rejects.toMatchObject({ kind: 'DENIED' });
});

it('labels a lead by name and day added, never by ID or contact details, and searches by name', () => {
  expect(leadPickLabel(lead(1), 'en')).toBe('Sam1 Lee · added Nov 10, 2026');
  expect(leadPickLabel(lead(1), 'en')).not.toMatch(/example\.test|00000000/);
  expect(matchesLeadSearch(lead(1), ' sam1 ')).toBe(true);
  expect(matchesLeadSearch(lead(1), 'lee')).toBe(true);
  expect(matchesLeadSearch(lead(1), 'sam1@')).toBe(false);
});

it('shows a name picker with plain states, keeping a chosen lead visible while filtered', () => {
  const html = renderToStaticMarkup(<ChadLeadPickerView state={{ state: 'READY', items: [lead(1), lead(2)] }} leadId={id(802)} search="Sam1" disabled={false}/>);
  expect(html).toContain('>Lead</label>');
  expect(html).toContain(`<option value="${id(802)}" selected="">Sam2 Lee`);
  expect(html).toContain('Sam1 Lee');
  expect(html).not.toContain('sam1@example.test');
  expect(renderToStaticMarkup(<ChadLeadPickerView state={{ state: 'READY', items: [] }} leadId="" search="" disabled={false}/>)).toContain('no open leads');
  expect(renderToStaticMarkup(<ChadLeadPickerView state={{ state: 'DENIED' }} leadId="" search="" disabled={false}/>)).toContain('does not include this school’s leads');
});

it('with a shell school the Chad page shows the picker instead of UUID and version boxes', () => {
  const html = renderToStaticMarkup(<ChadFollowUpAssistantWorkbench shellScope={scope}/>);
  expect(html).toContain('Reading open leads');
  expect(html).not.toMatch(/Known CRM lead UUID|Observed lead version/);
  expect(renderToStaticMarkup(<ChadFollowUpAssistantWorkbench/>)).toContain('Known CRM lead UUID');
});
