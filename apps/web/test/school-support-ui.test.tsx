import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SupportRequest, SupportRequestList } from '@hon/contracts';
import { SUPPORT_LANGUAGES, supportText } from '../src/components/school-support/copy';
import { SupportError, keepForRetry, pageHintFrom, supportApi, supportErrorFor } from '../src/components/school-support/http';
import { EMPTY_DRAFT, SupportView, draftReady, type SupportViewProps } from '../src/components/school-support/view';
import { SCHOOL_SHELL_NAV, schoolShellActiveRoute } from '../src/components/school-shell/catalog';
import { id } from './account-status-fixtures';

beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const org = id(1), school = id(2), key = id(77), rid = id(40), scope = { organizationId: org, schoolId: school };
const meta = { requestId: id(5), correlationId: id(5) };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const stub = (response: Response) => { const f = vi.fn(async () => response); vi.stubGlobal('fetch', f); return f; };
const signal = () => new AbortController().signal;
const fails = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as SupportError; } throw new Error('expected a failure'); };
const request = (over: Partial<SupportRequest> = {}): SupportRequest => ({ requestId: rid, topic: 'GETTING_STARTED', subject: 'How do I add a class?', status: 'OPEN', pageHint: '/staff/welcome',
  openedAt: '2026-11-13T07:00:00.000Z', updatedAt: '2026-11-13T07:05:00.000Z', closedAt: null,
  messages: [{ seq: 1, note: 'We teach on Tuesdays.\nWhere do I start?', at: '2026-11-13T07:00:00.000Z', author: 'Synthetic Owner' }], ...over });
const list = (requests: SupportRequest[] = [request()]): SupportRequestList => ({ requests, limits: { requestsPerDay: 10, messagesPerDay: 30, subjectMax: 200, messageMax: 4000 }, checkedAt: '2026-11-13T07:10:00.000Z' });
const ask = { topic: 'GETTING_STARTED' as const, subject: 'How do I add a class?', message: 'Help', pageHint: null };

it('lists with a plain same-origin GET and sends each command with its own name and key', async () => {
  const f = stub(json({ data: list(), meta }));
  expect((await supportApi.list({ organizationId: org.toUpperCase(), schoolId: school }, signal(), () => true)).requests).toHaveLength(1);
  const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe(`/api/v1/organizations/${org}/schools/${school}/support-requests`);
  expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error' });
  expect(Object.keys(init.headers as object).some(k => /^x-hon|idempotency/i.test(k))).toBe(false);
  const g = stub(json({ data: request(), meta: { ...meta, replayed: false } }));
  await supportApi.submit(scope, ask, key, signal(), () => true);
  expect((g.mock.calls[0] as unknown as [string, RequestInit])[1].headers).toMatchObject({ 'X-HON-Human-Command': 'support.request.submit', 'Idempotency-Key': key });
  expect(JSON.parse((g.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toEqual(ask);
  const h = stub(json({ data: request(), meta }));
  await supportApi.message(scope, rid.toUpperCase(), { message: 'More' }, key, signal(), () => true);
  expect((h.mock.calls[0] as unknown as [string])[0]).toBe(`/api/v1/organizations/${org}/schools/${school}/support-requests/${rid}/messages`);
  expect((h.mock.calls[0] as unknown as [string, RequestInit])[1].headers).toMatchObject({ 'X-HON-Human-Command': 'support.request.message' });
  stub(json({ data: request({ requestId: id(41) }), meta }));
  expect((await fails(supportApi.message(scope, rid, { message: 'More' }, key, signal(), () => true))).kind).toBe('UNKNOWN');
  const none = stub(json({}));
  expect((await fails(supportApi.submit(scope, { ...ask, subject: 'hi' }, key, signal(), () => true))).kind).toBe('INVALID');
  expect((await fails(supportApi.submit(scope, ask, 'nope', signal(), () => true))).kind).toBe('INVALID');
  expect(none).not.toHaveBeenCalled();
});

it('maps refusals, keeps only unknown outcomes for retry, and reads the page hint only from a staff path', () => {
  expect(supportErrorFor(429, 'SUPPORT_RATE_LIMITED').kind).toBe('LIMIT'); expect(supportErrorFor(409, 'SUPPORT_REQUEST_CLOSED').kind).toBe('CLOSED');
  expect(supportErrorFor(404, null).kind).toBe('GONE'); expect(supportErrorFor(409, 'SUPPORT_BUSY').kind).toBe('UNKNOWN'); expect(supportErrorFor(503, null).kind).toBe('UNKNOWN');
  expect(keepForRetry(new SupportError('UNKNOWN'))).toBe(true); expect(keepForRetry(new SupportError('LIMIT'))).toBe(false);
  expect(pageHintFrom('#/staff/welcome')).toBe('/staff/welcome'); expect(pageHintFrom('#https://evil.test')).toBeNull(); expect(pageHintFrom('#/family/x')).toBeNull(); expect(pageHintFrom('')).toBeNull();
  expect(draftReady({ topic: 'IDEA', subject: 'New idea', message: 'x' })).toBe(true);
  expect(draftReady({ topic: null, subject: 'New idea', message: 'x' })).toBe(false); expect(draftReady({ topic: 'IDEA', subject: ' New', message: 'x' })).toBe(false);
});

const base = (over: Partial<SupportViewProps> = {}): SupportViewProps => ({ language: 'en', locale: 'en-US', waiting: false, concealed: false, hasSchool: true, pageHint: null,
  list: { state: 'READY', list: list() }, draft: EMPTY_DRAFT, replyTo: null, replyText: '', outcome: null, locked: false, canRetry: false, ...over });

it('shows nothing from the school while waiting, hidden, with no school, or refused', () => {
  for (const over of [{ waiting: true }, { concealed: true }, { hasSchool: false }, { list: { state: 'DENIED' as const } }, { list: { state: 'UNAVAILABLE' as const } }]) {
    const html = renderToStaticMarkup(<SupportView {...base(over)} />);
    expect(html).not.toContain('data-support-list'); expect(html).not.toContain('Tuesdays');
  }
});

it('shows the ask form, the school\'s requests with status and own messages, and write-back only while not closed', () => {
  let html = renderToStaticMarkup(<SupportView {...base({ pageHint: '/staff/welcome' })} />);
  expect(html).toContain('Bringing over my data'); expect(html).toContain('Asked from /staff/welcome.'); expect(html).toMatch(/<button type="submit"[^>]*disabled/);
  expect(html).toContain('With HON support'); expect(html).toContain('We teach on Tuesdays.'); expect(html).toContain('Write back');
  html = renderToStaticMarkup(<SupportView {...base({ list: { state: 'READY', list: list([request({ status: 'WAITING_ON_SCHOOL' }), request({ requestId: id(42), status: 'CLOSED', closedAt: '2026-11-13T08:00:00.000Z' })]) } })} />);
  expect(html).toContain('HON support needs something from you'); expect(html).toContain('This request is closed');
  expect((html.match(/Write back/g) ?? []).length).toBe(1);
  html = renderToStaticMarkup(<SupportView {...base({ replyTo: rid, replyText: ' padded' })} />);
  expect(html).toContain('Add a message'); expect(html).toContain('Remove spaces at the start or end');
  expect(renderToStaticMarkup(<SupportView {...base({ list: { state: 'READY', list: list([]) } })} />)).toContain('No requests yet.');
});

it('reports outcomes plainly, with Try again only for an unknown outcome', () => {
  expect(renderToStaticMarkup(<SupportView {...base({ outcome: { kind: 'DONE', action: 'submit' } })} />)).toContain('HON support has your question');
  expect(renderToStaticMarkup(<SupportView {...base({ outcome: { kind: 'LIMIT', action: 'submit' } })} />)).toContain('today&#x27;s limit');
  expect(renderToStaticMarkup(<SupportView {...base({ outcome: { kind: 'UNKNOWN', action: 'message' }, canRetry: true, locked: true })} />)).toContain('Try again');
});

it('has every wording in English, Korean and Spanish, a staff route, and conceals on privacy events', () => {
  const keys = Object.keys(SUPPORT_LANGUAGES.en).sort();
  expect(Object.keys(SUPPORT_LANGUAGES.ko).sort()).toEqual(keys); expect(Object.keys(SUPPORT_LANGUAGES.es).sort()).toEqual(keys);
  for (const table of Object.values(SUPPORT_LANGUAGES)) expect(Object.values(table).every(v => v.trim().length > 0)).toBe(true);
  expect(supportText('ko', 'title')).toBe('HON에 도움 요청');
  expect(SCHOOL_SHELL_NAV.flatMap(g => g.routes.map(r => r.href))).toContain('/staff/help');
  expect(schoolShellActiveRoute('/staff/help')?.href).toBe('/staff/help');
  expect(readFileSync('src/app/staff/help/page.tsx', 'utf8')).toContain('await requireVerifiedWebSession()');
  expect(readFileSync('public/manus-routes.json', 'utf8')).toContain('"/staff/help"');
  const controller = readFileSync('src/components/school-support/help.tsx', 'utf8');
  expect(controller).toContain('data-shell-private'); expect(controller).toContain('onShellPrivacyEvent');
});
