import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ADMISSION_LIMITS_COMMAND, validateAdmissionStatus } from '@hon/contracts';
import { ADMISSION_LANGUAGES } from '../src/components/hq-admission/copy';
import { AdmissionError, admissionApi, admissionErrorFor, keepForRetry } from '../src/components/hq-admission/http';
import { AdmissionView, limitsRequest, type AdmissionViewProps } from '../src/components/hq-admission/hq-admission';
import { HQ_REVENUE } from '../src/components/hq-modern/catalog';
import { id } from './account-status-fixtures';

beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const owner = id(9), v1 = id(40), v2 = id(41);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const stub = (response: Response) => { const f = vi.fn(async () => response); vi.stubGlobal('fetch', f); return f; };
const signal = () => new AbortController().signal;
const fails = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as AdmissionError; } throw new Error('expected a failure'); };

const limits = (over: Record<string, unknown> = {}) => ({ versionId: v2, version: 2, signupsPerHour: 12, signupsPerDay: 150, trialsPerHour: 8, trialsPerDay: 90,
  reason: 'Tighten limits before opening', recordedBy: 'HQ_OWNER', actorPrincipalId: owner, recordedAt: '2026-11-12T06:00:00.000Z', ...over });
const first = limits({ versionId: v1, version: 1, signupsPerHour: 30, signupsPerDay: 200, trialsPerHour: 30, trialsPerDay: 200, reason: 'Default limits from migration 0273',
  recordedBy: 'MIGRATION_OWNER', actorPrincipalId: null, recordedAt: '2026-11-12T04:00:00.000Z' });
const status = (over: Record<string, unknown> = {}) => ({ limits: limits(), history: [limits(), first], historyHasMore: false,
  usage: { signups: { lastHour: 12, lastDay: 40, perHour: 12, perDay: 150, full: true }, trials: { lastHour: 1, lastDay: 3, perHour: 8, perDay: 90, full: false } },
  refusals: [{ kind: 'SIGNUP', hourStart: '2026-11-12T05:00:00.000Z', count: 4, firstAt: '2026-11-12T05:10:00.000Z', lastAt: '2026-11-12T05:40:00.000Z' }],
  programs: { signup: 'CLOSED', trial: 'CLOSED' }, blockedEmailDomains: 36, asOf: '2026-11-12T06:05:00.000Z', ...over });
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, '\'').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const view = (over: Partial<AdmissionViewProps> = {}) => renderToStaticMarkup(<AdmissionView language="en" concealed={false}
  read={{ state: 'READY', view: validateAdmissionStatus(status()) }} onRefresh={() => {}} {...over}/>);

it('reads the status as a plain same-origin GET with no command headers, and refuses drift', async () => {
  const f = stub(json({ data: status() }));
  const read = await admissionApi.status(signal(), () => true);
  expect(read.usage.signups.full).toBe(true);
  const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe('/api/v1/hq/admission');
  expect(init.method).toBe('GET'); expect(init.credentials).toBe('same-origin'); expect(init.headers).toEqual({ Accept: 'application/json' });
  for (const drift of [status({ extra: 1 }), status({ usage: { ...status().usage, signups: { ...status().usage.signups, full: false } } }),
    status({ history: [first, limits()] }), status({ programs: { signup: 'LIVE', trial: 'CLOSED' } }),
    status({ refusals: [{ kind: 'SIGNUP', hourStart: '2026-11-12T05:30:00.000Z', count: 1, firstAt: '2026-11-12T05:31:00.000Z', lastAt: '2026-11-12T05:32:00.000Z' }] }),
    status({ limits: limits({ recordedBy: 'HQ_OWNER', actorPrincipalId: null }) })]) {
    stub(json({ data: drift }));
    expect((await fails(admissionApi.status(signal(), () => true))).kind).toBe('UNKNOWN');
  }
  stub(json({ code: 'ADMISSION_FORBIDDEN' }, 403));
  expect((await fails(admissionApi.status(signal(), () => true))).kind).toBe('DENIED');
});

it('changes limits with its own command header and key, and accepts only the next version with the same numbers', async () => {
  const body = { expectedVersion: 1, signupsPerHour: 12, signupsPerDay: 150, trialsPerHour: 8, trialsPerDay: 90, reason: 'Tighten limits before opening' };
  const key = id(77), f = stub(json({ data: { limits: limits(), replayed: false } }));
  const receipt = await admissionApi.set(body, key, signal(), () => true);
  expect(receipt.limits.version).toBe(2);
  const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe('/api/v1/hq/admission/limits'); expect(init.method).toBe('POST');
  expect(init.headers).toEqual({ Accept: 'application/json', 'Content-Type': 'application/json', 'X-HON-Human-Command': ADMISSION_LIMITS_COMMAND, 'Idempotency-Key': key });
  expect(JSON.parse(String(init.body))).toEqual(body);
  stub(json({ data: { limits: limits({ signupsPerHour: 13 }), replayed: false } }));
  expect((await fails(admissionApi.set(body, key, signal(), () => true))).kind).toBe('UNKNOWN');
  const sent = stub(json({}));
  expect((await fails(admissionApi.set({ ...body, signupsPerHour: 151 }, key, signal(), () => true))).kind).toBe('INVALID');
  expect(sent).not.toHaveBeenCalled();
  for (const [s, code, kind] of [[403, 'ADMISSION_FORBIDDEN', 'DENIED'], [409, 'ADMISSION_LIMITS_CHANGED', 'CHANGED'], [409, 'IDEMPOTENCY_KEY_REUSED', 'INVALID'],
    [400, 'ADMISSION_INPUT_INVALID', 'INVALID'], [503, 'ADMISSION_OUTCOME_UNKNOWN', 'UNKNOWN'], [409, 'SOMETHING_NEW', 'UNKNOWN']] as const) {
    expect(admissionErrorFor(s, code).kind).toBe(kind);
  }
  expect(keepForRetry(new AdmissionError('UNKNOWN'))).toBe(true);
  for (const kind of ['DENIED', 'CHANGED', 'INVALID', 'SESSION'] as const) expect(keepForRetry(new AdmissionError(kind))).toBe(false);
});

it('builds the change from the form against the version that was read, and refuses bad numbers before sending', () => {
  const read = validateAdmissionStatus(status());
  const fields = { signupsPerHour: ' 20 ', signupsPerDay: '300', trialsPerHour: '10', trialsPerDay: '100', reason: '  More room for the launch week  ' };
  expect(limitsRequest(fields, read)).toEqual({ expectedVersion: 2, signupsPerHour: 20, signupsPerDay: 300, trialsPerHour: 10, trialsPerDay: 100, reason: 'More room for the launch week' });
  for (const bad of [{ signupsPerHour: '0' }, { signupsPerHour: '400' }, { trialsPerHour: '1.5' }, { trialsPerDay: '200000' }, { reason: 'short' }, { signupsPerDay: '' }])
    expect(() => limitsRequest({ ...fields, ...bad }, read)).toThrow(AdmissionError);
});

it('shows usage against each limit, cap hits, the limits in force and their history', () => {
  const page = text(view());
  expect(page).toContain('Sign-up Limits');
  expect(page).toContain('New schools Limit reached: new requests are being turned away now.');
  expect(page).toContain('Last hour 12 of 12');
  expect(page).toContain('Trial starts Below the limit.');
  expect(page).toContain('New school: 4 turned away in the hour from');
  expect(page).toContain('Version 2'); expect(page).toContain('Reason: Tighten limits before opening'); expect(page).toContain('Version 1');
  expect(page).toContain('36 throwaway email domains are refused at sign-up.');
  expect(page).toContain('Self-serve sign-up Closed');
  expect(page).not.toContain('data-admission-form');
  const none = text(view({ read: { state: 'READY', view: validateAdmissionStatus(status({ refusals: [] })) } }));
  expect(none).toContain('No one has been turned away by a limit in the last 7 days.');
});

it('opens the change form with the limits in force, and reports each outcome', () => {
  const form = view({ formOpen: true });
  expect(form).toContain('data-admission-form');
  expect(form).toContain('name="signupsPerHour"'); expect(form).toContain('value="12"'); expect(form).toContain('name="reason"');
  expect(text(view({ outcome: { kind: 'DONE', version: 3, replayed: false } }))).toContain('Saved as version 3.');
  expect(text(view({ outcome: { kind: 'CHANGED' } }))).toContain('Someone changed the limits since this page was read.');
  const kept = view({ outcome: { kind: 'UNKNOWN' }, canRetry: true, locked: true });
  expect(text(kept)).toContain('Try again'); expect(text(kept)).toContain('Stop and read again');
  expect(text(view({ read: { state: 'DENIED' } }))).toContain('does not include sign-up limits');
  expect(text(view({ concealed: true }))).toContain('Hidden while you were away.');
  expect(view({ concealed: true })).not.toContain('Version 2');
});

it('has the same wording keys in English, Korean and Spanish, and shows Korean and Spanish', () => {
  const keys = Object.keys(ADMISSION_LANGUAGES.en).sort();
  expect(Object.keys(ADMISSION_LANGUAGES.ko).sort()).toEqual(keys);
  expect(Object.keys(ADMISSION_LANGUAGES.es).sort()).toEqual(keys);
  expect(text(view({ language: 'ko' }))).toContain('가입 한도');
  expect(text(view({ language: 'es' }))).toContain('Límites de registro');
});

it('is reachable from HQ Revenue and declared in the route manifest', () => {
  expect(HQ_REVENUE.some((entry) => entry.path === '/hq/revenue/sign-up-limits' && entry.title === 'Sign-up Limits')).toBe(true);
  const manifest = JSON.parse(readFileSync('public/manus-routes.json', 'utf8')) as { routes: { path: string }[] };
  expect(manifest.routes.filter((r) => r.path === '/hq/revenue/sign-up-limits')).toHaveLength(1);
});
