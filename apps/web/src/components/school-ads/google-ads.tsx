import React from 'react';
import { GOOGLE_AD_LIMITS, SOCIAL_AD_MAX_DAYS, SOCIAL_AD_RADIUS_MILES, type SocialAccount } from '@hon/contracts';
import styles from '../school-social/social.module.css';
import { adsText, type AdsKey } from './copy';
import { AdRow, BudgetForm, DONE, type MetaAdsProps } from './meta-ads';

/** The Google Search ad form as typed: one headline, description or keyword per line. */
export type GoogleDraftForm = Readonly<{
  accountId: string; headlines: string; descriptions: string; finalUrl: string; keywords: string; amount: string; startsOn: string; endsOn: string;
}>;
export const EMPTY_GOOGLE_DRAFT: GoogleDraftForm = { accountId: '', headlines: '', descriptions: '', finalUrl: '', keywords: '', amount: '', startsOn: '', endsOn: '' };

/** Lines of a text box, trimmed, blank lines dropped. The server checks counts, lengths and duplicates again. */
export const lines = (text: string): string[] => text.split('\n').map(s => s.trim()).filter(Boolean);

export type GoogleAdsProps = Omit<MetaAdsProps, 'draftForm' | 'onDraftForm' | 'onSaveDraft'> & Readonly<{
  /** This school's connected Google Ads accounts with ads on (from the verified connection list). */
  accounts: readonly SocialAccount[];
  /** Whether the Meta card already shows the shared monthly limit form. */
  budgetShownInMeta: boolean;
  form: GoogleDraftForm;
  onForm?: ((next: GoogleDraftForm) => void) | undefined; onSave?: (() => void) | undefined;
}>;

/**
 * Google Search ads on the 0453 API: the same monthly limit, approve (created paused at Google), turn on (spends),
 * pause and settle unknowns as Meta. Every ad reaches people within 5 miles of the school's street address.
 */
export function GoogleAds(p: GoogleAdsProps): React.ReactElement {
  const t = (key: AdsKey) => adsText(p.language, key);
  const a = p.ads;
  if (a.state === 'LOADING') return <p className={styles.meta} role="status">{t('adsLoading')}</p>;
  if (a.state === 'DENIED') return <p className={styles.notice} data-google-run="DENIED">{t('adsDenied')}</p>;
  if (a.state !== 'READY') return <p className={`${styles.notice} ${styles.warn}`} role="alert" data-google-run="UNAVAILABLE">{t('adsUnavailable')}</p>;
  const v = a.view, o = p.outcome, f = p.form, googleAds = v.ads.filter(ad => ad.channel === 'GOOGLE_SEARCH');
  const count = (text: string) => lines(text).length;
  const [hMin, hMax, hLen] = GOOGLE_AD_LIMITS.headlines, [dMin, dMax, dLen] = GOOGLE_AD_LIMITS.descriptions, [kMin, kMax, kLen] = GOOGLE_AD_LIMITS.keywords;
  const fill = (key: AdsKey, values: Record<string, number | string>) => Object.entries(values).reduce((s, [k, x]) => s.replaceAll(`{${k}}`, String(x)), t(key));
  return <div className={styles.actions} data-google-run={v.adsEnabled ? 'ON' : 'OFF'}>
    {!v.adsEnabled && <p className={styles.notice} data-google-off>{t('g_runOff')}</p>}
    {o && o.kind !== 'SENDING' && o.google && <div className={`${styles.notice} ${o.kind === 'DONE' ? '' : styles.warn}`} role={o.kind === 'DONE' ? 'status' : 'alert'} data-google-outcome={o.kind}>
      <p>{o.kind === 'DONE' ? t(DONE[o.action]) : t(`ae_${o.kind}`)}</p>
      {p.canRetry && <button type="button" className={styles.primary} onClick={p.onTryAgain}>{t('tryAgain')}</button>}</div>}
    {p.budgetShownInMeta ? <p className={styles.meta} data-google-cap>{t('g_sameCap')}</p> : <BudgetForm p={p} view={v} t={t} />}
    <div className={styles.form} data-google-draft>
      <h3>{t('g_formTitle')}</h3>
      <p className={styles.meta} data-google-radius>{fill('g_radius', { miles: SOCIAL_AD_RADIUS_MILES })}</p>
      {p.accounts.length > 1 && <label className={styles.field}>{t('g_account')}<select value={f.accountId} disabled={p.locked} onChange={(e) => p.onForm?.({ ...f, accountId: e.target.value })}>
        <option value="">{t('g_chooseAccount')}</option>
        {p.accounts.map(x => <option key={x.accountId} value={x.accountId}>{x.displayName}</option>)}</select></label>}
      <label className={styles.field}>{t('g_headlines')} ({count(f.headlines)})<textarea rows={5} value={f.headlines} disabled={p.locked} data-google-headlines
        onChange={(e) => p.onForm?.({ ...f, headlines: e.target.value })} /></label>
      <p className={styles.meta}>{fill('g_linesHelp', { min: hMin, max: hMax, len: hLen })}</p>
      <label className={styles.field}>{t('g_descriptions')} ({count(f.descriptions)})<textarea rows={3} value={f.descriptions} disabled={p.locked} data-google-descriptions
        onChange={(e) => p.onForm?.({ ...f, descriptions: e.target.value })} /></label>
      <p className={styles.meta}>{fill('g_linesHelp', { min: dMin, max: dMax, len: dLen })}</p>
      <label className={styles.field}>{t('g_finalUrl')}<input type="url" inputMode="url" placeholder="https://" value={f.finalUrl} disabled={p.locked} data-google-url
        onChange={(e) => p.onForm?.({ ...f, finalUrl: e.target.value })} /></label>
      <label className={styles.field}>{t('g_keywords')} ({count(f.keywords)})<textarea rows={4} value={f.keywords} disabled={p.locked} data-google-keywords
        onChange={(e) => p.onForm?.({ ...f, keywords: e.target.value })} /></label>
      <p className={styles.meta}>{fill('g_keywordsHelp', { min: kMin, max: kMax, len: kLen })}</p>
      <div className={styles.grid}>
        <label className={styles.field}>{t('boostBudget')}<input inputMode="decimal" value={f.amount} disabled={p.locked} data-google-amount onChange={(e) => p.onForm?.({ ...f, amount: e.target.value })} /></label>
        <label className={styles.field}>{t('startsOn')}<input type="date" min={v.today} value={f.startsOn} disabled={p.locked} onChange={(e) => p.onForm?.({ ...f, startsOn: e.target.value })} /></label>
        <label className={styles.field}>{t('endsOn')}<input type="date" min={f.startsOn || v.today} value={f.endsOn} disabled={p.locked} onChange={(e) => p.onForm?.({ ...f, endsOn: e.target.value })} /></label>
      </div>
      <p className={styles.meta}>{fill('g_budgetHelp', { days: SOCIAL_AD_MAX_DAYS })}</p>
      <div className={styles.row}><button type="button" className={styles.primary} disabled={p.locked} data-google-save onClick={p.onSave}>{t('saveDraft')}</button></div>
    </div>
    <div data-google-list>
      <h3>{t('g_listTitle')}</h3>
      {googleAds.length === 0 ? <p className={styles.meta}>{t('noAds')}</p> : <ul className={styles.list}>{googleAds.map(ad => <AdRow key={ad.adId} ad={ad} p={p} t={t} />)}</ul>}
    </div>
  </div>;
}
