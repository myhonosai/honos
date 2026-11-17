import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import type { SocialAccount, SocialAccountList } from '@hon/contracts';
import { ADS_LANGUAGES, adsText, ADS_KEYS } from '../src/components/school-ads/copy';
import { AdsView, metaAdsState, type AdsViewProps } from '../src/components/school-ads/view';
import { SCHOOL_SHELL_NAV, schoolShellActiveItem, schoolShellSectionItems } from '../src/components/school-shell/catalog';
import { id } from './account-status-fixtures';

const at = '2026-11-17T00:00:00.000Z';
const account = (over: Partial<SocialAccount> = {}): SocialAccount => ({ accountId: id(40), platform: 'FACEBOOK', displayName: 'Synthetic Dojo Page', status: 'CONNECTED',
  publishEnabled: false, inboxEnabled: false, adsEnabled: false, version: 1, connectedAt: at, updatedAt: at, disconnectedAt: null, ...over });
const list = (over: Partial<SocialAccountList> = {}): SocialAccountList => ({ profileLinked: true, connectEnabled: true, accounts: [account()], checkedAt: at, ...over });
const props = (over: Partial<AdsViewProps> = {}): AdsViewProps => ({ language: 'en', waiting: false, concealed: false, hasSchool: true,
  list: { state: 'READY', list: list() }, connecting: false, outcome: null, ...over });

it('is its own page under the Marketing heading, between Marketing and Creative Studio', () => {
  expect(schoolShellSectionItems('marketing').map(item => item.key)).toEqual(['website', 'marketing', 'ads', 'creative']);
  expect(schoolShellActiveItem('/staff/marketing/ads')?.key).toBe('ads');
  expect(SCHOOL_SHELL_NAV.find(item => item.key === 'ads')?.routes.map(route => route.href)).toEqual(['/staff/marketing/ads']);
});

it('works out the Meta Ads state only from the real connection read', () => {
  expect(metaAdsState(list({ accounts: [] }))).toBe('NOT_CONNECTED');
  expect(metaAdsState(list({ accounts: [account({ platform: 'INSTAGRAM' })] }))).toBe('NOT_CONNECTED');
  expect(metaAdsState(list({ accounts: [account({ status: 'DISCONNECTED', disconnectedAt: at })] }))).toBe('NOT_CONNECTED');
  expect(metaAdsState(list())).toBe('CONNECTED_ADS_OFF');
  expect(metaAdsState(list({ accounts: [account(), account({ accountId: id(41), adsEnabled: true })] }))).toBe('READY_FOR_ADS');
});

it('shows Meta Ads and Google Ads side by side, with a connect button only where connecting is turned on', () => {
  let html = renderToStaticMarkup(<AdsView {...props({ list: { state: 'READY', list: list({ accounts: [] }) } })} />);
  expect(html).toContain('Meta Ads');
  expect(html).toContain('Google Ads');
  expect(html).toContain('data-ads-connect-meta');
  expect(html).toContain('Connect Facebook for Meta Ads');
  html = renderToStaticMarkup(<AdsView {...props({ list: { state: 'READY', list: list({ accounts: [], connectEnabled: false }) } })} />);
  expect(html).not.toContain('data-ads-connect-meta');
  expect(html).toContain('not turned on for HON OS yet');
  // Google Ads has no backend yet: never a button, always an honest status.
  expect(html).not.toContain('data-ads-connect-google');
  expect(html).toContain('data-ads-google="NOT_AVAILABLE"');
});

it('lists each connected Facebook Page with its real ads switch and sends changes to Social accounts', () => {
  const html = renderToStaticMarkup(<AdsView {...props({ list: { state: 'READY', list: list({ accounts: [account(), account({ accountId: id(41), displayName: 'Second Page', adsEnabled: true })] }) } })} />);
  expect(html).toContain('Synthetic Dojo Page');
  expect(html).toContain('Second Page');
  expect(html).toContain('Ads off');
  expect(html).toContain('Ads on');
  expect(html).toContain('href="/staff/marketing/social"');
  expect(html).toContain('data-ads-meta="READY_FOR_ADS"');
  // Running ads is not built on main yet: the page says so instead of offering a fake button.
  expect(html).toContain('every ad starts paused');
  expect(html).not.toMatch(/data-ads-(create|activate|spend)/);
});

it('opens Marcus for AI ad setup and never claims AI runs ads by itself', () => {
  const html = renderToStaticMarkup(<AdsView {...props()} />);
  expect(html).toContain('href="/staff/marketing/assistant"');
  expect(html).toContain('Marcus');
  expect(html).toContain('A person approves');
});

it('hides accounts while waiting, hidden, without a school, loading, denied or unavailable', () => {
  for (const over of [{ waiting: true }, { concealed: true }, { hasSchool: false }, { list: { state: 'LOADING' as const } }, { list: { state: 'DENIED' as const } }, { list: { state: 'UNAVAILABLE' as const } }]) {
    expect(renderToStaticMarkup(<AdsView {...props(over)} />)).not.toContain('Synthetic Dojo Page');
  }
  expect(renderToStaticMarkup(<AdsView {...props({ list: { state: 'DENIED' } })} />)).toContain('role="alert"');
});

it('says a lost connect answer means start again, and never retries it', () => {
  const html = renderToStaticMarkup(<AdsView {...props({ outcome: 'UNKNOWN' })} />);
  expect(html).toContain('Start again');
  expect(html).not.toContain('Try again');
});

it('has every phrase in Korean and Spanish', () => {
  for (const language of ADS_LANGUAGES) for (const key of ADS_KEYS) expect(adsText(language, key), `${language}.${key}`).toBeTruthy();
  expect(renderToStaticMarkup(<AdsView {...props({ language: 'ko' })} />)).toContain('광고');
  expect(renderToStaticMarkup(<AdsView {...props({ language: 'es' })} />)).toContain('Anuncios');
});
