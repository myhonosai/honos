import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { validateHqSupportCaseDetail, validateHqSupportCaseList, validateHqSupportSchools } from '@hon/contracts';
import { SupportError, supportApi, supportCaseId, supportCommandError } from '../src/components/hq-support/http';
import { supportOutcomeFor } from '../src/components/hq-support/model';
import { HqSupportListView, openInputFrom, type SupportListViewProps } from '../src/components/hq-support/list-view';
import { HqSupportCaseView, changeInputFrom, type SupportCaseViewProps } from '../src/components/hq-support/case-view';
import { supportText } from '../src/components/hq-support/copy';
import { HQ_PLANNED, hqPageLabel } from '../src/components/hq-modern/catalog';

const yes = () => true;
beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const T = '2026-11-01T00:00:00.000Z', T2 = '2026-11-02T00:00:00.000Z';
const agent = { principalId: id(50), displayName: 'Synthetic Agent' }, lead = { principalId: id(51), displayName: 'Synthetic Lead' };
const kase = (patch: Record<string, unknown> = {}) => ({ caseId: id(1), organizationId: id(2), organizationDisplayName: 'Synthetic Dojo', schoolId: id(3),
  schoolDisplayName: 'Synthetic Academy', subject: 'Owner cannot sign in', category: 'ACCOUNT_ACCESS', priority: 'HIGH', status: 'OPEN', assignee: null,
  openedBy: agent, openedAt: T, updatedAt: T, closedAt: null, version: 1, noteCount: 1, ...patch });
const summary = { OPEN: 1, WAITING_ON_SCHOOL: 0, RESOLVED: 0, CLOSED: 0, urgentActive: 0, unassignedActive: 1 };
const listRaw = (patch: Record<string, unknown> = {}) => ({ cases: [kase()], limit: 25, nextCursor: null, summary, viewer: agent, asOf: T2, ...patch });
const event = (patch: Record<string, unknown> = {}) => ({ seq: 1, kind: 'OPENED', actor: agent, note: 'Reported twice.', statusFrom: null, statusTo: null,
  priorityFrom: null, priorityTo: null, assigneeChanged: false, assigneeTo: null, occurredAt: T, ...patch });
const detailRaw = (patch: Record<string, unknown> = {}) => ({ case: kase(), events: [event()], assignees: [agent, lead], viewer: agent, asOf: T2, ...patch });
const receipt = (operation: string, c: Record<string, unknown>) => ({ operation, case: kase(c), replayed: false });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const stub = (...answers: Response[]) => { const f = vi.fn(async () => answers.shift() ?? json({}, 500)); vi.stubGlobal('fetch', f); return f; };
const call = (f: ReturnType<typeof stub>, n = 0) => f.mock.calls[n] as unknown as [string, RequestInit];

it('reads the list with only the declared query and a plain same-origin GET', async () => {
  const f = stub(json({ data: listRaw() }));
  await supportApi.list({ status: 'ACTIVE', organizationId: id(2).toUpperCase(), cursor: { openedAt: T, caseId: id(9) } }, new AbortController().signal, yes);
  const [path, init] = call(f);
  expect(path).toBe(`/api/v1/hq/support/cases?status=ACTIVE&organizationId=${id(2)}&cursor=${new URLSearchParams({ c: `${T}~${id(9)}` }).toString().slice(2)}&limit=25`);
  expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer' });
  expect(Object.keys(init.headers as object)).toEqual(['Accept']);
  // A page that does not match the filter is never shown.
  stub(json({ data: listRaw({ cases: [kase({ status: 'CLOSED', closedAt: T2 })] }) }));
  await expect(supportApi.list({ status: 'ACTIVE', organizationId: null, cursor: null }, new AbortController().signal, yes)).rejects.toMatchObject({ kind: 'UNKNOWN' });
  stub(json({ data: listRaw() }));
  await expect(supportApi.list({ status: null, organizationId: id(7), cursor: null }, new AbortController().signal, yes)).rejects.toMatchObject({ kind: 'UNKNOWN' });
});

it('reads one case by a validated id and the school picker without a query', async () => {
  const f = stub(json({ data: detailRaw() }), json({ data: { schools: [], truncated: false, asOf: T2 } }));
  expect((await supportApi.read(id(1).toUpperCase(), new AbortController().signal, yes)).case.caseId).toBe(id(1));
  expect(call(f)[0]).toBe(`/api/v1/hq/support/cases/${id(1)}`);
  await supportApi.schools(new AbortController().signal, yes);
  expect(call(f, 1)[0]).toBe('/api/v1/hq/support/cases/schools');
  for (const bad of ['', 'schools', '../x', `${id(1)}?a=1`]) {
    expect(supportCaseId(bad)).toBeNull();
    await expect(supportApi.read(bad, new AbortController().signal, yes)).rejects.toMatchObject({ kind: 'INVALID' });
  }
  expect(f).toHaveBeenCalledTimes(2);
  stub(json({ data: detailRaw({ case: kase({ caseId: id(4) }) }) }));
  await expect(supportApi.read(id(1), new AbortController().signal, yes)).rejects.toMatchObject({ kind: 'UNKNOWN' });
  for (const [answer, kind] of [[json({ code: 'SAAS_FORBIDDEN' }, 403), 'DENIED'], [json({ code: 'SAAS_UNAVAILABLE' }, 404), 'GONE'], [json({}, 404), 'UNKNOWN'],
    [json({ data: { ...detailRaw(), email: 'a@example.test' } }), 'UNKNOWN'], [json({ data: detailRaw(), extra: 1 }), 'UNKNOWN'],
    [new Response('<html>', { status: 200, headers: { 'Content-Type': 'text/html' } }), 'UNKNOWN']] as const) {
    stub(answer);
    await expect(supportApi.read(id(1), new AbortController().signal, yes)).rejects.toMatchObject({ kind });
  }
});

it('sends commands with the human marker, a key and the validated body, and checks the receipt matches', async () => {
  const input = { organizationId: id(2), schoolId: id(3), subject: 'Owner cannot sign in', category: 'ACCOUNT_ACCESS' as const, priority: 'HIGH' as const, note: 'Reported twice.' };
  const f = stub(json({ data: receipt('OPEN', {}) }));
  await supportApi.open(input, id(80), new AbortController().signal, yes);
  const [path, init] = call(f);
  expect(path).toBe('/api/v1/hq/support/cases');
  expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store' });
  expect(init.headers).toEqual({ Accept: 'application/json', 'Content-Type': 'application/json', 'X-HON-Human-Command': 'hq-support-case-open', 'Idempotency-Key': id(80) });
  expect(JSON.parse(String(init.body))).toEqual(input);
  stub(json({ data: receipt('OPEN', { schoolId: null, schoolDisplayName: null }) }));
  await expect(supportApi.open(input, id(80), new AbortController().signal, yes)).rejects.toMatchObject({ kind: 'UNKNOWN' });

  const g = stub(json({ data: receipt('NOTE', { version: 4, noteCount: 2 }) }));
  await supportApi.note(id(1), { expectedVersion: 3, note: 'Called back.' }, id(81), new AbortController().signal, yes);
  expect(call(g)[0]).toBe(`/api/v1/hq/support/cases/${id(1)}/notes`);
  expect((call(g)[1].headers as Record<string, string>)['X-HON-Human-Command']).toBe('hq-support-case-note');
  stub(json({ data: receipt('NOTE', { version: 9 }) }));
  await expect(supportApi.note(id(1), { expectedVersion: 3, note: 'x' }, id(81), new AbortController().signal, yes)).rejects.toMatchObject({ kind: 'UNKNOWN' });

  const h = stub(json({ data: receipt('CHANGE', { version: 3, status: 'RESOLVED', assignee: lead }) }));
  await supportApi.change(id(1), { expectedVersion: 2, status: 'RESOLVED', assigneePrincipalId: lead.principalId }, id(82), new AbortController().signal, yes);
  expect(call(h)[0]).toBe(`/api/v1/hq/support/cases/${id(1)}/changes`);
  stub(json({ data: receipt('CHANGE', { version: 3, status: 'OPEN' }) }));
  await expect(supportApi.change(id(1), { expectedVersion: 2, status: 'RESOLVED' }, id(82), new AbortController().signal, yes)).rejects.toMatchObject({ kind: 'UNKNOWN' });
  // Invalid requests never leave the page.
  const none = stub();
  await expect(supportApi.change(id(1), { expectedVersion: 2 }, id(83), new AbortController().signal, yes)).rejects.toMatchObject({ kind: 'INVALID' });
  await expect(supportApi.note('nope', { expectedVersion: 2, note: 'x' }, id(83), new AbortController().signal, yes)).rejects.toMatchObject({ kind: 'INVALID' });
  expect(none).not.toHaveBeenCalled();
});

it('maps only exact refusals to definite outcomes; everything else keeps the request for an identical retry', () => {
  const cases: [number, string | null, string][] = [[403, 'SAAS_FORBIDDEN', 'DENIED'], [400, 'INVALID_SAAS_INPUT', 'INVALID'], [404, 'SAAS_UNAVAILABLE', 'GONE'],
    [409, 'SAAS_VERSION_CONFLICT', 'CHANGED'], [422, 'SUPPORT_CASE_CLOSED', 'CHANGED'], [422, 'SUPPORT_ASSIGNEE_NOT_ELIGIBLE', 'REFUSED'],
    [422, 'SUPPORT_NO_CHANGE', 'REFUSED'], [409, 'IDEMPOTENCY_KEY_REUSED', 'KEY_REUSED'], [409, 'SAAS_OUTCOME_UNKNOWN', 'UNKNOWN'], [503, null, 'UNKNOWN'],
    [422, 'SOMETHING_NEW', 'UNKNOWN'], [404, null, 'UNKNOWN']];
  for (const [status, code, kind] of cases) expect(supportCommandError(status, code).kind, `${status} ${code}`).toBe(kind);
  expect(supportOutcomeFor(new SupportError('UNKNOWN'))).toEqual({ outcome: { kind: 'UNKNOWN' }, keep: true });
  expect(supportOutcomeFor(new Error('network'))).toEqual({ outcome: { kind: 'UNKNOWN' }, keep: true });
  expect(supportOutcomeFor(new SupportError('CHANGED')).keep).toBe(false);
  expect(supportOutcomeFor(new SupportError('SESSION'))).toEqual({ outcome: null, keep: false });
});

it('builds closed open and change requests from the forms', () => {
  const schools = validateHqSupportSchools({ schools: [{ schoolId: id(3), schoolDisplayName: 'Synthetic Academy', organizationId: id(2), organizationDisplayName: 'Synthetic Dojo' }], truncated: false, asOf: T2 });
  const draft = { target: `school:${id(3)}`, subject: '  Owner cannot sign in ', category: 'ACCOUNT_ACCESS', priority: 'HIGH', note: ' Reported. ' };
  expect(openInputFrom(draft, schools)).toEqual({ organizationId: id(2), schoolId: id(3), subject: 'Owner cannot sign in', category: 'ACCOUNT_ACCESS', priority: 'HIGH', note: 'Reported.' });
  expect(openInputFrom({ ...draft, target: `org:${id(2)}` }, schools)?.schoolId).toBeNull();
  for (const bad of [{ target: `school:${id(9)}` }, { target: '' }, { subject: 'ab' }, { note: '  ' }, { category: 'REFUND' }, { priority: 'P1' }])
    expect(openInputFrom({ ...draft, ...bad }, schools), JSON.stringify(bad)).toBeNull();
  expect(openInputFrom(draft, null)).toBeNull();

  const view = validateHqSupportCaseDetail(detailRaw({ case: kase({ version: 3, assignee: agent }) }));
  const keep = { status: 'KEEP', priority: 'KEEP', assignee: 'KEEP', note: '' };
  expect(changeInputFrom({ ...keep, status: 'RESOLVED', note: ' Fixed. ' }, view)).toEqual({ expectedVersion: 3, status: 'RESOLVED', note: 'Fixed.' });
  expect(changeInputFrom({ ...keep, assignee: 'NOBODY' }, view)).toEqual({ expectedVersion: 3, assigneePrincipalId: null });
  expect(changeInputFrom({ ...keep, assignee: lead.principalId, priority: 'URGENT' }, view)).toEqual({ expectedVersion: 3, priority: 'URGENT', assigneePrincipalId: lead.principalId });
  for (const bad of [keep, { ...keep, note: 'only a note' }, { ...keep, status: 'OPEN' }, { ...keep, assignee: agent.principalId }, { ...keep, assignee: id(99) }, { ...keep, status: 'DONE' }])
    expect(changeInputFrom(bad, view), JSON.stringify(bad)).toBeNull();
});

const noop = () => {};
const listProps = (patch: Partial<SupportListViewProps> = {}): SupportListViewProps => ({ language: 'en', formattingLocale: 'en-US', concealed: false,
  state: { state: 'READY', view: validateHqSupportCaseList(listRaw()), cases: validateHqSupportCaseList(listRaw()).cases, loadingMore: false, moreFailed: false },
  filter: 'ACTIVE', formOpen: false, schools: { state: 'IDLE' }, outcome: null, locked: false, canRetry: false,
  onFilter: noop, onMore: noop, onRefresh: noop, onReveal: noop, onForm: noop, onOpen: noop, onTryAgain: noop, ...patch });
const caseProps = (patch: Partial<SupportCaseViewProps> = {}): SupportCaseViewProps => ({ language: 'en', formattingLocale: 'en-US', concealed: false,
  state: { state: 'READY', view: validateHqSupportCaseDetail(detailRaw()) }, busy: false, outcome: null, locked: false, canRetry: false, formKey: 0,
  onRefresh: noop, onReveal: noop, onNote: noop, onChange: noop, onTryAgain: noop, ...patch });

it('renders the list from the verified answer and hides everything while concealed', () => {
  const html = renderToStaticMarkup(<HqSupportListView {...listProps()}/>);
  for (const text of ['Owner cannot sign in', 'Synthetic Dojo', 'Synthetic Academy', 'Account access', 'Open a case', `href="/hq/support/${id(1)}"`, 'aria-pressed="true"'])
    expect(html).toContain(text);
  expect(html).not.toMatch(/@example|impersonat/i);
  const hidden = renderToStaticMarkup(<HqSupportListView {...listProps({ concealed: true })}/>);
  expect(hidden).toContain(supportText('en', 'concealed'));
  expect(hidden).not.toContain('Owner cannot sign in');
  expect(renderToStaticMarkup(<HqSupportListView {...listProps({ state: { state: 'DENIED' } })}/>)).toContain(supportText('en', 'denied'));
  const form = renderToStaticMarkup(<HqSupportListView {...listProps({ formOpen: true, schools: { state: 'READY', view: validateHqSupportSchools({ schools: [
    { schoolId: id(3), schoolDisplayName: 'Synthetic Academy', organizationId: id(2), organizationDisplayName: 'Synthetic Dojo' }], truncated: true, asOf: T2 }) } })}/>);
  for (const text of [`value="org:${id(2)}"`, `value="school:${id(3)}"`, 'Synthetic Dojo · Whole organization', supportText('en', 'schoolsTruncated'), 'Open case'])
    expect(form).toContain(text);
  const unknown = renderToStaticMarkup(<HqSupportListView {...listProps({ outcome: { kind: 'UNKNOWN' }, canRetry: true, locked: true })}/>);
  expect(unknown).toContain('Try again'); expect(unknown).toMatch(/disabled="">Open a case/);
});

it('renders the case history, forms for an open case and no forms for a closed one', () => {
  const view = validateHqSupportCaseDetail(detailRaw({ case: kase({ version: 2, assignee: lead }), events: [event(),
    event({ seq: 2, kind: 'CHANGED', note: null, actor: lead, statusFrom: 'OPEN', statusTo: 'WAITING_ON_SCHOOL', assigneeChanged: true, assigneeTo: lead })] }));
  const html = renderToStaticMarkup(<HqSupportCaseView {...caseProps({ state: { state: 'READY', view } })}/>);
  for (const text of ['Reported twice.', 'Status Open → Waiting on school', 'Assigned to Synthetic Lead', 'Add note', 'Save changes', 'value="NOBODY"', `value="${agent.principalId}"`])
    expect(html).toContain(text);
  expect(html.indexOf('Changed the case')).toBeLessThan(html.indexOf('Opened the case'));
  const closed = renderToStaticMarkup(<HqSupportCaseView {...caseProps({ state: { state: 'READY', view: validateHqSupportCaseDetail(detailRaw({ case: kase({ status: 'CLOSED', closedAt: T2 }) })) } })}/>);
  expect(closed).toContain(supportText('en', 'closedFinal'));
  expect(closed).not.toContain('data-support-form');
  const hidden = renderToStaticMarkup(<HqSupportCaseView {...caseProps({ concealed: true })}/>);
  expect(hidden).not.toContain('Reported twice.');
  for (const [state, key] of [['GONE', 'gone'], ['INVALID', 'invalid'], ['UNAVAILABLE', 'unavailable']] as const)
    expect(renderToStaticMarkup(<HqSupportCaseView {...caseProps({ state: { state } })}/>)).toContain(supportText('en', key));
  expect(renderToStaticMarkup(<HqSupportCaseView {...caseProps({ outcome: { kind: 'REFUSED', code: 'SUPPORT_ASSIGNEE_NOT_ELIGIBLE' } })}/>)).toContain(supportText('en', 'refusedAssignee'));
});

it('has every phrase in all three languages and registers the pages', () => {
  for (const lang of ['ko', 'es']) expect(supportText(lang, 'intro')).not.toBe(supportText('en', 'intro'));
  expect(HQ_PLANNED['/hq/support']).toBeUndefined();
  expect(hqPageLabel(`/hq/support/${id(1)}`)).toBe('Support case');
  expect(hqPageLabel('/hq/support/nope')).toBe('HQ workspace');
  const manifest = JSON.parse(readFileSync('public/manus-routes.json', 'utf8')) as { routes: { path: string }[] };
  for (const path of ['/hq/support', '/hq/support/:caseId']) expect(manifest.routes.filter(r => r.path === path)).toHaveLength(1);
  expect(readFileSync('src/app/hq/support/page.tsx', 'utf8')).not.toContain('HqPlannedPage');
});
