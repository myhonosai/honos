import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SIGNUP_PROGRAMS_COMMAND, validateSignupProgramsStatus } from '@hon/contracts';
import { ADMISSION_LANGUAGES } from '../src/components/hq-admission/copy';
import { AdmissionError, programsApi } from '../src/components/hq-admission/http';
import { ProgramsView, SWITCH_REASON, nextTarget, switchRequest, type ProgramsViewProps } from '../src/components/hq-admission/programs';
import { id } from './account-status-fixtures';

beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const owner = id(9), v1 = id(50), v2 = id(51), terms = id(52);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const stub = (response: Response) => { const f = vi.fn(async () => response); vi.stubGlobal('fetch', f); return f; };
const signal = () => new AbortController().signal;
const fails = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as AdmissionError; } throw new Error('expected a failure'); };
const first = { versionId: v1, version: 1, signup: 'CLOSED', trial: 'CLOSED', reason: 'Program state at migration 0710', recordedBy: 'MIGRATION_OWNER', actorPrincipalId: null, recordedAt: '2026-11-28T08:00:00.000Z' };
const opened = { versionId: v2, version: 2, signup: 'OPEN', trial: 'OPEN', reason: SWITCH_REASON.OPEN, recordedBy: 'HQ_OWNER', actorPrincipalId: owner, recordedAt: '2026-11-28T09:00:00.000Z' };
const finalTerms = { termsVersionId: terms, version: 2, status: 'FINAL', title: 'HON OS sign-up and free trial terms', documentDigest: 'a'.repeat(64) };
const closedStatus = { programs: first, history: [first], current: { signup: 'CLOSED', trial: 'CLOSED' }, terms: finalTerms, asOf: '2026-11-28T08:05:00.000Z' };
const openStatus = { programs: opened, history: [opened, first], current: { signup: 'OPEN', trial: 'OPEN' }, terms: finalTerms, asOf: '2026-11-28T09:05:00.000Z' };
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, '\'').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const noop = () => {};
const view = (over: Partial<ProgramsViewProps> = {}) => renderToStaticMarkup(<ProgramsView language="en" read={{ state: 'READY', view: validateSignupProgramsStatus(closedStatus) }}
  confirming={null} outcome={null} locked={false} canRetry={false} onAsk={noop} onConfirm={noop} onCancel={noop} onTryAgain={noop} onStop={noop} {...over}/>);

it('reads the programs with a plain GET and refuses drift or a TEST_MODE change by HQ', async () => {
  const f = stub(json({ data: closedStatus }));
  const read = await programsApi.status(signal(), () => true);
  expect(read.current).toEqual({ signup: 'CLOSED', trial: 'CLOSED' });
  const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe('/api/v1/hq/signup-programs'); expect(init.method).toBe('GET'); expect(init.headers).toEqual({ Accept: 'application/json' });
  for (const drift of [{ ...closedStatus, extra: 1 }, { ...closedStatus, current: { signup: 'LIVE', trial: 'CLOSED' } },
    { ...openStatus, programs: { ...opened, signup: 'TEST_MODE' }, history: [{ ...opened, signup: 'TEST_MODE' }, first] }, { ...closedStatus, history: [] }]) {
    stub(json({ data: drift })); expect((await fails(programsApi.status(signal(), () => true))).kind).toBe('UNKNOWN');
  }
  stub(json({ code: 'ADMISSION_FORBIDDEN' }, 403)); expect((await fails(programsApi.status(signal(), () => true))).kind).toBe('DENIED');
});

it('switches with its own command header and key; only CLOSED or OPEN; the receipt must match exactly', async () => {
  const body = switchRequest('OPEN', validateSignupProgramsStatus(closedStatus));
  expect(body).toEqual({ expectedVersion: 1, signup: 'OPEN', trial: 'OPEN', reason: SWITCH_REASON.OPEN });
  const key = id(60), f = stub(json({ data: { programs: opened, replayed: false } }));
  expect((await programsApi.set(body, key, signal(), () => true)).programs.version).toBe(2);
  const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe('/api/v1/hq/signup-programs'); expect(init.method).toBe('POST');
  expect(init.headers).toMatchObject({ 'X-HON-Human-Command': SIGNUP_PROGRAMS_COMMAND, 'Idempotency-Key': key });
  expect(JSON.parse(String(init.body))).toEqual(body);
  const g = stub(json({ data: { programs: opened, replayed: false } }));
  expect((await fails(programsApi.set({ ...body, signup: 'TEST_MODE' as 'OPEN' }, key, signal(), () => true))).kind).toBe('INVALID'); expect(g).not.toHaveBeenCalled();
  stub(json({ data: { programs: { ...opened, trial: 'CLOSED' }, replayed: false } })); expect((await fails(programsApi.set(body, key, signal(), () => true))).kind).toBe('UNKNOWN');
  stub(json({ code: 'ADMISSION_LIMITS_CHANGED' }, 409)); expect((await fails(programsApi.set(body, key, signal(), () => true))).kind).toBe('CHANGED');
  stub(json({ code: 'ADMISSION_FORBIDDEN' }, 403)); expect((await fails(programsApi.set(body, key, signal(), () => true))).kind).toBe('DENIED');
});

it('shows the state and terms, and asks for a confirmation before opening or closing', () => {
  const closed = text(view());
  expect(closed).toContain('Self-serve sign-up Closed'); expect(closed).toContain('version 2 (final)'); expect(closed).toContain('Publish the trial offer in HQ › Trials first');
  expect(view()).toContain('data-programs-ask="OPEN"'); expect(closed).toContain('Open sign-up and trials'); expect(view()).not.toContain('data-programs-confirm');
  const asking = view({ confirming: 'OPEN' });
  expect(asking).toContain('data-programs-confirm="OPEN"'); expect(text(asking)).toContain('Open sign-up and trials for everyone now?'); expect(text(asking)).toContain('Yes, do it');
  expect(asking).not.toContain('data-programs-ask');
  const open = validateSignupProgramsStatus(openStatus);
  expect(nextTarget(open)).toBe('CLOSED'); expect(view({ read: { state: 'READY', view: open } })).toContain('data-programs-ask="CLOSED"');
  expect(text(view({ read: { state: 'READY', view: open }, confirming: 'CLOSED' }))).toContain('Schools already signed up keep their account and trial');
  expect(nextTarget(validateSignupProgramsStatus({ ...closedStatus, current: { signup: 'OPEN', trial: 'CLOSED' } }))).toBe('OPEN');
  expect(text(view({ outcome: { kind: 'DONE', version: 2, replayed: false, signup: 'OPEN', trial: 'OPEN' } }))).toContain('Sign-up is Open to everyone and trials are Open to everyone (version 2)');
  expect(text(view({ outcome: { kind: 'DENIED' } }))).toContain('Only the HQ owner can open or close sign-up');
  expect(view({ outcome: { kind: 'UNKNOWN' }, canRetry: true })).toContain('Try again');
  expect(text(view({ read: { state: 'DENIED' } }))).toContain('Only the HQ owner');
});

it('has every switch word in Korean and Spanish', () => {
  for (const key of Object.keys(ADMISSION_LANGUAGES.en) as (keyof typeof ADMISSION_LANGUAGES.en)[]) {
    expect(ADMISSION_LANGUAGES.ko[key], key).toBeTruthy(); expect(ADMISSION_LANGUAGES.es[key], key).toBeTruthy();
  }
});
