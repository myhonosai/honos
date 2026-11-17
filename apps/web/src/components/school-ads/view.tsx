import React from 'react';
import type { SocialAccountList } from '@hon/contracts';
import type { SocialErrorKind } from '../school-social/http';
import styles from '../school-social/social.module.css';
import { adsText, type AdsKey } from './copy';

export type AdsListState = { state: 'LOADING' | 'DENIED' | 'UNAVAILABLE' } | { state: 'READY'; list: SocialAccountList };
/** Only a failed connect start is shown; a lost answer is never resent (a fresh start is safe: the unused link expires). */
export type AdsOutcome = null | Exclude<SocialErrorKind, 'SESSION' | 'STATE' | 'STALE' | 'GONE'>;
export type MetaAdsState = 'NOT_CONNECTED' | 'CONNECTED_ADS_OFF' | 'READY_FOR_ADS';

export type AdsViewProps = Readonly<{
  language: string; waiting: boolean; concealed: boolean; hasSchool: boolean; list: AdsListState; connecting: boolean; outcome: AdsOutcome;
  onRefresh?: (() => void) | undefined; onConnectMeta?: (() => void) | undefined;
}>;

const facebookPages = (list: SocialAccountList) => list.accounts.filter(a => a.platform === 'FACEBOOK' && a.status === 'CONNECTED');

/** Meta ads run from a connected Facebook Page whose ads switch is on (0347). Read from the server, never assumed. */
export function metaAdsState(list: SocialAccountList): MetaAdsState {
  const pages = facebookPages(list);
  if (pages.length === 0) return 'NOT_CONNECTED';
  return pages.some(a => a.adsEnabled) ? 'READY_FOR_ADS' : 'CONNECTED_ADS_OFF';
}

/** Pure view of Marketing > Ads. Statuses come only from the verified connection list; pieces not built yet say so. */
export function AdsView(p: AdsViewProps): React.ReactElement {
  const t = (key: AdsKey) => adsText(p.language, key);
  const head = <div className={styles.head}><div><h1>{t('title')}</h1><p className={styles.intro}>{t('intro')}</p></div>
    {p.list.state === 'READY' && !p.waiting && !p.concealed && p.hasSchool && <button type="button" className={styles.secondary} disabled={p.connecting} onClick={p.onRefresh}>{t('refresh')}</button>}</div>;
  const ai = <div className={styles.card} data-ads-ai>
    <h2>{t('aiTitle')}</h2><p className={styles.meta}>{t('aiHelp')}</p><p className={styles.meta}>{t('aiNext')}</p>
    <div className={styles.row}><a className={styles.primary} href="/staff/marketing/assistant">{t('openMarcus')}</a>
      <a className={styles.secondary} href="/staff/marketing/campaigns">{t('openCampaigns')}</a></div>
  </div>;
  const google = <div className={styles.card} data-ads-google="NOT_AVAILABLE">
    <div className={styles.cardHead}><h2>{t('googleTitle')}</h2><span className={styles.chip}>{t('googleStatus')}</span></div>
    <p className={styles.meta}>{t('googleHelp')}</p>
  </div>;
  if (p.waiting) return <section className={styles.page}>{head}<p className={styles.meta} role="status">{t('waiting')}</p></section>;
  if (p.concealed) return <section className={styles.page}>{head}<p className={styles.notice}>{t('concealed')}</p></section>;
  if (!p.hasSchool) return <section className={styles.page}>{head}<p className={styles.notice}>{t('noSchool')}</p></section>;
  if (p.list.state !== 'READY') return <section className={styles.page}>{head}
    {p.list.state === 'LOADING' ? <p className={styles.meta} role="status">{t('loading')}</p>
      : <div className={styles.notice} role="alert"><p>{t(p.list.state === 'DENIED' ? 'denied' : 'unavailable')}</p>
        {p.list.state === 'UNAVAILABLE' && <button type="button" className={styles.secondary} onClick={p.onRefresh}>{t('refresh')}</button>}</div>}
    {google}{ai}
  </section>;
  const l = p.list.list, state = metaAdsState(l), pages = facebookPages(l);
  return <section className={styles.page}>
    {head}
    {p.outcome && <div className={`${styles.notice} ${styles.warn}`} role="alert" data-ads-outcome={p.outcome}><p>{t(`e_${p.outcome}`)}</p></div>}
    <div className={styles.card} data-ads-meta={state}>
      <div className={styles.cardHead}><h2>{t('metaTitle')}</h2><span className={styles.chip} data-state={state === 'READY_FOR_ADS' ? 'ACTIVE' : undefined}>{t(`meta_${state}`)}</span></div>
      <p className={styles.meta}>{t('metaHelp')}</p>
      {pages.length > 0 && <ul className={styles.list}>{pages.map(a => <li key={a.accountId} data-ads-page={a.accountId}>
        <strong>{a.displayName}</strong><span className={styles.chip} data-state={a.adsEnabled ? 'ACTIVE' : undefined}>{t(a.adsEnabled ? 'adsOn' : 'adsOff')}</span></li>)}</ul>}
      {state === 'NOT_CONNECTED' && (l.connectEnabled
        ? <><p className={styles.meta}>{t('connectHelp')}</p><div className={styles.row}>
          <button type="button" className={styles.primary} data-ads-connect-meta disabled={p.connecting} onClick={p.onConnectMeta}>{p.connecting ? t('connecting') : t('connectMeta')}</button></div></>
        : <p className={styles.notice}>{t('connectOff')}</p>)}
      {pages.length > 0 && <div className={styles.row}><a className={styles.secondary} href="/staff/marketing/social">{t('changeOnSocial')}</a></div>}
      <p className={styles.meta}>{t('metaNext')}</p>
    </div>
    {google}
    {ai}
  </section>;
}
