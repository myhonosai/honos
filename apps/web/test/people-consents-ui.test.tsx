import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ConsentError, consentApi, consentErrorFor, keepConsentForRetry } from '../src/components/people/consent-http';
import { ConsentCard, consentInput, type ConsentCardProps } from '../src/components/people/consents';
import { PeopleView } from '../src/components/people/view';
import { HON_SESSION_INVALIDATED_EVENT } from '../src/components/session-invalidation';
import { id } from './account-status-fixtures';

beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const org = id(1), school = id(2), person = id(30), key = id(77), scope = { organizationId: org, schoolId: school };
const meta = { requestId: id(5), correlationId: id(5) };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const stub = (response: Response) => { const f = vi.fn(async () => response); vi.stubGlobal('fetch', f); return f; };
const signal = () => new AbortController().signal;
const fails = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as ConsentError; } throw new Error('expected a failure'); };
const row = (over: Record<string, unknown> = {}) => ({ channel: 'EMAIL', status: 'OPTED_IN', source: 'STAFF', capturedAt: '2026-11-01T10:00:00.000Z', version: 2,
  updatedAt: '2026-11-01T10:00:01.000Z', ...over });
const base = `/api/v1/organizations/${org}/schools/${school}/people/${person}/communication-consents`;
const NOW = '2026-11-09T02:40:00.000Z';

it('reads consent as a plain same-origin GET and refuses drifted answers', async () => {
  const f = stub(json({ data: [row(), row({ channel: 'SMS', status: 'OPTED_OUT', source: 'PARENT', version: 1 })], meta }));
  expect(await consentApi.list(scope, person.toUpperCase(), signal(), () => true)).toHaveLength(2);
  const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe(base);
  expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', headers: { Accept: 'application/json' } });
  expect(Object.keys(init.headers as object).some((k) => /^x-hon|idempotency/i.test(k))).toBe(false);
  for (const bad of [{ data: [row(), row()], meta }, { data: [row({ status: 'MAYBE' })], meta }, { data: [row({ address: 'a@b.c' })], meta }, { data: [] }]) {
    stub(json(bad));
    expect((await fails(consentApi.list(scope, person, signal(), () => true))).kind).toBe('UNKNOWN');
  }
  stub(json({ statusCode: 403 }, 403));
  expect((await fails(consentApi.list(scope, person, signal(), () => true))).kind).toBe('DENIED');
});

it('records one choice as a PUT with the consent marker and key, and checks the answer matches what was sent', async () => {
  const input = { status: 'OPTED_OUT', source: 'STAFF', capturedAt: NOW, expectedVersion: 2 } as const;
  const f = stub(json({ data: row({ status: 'OPTED_OUT', capturedAt: NOW, version: 3 }), meta: { ...meta, replayed: false } }));
  const answer = await consentApi.record(scope, person, 'EMAIL', input, key, signal(), () => true);
  expect(answer).toMatchObject({ consent: { status: 'OPTED_OUT', version: 3 }, replayed: false });
  const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe(`${base}/EMAIL`);
  expect(init).toMatchObject({ method: 'PUT', redirect: 'error', headers: { 'X-HON-Human-Command': 'communication.consent.record', 'Idempotency-Key': key, 'Content-Type': 'application/json' } });
  expect(JSON.parse(init.body as string)).toEqual(input);
  // A first record (201) carries no version and must come back as version 1.
  stub(json({ data: row({ channel: 'SMS', status: 'OPTED_IN', capturedAt: NOW, version: 1 }), meta: { ...meta, replayed: true } }, 201));
  expect((await consentApi.record(scope, person, 'SMS', { status: 'OPTED_IN', source: 'STAFF', capturedAt: NOW }, key, signal(), () => true)).replayed).toBe(true);
  for (const wrong of [row({ status: 'OPTED_IN', capturedAt: NOW, version: 3 }), row({ status: 'OPTED_OUT', capturedAt: NOW, version: 4 }), row({ channel: 'SMS', status: 'OPTED_OUT', capturedAt: NOW, version: 3 }),
    row({ status: 'OPTED_OUT', capturedAt: '2026-11-09T02:41:00.000Z', version: 3 }), row({ status: 'OPTED_OUT', source: 'IMPORT', capturedAt: NOW, version: 3 })]) {
    stub(json({ data: wrong, meta: { ...meta, replayed: false } }));
    expect((await fails(consentApi.record(scope, person, 'EMAIL', input, key, signal(), () => true))).kind).toBe('UNKNOWN');
  }
  const g = stub(json({}));
  expect((await fails(consentApi.record(scope, person, 'PUSH' as never, input, key, signal(), () => true))).kind).toBe('INVALID');
  expect((await fails(consentApi.record(scope, person, 'EMAIL', input, 'not-a-key', signal(), () => true))).kind).toBe('INVALID');
  expect((await fails(consentApi.record(scope, person, 'EMAIL', { ...input, capturedAt: '2026-11-09' }, key, signal(), () => true))).kind).toBe('INVALID');
  expect(g).not.toHaveBeenCalled();
});

it('maps refusals, keeps only unknown or in-progress requests, and ends the session only when owned', async () => {
  expect(consentErrorFor(409, 'VERSION_CONFLICT').kind).toBe('CONFLICT');
  expect(consentErrorFor(409, 'VERSION_REQUIRED').kind).toBe('CONFLICT');
  expect(consentErrorFor(409, 'VERSION_NOT_ALLOWED_ON_CREATE').kind).toBe('CONFLICT');
  expect(consentErrorFor(409, 'IDEMPOTENCY_IN_PROGRESS').kind).toBe('BUSY');
  expect(consentErrorFor(409, 'IDEMPOTENCY_KEY_REUSED').kind).toBe('INVALID');
  expect(consentErrorFor(403, 'HUMAN_UI_REQUIRED').kind).toBe('DENIED');
  expect(consentErrorFor(404, null).kind).toBe('MISSING');
  expect(consentErrorFor(503, null).kind).toBe('UNKNOWN');
  expect(consentErrorFor(409, 'SOMETHING_NEW').kind).toBe('UNKNOWN');
  expect(keepConsentForRetry(new ConsentError('UNKNOWN'))).toBe(true); expect(keepConsentForRetry(new ConsentError('BUSY'))).toBe(true);
  for (const k of ['CONFLICT', 'DENIED', 'INVALID', 'MISSING', 'SESSION'] as const) expect(keepConsentForRetry(new ConsentError(k))).toBe(false);
  const seen = vi.fn(); (window as unknown as EventTarget).addEventListener(HON_SESSION_INVALIDATED_EVENT, seen);
  stub(new Response(null, { status: 401 }));
  expect((await fails(consentApi.list(scope, person, signal(), () => false))).kind).toBe('SESSION'); expect(seen).not.toHaveBeenCalled();
  stub(new Response(null, { status: 401 }));
  expect((await fails(consentApi.list(scope, person, signal(), () => true))).kind).toBe('SESSION'); expect(seen).toHaveBeenCalledTimes(1);
});

it('sends the read version when replacing a record and none for a first record; the time is now', () => {
  const now = Date.parse(NOW);
  expect(consentInput([row() as never], { channel: 'EMAIL', status: 'OPTED_OUT' }, now)).toEqual({ status: 'OPTED_OUT', source: 'STAFF', capturedAt: NOW, expectedVersion: 2 });
  expect(consentInput([row() as never], { channel: 'SMS', status: 'OPTED_IN' }, now)).toEqual({ status: 'OPTED_IN', source: 'STAFF', capturedAt: NOW });
});

const card = (over: Partial<ConsentCardProps> = {}) => renderToStaticMarkup(<ConsentCard language="en" name="Sam Lee" canEdit summary={{ EMAIL: 'OPTED_IN', SMS: 'NOT_RECORDED' }}
  read={{ state: 'READY', rows: [row() as never] }} form={null} outcome={null} locked={false} canRetry={false} {...over}/>);

it('offers opt-out for an agreed channel and agreement for the rest, with an attestation required to record agreement', () => {
  const html = card();
  expect(html).toMatch(/data-testid="consent-EMAIL" data-status="OPTED_IN"/); expect(html).toMatch(/data-testid="consent-SMS" data-status="NOT_RECORDED"/);
  expect(html).toContain('Record opt-out'); expect(html).toContain('Record agreement'); expect(html).toContain('by school staff');
  const optIn = card({ form: { channel: 'SMS', status: 'OPTED_IN' } });
  expect(optIn).toContain('Record that Sam Lee agreed to text messages from this school.');
  expect(optIn).toContain(`<input type="checkbox" required="" name="attest"/>`);
  const optOut = card({ form: { channel: 'EMAIL', status: 'OPTED_OUT' } });
  expect(optOut).toContain('Record that Sam Lee no longer wants email'); expect(optOut).not.toContain('type="checkbox"');
  expect(card({ canEdit: false })).not.toContain('Record opt-out');
});

it('falls back to the saved summary, read only, when the consent read is refused', () => {
  const html = card({ read: { state: 'DENIED' } });
  expect(html).toContain('Showing the saved summary only'); expect(html).toMatch(/data-testid="consent-EMAIL" data-status="OPTED_IN"/);
  expect(html).not.toContain('Record opt-out'); expect(html).not.toContain('Record agreement');
  expect(card({ read: { state: 'UNAVAILABLE' }, onReload: () => {} })).toContain('Read again');
});

it('says what an answer means, and offers Try again and Stop only for a kept request', () => {
  expect(card({ outcome: { kind: 'DONE', channel: 'EMAIL', status: 'OPTED_OUT', replayed: true } })).toContain('Opt-out recorded for email. It was already recorded');
  const kept = card({ outcome: { kind: 'UNKNOWN', channel: 'EMAIL', status: 'OPTED_OUT' }, locked: true, canRetry: true, onTryAgain: () => {}, onStop: () => {} });
  expect(kept).toContain('Try again'); expect(kept).toContain('Stop and read again');
  const conflict = card({ outcome: { kind: 'CONFLICT', channel: 'EMAIL', status: 'OPTED_OUT' }, onTryAgain: () => {}, onStop: () => {} });
  expect(conflict).toContain('changed since it was read'); expect(conflict).not.toContain('Try again');
});

it('puts the consent card on the person page in place of the summary list', () => {
  const record = { schoolId: school, personId: person, givenName: 'Sam', familyName: 'Lee', email: 'sam@example.com', phoneE164: null, version: 1, updatedAt: '2026-11-01T10:00:00.000Z',
    student: null, consents: { EMAIL: 'OPTED_IN', SMS: 'NOT_RECORDED' }, canEdit: true } as never;
  const props = { language: 'en', waiting: false, concealed: false, hasSchool: true, list: { state: 'READY', query: '', items: [] }, record: { state: 'READY', record },
    selectedId: person, outcome: null, locked: false, canRetry: false } as unknown as React.ComponentProps<typeof PeopleView>;
  const withSlot = renderToStaticMarkup(<PeopleView {...props} consentSlot={() => <p data-testid="slot">consent card</p>}/>);
  expect(withSlot).toContain('data-testid="slot"'); expect(withSlot).not.toMatch(/<dl[^>]*aria-label="Contact consent"/);
  expect(withSlot).toContain('Use Contact consent below');
  expect(renderToStaticMarkup(<PeopleView {...props}/>)).toMatch(/<dl[^>]*aria-label="Contact consent"/);
});
