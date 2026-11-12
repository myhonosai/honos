import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AddProgramError, AddProgramView, programApi, programErrorFor, programName, programText } from '../src/components/class-series/add-program';
import { ClassSeriesView } from '../src/components/class-series/view';
import { id } from './account-status-fixtures';

// Weak spot 6: a school could only make a program once, in Owner launch. The timetable now adds one through the existing command.
beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const org = id(1), school = id(2), programId = id(31), key = id(77), scope = { organizationId: org, schoolId: school };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const stub = (response: Response) => { const f = vi.fn(async () => response); vi.stubGlobal('fetch', f); return f; };
const signal = () => new AbortController().signal;
const fails = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as AddProgramError; } throw new Error('expected a failure'); };
const receipt = (over: Record<string, unknown> = {}) => ({ data: { id: programId, name: 'Little Dragons', status: 'ACTIVE', version: 1, createdAt: '2026-11-12T03:00:00.000Z', ...over }, meta: { requestId: id(5) } });

it('sends the existing program create command with only the trimmed name, a key and the human-command header', async () => {
  const f = stub(json(receipt(), 201));
  await expect(programApi.create({ organizationId: org.toUpperCase(), schoolId: school }, 'Little Dragons', key, signal(), () => true))
    .resolves.toEqual({ programId, name: 'Little Dragons' });
  const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe(`/api/v1/organizations/${org}/schools/${school}/programs`);
  expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error',
    headers: { 'Idempotency-Key': key, 'X-HON-Human-Command': 'program.create', 'Content-Type': 'application/json' } });
  expect(JSON.parse(init.body as string)).toEqual({ name: 'Little Dragons' });
  stub(json(receipt(), 200));
  await expect(programApi.create(scope, 'Little Dragons', key, signal(), () => true)).resolves.toMatchObject({ programId });
});

it('refuses a bad name or key before sending, and a receipt for another name', async () => {
  const f = stub(json(receipt(), 201));
  expect((await fails(programApi.create(scope, ' Little Dragons ', key, signal(), () => true))).kind).toBe('INVALID');
  expect((await fails(programApi.create(scope, 'x'.repeat(141), key, signal(), () => true))).kind).toBe('INVALID');
  expect((await fails(programApi.create(scope, 'Kids', 'not-a-key', signal(), () => true))).kind).toBe('INVALID');
  expect(f).not.toHaveBeenCalled();
  stub(json(receipt({ name: 'Other' }), 201));
  expect((await fails(programApi.create(scope, 'Little Dragons', key, signal(), () => true))).kind).toBe('UNKNOWN');
  expect(programName('  Kids  ')).toBe('Kids');
  expect(programName('   ')).toBeNull();
});

it('reads refusals: duplicate name, denied, invalid, rate, and anything else is unknown (same key only)', async () => {
  stub(json({ code: 'PROGRAM_NAME_EXISTS', detail: 'x' }, 409));
  expect((await fails(programApi.create(scope, 'Kids', key, signal(), () => true))).kind).toBe('EXISTS');
  stub(json({ message: 'no' }, 403));
  expect((await fails(programApi.create(scope, 'Kids', key, signal(), () => true))).kind).toBe('DENIED');
  stub(json({ code: 'IDEMPOTENCY_IN_PROGRESS' }, 409));
  expect((await fails(programApi.create(scope, 'Kids', key, signal(), () => true))).kind).toBe('UNKNOWN');
  stub(new Response('oops', { status: 502 }));
  expect((await fails(programApi.create(scope, 'Kids', key, signal(), () => true))).kind).toBe('UNKNOWN');
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('network'); }));
  expect((await fails(programApi.create(scope, 'Kids', key, signal(), () => true))).kind).toBe('UNKNOWN');
  expect(programErrorFor(400, null).kind).toBe('INVALID');
  expect(programErrorFor(429, null).kind).toBe('RATE');
  expect(programErrorFor(409, 'IDEMPOTENCY_KEY_REUSED').kind).toBe('INVALID');
});

it('a 401 ends the session only when the request is still the one shown', async () => {
  const seen = vi.fn(); window.addEventListener('hon:session-invalidated', seen);
  stub(new Response(null, { status: 401 }));
  expect((await fails(programApi.create(scope, 'Kids', key, signal(), () => false))).kind).toBe('SESSION');
  expect(seen).not.toHaveBeenCalled();
  stub(new Response(null, { status: 401 }));
  expect((await fails(programApi.create(scope, 'Kids', key, signal(), () => true))).kind).toBe('SESSION');
  expect(seen).toHaveBeenCalledTimes(1);
});

it('shows the button, the form, results and a kept retry in plain words (en/ko/es)', () => {
  const closed = renderToStaticMarkup(<AddProgramView language="en" open={false} status={{ kind: 'IDLE' }} locked={false} canRetry={false}/>);
  expect(closed).toContain('Add a program');
  const form = renderToStaticMarkup(<AddProgramView language="en" open status={{ kind: 'IDLE' }} locked={false} canRetry={false}/>);
  expect(form).toContain('Program name'); expect(form).toContain('maxLength="140"');
  expect(renderToStaticMarkup(<AddProgramView language="en" open={false} status={{ kind: 'DONE', name: 'Kids' }} locked={false} canRetry={false}/>))
    .toContain('&quot;Kids&quot; was added. You can now create a class series for it.');
  const unknown = renderToStaticMarkup(<AddProgramView language="en" open status={{ kind: 'UNKNOWN' }} locked={false} canRetry/>);
  expect(unknown).toContain('Try again'); expect(unknown).toContain('never add the program twice');
  expect(programText('ko', 'open')).toBe('프로그램 추가');
  expect(programText('es', 'EXISTS')).toContain('Ya existe');
});

it('the series card lists the programs and places the add control under them', () => {
  const read = { localToday: '2026-11-09', timezone: 'America/Los_Angeles', fillLimit: '2027-02-01', topUpDue: false, series: [], programs: [{ programId, name: 'Adult Karate' }, { programId: id(32), name: 'Kids' }] };
  const base = { language: 'en', waiting: false, concealed: false, hasSchool: true, week: { state: 'LOADING' as const }, form: null, outcome: null, locked: false, canRetry: false, addProgram: <span>ADD-SLOT</span> };
  const html = renderToStaticMarkup(<ClassSeriesView {...base} series={{ state: 'READY', read }}/>);
  expect(html).toContain('Programs: Adult Karate, Kids'); expect(html).toContain('ADD-SLOT');
  const empty = renderToStaticMarkup(<ClassSeriesView {...base} series={{ state: 'READY', read: { ...read, programs: [] } }}/>);
  expect(empty).toContain('Add a program first'); expect(empty).toContain('ADD-SLOT');
  expect(renderToStaticMarkup(<ClassSeriesView {...base} series={{ state: 'DENIED' }}/>)).not.toContain('ADD-SLOT');
});
