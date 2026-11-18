'use client';
import React, { useEffect, useRef, useState } from 'react';
import { LANGUAGES, type LocalePreferences } from '@hon/design-system';
import type { HqContactView, SchoolBranding, SchoolOwnerOwnershipView } from '@hon/contracts';
import { useLocale } from '../localization/provider';
import { useSchoolShell } from '../school-shell/context';
import { concealShellPrivateNow, onShellPrivacyEvent } from '../school-shell/privacy';
import { HON_SCHOOL_CONTEXT_CHANGED_EVENT, HON_SESSION_INVALIDATED_EVENT } from '../session-invalidation';
import { SchoolCheckoutError, loadSchoolAccount, type SchoolAccount } from '../school-subscription/http';
import { BrandingError, brandingApi } from '../school-branding/http';
import { OwnershipError, ownershipApi } from '../school-ownership/http';
import { hqContactApi } from '../hq-contact/http';
import { CommsError } from '../hq-communications/http';
import { settingsText, type SettingsKey } from './copy';
import { demoCopy } from '../school-demo-data/copy';
import styles from './summary.module.css';

/**
 * Settings summary (owner, 2026-11-14): one page that shows what is set for this school, each with a Change link to
 * the page that edits it. Read-only: it reuses each page's existing verified GET and never writes.
 */
export type Panel<T> = { state: 'LOADING' | 'DENIED' | 'UNAVAILABLE' } | { state: 'READY'; value: T };
export type PlanSummary = { tier: SchoolAccount['plan']['entitlementTier']; status: NonNullable<SchoolAccount['plan']['subscription']>['status'] | null } | 'OTHER_SCHOOL';
export type SettingsSources = { plan: Panel<PlanSummary>; branding: Panel<SchoolBranding>; owners: Panel<SchoolOwnerOwnershipView>; texts: Panel<HqContactView> };
export const SETTINGS_LOADING: SettingsSources = { plan: { state: 'LOADING' }, branding: { state: 'LOADING' }, owners: { state: 'LOADING' }, texts: { state: 'LOADING' } };
type Scope = Readonly<{ organizationId: string; schoolId: string }>;
export type SettingsApi = { [K in keyof SettingsSources]: (scope: Scope, signal: AbortSignal, owned: () => boolean) => Promise<SettingsSources[K] extends Panel<infer T> ? T : never> };

export const SETTINGS_API: SettingsApi = {
  plan: async (scope, signal) => {
    const account = await loadSchoolAccount(signal);
    // The plan read follows the signed-in person's current school; it is shown only when that is this school.
    if (account.context.schoolId.toLowerCase() !== scope.schoolId.toLowerCase()) return 'OTHER_SCHOOL';
    const sub = account.plan.subscription;
    return { tier: account.plan.entitlementTier, status: sub ? sub.status : null };
  },
  branding: (scope, signal, owned) => brandingApi.read(scope, signal, owned),
  owners: (scope, signal, owned) => ownershipApi.ownerRead(scope.schoolId, signal, owned),
  texts: (_scope, signal, owned) => hqContactApi.read(signal, owned),
};

export function panelFromError(error: unknown): Panel<never> {
  const denied = (error instanceof SchoolCheckoutError && (error.kind === 'DENIED' || error.kind === 'UNAUTHORIZED'))
    || (error instanceof BrandingError && error.kind === 'DENIED') || (error instanceof OwnershipError && error.kind === 'DENIED')
    || (error instanceof CommsError && error.kind === 'DENIED');
  return denied ? { state: 'DENIED' } : { state: 'UNAVAILABLE' };
}

type Line = { text: string; swatch?: string };
function Card({ id, title, href, lines, panel, t, action = 'change' }: {
  id: string; title: string; href: string; lines?: Line[]; panel?: Panel<unknown>; t: (key: SettingsKey) => string; action?: 'change' | 'open' | 'start';
}): React.ReactElement {
  const body = !panel || panel.state === 'READY' ? lines ?? [] : [{ text: t(panel.state === 'LOADING' ? 'loading' : panel.state === 'DENIED' ? 'denied' : 'unavailable') }];
  return <article className={styles.card} data-setting={id} data-state={panel?.state ?? 'READY'}>
    <h2>{title}</h2>
    <ul>{body.map((line, index) => <li key={index}>{line.swatch && <span className={styles.swatch} style={{ background: line.swatch }} aria-hidden="true" />}{line.text}</li>)}</ul>
    <a className={styles.change} href={href}>{t(action)}<span aria-hidden="true"> →</span></a>
  </article>;
}

/** Pure view, so every state renders with static markup. */
export function SettingsSummaryView({ language, preferences, sources }: { language: string; preferences: LocalePreferences; sources: SettingsSources }): React.ReactElement {
  const t = (key: SettingsKey, params?: Record<string, string | number>) => settingsText(language, key, params);
  const plan = sources.plan.state === 'READY' ? sources.plan.value : null;
  const planLines: Line[] = plan === 'OTHER_SCHOOL' ? [{ text: t('planOtherSchool') }]
    : plan ? [{ text: plan.tier ? t(`tier${plan.tier}` as SettingsKey) : t('planNone') }, { text: plan.status ? t(`sub${plan.status}` as SettingsKey) : t('subNone') }] : [];
  const brand = sources.branding.state === 'READY' ? sources.branding.value : null;
  const brandLines: Line[] = brand ? [{ text: brand.logoUrl ? t('logoSet') : t('logoNone') },
    brand.accentColor ? { text: `${t('accent')}: ${brand.accentColor}`, swatch: brand.accentColor } : { text: t('accentNone') },
    { text: brand.contactLine ?? t('contactNone') }] : [];
  const owners = sources.owners.state === 'READY' ? sources.owners.value : null;
  const ownerLines: Line[] = owners ? [{ text: t('ownersCount', { n: owners.owners.length }) },
    { text: owners.primaryOwnerGrantId === owners.yourOwnerGrantId ? t('youPrimary') : t('youOwner') }] : [];
  const contact = sources.texts.state === 'READY' ? sources.texts.value.contact : null;
  const textLines: Line[] = contact ? [{ text: !contact.phone || contact.status === 'REMOVED' ? t('textsNone')
    : contact.status === 'PENDING' ? t('textsPending', { phone: contact.phone }) : contact.textingOn ? t('textsOn', { phone: contact.phone }) : t('textsOff', { phone: contact.phone }) }] : [];
  const languageName = LANGUAGES.find(l => l.code === preferences.language)?.name ?? preferences.language;
  return <main className={styles.page} data-settings-summary="">
    <header><h1>{t('title')}</h1><p>{t('lead')}</p></header>
    <section className={styles.grid} aria-label={t('title')}>
      <Card id="plan" title={t('plan')} href="/staff/subscription" panel={sources.plan} lines={planLines} t={t} />
      <Card id="branding" title={t('branding')} href="/staff/settings/branding" panel={sources.branding} lines={brandLines} t={t} />
      <Card id="owners" title={t('owners')} href="/staff/owners" panel={sources.owners} lines={ownerLines} t={t} />
      <Card id="language" title={t('language')} href="/settings/language-region"
        lines={[{ text: languageName }, { text: `${t('timeZone')}: ${preferences.timeZone}` }, ...(preferences.region === 'auto' ? [{ text: t('regionAuto') }] : [{ text: preferences.region }])]} t={t} />
      <Card id="texts" title={t('texts')} href="/settings/texts-from-hon" panel={sources.texts} lines={textLines} t={t} />
      <Card id="usage" title={t('usage')} href="/staff/account-status" lines={[{ text: t('usageLine') }]} t={t} action="open" />
      <Card id="automation" title={t('automation')} href="/staff/automation/rules" lines={[{ text: t('automationLine') }]} t={t} action="open" />
      <Card id="help" title={t('help')} href="/staff/help" lines={[{ text: t('helpLine') }]} t={t} action="open" />
      <Card id="demo-data" title={demoCopy(language).summaryTitle} href="/staff/settings/demo-data" lines={[{ text: demoCopy(language).summaryLine }]} t={t} action="open" />
      <Card id="tour" title={t('tour')} href="/staff/settings?tour=1" lines={[{ text: t('tourLine') }]} t={t} action="start" />
    </section>
    <p className={styles.setup}><strong>{t('setupTitle')}</strong> {t('setupLine')} <a href="/staff/welcome">{t('setupOpen')}</a></p>
  </main>;
}

/** Loads each summary read for the school the shell verified; a privacy event hides and clears everything at once. */
export function SchoolSettingsSummary({ api = SETTINGS_API }: { api?: SettingsApi }): React.ReactElement {
  const { preferences } = useLocale();
  const shell = useSchoolShell();
  const selection = shell.phase === 'READY' ? shell.selection : null;
  const [sources, setSources] = useState<SettingsSources>(SETTINGS_LOADING);
  const generation = useRef(0);
  useEffect(() => onShellPrivacyEvent(() => { concealShellPrivateNow(); generation.current++; setSources(SETTINGS_LOADING); },
    [HON_SESSION_INVALIDATED_EVENT, HON_SCHOOL_CONTEXT_CHANGED_EVENT]), []);
  useEffect(() => {
    const current = ++generation.current;
    setSources(SETTINGS_LOADING);
    if (!selection) return;
    const abort = new AbortController(), owned = () => current === generation.current && !abort.signal.aborted;
    const scope = { organizationId: selection.organizationId, schoolId: selection.schoolId };
    for (const key of Object.keys(api) as (keyof SettingsSources)[]) {
      (api[key] as SettingsApi['plan'])(scope, abort.signal, owned).then(
        value => { if (owned()) setSources(prior => ({ ...prior, [key]: { state: 'READY', value } })); },
        error => { if (owned()) setSources(prior => ({ ...prior, [key]: panelFromError(error) })); });
    }
    return () => { abort.abort(); };
  }, [selection?.organizationId, selection?.schoolId, api]); // eslint-disable-line react-hooks/exhaustive-deps
  return <div key={shell.phase} data-shell-private="">
    <SettingsSummaryView language={preferences.language} preferences={preferences} sources={sources} />
  </div>;
}
