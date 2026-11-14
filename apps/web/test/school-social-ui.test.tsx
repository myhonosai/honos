import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SocialAccount, SocialAccountList } from '@hon/contracts';
import { SOCIAL_LANGUAGES, socialText } from '../src/components/school-social/copy';
import { SocialError, keepForRetry, socialApi, socialErrorFor } from '../src/components/school-social/http';
import { SocialReturnView, SocialView, type SocialViewProps } from '../src/components/school-social/view';
import { SCHOOL_SHELL_NAV, schoolShellActiveRoute } from '../src/components/school-shell/catalog';
import { id } from './account-status-fixtures';

beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const org = id(1), school = id(2), key = id(77), aid = id(40), scope = { organizationId: org, schoolId: school };
const meta = { requestId: id(5), correlationId: id(5) };
const at = '2026-11-14T05:00:00.000Z';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const stub = (response: Response) => { const f = vi.fn(async () => response); vi.stubGlobal('fetch', f); return f; };
const signal = () => new AbortController().signal;
const fails = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as SocialError; } throw new Error('expected a failure'); };
const account = (over: Partial<SocialAccount> = {}): SocialAccount => ({ accountId: aid, platform: 'FACEBOOK', displayName: 'Synthetic Dojo Page', status: 'CONNECTED',
  publishEnabled: false, inboxEnabled: false, adsEnabled: false, version: 1, connectedAt: at, updatedAt: at, disconnectedAt: null, ...over });
const list = (over: Partial<SocialAccountList> = {}): SocialAccountList => ({ profileLinked: true, connectEnabled: true, accounts: [account()], checkedAt: at, ...over });

it('reads with a plain same-origin GET and sends connect, complete and change each with its own command and key', async () => {
  const f = stub(json({ data: list(), meta }));
  expect((await socialApi.list({ organizationId: org.toUpperCase(), schoolId: school }, signal(), () => true)).accounts).toHaveLength(1);
  const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe(`/api/v1/organizations/${org}/schools/${school}/marketing/social/accounts`);
  expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error' });
  expect(Object.keys(init.headers as object).some(k => /^x-hon|idempotency/i.test(k))).toBe(false);
  const g = stub(json({ data: { authUrl: 'https://www.facebook.com/dialog/oauth?x=1', platform: 'FACEBOOK', expiresAt: at }, meta }));
  expect((await socialApi.connect(scope, 'FACEBOOK', key, signal(), () => true)).authUrl).toContain('facebook.com');
  expect((g.mock.calls[0] as unknown as [string, RequestInit])[1].headers).toMatchObject({ 'X-HON-Human-Command': 'marketing.social.connect', 'Idempotency-Key': key });
  expect(JSON.parse((g.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toEqual({ platform: 'FACEBOOK' });
  const state = 'a'.repeat(43);
  const h = stub(json({ data: { platform: 'FACEBOOK', connected: 1, conflicts: 0, accounts: [account()] }, meta }));
  await socialApi.complete(scope, state, key, signal(), () => true);
  expect((h.mock.calls[0] as unknown as [string])[0]).toBe(`/api/v1/organizations/${org}/schools/${school}/marketing/social/connect/complete`);
  expect(JSON.parse((h.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toEqual({ state });
  const c = stub(json({ data: { account: account({ publishEnabled: true, version: 2 }), providerRemoval: 'NOT_ATTEMPTED' }, meta: { ...meta, replayed: false } }));
  await socialApi.change(scope, aid.toUpperCase(), { expectedVersion: 1, publishEnabled: true, inboxEnabled: false, adsEnabled: false }, key, signal(), () => true);
  expect((c.mock.calls[0] as unknown as [string])[0]).toBe(`/api/v1/organizations/${org}/schools/${school}/marketing/social/accounts/${aid}`);
  expect((c.mock.calls[0] as unknown as [string, RequestInit])[1].headers).toMatchObject({ 'X-HON-Human-Command': 'marketing.social.account.change' });
  stub(json({ data: { account: account({ accountId: id(41) }), providerRemoval: 'NOT_ATTEMPTED' }, meta }));
  expect((await fails(socialApi.change(scope, aid, { expectedVersion: 1, disconnect: true }, key, signal(), () => true))).kind).toBe('UNKNOWN');
  stub(json({ data: { authUrl: 'javascript:alert(1)', platform: 'FACEBOOK', expiresAt: at }, meta }));
  expect((await fails(socialApi.connect(scope, 'FACEBOOK', key, signal(), () => true))).kind).toBe('UNKNOWN');
  const none = stub(json({}));
  expect((await fails(socialApi.complete(scope, 'short', key, signal(), () => true))).kind).toBe('INVALID');
  expect((await fails(socialApi.connect(scope, 'TIKTOK' as never, key, signal(), () => true))).kind).toBe('INVALID');
  expect((await fails(socialApi.change(scope, aid, { expectedVersion: 1, disconnect: true }, 'nope', signal(), () => true))).kind).toBe('INVALID');
  expect(none).not.toHaveBeenCalled();
});

it('maps refusals to closed kinds and keeps only unknown outcomes for retry', () => {
  expect(socialErrorFor(403, 'SOCIAL_FORBIDDEN').kind).toBe('DENIED');
  expect(socialErrorFor(503, 'SOCIAL_CONNECT_NOT_ENABLED').kind).toBe('NOT_ENABLED');
  expect(socialErrorFor(503, 'SOCIAL_UNAVAILABLE').kind).toBe('UNKNOWN');
  expect(socialErrorFor(400, 'SOCIAL_CONNECT_STATE_EXPIRED').kind).toBe('STATE');
  expect(socialErrorFor(502, 'SOCIAL_PROVIDER_UNAVAILABLE').kind).toBe('PROVIDER');
  expect(socialErrorFor(409, 'SOCIAL_VERSION_CONFLICT').kind).toBe('STALE');
  expect(socialErrorFor(409, 'SOCIAL_ACCOUNT_DISCONNECTED').kind).toBe('GONE');
  expect(socialErrorFor(409, 'SOCIAL_BUSY').kind).toBe('UNKNOWN');
  expect(socialErrorFor(429, 'SOCIAL_RATE_LIMITED').kind).toBe('LIMIT');
  expect(keepForRetry(new SocialError('UNKNOWN'))).toBe(true);
  for (const k of ['DENIED', 'STALE', 'GONE', 'INVALID', 'LIMIT', 'PROVIDER', 'NOT_ENABLED'] as const) expect(keepForRetry(new SocialError(k))).toBe(false);
});

const props = (over: Partial<SocialViewProps> = {}): SocialViewProps => ({ language: 'en', locale: 'en-US', waiting: false, concealed: false, hasSchool: true, canManage: true,
  list: { state: 'READY', list: list() }, edits: {}, confirming: null, outcome: null, locked: false, canRetry: false, ...over });

it('shows every switch off, says plainly when connecting is not turned on, and only enables Save after a change', () => {
  let html = renderToStaticMarkup(<SocialView {...props()} />);
  expect(html).toContain('Connect Facebook Page'); expect(html).toContain('Connect Instagram account');
  expect((html.match(/type="checkbox"/g) ?? []).length).toBe(3); expect(html).not.toMatch(/checked=""/);
  expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Save switches/);
  html = renderToStaticMarkup(<SocialView {...props({ edits: { [aid]: { publishEnabled: true, inboxEnabled: false, adsEnabled: false } } })} />);
  expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Save switches/);
  html = renderToStaticMarkup(<SocialView {...props({ list: { state: 'READY', list: list({ connectEnabled: false }) } })} />);
  expect(html).toContain('not turned on for HON OS yet'); expect(html).not.toContain('Connect Facebook Page');
  html = renderToStaticMarkup(<SocialView {...props({ list: { state: 'READY', list: list({ accounts: [account({ status: 'DISCONNECTED', disconnectedAt: at, version: 3 })] }) } })} />);
  expect(html).toContain('Disconnected'); expect(html).not.toContain('type="checkbox"'); expect(html).not.toContain('Save switches');
  html = renderToStaticMarkup(<SocialView {...props({ confirming: aid })} />);
  expect(html).toContain('Yes, disconnect');
  html = renderToStaticMarkup(<SocialView {...props({ outcome: { kind: 'DONE', action: 'disconnect', removal: 'NOT_REMOVED' } })} />);
  expect(html).toContain('Remove it in Zernio too');
  html = renderToStaticMarkup(<SocialView {...props({ outcome: { kind: 'UNKNOWN', action: 'change' }, canRetry: true })} />);
  expect(html).toContain('Try again');
  for (const state of ['LOADING', 'DENIED', 'UNAVAILABLE'] as const) expect(renderToStaticMarkup(<SocialView {...props({ list: { state } })} />)).not.toContain('Synthetic Dojo Page');
  expect(renderToStaticMarkup(<SocialView {...props({ concealed: true })} />)).not.toContain('Synthetic Dojo Page');
});

it('return page reports connected and conflicting counts without naming another school\'s account', () => {
  const html = renderToStaticMarkup(<SocialReturnView language="en" waiting={false} state={{ state: 'DONE', result: { platform: 'FACEBOOK', connected: 1, conflicts: 2, accounts: [account()] } }} />);
  expect(html).toContain('Connected 1 account(s).'); expect(html).toContain('2 account(s) belong to another school');
  expect(renderToStaticMarkup(<SocialReturnView language="ko" waiting={false} state={{ state: 'MISSING' }} />)).toContain('소셜 계정에서 다시 시작하세요');
  expect(renderToStaticMarkup(<SocialReturnView language="es" waiting={false} state={{ state: 'FAILED', kind: 'STATE' }} />)).toContain('caducó');
});

it('has every phrase in Korean and Spanish and is listed under Marketing', () => {
  for (const language of ['ko', 'es'] as const) for (const k of Object.keys(SOCIAL_LANGUAGES.en)) {
    const v = SOCIAL_LANGUAGES[language][k as keyof typeof SOCIAL_LANGUAGES.en];
    if (SOCIAL_LANGUAGES.en[k as keyof typeof SOCIAL_LANGUAGES.en] !== '') expect(v, `${language}:${k}`).not.toBe('');
  }
  expect(socialText('ko', 'returnDone', { count: '2' })).toContain('2');
  const marketing = SCHOOL_SHELL_NAV.find(g => g.key === 'marketing');
  expect(marketing?.routes.some(r => r.href === '/staff/marketing/social')).toBe(true);
  expect(schoolShellActiveRoute('/staff/marketing/social/return')?.href).toBe('/staff/marketing/social');
});
