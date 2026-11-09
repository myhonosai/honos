import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { validateSaasCreativeHqWallet, validateSaasCreativeHqWalletList } from '@hon/contracts';
import { CREDITS_LANGUAGES } from '../src/components/hq-creative-credits/copy';
import { CreditsError, creditsApi } from '../src/components/hq-creative-credits/http';
import { CreditsView, type CreditsViewProps } from '../src/components/hq-creative-credits/view';
import { HQ_AI } from '../src/components/hq-modern/catalog';
import { HON_SESSION_INVALIDATED_EVENT } from '../src/components/session-invalidation';
import { list, school, school2, wallet } from './hq-creative-credits-fixtures';

beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const stub = (response: Response) => { const f = vi.fn(async () => response); vi.stubGlobal('fetch', f); return f; };
const signal = () => new AbortController().signal;
const fails = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as CreditsError; } throw new Error('expected a failure'); };
const view = (over: Partial<CreditsViewProps> = {}) => renderToStaticMarkup(<CreditsView language="en" concealed={false} detail={null}
  wallets={{ state: 'READY', view: validateSaasCreativeHqWalletList(list()) }} onRefresh={() => {}} onOpen={() => {}} onClose={() => {}} {...over}/>);
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, '\'').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const ready = () => ({ state: 'READY' as const, schoolId: school, wallet: validateSaasCreativeHqWallet(wallet()) });

it('reads the wallet list as a plain same-origin GET with no command headers and refuses drift', async () => {
  const f = stub(json({ data: list() }));
  expect((await creditsApi.wallets(signal(), () => true)).wallets).toHaveLength(2);
  const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe('/api/v1/hq/saas/creative-credits');
  expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', headers: { Accept: 'application/json' } });
  expect(Object.keys(init.headers as object).some((k) => /^x-hon|idempotency|content-type/i.test(k))).toBe(false);
  expect(init.body).toBeUndefined();
  // A changed monthly allowance, a duplicated school or an extra key is not trusted.
  stub(json({ data: list({ program: { status: 'ACTIVE', version: 2, monthlyIncludedCredits: 15000 } }) }));
  expect((await fails(creditsApi.wallets(signal(), () => true))).kind).toBe('UNKNOWN');
  stub(json({ data: list({ wallets: [list().wallets[0], list().wallets[0]] }) }));
  expect((await fails(creditsApi.wallets(signal(), () => true))).kind).toBe('UNKNOWN');
  stub(json({ data: list(), extra: 1 }));
  expect((await fails(creditsApi.wallets(signal(), () => true))).kind).toBe('UNKNOWN');
  stub(json({ code: 'SAAS_FORBIDDEN' }, 403));
  expect((await fails(creditsApi.wallets(signal(), () => true))).kind).toBe('DENIED');
  stub(json({ code: 'BUSY' }, 503));
  expect((await fails(creditsApi.wallets(signal(), () => true))).kind).toBe('UNKNOWN');
});

it('reads one school wallet only for the school asked, and a 401 ends the session only for an owned read', async () => {
  const f = stub(json({ data: wallet() }));
  expect((await creditsApi.school(school.toUpperCase(), signal(), () => true)).balance.availableCredits).toBe(440);
  expect((f.mock.calls[0] as unknown as [string])[0]).toBe(`/api/v1/hq/saas/creative-credits/schools/${school}`);
  stub(json({ data: wallet() }));
  expect((await fails(creditsApi.school(school2, signal(), () => true))).kind).toBe('UNKNOWN');
  // Provider cost that does not add up is refused.
  stub(json({ data: wallet({ providerExpense: { ...wallet().providerExpense, finalizedProviderCostMicrounits: 1 } }) }));
  expect((await fails(creditsApi.school(school, signal(), () => true))).kind).toBe('UNKNOWN');
  const bad = stub(json({ data: wallet() }));
  expect((await fails(creditsApi.school('../program', signal(), () => true))).kind).toBe('UNKNOWN');
  expect(bad).not.toHaveBeenCalled();
  const ended = vi.fn(); window.addEventListener(HON_SESSION_INVALIDATED_EVENT, ended);
  stub(new Response('', { status: 401 }));
  expect((await fails(creditsApi.school(school, signal(), () => false))).kind).toBe('SESSION');
  expect(ended).not.toHaveBeenCalled();
  stub(new Response('', { status: 401 }));
  expect((await fails(creditsApi.wallets(signal(), () => true))).kind).toBe('SESSION');
  expect(ended).toHaveBeenCalledTimes(1);
});

it('shows the program, packages, rates and school wallets, with no command anywhere', () => {
  const html = view(), t = text(html);
  expect(t).toContain('Creative Credits');
  expect(t).toContain('This page only reads. Nothing here grants, removes or charges credits, and payment collection is not connected.');
  expect(html).toMatch(/data-testid="credits-program"[^>]*data-state="INACTIVE"/);
  expect(t).toContain('Each eligible paying school receives 12,000 included credits a month.');
  expect(t).toContain('While the program is off, no school can use or receive creative credits.');
  expect(t).toContain('7,200 credits (6,000 + 1,200 bonus) for $60.00');
  expect(t).toContain('No card can be charged: payment collection is not connected.');
  expect(t).toContain('Standard image');
  expect(t).toContain('20 / image');
  expect(t).toContain('Provisional');
  expect(t).toContain('Synthetic Dojo North');
  expect(t).toContain('Organization: Synthetic Martial Arts LLC');
  expect(t).toContain('$0.08');
  expect([...html.matchAll(/data-testid="credits-wallet"[^>]*data-attention="(\w+)"/g)].map((m) => m[1])).toEqual(['true', 'false']);
  // Read only: the only buttons are Refresh and one View wallet per school.
  const buttons = [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((m) => m[1]);
  expect(buttons).toEqual(['Refresh', 'View wallet', 'View wallet']);
  expect(html).toContain('aria-label="View wallet for Synthetic Dojo North"');
  expect(html).not.toMatch(/<form|<input|<textarea|<select/);
});

it('shows one school wallet: balance, provider expense, unknown outcomes, adjustments and pending top-ups', () => {
  const html = view({ detail: ready() }), t = text(html);
  expect(t).toContain('Synthetic Dojo North: wallet');
  expect(t).toContain('Wallet version 3');
  expect(t).toContain('This school cannot use creative credits now: the program is off.');
  expect(t).toContain('Promotional 500 440 20 40 0 0');
  expect(t).toContain('Recorded provider cost $0.08');
  expect(t).toContain('Generations with cost pending 1');
  expect(t).toContain('1 finished · 0 released · 0 in progress · 1 outcome unknown');
  expect(t).toContain('Promotional: 500 credits, granted Nov 5, 2026, 10:00 AM UTC');
  expect(t).toContain('440 available · 20 held · 40 used · 0 expired · 0 removed');
  expect(html).toMatch(/data-testid="credits-reservation" data-status="FINALIZED" data-cost="RECORDED"/);
  expect(html).toMatch(/data-testid="credits-reservation" data-status="OUTCOME_UNKNOWN" data-cost="PENDING"/);
  expect(t).toContain('Charged 40 credits');
  expect(t).toContain('Cost recorded: $0.08');
  expect(t).toContain('Cost pending');
  expect(t).toContain('Provider synthetic-provider, model synthetic-image-1');
  expect(t).toContain('Promotional grant: 500 credits, promotion');
  expect(t).toContain('Note: Synthetic launch promotion');
  expect(t).toContain('Starter for $30.00');
  expect(t).toContain('Waiting for a verified payment');
  expect(t).toContain('Payment collection: not connected');
  const buttons = [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((m) => m[1]);
  expect(buttons).toEqual(['Refresh', 'View wallet', 'View wallet', 'Close']);
  // An unknown provider cost is shown as unknown, never as zero.
  const unknown = wallet({ reservations: [{ ...wallet().reservations[1], status: 'RELEASED', statusReason: 'HQ_RESOLVED_NOT_CHARGED', settledAt: '2026-11-08T10:00:00.000Z', costStatus: 'UNKNOWN' }] });
  expect(text(view({ detail: { state: 'READY', schoolId: school, wallet: validateSaasCreativeHqWallet(unknown) } }))).toContain('Cost unknown (never counted as zero)');
});

it('shows nothing when a read is denied, unavailable or the session ended', () => {
  expect(text(view({ wallets: { state: 'DENIED' } }))).toContain('Your HQ access does not include creative credits. Nothing is shown.');
  expect(text(view({ wallets: { state: 'UNAVAILABLE' } }))).toContain('This could not be read. Nothing is shown.');
  expect(text(view({ detail: { state: 'DENIED', schoolId: school } }))).toContain('Your HQ access does not include this school\'s wallet. Nothing is shown.');
  expect(text(view({ detail: { state: 'UNAVAILABLE', schoolId: school } }))).toContain('This school\'s wallet could not be read. Nothing is shown.');
  const hidden = view({ concealed: true, detail: ready(), onShowAgain: () => {} });
  expect(text(hidden)).toContain('Hidden because your session ended.');
  expect(text(hidden)).not.toContain('Synthetic Dojo');
  expect([...hidden.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((m) => m[1])).toEqual(['Show again']);
  const empty = text(view({ wallets: { state: 'READY', view: validateSaasCreativeHqWalletList(list({ rates: null, wallets: [] })) } }));
  expect(empty).toContain('No generation rates have been published.');
  expect(empty).toContain('No school has a creative credit wallet yet.');
});

it('has every wording key in Korean and Spanish, and is listed under AI', () => {
  const keys = Object.keys(CREDITS_LANGUAGES.en).sort();
  for (const language of ['ko', 'es'] as const) expect(Object.keys(CREDITS_LANGUAGES[language]).sort()).toEqual(keys);
  expect(text(view({ language: 'ko' }))).toContain('크리에이티브 크레딧');
  expect(text(view({ language: 'es' }))).toContain('Créditos creativos');
  expect(HQ_AI.some((entry) => entry.path === '/hq/creative-credits' && entry.title === 'Creative Credits')).toBe(true);
  const manifest = JSON.parse(readFileSync('public/manus-routes.json', 'utf8')) as { routes: { path: string }[] };
  expect(manifest.routes.filter((r) => r.path === '/hq/creative-credits')).toHaveLength(1);
});
