import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DEFAULT_LOCALE } from '@hon/design-system';
import { SETTINGS_LOADING, SettingsSummaryView, panelFromError, type SettingsSources } from '../src/components/school-settings/summary';
import { settingsText } from '../src/components/school-settings/copy';
import { SchoolCheckoutError } from '../src/components/school-subscription/http';
import { BrandingError } from '../src/components/school-branding/http';
import { SetupCardView } from '../src/components/school-onboarding/setup-card';

const ready = <T,>(value: T) => ({ state: 'READY' as const, value });
const owner = (n: number, primary: boolean) => ({ ownerGrantId: `00000000-0000-4000-8000-00000000000${n}`, displayName: `Owner ${n}`, email: `o${n}@example.test`, since: '2026-11-01T00:00:00.000Z', primary, viaInvitation: false });
const sources: SettingsSources = {
  plan: ready({ tier: 'COMPLETE', status: 'IN_SERVICE' }),
  branding: ready({ logoUrl: 'https://cdn.example.test/logo.png', coverUrl: null, accentColor: '#2f7bff', contactLine: 'Call us any time', version: 3, updatedAt: '2026-11-10T00:00:00.000Z' }),
  owners: ready({ schoolId: '00000000-0000-4000-8000-000000000002', owners: [owner(1, true), owner(2, false)], yourOwnerGrantId: '00000000-0000-4000-8000-000000000001',
    primaryOwnerGrantId: '00000000-0000-4000-8000-000000000001', notices: [], asOf: '2026-11-15T00:00:00.000Z' }),
  texts: ready({ contact: { status: 'CONFIRMED', phone: '+15555550100', codeExpiresAt: null, codeExpired: false, wrongCodes: 0, codesLeftToday: 5, confirmedAt: '2026-11-01T00:00:00.000Z',
    textingOn: true, stoppedByReply: false, version: 2, hqNumber: null }, asOf: '2026-11-15T00:00:00.000Z' }),
} as SettingsSources;
const view = (s: SettingsSources, language = 'en') => renderToStaticMarkup(<SettingsSummaryView language={language} preferences={{ ...DEFAULT_LOCALE, language: language as 'en' }} sources={s} />);
const card = (html: string, id: string) => html.match(new RegExp(`data-setting="${id}"[^>]*>(.*?)</article>`, 's'))?.[1] ?? '';

describe('settings summary', () => {
  it('shows what is set for each area with one Change or Open link to the page that edits it', () => {
    const html = view(sources);
    expect(card(html, 'plan')).toContain('Complete'); expect(card(html, 'plan')).toContain('Active'); expect(card(html, 'plan')).toContain('href="/staff/subscription"');
    expect(card(html, 'branding')).toContain('Logo added'); expect(card(html, 'branding')).toContain('Accent color: #2f7bff'); expect(card(html, 'branding')).toContain('Call us any time');
    expect(card(html, 'owners')).toContain('2 owner(s)'); expect(card(html, 'owners')).toContain('You are the primary owner');
    expect(card(html, 'language')).toContain('English'); expect(card(html, 'language')).toContain('Time zone: UTC'); expect(card(html, 'language')).toContain('href="/settings/language-region"');
    expect(card(html, 'texts')).toContain('Texts on to +15555550100');
    for (const id of ['usage', 'automation', 'help']) expect(card(html, id)).toContain('>Open<');
    expect(card(html, 'tour')).toContain('href="/staff/settings?tour=1"'); expect(card(html, 'tour')).toContain('>Start<');
    for (const id of ['plan', 'branding', 'owners', 'language', 'texts']) expect(card(html, id)).toContain('>Change<');
    // Setup lives in onboarding: one link to it, not three Settings tabs.
    expect(html).toContain('href="/staff/welcome"'); expect(html).not.toContain('href="/staff/launch"'); expect(html).not.toContain('href="/staff/founder-setup"');
  });

  it('never invents a value while loading, refused or unavailable', () => {
    const html = view({ ...SETTINGS_LOADING, owners: { state: 'DENIED' }, texts: { state: 'UNAVAILABLE' } });
    expect(card(html, 'plan')).toContain('Reading…'); expect(card(html, 'plan')).not.toContain('Complete');
    expect(card(html, 'owners')).toContain('Your role does not include this.'); expect(card(html, 'texts')).toContain('Could not be read right now.');
    expect(view({ ...sources, plan: ready('OTHER_SCHOOL') })).toContain("Open the subscription page to see this school&#x27;s plan.");
    expect(view({ ...sources, plan: ready({ tier: null, status: null }) })).toMatch(/No HON plan yet.*No subscription yet/s);
    expect(panelFromError(new SchoolCheckoutError('DENIED', 'x'))).toEqual({ state: 'DENIED' });
    expect(panelFromError(new BrandingError('DENIED'))).toEqual({ state: 'DENIED' });
    expect(panelFromError(new BrandingError('UNKNOWN'))).toEqual({ state: 'UNAVAILABLE' });
    expect(panelFromError(new Error('network'))).toEqual({ state: 'UNAVAILABLE' });
  });

  it('is translated', () => {
    expect(view(sources, 'ko')).toContain('설정'); expect(view(sources, 'es')).toContain('Ajustes');
    expect(settingsText('ko', 'ownersCount', { n: 2 })).toBe('소유자 2명');
  });

  it('Home shows a setup card only while required setup steps remain', () => {
    const html = renderToStaticMarkup(<SetupCardView language="en" done={3} total={7} />);
    expect(html).toContain('3 of 7 setup steps done.'); expect(html).toContain('href="/staff/welcome"');
    expect(renderToStaticMarkup(<SetupCardView language="en" done={7} total={7} />)).toBe('');
    expect(renderToStaticMarkup(<SetupCardView language="es" done={1} total={2} />)).toContain('Continuar la configuración');
  });
});
