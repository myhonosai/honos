import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SocialAccount, SocialAccountList, SocialAd, SocialAdsView } from '@hon/contracts';
import { adsApi, adsErrorFor, AdsError } from '../src/components/school-ads/http';
import { EMPTY_GOOGLE_DRAFT, GoogleAds, lines, type GoogleAdsProps } from '../src/components/school-ads/google-ads';
import { MetaAds, type MetaAdsProps } from '../src/components/school-ads/meta-ads';
import { AdsView, googleAdsAccounts, googleAdsState, type AdsViewProps } from '../src/components/school-ads/view';
import { adsText } from '../src/components/school-ads/copy';
import { id } from './account-status-fixtures';

beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const org = id(1), school = id(2), key = id(77), scope = { organizationId: org, schoolId: school };
const meta = { requestId: id(5), correlationId: id(5) };
const at = '2026-11-17T05:00:00.000Z';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const stub = (response: Response) => { const f = vi.fn(async () => response); vi.stubGlobal('fetch', f); return f; };
const signal = () => new AbortController().signal;
const content = { headlines: ['Kids karate near you', 'Free trial week', 'Classes for ages 5-12'], descriptions: ['Two free classes, uniform included.', 'Friendly coaches, small classes.'],
  finalUrl: 'https://dojo.example/trial', keywords: ['kids karate', 'martial arts classes'] };
const gAd = (over: Partial<SocialAd> = {}): SocialAd => ({ adId: id(62), channel: 'GOOGLE_SEARCH', accountId: id(45), targetId: null, postId: null, accountName: 'Synthetic Dojo Google Ads',
  budgetCents: 7000, currency: 'USD', startsOn: '2026-11-17', endsOn: '2026-11-23', status: 'DRAFT', operation: null, resolvedByPerson: false, createdAt: at, version: 1, google: content, ...over });
const mAd = (over: Partial<SocialAd> = {}): SocialAd => ({ ...gAd(), adId: id(60), channel: 'META_BOOST', accountId: id(40), targetId: id(50), postId: id(51), accountName: 'Synthetic Dojo Page', google: null, ...over });
const view = (over: Partial<SocialAdsView> = {}): SocialAdsView => ({ budget: { monthlyCapCents: 30000, currency: 'USD', version: 1 }, committedThisMonthCents: 0,
  ads: [gAd(), mAd()], today: '2026-11-17', checkedAt: at, adsEnabled: true, pauseEnabled: true, ...over });
const gAccount = (over: Partial<SocialAccount> = {}): SocialAccount => ({ accountId: id(45), platform: 'GOOGLE_ADS', displayName: 'Synthetic Dojo Google Ads', status: 'CONNECTED',
  publishEnabled: false, inboxEnabled: false, adsEnabled: true, version: 1, connectedAt: at, updatedAt: at, disconnectedAt: null, ...over });
const fbPage = (over: Partial<SocialAccount> = {}): SocialAccount => ({ ...gAccount(), accountId: id(40), platform: 'FACEBOOK', displayName: 'Synthetic Dojo Page', ...over });
const list = (accounts: SocialAccount[], over: Partial<SocialAccountList> = {}): SocialAccountList => ({ profileLinked: true, connectEnabled: true, accounts, checkedAt: at, ...over });
const gProps = (over: Partial<GoogleAdsProps> = {}): GoogleAdsProps => ({ language: 'en', locale: 'en-US',
  ads: { state: 'READY', view: view(), boostable: [] }, budgetForm: { amount: '300.00', currency: 'USD' }, confirming: null, outcome: null, locked: false, canRetry: false,
  accounts: [gAccount()], budgetShownInMeta: false, form: { ...EMPTY_GOOGLE_DRAFT, accountId: id(45), startsOn: '2026-11-17', endsOn: '2026-11-17' }, ...over });
const render = (over: Partial<GoogleAdsProps> = {}) => renderToStaticMarkup(<GoogleAds {...gProps(over)} />);

it('saves a Google draft with its own command and key, and refuses an answer that is not that Google ad', async () => {
  const input = { accountId: id(45), budgetCents: 7000, startsOn: '2026-11-17', endsOn: '2026-11-23', ...content };
  const f = stub(json({ data: gAd(), meta }));
  expect((await adsApi.googleDraft(scope, input, key, signal(), () => true)).channel).toBe('GOOGLE_SEARCH');
  const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe(`/api/v1/organizations/${org}/schools/${school}/marketing/social/ads/google`);
  expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin', mode: 'same-origin', redirect: 'error' });
  expect(init.headers).toMatchObject({ 'X-HON-Human-Command': 'marketing.social.ads.google.create', 'Idempotency-Key': key });
  expect(JSON.parse(init.body as string)).toEqual(input);
  // A Meta ad, or a Google ad on another account, is not an answer to this request: it becomes an unknown, never a success.
  for (const wrong of [mAd(), gAd({ accountId: id(46) })]) {
    stub(json({ data: wrong, meta }));
    expect(((await adsApi.googleDraft(scope, input, key, signal(), () => true).catch((e: unknown) => e)) as AdsError).kind).toBe('UNKNOWN');
  }
  // Too few headlines never leaves the browser.
  const g = stub(json({ data: gAd(), meta }));
  await expect(adsApi.googleDraft(scope, { ...input, headlines: ['One', 'Two'] }, key, signal(), () => true)).rejects.toMatchObject({ kind: 'INVALID' });
  expect(g).not.toHaveBeenCalled();
  expect(adsErrorFor(409, 'SOCIAL_ACCOUNT_DISCONNECTED').kind).toBe('ADS_OFF');
});

it('splits each box into trimmed lines with blank lines dropped', () => {
  expect(lines('  Kids karate \n\n Free trial week\n  \n')).toEqual(['Kids karate', 'Free trial week']);
  expect(lines('')).toEqual([]);
});

it('works out the Google Ads state only from connected Google Ads accounts and their ads switch', () => {
  expect(googleAdsState(list([]))).toBe('NOT_CONNECTED');
  expect(googleAdsState(list([fbPage()]))).toBe('NOT_CONNECTED');
  expect(googleAdsState(list([gAccount({ status: 'DISCONNECTED', disconnectedAt: at })]))).toBe('NOT_CONNECTED');
  expect(googleAdsState(list([gAccount({ adsEnabled: false })]))).toBe('CONNECTED_ADS_OFF');
  expect(googleAdsState(list([gAccount({ adsEnabled: false }), gAccount({ accountId: id(46) })]))).toBe('READY_FOR_ADS');
  expect(googleAdsAccounts(list([fbPage(), gAccount()])).map(a => a.accountId)).toEqual([id(45)]);
});

const page = (over: Partial<AdsViewProps> = {}) => renderToStaticMarkup(<AdsView language="en" waiting={false} concealed={false} hasSchool connecting={false} outcome={null}
  list={{ state: 'READY', list: list([gAccount()]) }} {...over} />);
const googleRun = (): NonNullable<AdsViewProps['google']> => { const { accounts: _a, budgetShownInMeta: _b, language: _l, locale: _c, ...rest } = gProps(); return rest; };

it('the Ads page shows the Google form only once a Google Ads account has ads on', () => {
  let html = page({ list: { state: 'READY', list: list([gAccount({ adsEnabled: false })]) }, google: googleRun() });
  expect(html).toContain('data-ads-google="CONNECTED_ADS_OFF"');
  expect(html).toContain('Synthetic Dojo Google Ads');
  expect(html).toContain('Change on Social accounts');
  expect(html).not.toContain('data-google-draft');
  expect(html).not.toContain('data-ads-connect-google');
  html = page({ google: googleRun() });
  expect(html).toContain('data-ads-google="READY_FOR_ADS"');
  expect(html).toContain('data-google-draft');
  // No Facebook Page: the shared monthly limit form is shown in the Google card instead.
  expect(html).toContain('data-ads-save-budget');
  expect(html).not.toContain('data-google-cap');
  html = page({ list: { state: 'READY', list: list([fbPage(), gAccount()]) }, google: googleRun(), run: { ...googleRun(), draftForm: { targetId: '', amount: '', startsOn: '2026-11-17', endsOn: '2026-11-17' } } as AdsViewProps['run'] });
  expect(html.match(/data-ads-save-budget/g)).toHaveLength(1);
  expect(html).toContain('data-google-cap');
});

it('the Google form says 5 miles from the school, counts each box, and lists only Google ads', () => {
  const html = render({ form: { ...gProps().form, headlines: 'One\nTwo\n\nThree', descriptions: 'A', keywords: 'kids karate' } });
  expect(html).toContain('within 5 miles of your school');
  expect(html).toContain('Headlines, one per line (3)');
  expect(html).toContain('Descriptions, one per line (1)');
  expect(html).toContain('Keywords, one per line (1)');
  expect(html).toContain('Write 3 to 15 lines, each up to 30 characters');
  expect(html).toContain('Write 2 to 4 lines, each up to 90 characters');
  expect(html).toContain('nothing is sent to Google');
  expect(html).toContain(`data-ad="${id(62)}"`);
  expect(html).not.toContain(`data-ad="${id(60)}"`);
  // One account with ads on: no account picker.
  expect(html).not.toContain('Choose an account');
  expect(render({ accounts: [gAccount(), gAccount({ accountId: id(46), displayName: 'Second Google Ads' })] })).toContain('Second Google Ads');
});

it('Google ads use Google wording for turning on and for unknowns, never Meta wording', () => {
  let html = render({ ads: { state: 'READY', view: view({ ads: [gAd({ status: 'PAUSED', version: 3 })] }), boostable: [] }, confirming: id(62) });
  const listOnly = (h: string) => h.slice(h.indexOf('data-google-list'));
  expect(listOnly(html)).toContain('Google starts spending');
  expect(listOnly(html)).not.toContain('Meta');
  html = render({ ads: { state: 'READY', view: view({ ads: [gAd({ status: 'UNKNOWN', operation: 'CREATE' })] }), boostable: [] } });
  expect(html).toContain('Check Google Ads');
  expect(html).not.toContain('Meta Ads Manager');
  html = render({ ads: { state: 'READY', view: view({ ads: [gAd({ status: 'CREATING', operation: 'CREATE' })] }), boostable: [] } });
  expect(html).toContain('Creating at Google');
});

it('shows each outcome only in the card it belongs to', () => {
  const done = { kind: 'DONE', action: 'googleDraft', google: true } as const;
  expect(render({ outcome: done })).toContain('create the ad at Google, paused');
  const metaProps = { ...gProps(), draftForm: { targetId: '', amount: '', startsOn: '2026-11-17', endsOn: '2026-11-17' } } as unknown as MetaAdsProps;
  expect(renderToStaticMarkup(<MetaAds {...metaProps} outcome={done} />)).not.toContain('data-ads-outcome');
  expect(render({ outcome: { kind: 'DONE', action: 'draft', google: false } })).not.toContain('data-google-outcome');
  expect(render({ outcome: { kind: 'NO_ADDRESS', action: 'CREATE', google: true } })).toContain('Settings &gt; Location');
});

it('while ads are off at HON OS the Google card says so, and every write is disabled while one is sending', () => {
  expect(render({ ads: { state: 'READY', view: view({ adsEnabled: false }), boostable: [] } })).toContain('data-google-off');
  const html = render({ locked: true });
  expect(html).toMatch(/data-google-save[^>]*disabled|disabled[^>]*data-google-save/);
  expect(html).toMatch(/<textarea[^>]*disabled/);
});

it('hides Google ads from people without ad permission and says when they could not be read', () => {
  expect(render({ ads: { state: 'DENIED' } })).toContain('data-google-run="DENIED"');
  expect(render({ ads: { state: 'UNAVAILABLE' } })).toContain('data-google-run="UNAVAILABLE"');
  expect(render({ ads: { state: 'DENIED' } })).not.toContain('data-google-draft');
});

it('has every new Google phrase in Korean and Spanish, with the same placeholders', () => {
  for (const k of ['g_radius', 'g_linesHelp', 'g_keywordsHelp', 'g_budgetHelp'] as const) {
    const holes = (s: string) => (s.match(/\{[a-z]+\}/g) ?? []).sort();
    for (const lang of ['ko', 'es']) expect(holes(adsText(lang, k)), `${lang} ${k}`).toEqual(holes(adsText('en', k)));
  }
});
