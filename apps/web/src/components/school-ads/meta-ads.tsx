import React from 'react';
import { SOCIAL_AD_MAX_DAYS, type SocialAd, type SocialAdsView, type SocialPostList } from '@hon/contracts';
import styles from '../school-social/social.module.css';
import { adsText, type AdsKey } from './copy';
import type { AdsErrorKind } from './http';

/** A Facebook post HON published that can be boosted (its PUBLISHED target). */
export type Boostable = Readonly<{ targetId: string; pageName: string; excerpt: string }>;
export type AdsReadState = { state: 'LOADING' | 'DENIED' | 'UNAVAILABLE' } | { state: 'READY'; view: SocialAdsView; boostable: readonly Boostable[] };
export type AdsAction = 'budget' | 'draft' | 'CREATE' | 'ACTIVATE' | 'PAUSE' | 'cancel' | 'resolve';
export type AdsActionOutcome = null | Readonly<{ kind: 'SENDING' | 'DONE' | Exclude<AdsErrorKind, 'SESSION'>; action: AdsAction }>;
export type BudgetForm = Readonly<{ amount: string; currency: string }>;
export type DraftForm = Readonly<{ targetId: string; amount: string; startsOn: string; endsOn: string }>;

export type MetaAdsProps = Readonly<{
  language: string; locale: string; ads: AdsReadState; budgetForm: BudgetForm; draftForm: DraftForm; confirming: string | null;
  outcome: AdsActionOutcome; locked: boolean; canRetry: boolean;
  onBudgetForm?: ((next: BudgetForm) => void) | undefined; onSaveBudget?: (() => void) | undefined;
  onDraftForm?: ((next: DraftForm) => void) | undefined; onSaveDraft?: (() => void) | undefined;
  onOperation?: ((ad: SocialAd, operation: 'CREATE' | 'ACTIVATE' | 'PAUSE') => void) | undefined;
  onCancel?: ((ad: SocialAd) => void) | undefined; onResolve?: ((ad: SocialAd, state: 'NOT_CREATED' | 'ACTIVE' | 'PAUSED') => void) | undefined;
  onConfirm?: ((adId: string | null) => void) | undefined; onTryAgain?: (() => void) | undefined;
}>;

/** Published Facebook targets, newest post first, at most 50. */
export function boostableFrom(list: SocialPostList): Boostable[] {
  const out: Boostable[] = [];
  for (const post of [...list.posts].sort((a, b) => b.createdAt.localeCompare(a.createdAt))) for (const t of post.targets) {
    if (t.platform === 'FACEBOOK' && t.status === 'PUBLISHED' && out.length < 50) out.push({ targetId: t.targetId, pageName: t.displayName, excerpt: post.text.length > 80 ? `${post.text.slice(0, 79)}…` : post.text });
  }
  return out;
}

export function money(locale: string, cents: number, currency: string): string {
  try { return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(cents / 100); } catch { return `${(cents / 100).toFixed(2)} ${currency}`; }
}
const DONE: Record<AdsAction, AdsKey> = { budget: 'done_budget', draft: 'done_draft', CREATE: 'done_CREATE', ACTIVATE: 'done_ACTIVATE', PAUSE: 'done_PAUSE', cancel: 'done_cancel', resolve: 'done_resolve' };

function AdRow({ ad, p, t }: { ad: SocialAd; p: MetaAdsProps; t: (k: AdsKey) => string }): React.ReactElement {
  // Pausing only lowers spend, so it needs only pauseEnabled (true whenever a Zernio key exists), not the ads switch.
  const on = p.ads.state === 'READY' && p.ads.view.adsEnabled, canPause = p.ads.state === 'READY' && p.ads.view.pauseEnabled, busy = p.locked;
  const op = (operation: 'CREATE' | 'ACTIVATE' | 'PAUSE', label: AdsKey, primary = false) =>
    <button type="button" className={primary ? styles.primary : styles.secondary} disabled={busy || !(operation === 'PAUSE' ? canPause : on)} data-ads-op={operation} onClick={() => p.onOperation?.(ad, operation)}>{t(label)}</button>;
  let actions: React.ReactNode = null;
  if (ad.status === 'DRAFT') actions = <>{op('CREATE', 'approve', true)}
    <button type="button" className={styles.secondary} disabled={busy} data-ads-cancel onClick={() => p.onCancel?.(ad)}>{t('cancelDraft')}</button></>;
  else if (ad.status === 'PAUSED') actions = p.confirming === ad.adId
    ? <><p className={styles.warnText}>{t('confirmActivate')}</p>{op('ACTIVATE', 'yesActivate', true)}
      <button type="button" className={styles.secondary} disabled={busy} onClick={() => p.onConfirm?.(null)}>{t('cancel')}</button></>
    : <button type="button" className={styles.primary} disabled={busy || !on} data-ads-op="ACTIVATE-ASK" onClick={() => p.onConfirm?.(ad.adId)}>{t('activate')}</button>;
  else if (ad.status === 'ACTIVE') actions = op('PAUSE', 'pause', true);
  else if (ad.status === 'UNKNOWN') actions = <><p className={styles.warnText}>{t(ad.operation === 'CREATE' ? 'unknownCreate' : 'unknownOther')}</p>
    {ad.operation === 'CREATE'
      ? <button type="button" className={styles.secondary} disabled={busy} data-ads-resolve="NOT_CREATED" onClick={() => p.onResolve?.(ad, 'NOT_CREATED')}>{t('resolveNotCreated')}</button>
      : <>{op('PAUSE', 'pause', true)}
        <button type="button" className={styles.secondary} disabled={busy} data-ads-resolve="ACTIVE" onClick={() => p.onResolve?.(ad, 'ACTIVE')}>{t('resolveActive')}</button>
        <button type="button" className={styles.secondary} disabled={busy} data-ads-resolve="PAUSED" onClick={() => p.onResolve?.(ad, 'PAUSED')}>{t('resolvePaused')}</button></>}</>;
  return <li data-ad={ad.adId} data-ad-status={ad.status}>
    <strong>{ad.accountName}</strong>
    <div className={styles.row}><span className={styles.chip} data-state={ad.status === 'ACTIVE' ? 'ACTIVE' : ad.status === 'CANCELLED' || ad.status === 'FAILED' ? 'CANCELLED' : undefined}>{t(`ad_${ad.status}`)}</span>
      <span className={styles.meta}>{money(p.locale, ad.budgetCents, ad.currency)} · {ad.startsOn} → {ad.endsOn}</span></div>
    {actions && <div className={styles.row}>{actions}</div>}
  </li>;
}

/** Meta ads on the 0437 API: the monthly limit, boost drafts, approve (created paused), turn on (spends), pause, settle unknowns. */
export function MetaAds(p: MetaAdsProps): React.ReactElement {
  const t = (key: AdsKey) => adsText(p.language, key);
  const a = p.ads;
  if (a.state === 'LOADING') return <p className={styles.meta} role="status">{t('adsLoading')}</p>;
  if (a.state === 'DENIED') return <p className={styles.notice} data-ads-run="DENIED">{t('adsDenied')}</p>;
  if (a.state !== 'READY') return <p className={`${styles.notice} ${styles.warn}`} role="alert" data-ads-run="UNAVAILABLE">{t('adsUnavailable')}</p>;
  const v = a.view, o = p.outcome, cap = v.budget, boostable = a.boostable;
  return <div className={styles.actions} data-ads-run={v.adsEnabled ? 'ON' : 'OFF'}>
    {!v.adsEnabled && <p className={styles.notice} data-ads-off>{t('runOff')}</p>}
    {o && o.kind !== 'SENDING' && <div className={`${styles.notice} ${o.kind === 'DONE' ? '' : styles.warn}`} role={o.kind === 'DONE' ? 'status' : 'alert'} data-ads-outcome={o.kind}>
      <p>{o.kind === 'DONE' ? t(DONE[o.action]) : t(`ae_${o.kind}`)}</p>
      {p.canRetry && <button type="button" className={styles.primary} onClick={p.onTryAgain}>{t('tryAgain')}</button>}</div>}
    <div className={styles.form} data-ads-budget>
      <h3>{t('capTitle')}</h3>
      <p className={styles.meta}>{cap && cap.monthlyCapCents > 0 ? `${t('capNow')} ${money(p.locale, cap.monthlyCapCents, cap.currency)} · ${t('committed')} ${money(p.locale, v.committedThisMonthCents, cap.currency)}` : t('capNone')}</p>
      <div className={styles.grid}>
        <label className={styles.field}>{t('capAmount')}<input inputMode="decimal" value={p.budgetForm.amount} disabled={p.locked} onChange={(e) => p.onBudgetForm?.({ ...p.budgetForm, amount: e.target.value })} /></label>
        <label className={styles.field}>{t('currency')}<input maxLength={3} value={p.budgetForm.currency} disabled={p.locked} onChange={(e) => p.onBudgetForm?.({ ...p.budgetForm, currency: e.target.value.toUpperCase() })} /></label>
      </div>
      <p className={styles.meta}>{t('capHelp')}</p>
      <div className={styles.row}><button type="button" className={styles.primary} disabled={p.locked} data-ads-save-budget onClick={p.onSaveBudget}>{t('saveCap')}</button></div>
    </div>
    <div className={styles.form} data-ads-draft>
      <h3>{t('boostTitle')}</h3>
      {boostable.length === 0 ? <p className={styles.meta}>{t('noBoostable')}</p> : <>
        <label className={styles.field}>{t('boostPost')}<select value={p.draftForm.targetId} disabled={p.locked} onChange={(e) => p.onDraftForm?.({ ...p.draftForm, targetId: e.target.value })}>
          <option value="">{t('choosePost')}</option>
          {boostable.map(b => <option key={b.targetId} value={b.targetId}>{b.pageName}: {b.excerpt}</option>)}</select></label>
        <div className={styles.grid}>
          <label className={styles.field}>{t('boostBudget')}<input inputMode="decimal" value={p.draftForm.amount} disabled={p.locked} onChange={(e) => p.onDraftForm?.({ ...p.draftForm, amount: e.target.value })} /></label>
          <label className={styles.field}>{t('startsOn')}<input type="date" min={v.today} value={p.draftForm.startsOn} disabled={p.locked} onChange={(e) => p.onDraftForm?.({ ...p.draftForm, startsOn: e.target.value })} /></label>
          <label className={styles.field}>{t('endsOn')}<input type="date" min={p.draftForm.startsOn || v.today} value={p.draftForm.endsOn} disabled={p.locked} onChange={(e) => p.onDraftForm?.({ ...p.draftForm, endsOn: e.target.value })} /></label>
        </div>
        <p className={styles.meta}>{t('boostHelp').replace('{days}', String(SOCIAL_AD_MAX_DAYS))}</p>
        <div className={styles.row}><button type="button" className={styles.primary} disabled={p.locked || !p.draftForm.targetId} data-ads-save-draft onClick={p.onSaveDraft}>{t('saveDraft')}</button></div>
      </>}
    </div>
    <div data-ads-list>
      <h3>{t('adsTitle')}</h3>
      {v.ads.length === 0 ? <p className={styles.meta}>{t('noAds')}</p> : <ul className={styles.list}>{v.ads.map(ad => <AdRow key={ad.adId} ad={ad} p={p} t={t} />)}</ul>}
    </div>
  </div>;
}
