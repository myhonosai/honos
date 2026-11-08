import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { LeadListItem } from '@hon/contracts';
import { LEADS_LANGUAGES, leadsText } from '../src/components/leads/copy';
import { LeadsError, leadsApi } from '../src/components/leads/http';
import { LeadsView, filterLeads, type LeadsViewProps } from '../src/components/leads/view';
import { SCHOOL_SHELL_NAV } from '../src/components/school-shell/catalog';
import { HON_SESSION_INVALIDATED_EVENT } from '../src/components/session-invalidation';
import { id, scope } from './account-status-fixtures';

beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const at = '2026-11-05T12:00:00.000Z';
const lead = (n: number, over: Partial<LeadListItem> = {}): LeadListItem => ({ id: id(40 + n), status: 'OPEN', pipelineStageId: id(30), primaryPersonId: id(50 + n), version: 3, createdAt: at,
  givenName: `Riley${n}`, familyName: 'Park', email: `riley${n}@example.invalid`, phoneE164: '+15555550100', nextFollowUpAt: at, ...over });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const stub = (response: Response) => { const f = vi.fn(async () => response); vi.stubGlobal('fetch', f); return f; };
const signal = () => new AbortController().signal;
const trial = (n: number, status = 'COMPLETED') => ({ id: id(70 + n), crmLeadId: id(41), appointmentType: 'TRIAL', status, startsAt: at, endsAt: '2026-11-05T13:00:00.000Z',
  createdByPrincipalId: id(9), version: 1, createdAt: at, updatedAt: at, location: 'Main mat' });
const props = (over: Partial<LeadsViewProps> = {}): LeadsViewProps => ({ language: 'en', waiting: false, concealed: false, scope, tab: 'OPEN',
  list: { state: 'READY', tab: 'OPEN', items: [lead(1), lead(2, { givenName: 'Jordan', familyName: 'Kim', email: null, nextFollowUpAt: undefined } as Partial<LeadListItem>)] },
  filter: '', selectedId: null, trials: { state: 'NONE' }, ...over });
const render = (over: Partial<LeadsViewProps> = {}) => renderToStaticMarkup(<LeadsView {...props(over)}/>);

it('reads the verified school’s lead list at the fixed path with the status tab', async () => {
  const f = stub(json({ data: [lead(1)], meta: { requestId: 'r' } }));
  await expect(leadsApi.list(scope, 'OPEN', signal(), () => true)).resolves.toHaveLength(1);
  const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe(`/api/v1/organizations/${scope.organizationId}/schools/${scope.schoolId}/crm/leads?limit=50&status=OPEN`);
  expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
  stub(json({ data: [], meta: {} }));
  await leadsApi.list(scope, null, signal(), () => true);
});

it('treats drift, a wrong status and failures as unavailable or denied, never as an empty list', async () => {
  for (const [response, kind] of [[json({ data: [lead(1)] }), 'UNAVAILABLE'], [json({ data: [lead(1, { status: 'WON' })], meta: {} }), 'UNAVAILABLE'],
    [json({ data: [{ ...lead(1), extra: 1 }], meta: {} }), 'UNAVAILABLE'], [json({}, 500), 'UNAVAILABLE'], [json({ code: 'FORBIDDEN' }, 403), 'DENIED']] as const) {
    stub(response);
    await expect(leadsApi.list(scope, 'OPEN', signal(), () => true)).rejects.toMatchObject({ kind });
  }
});

it('a 401 for a retired list read never ends the session; a current one does', async () => {
  const seen = vi.fn(); (window as unknown as EventTarget).addEventListener(HON_SESSION_INVALIDATED_EVENT, seen);
  stub(json({ code: 'SIGN_IN_REQUIRED' }, 401));
  await expect(leadsApi.list(scope, 'OPEN', signal(), () => false)).rejects.toBeInstanceOf(LeadsError);
  expect(seen).not.toHaveBeenCalled();
  stub(json({ code: 'SIGN_IN_REQUIRED' }, 401));
  await expect(leadsApi.list(scope, 'OPEN', signal(), () => true)).rejects.toMatchObject({ kind: 'SESSION' });
  expect(seen).toHaveBeenCalledTimes(1);
});

it('reads a lead’s trials through the existing verified trial read and maps its failures', async () => {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' };
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: { activeTrial: null, trials: [trial(1)] }, meta: { requestId: id(5), correlationId: id(5) } }), { status: 200, headers })));
  await expect(leadsApi.trials(scope, id(41), signal())).resolves.toMatchObject({ trials: [{ status: 'COMPLETED' }] });
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 403, headers })));
  await expect(leadsApi.trials(scope, id(41), signal())).rejects.toMatchObject({ kind: 'DENIED' });
});

it('shows nothing private before the shell verifies the school, while concealed, or with no school', () => {
  for (const over of [{ waiting: true }, { concealed: true }, { scope: null }]) {
    const html = render({ ...over, selectedId: id(41) });
    expect(html).not.toContain('Riley1'); expect(html).not.toContain('riley1@example.invalid'); expect(html).not.toContain('Main mat');
  }
  expect(render({ concealed: true })).toContain('Leads are hidden');
});

it('lists leads with status, follow-up and a status tab bar; the filter only narrows what was read', () => {
  const html = render();
  expect(html).toContain('Riley1 Park'); expect(html).toContain('Jordan Kim'); expect(html).toContain('No follow-up scheduled'); expect(html).toContain('2 shown');
  expect(html).toMatch(/aria-pressed="true"[^>]*>Open</); expect(html).toContain('>Archived<');
  expect(filterLeads(props().list.state === 'READY' ? (props().list as { items: LeadListItem[] }).items : [], 'jordan').map((l) => l.givenName)).toEqual(['Jordan']);
  expect(filterLeads([lead(1)], 'RILEY1@')).toHaveLength(1);
  expect(render({ filter: 'nobody' })).toContain('No shown lead matches this filter');
  expect(render({ list: { state: 'READY', tab: 'OPEN', items: Array.from({ length: 50 }, (_, n) => lead(n)) } })).toContain('Showing up to 50 leads');
  expect(render({ list: { state: 'DENIED' } })).toContain('does not include CRM leads');
  expect(render({ list: { state: 'UNAVAILABLE' } })).toContain('Nothing is shown');
  expect(render({ list: { state: 'READY', tab: 'WON', items: [] } })).toContain('No leads with this status');
});

it('a selected lead shows contact, trials and links that carry only the verified selectors', () => {
  const html = render({ selectedId: id(41), trials: { state: 'READY', leadId: id(41), recovery: { activeTrial: { ...trial(2, 'SCHEDULED') } as never, trials: [trial(2, 'SCHEDULED') as never, trial(1) as never] } } });
  expect(html).toContain('riley1@example.invalid'); expect(html).toContain('Upcoming trial'); expect(html).toContain('Scheduled'); expect(html).toContain('Completed');
  const q = `organizationId=${scope.organizationId}&amp;schoolId=${scope.schoolId}&amp;leadId=${id(41)}`;
  expect(html).toContain(`href="/staff/crm/journey?${q}"`); expect(html).toContain(`href="/staff/crm/lead-memberships?${q}"`);
  expect(html).toContain(`href="/staff/crm/follow-ups?leadId=${id(41)}"`);
  expect(html).not.toMatch(/<form|method="post"/i);
  const archived = render({ list: { state: 'READY', tab: 'ARCHIVED', items: [lead(1, { status: 'ARCHIVED' })] }, selectedId: id(41) });
  expect(archived).not.toContain('/staff/crm/journey'); expect(archived).not.toContain('/staff/crm/follow-ups');
  expect(render({ selectedId: id(41), trials: { state: 'DENIED' } })).toContain('does not include trial appointments');
  expect(render({ selectedId: id(41), trials: { state: 'READY', leadId: id(41), recovery: { activeTrial: null, trials: [] } } })).toContain('No trials booked yet');
  // Trials read for another lead are never shown under this one.
  expect(render({ selectedId: id(42), trials: { state: 'READY', leadId: id(41), recovery: { activeTrial: null, trials: [trial(1) as never] } } })).not.toContain('Main mat');
});

it('has every phrase in Korean and Spanish, and the Leads page is in the shell’s CRM group', () => {
  for (const language of ['ko', 'es'] as const) expect(Object.keys(LEADS_LANGUAGES[language]).sort()).toEqual(Object.keys(LEADS_LANGUAGES.en).sort());
  expect(leadsText('ko', 'title')).toBe('문의'); expect(leadsText('es', 'title')).toBe('Prospectos');
  const crm = SCHOOL_SHELL_NAV.find((group) => group.key === 'crm');
  expect(crm?.routes[0]?.href).toBe('/staff/crm');
});
