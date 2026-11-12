'use client';

import React, { useEffect, useState } from 'react';
import { SAAS_FOUNDER_POOL_CAPACITY } from '@hon/contracts';
import { useLocale } from '../localization/provider';
import { FOUNDER_REASON_COPY, HON_OS_PRICE_LABELS, honOsPriceRows } from './catalog';
import { loadHonOsPrices, type HonOsPriceReads, type SchoolAccount } from './http';
import styles from './subscription.module.css';

/**
 * HON OS standard and founder prices, monthly and annual. Read only: it never reserves a founder spot,
 * opens a checkout or changes the school's plan. Server-returned offers replace the launch reference prices.
 */
export function HonOsPrices({ account }: { account: SchoolAccount | null }): React.ReactElement {
  const { t, text, money, number } = useLocale();
  const [reads, setReads] = useState<HonOsPriceReads | null>(null);
  const [failed, setFailed] = useState(false);
  const schoolId = account?.context.schoolId;
  useEffect(() => {
    if (!account) return;
    const abort = new AbortController();
    setReads(null); setFailed(false);
    loadHonOsPrices(account, abort.signal).then(setReads, (error: unknown) => { if (!(error instanceof Error && error.name === 'AbortError')) setFailed(true); });
    return () => abort.abort();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- reload only when the verified school changes
  }, [schoolId]);
  const rows = honOsPriceRows(reads?.offers ?? null, reads?.founder ?? null);
  const pool = reads?.founder?.pool ?? null;
  return <section className={styles.honOsPrices} aria-labelledby="hon-os-prices-title">
    <p className={styles.kicker}>{t("HON OS PRICES")}</p>
    <h2 id="hon-os-prices-title">{t("Monthly or annual. Founder or standard.")}</h2>
    <p className={styles.small} role="status">{!account ? t("Prices shown are the owner-approved launch prices. Your school's offers have not been verified.")
      : failed ? t("HON could not verify your school's offers. Prices shown are the owner-approved launch prices.")
      : !reads ? t("Verifying your school's offers…")
      : pool ? t("Founder spots: {remaining} of {capacity} left. A spot is counted only when the first payment is verified; choosing a plan does not reserve one.", { remaining: number(pool.remaining), capacity: number(SAAS_FOUNDER_POOL_CAPACITY) })
      : t("Founder spot availability could not be verified.")}</p>
    <ul className={styles.honOsPriceList}>
      {rows.map((row) => <li key={row.kind} className={row.founder ? styles.founderPrice : undefined} data-kind={row.kind}>
        <h3>{text(HON_OS_PRICE_LABELS[row.kind])}</h3>
        <div className={styles.price}><strong>{money(row.priceMinor)}</strong><span>{row.annual ? t("/ year") : t("/ month")}</span></div>
        <p className={styles.small}>{row.founder
          ? t("Locked for as long as your school stays subscribed. After a cancellation, or a lapse past the 7-day grace period, a new subscription is {standard}.", { standard: money(row.standardPriceMinor) })
          : row.annual ? t("Billed once a year. Renews at the same price.") : t("Billed monthly. Renews at the same price.")}</p>
        {row.founderSpot && <p className={styles.small}>{row.founderSpot.state === 'AVAILABLE' ? t("A founder spot is available for your organization now.")
          : row.founderSpot.reason ? text(FOUNDER_REASON_COPY[row.founderSpot.reason]) : t("Founder availability has not been verified.")}</p>}
        <p className={styles.small}>USD · {row.source === 'SERVER_OFFER' ? t("Server-returned offer") : t("Owner-approved launch price")}</p>
      </li>)}
    </ul>
    <p className={styles.small}>{t("Checkout for these prices is not open yet. No payment is taken on this page, and a refund never returns a founder spot.")}</p>
  </section>;
}
