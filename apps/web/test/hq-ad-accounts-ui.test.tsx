import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { verifyHqAdAccountList, type HqAdAccountList } from '@hon/contracts';
import { AdAccountsView, AdReturnView, adAccountsApi, type AdAccountsViewProps } from '../src/components/hq-marketing/ad-accounts';
import { adText } from '../src/components/hq-marketing/ad-copy';

// 0677 HQ ad account cards: live connection state, owner-only Connect/Disconnect, honest "not turned on" text, and the
// same-origin command shape. Connecting only links an account; every card still says it cannot publish or spend.
const yes = () => true;
beforeEach(() => { vi.stubGlobal('window', Object.assign(new EventTarget(), { location: { origin: 'https://app.example' } })); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const T = '2026-11-24T05:00:00.000Z';
const person = { principalId: id(50), displayName: 'David' };
const account = (patch: Record<string, unknown> = {}) => ({ accountId: id(1), provider: 'GOOGLE_ADS', displayName: 'HON Google Ads', status: 'CONNECTED', version: 1,
  connectedBy: person, connectedAt: T, updatedAt: T, disconnectedAt: null, ...patch });
const listRaw = (patch: Record<string, unknown> = {}) => ({ profileLinked: true, accounts: [account()], viewer: { ...person, canConnect: true }, checkedAt: T, connectEnabled: true, ...patch });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const stub = (...answers: Response[]) => { const f = vi.fn(async () => answers.shift() ?? json({}, 500)); vi.stubGlobal('fetch', f); return f; };
const render = (view: HqAdAccountList | null, patch: Partial<AdAccountsViewProps> = {}) => renderToStaticMarkup(<AdAccountsView language="en" formattingLocale="en-US"
  state={view ? { state: 'READY', view } : { state: 'LOADING' }} busy={false} notice={null} confirming={null}
  onConnect={() => {}} onAskDisconnect={() => {}} onDisconnect={() => {}} {...patch}/>);

it('shows Google Ads connected with its name and Meta not connected; both still cannot publish or spend; owner sees Connect', () => {
  const html = render(verifyHqAdAccountList(listRaw()));
  expect(html).toContain('data-ad-account="GOOGLE_ADS" data-connected="true"');
  expect(html).toContain('data-ad-account="META_ADS" data-connected="false"');
  expect(html).toContain('HON Google Ads');
  expect(html.match(/Cannot publish or spend/g)).toHaveLength(2);
  expect(html.match(/>Connect</g)).toHaveLength(2);
  expect(html).toContain('>Disconnect<');
  expect(html).not.toContain('data-ad-connect-off');
});

it('without the switch: no Connect button and an honest note; a reader sees no buttons and the owner-only note', () => {
  const off = render(verifyHqAdAccountList(listRaw({ connectEnabled: false })));
  expect(off).not.toMatch(/>Connect</);
  expect(off).toContain(adText('en', 'notEnabled'));
  const reader = render(verifyHqAdAccountList(listRaw({ viewer: { ...person, canConnect: false } })));
  expect(reader).not.toMatch(/>Connect<|>Disconnect</);
  expect(reader).toContain(adText('en', 'ownerOnly').replace("'", '&#x27;'));
  const ask = render(verifyHqAdAccountList(listRaw()), { confirming: id(1) });
  expect(ask).toContain('Yes, disconnect HON Google Ads');
  expect(ask).toContain('Nothing at Google or Meta is deleted.');
});

it('every language has every key; Korean and Spanish render', () => {
  expect(render(verifyHqAdAccountList(listRaw()), { language: 'ko' })).toContain('연결됨');
  expect(render(verifyHqAdAccountList(listRaw()), { language: 'es' })).toContain('Conectada');
  expect(renderToStaticMarkup(<AdReturnView language="en" state={{ state: 'DONE', result: { provider: 'META_ADS', connected: 1, conflicts: 1, accounts: [] } }}/>))
    .toContain('1 account(s) belong to a school and were skipped.');
  expect(renderToStaticMarkup(<AdReturnView language="en" state={{ state: 'MISSING' }}/>)).toContain('Start again from Marketing &amp; Creative.');
});

it('commands go same-origin with the exact marker; connect needs an https consent address; disconnect sends only the version', async () => {
  const f = stub(json({ data: { authUrl: 'https://accounts.google.com/o/oauth2/auth?x=1', provider: 'GOOGLE_ADS', expiresAt: T } }));
  const start = await adAccountsApi.connect('GOOGLE_ADS', id(9), new AbortController().signal, yes);
  expect(start.authUrl).toBe('https://accounts.google.com/o/oauth2/auth?x=1');
  const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe('/api/v1/hq/marketing/ad-accounts/connect');
  expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin', mode: 'same-origin', redirect: 'error', body: '{"provider":"GOOGLE_ADS"}' });
  expect((init.headers as Record<string, string>)['X-HON-Human-Command']).toBe('hq-ad-connect');
  stub(json({ data: { authUrl: 'http://evil.example/x', provider: 'GOOGLE_ADS', expiresAt: T } }));
  await expect(adAccountsApi.connect('GOOGLE_ADS', id(9), new AbortController().signal, yes)).rejects.toMatchObject({ kind: 'UNKNOWN' });
  stub(json({ code: 'HQ_AD_CONNECT_NOT_ENABLED' }, 503));
  await expect(adAccountsApi.connect('META_ADS', id(9), new AbortController().signal, yes)).rejects.toMatchObject({ code: 'HQ_AD_CONNECT_NOT_ENABLED' });
  const d = stub(json({ data: { account: account({ status: 'DISCONNECTED', version: 2, disconnectedAt: T }), providerRemoval: 'REMOVED', replayed: false } }));
  const r = await adAccountsApi.disconnect(verifyHqAdAccountList(listRaw()).accounts[0]!, id(9), new AbortController().signal, yes);
  expect(r.account.status).toBe('DISCONNECTED');
  const [dp, di] = d.mock.calls[0] as unknown as [string, RequestInit];
  expect([dp, di.body]).toEqual([`/api/v1/hq/marketing/ad-accounts/${id(1)}/disconnect`, '{"expectedVersion":1}']);
  expect((di.headers as Record<string, string>)['Idempotency-Key']).toBe(id(9));
});
