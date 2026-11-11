import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ADD_LEAD_LANGUAGES } from '../src/components/leads/add-lead-copy';
import { addLeadApi, buildLeadInput, normalizePhone, openStageChoices, type PipelineOption } from '../src/components/leads/add-lead-http';
import { AddLeadView, type AddLeadViewProps } from '../src/components/leads/add-lead-view';
import { LeadsError } from '../src/components/leads/http';
import { id, scope } from './account-status-fixtures';

beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers });
const stub = (...responses: Response[]) => { const f = vi.fn(async () => responses.shift() ?? json({}, 500)); vi.stubGlobal('fetch', f); return f; };
const signal = () => new AbortController().signal;
const pipeline = (n = 1, over: Partial<PipelineOption> = {}): PipelineOption => ({ id: id(60 + n), name: 'New students', version: 1, createdAt: '2026-11-11T00:00:00.000Z', stages: [
  { id: id(70 + n), name: 'New lead', position: 1 }, { id: id(80 + n), name: 'Trial booked', position: 2 },
  { id: id(90 + n), name: 'Enrolled', position: 3, terminalStatus: 'WON' }], ...over });
const meta = { requestId: id(5), correlationId: id(5) };

it('reads the verified school’s pipelines at the fixed path and keeps only verified rows', async () => {
  const f = stub(json({ data: [pipeline()], meta }));
  const pipelines = await addLeadApi.pipelines(scope, signal(), () => true);
  expect(pipelines[0]?.stages.map((stage) => stage.name)).toEqual(['New lead', 'Trial booked', 'Enrolled']);
  const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe(`/api/v1/organizations/${scope.organizationId}/schools/${scope.schoolId}/crm/pipelines`);
  expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
  for (const [response, kind] of [[json({ data: [{ ...pipeline(), extra: 1 }], meta }), 'UNAVAILABLE'], [json({ data: [pipeline(1, { id: 'nope' })], meta }), 'UNAVAILABLE'],
    [json({ data: 'x', meta }), 'UNAVAILABLE'], [json({}, 500), 'UNAVAILABLE'], [json({}, 403), 'DENIED'], [json({}, 401), 'SESSION']] as const) {
    stub(response);
    await expect(addLeadApi.pipelines(scope, signal(), () => true)).rejects.toMatchObject({ kind });
  }
});

it('starter setup is one explicit human command with an empty body and the given key', async () => {
  const f = stub(json({ data: pipeline(), meta: { ...meta, created: true, replayed: false } }, 201));
  const key = id(99).replace('-8000-', '-8000-');
  await expect(addLeadApi.setUpStarter(scope, key)).resolves.toMatchObject({ id: id(61) });
  const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe(`/api/v1/organizations/${scope.organizationId}/schools/${scope.schoolId}/crm/pipelines/starter`);
  expect(init).toMatchObject({ method: 'POST', body: '{}', credentials: 'same-origin', mode: 'same-origin', redirect: 'error' });
  expect(init.headers).toMatchObject({ 'Content-Type': 'application/json', 'Idempotency-Key': key, 'X-HON-Human-Command': 'crm-pipeline-starter' });
  stub(json({ code: 'FORBIDDEN' }, 403));
  await expect(addLeadApi.setUpStarter(scope, key)).rejects.toMatchObject({ kind: 'DENIED' });
  stub(json({ data: { ...pipeline(), stages: 'x' }, meta: { ...meta, created: true, replayed: false } }, 201));
  await expect(addLeadApi.setUpStarter(scope, key)).rejects.toMatchObject({ kind: 'UNAVAILABLE' });
  await expect(addLeadApi.setUpStarter(scope, 'not-a-key')).rejects.toThrow();
});

it('offers only open stages; terminal stages are never a choice', () => {
  expect(openStageChoices([pipeline()]).map((c) => c.label)).toEqual(['New lead', 'Trial booked']);
  const two = openStageChoices([pipeline(1), pipeline(2, { name: 'Kids' })]);
  expect(two.map((c) => c.label)).toEqual(['New students · New lead', 'New students · Trial booked', 'Kids · New lead', 'Kids · Trial booked']);
  expect(two[2]).toMatchObject({ pipelineId: id(62), stageId: id(72) });
  expect(openStageChoices([])).toEqual([]);
});

it('turns the typed form into the closed lead-create input, or names the field to fix', () => {
  const choice = openStageChoices([pipeline()])[0]!;
  expect(buildLeadInput({ givenName: ' Riley ', familyName: 'Park', email: '', phone: '' }, choice)).toEqual({ ok: true, input: { pipelineId: id(61), pipelineStageId: id(71), primaryContact: { givenName: 'Riley', familyName: 'Park' } } });
  expect(buildLeadInput({ givenName: 'Riley', familyName: 'Park', email: ' r@example.invalid ', phone: '(555) 555-0100' }, choice))
    .toMatchObject({ ok: true, input: { primaryContact: { email: 'r@example.invalid', phoneE164: '+15555550100' } } });
  expect(buildLeadInput({ givenName: '', familyName: 'Park', email: '', phone: '' }, choice)).toEqual({ ok: false, problem: 'nameMissing' });
  expect(buildLeadInput({ givenName: 'Riley', familyName: 'Park', email: 'nope', phone: '' }, choice)).toEqual({ ok: false, problem: 'emailInvalid' });
  expect(buildLeadInput({ givenName: 'Riley', familyName: 'Park', email: '', phone: '123' }, choice)).toEqual({ ok: false, problem: 'phoneInvalid' });
  expect(buildLeadInput({ givenName: 'Riley', familyName: 'Park', email: '', phone: '' }, null)).toEqual({ ok: false, problem: 'stageMissing' });
  expect(normalizePhone('+44 20 7946 0958')).toBe('+442079460958');
  expect(normalizePhone('1-555-555-0100')).toBe('+15555550100');
  expect(normalizePhone('555 0100')).toBeNull();
});

const props = (over: Partial<AddLeadViewProps> = {}): AddLeadViewProps => ({ language: 'en', pipelines: { state: 'READY', items: [pipeline()] }, setup: { state: 'IDLE' },
  open: true, form: { givenName: '', familyName: '', email: '', phone: '' }, stageId: id(71), save: { state: 'IDLE' }, ...over });
const render = (over: Partial<AddLeadViewProps> = {}) => renderToStaticMarkup(<AddLeadView {...props(over)}/>);

it('a school with no lead stages sees one plain setup step instead of a form', () => {
  const html = render({ pipelines: { state: 'READY', items: [] } });
  expect(html).toContain('Set up lead stages');
  expect(html).toContain('New lead, Trial booked, Enrolled and Not now');
  expect(html).toContain('Add the starter stages');
  expect(html).not.toContain('First name');
  expect(render({ pipelines: { state: 'READY', items: [] }, setup: { state: 'DENIED' } })).toContain('Ask your school owner');
  expect(render({ pipelines: { state: 'READY', items: [] }, setup: { state: 'WORKING' } })).toMatch(/<button[^>]*disabled=""[^>]*>Adding stages…/);
});

it('the add-lead form has labelled name, contact and stage fields with no ID inputs', () => {
  const html = render();
  for (const label of ['First name', 'Last name', 'Email (optional)', 'Mobile phone (optional)', 'Stage']) expect(html).toContain(`>${label}</label>`);
  expect(html).toContain('<option value="' + id(71) + '" selected="">New lead</option>');
  expect(html).not.toContain('Enrolled</option>');
  expect(html).not.toMatch(/pipeline id|stage id/i);
  expect(render({ open: false })).toContain('>Add a lead</button>');
  expect(render({ open: false })).not.toContain('First name');
  expect(render({ save: { state: 'SAVED', name: 'Riley Park' } })).toContain('Riley Park was added.');
  expect(render({ save: { state: 'PROBLEM', problem: 'emailInvalid' } })).toContain('role="alert"');
  expect(render({ save: { state: 'UNCERTAIN' } })).toContain('Try again');
  expect(render({ pipelines: { state: 'DENIED' } })).toBe('');
  expect(render({ pipelines: { state: 'LOADING' } })).toBe('');
});

it('has wording for every key in Korean and Spanish', () => {
  const keys = Object.keys(ADD_LEAD_LANGUAGES.en).sort();
  expect(Object.keys(ADD_LEAD_LANGUAGES.ko).sort()).toEqual(keys);
  expect(Object.keys(ADD_LEAD_LANGUAGES.es).sort()).toEqual(keys);
  expect(render({ language: 'es', pipelines: { state: 'READY', items: [] } })).not.toContain('Set up lead stages');
});

it('review P3: Close stays disabled while a save is uncertain, and reopening keeps the retained state', async () => {
  const { saveAfterOpen } = await import('../src/components/leads/add-lead');
  expect(render({ save: { state: 'UNCERTAIN' } })).toMatch(/<button[^>]*disabled=""[^>]*>Close<\/button>/);
  expect(render({ save: { state: 'IDLE' } })).not.toMatch(/<button[^>]*disabled=""[^>]*>Close<\/button>/);
  expect(saveAfterOpen({ state: 'UNCERTAIN' }, true)).toEqual({ state: 'UNCERTAIN' });
  expect(saveAfterOpen({ state: 'SAVED', name: 'x' }, false)).toEqual({ state: 'IDLE' });
});

it('review P3: a definite starter refusal drops the key; only an unknown outcome keeps it for the same retry', async () => {
  const { starterKeyAfter } = await import('../src/components/leads/add-lead');
  const { StarterRefusedError } = await import('../src/components/leads/add-lead-http');
  stub(json({ code: 'IDEMPOTENCY_KEY_REUSED' }, 409));
  const refused = await addLeadApi.setUpStarter(scope, id(99)).catch((e: unknown) => e);
  expect(refused).toBeInstanceOf(StarterRefusedError);
  expect(starterKeyAfter(refused)).toBe('clear');
  stub(json({}, 400));
  expect(starterKeyAfter(await addLeadApi.setUpStarter(scope, id(99)).catch((e: unknown) => e))).toBe('clear');
  expect(starterKeyAfter(new LeadsError('DENIED'))).toBe('clear');
  expect(starterKeyAfter(new LeadsError('SESSION'))).toBe('clear');
  expect(starterKeyAfter(new LeadsError('UNAVAILABLE'))).toBe('keep');
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('network'); }));
  expect(starterKeyAfter(await addLeadApi.setUpStarter(scope, id(99)).catch((e: unknown) => e))).toBe('keep');
});
