'use client';
import React, { useEffect, useRef, useState } from 'react';
import type { SchoolPlanPromotion } from '@hon/contracts';
import { schoolPromotionText, type SchoolPromotionKey } from './copy';
import { promotionOfferHref, schoolPromotionsApi, type SchoolPromotionsApi } from './http';
import styles from './banner.module.css';

const intervalKey = (p: SchoolPlanPromotion): SchoolPromotionKey =>
  p.offer.billingInterval === 'MONTHLY' ? 'perMonth' : p.offer.billingInterval === 'ANNUAL' ? 'perYear' : 'oneTime';
const price = (locale: string, minor: number) =>
  new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD', minimumFractionDigits: minor % 100 === 0 ? 0 : 2 }).format(minor / 100);
const day = (locale: string, iso: string) =>
  new Intl.DateTimeFormat(locale, { timeZone: 'UTC', dateStyle: 'medium' }).format(new Date(Date.parse(iso) - 1));

/** Presentation only: the promotions the server returned for this school and person, minus the ones dismissed. */
export function PlanPromotionCards({ language, formattingLocale, promotions, onOpen, onDismiss }: { language: string; formattingLocale: string;
  promotions: readonly SchoolPlanPromotion[]; onOpen: (p: SchoolPlanPromotion) => void; onDismiss: (p: SchoolPlanPromotion) => void }): React.ReactElement | null {
  const t = (key: SchoolPromotionKey, vars?: Record<string, string>) => schoolPromotionText(language, key, vars);
  const shown = promotions.filter(p => !p.dismissed);
  if (shown.length === 0) return null;
  return <section className={styles.region} aria-labelledby="hon-plan-promotions-title" data-plan-promotions="">
    <h2 id="hon-plan-promotions-title">{t('region')}</h2>
    {shown.map(p => <article key={p.promotionId} className={styles.card} data-plan-promotion={p.promotionId}>
      <h3>{p.headline}</h3>
      <p>{p.body}</p>
      <p className={styles.meta}>{`${p.offer.displayName} · ${price(formattingLocale, p.offer.priceMinor)} ${t(intervalKey(p))} · ${t('until', { date: day(formattingLocale, p.endsAt) })}`}</p>
      <div className={styles.actions}>
        <a className={styles.open} href={promotionOfferHref(p.offer.offerId)} data-plan-promotion-open="" onClick={() => onOpen(p)}>{p.buttonLabel}</a>
        <button type="button" className={styles.dismiss} aria-label={t('dismissLabel', { headline: p.headline })} onClick={() => onDismiss(p)}>{t('dismiss')}</button>
      </div>
    </article>)}
    <p className={styles.meta}>{t('note')}</p>
  </section>;
}

/**
 * Offers from HON for the verified school. Reads only what the server allows this person to see (billing staff only; anyone
 * else, or any failure, shows nothing). Marks each shown promotion seen once, opened on click and dismissed on "Not now".
 * A failed mark changes nothing on screen except that a dismissed card stays hidden for this visit.
 */
export function PlanPromotionBanner({ schoolId, language, formattingLocale, api = schoolPromotionsApi }: { schoolId: string | null; language: string;
  formattingLocale: string; api?: SchoolPromotionsApi }): React.ReactElement | null {
  const [promotions, setPromotions] = useState<readonly SchoolPlanPromotion[]>([]);
  const seen = useRef(new Set<string>());
  useEffect(() => {
    setPromotions([]); seen.current = new Set();
    if (!schoolId) return;
    const abort = new AbortController();
    api.load(schoolId, abort.signal).then(view => { if (!abort.signal.aborted) setPromotions(view.promotions); }, () => { /* nothing is shown */ });
    return () => abort.abort();
  }, [schoolId, api]);
  useEffect(() => {
    if (!schoolId) return;
    for (const p of promotions) if (!p.dismissed && !seen.current.has(p.promotionId)) {
      seen.current.add(p.promotionId);
      api.record(schoolId, p.promotionId, 'SEEN').catch(() => {});
    }
  }, [promotions, schoolId, api]);
  if (!schoolId) return null;
  return <PlanPromotionCards language={language} formattingLocale={formattingLocale} promotions={promotions}
    onOpen={p => { api.record(schoolId, p.promotionId, 'OPENED').catch(() => {}); }}
    onDismiss={p => { setPromotions(list => list.map(q => q.promotionId === p.promotionId ? { ...q, dismissed: true } : q)); api.record(schoolId, p.promotionId, 'DISMISSED').catch(() => {}); }}/>;
}
