'use client';
import React, { useState } from 'react';
import { SAAS_SCHEDULED_OFFER_KINDS, type SaasHonOsOfferSet, type SaasPriceSchedule } from '@hon/contracts';
import { useLocale } from '../localization/provider';
import { newKey, prepareCheckoutTerms, UpgradeError } from '../plan-upgrade/http';
import base from './hq-modern.module.css';
import styles from './pricing-offers.module.css';

/**
 * Plan builder piece 5 (0707): before a school can subscribe, HQ prepares the exact checkout terms of each published price
 * (the existing 0230 price schedule record, HQ owner only, server checked). It records terms only: nothing is charged and no
 * checkout opens. A published price never changes, so each price needs this once; a second try reports it is already done.
 */
type Row = { status: 'idle' | 'sending' | 'done' | 'already' | 'failed'; key: string; schedule?: SaasPriceSchedule; error?: UpgradeError };
export function PriceTerms({ published, owner }: { published: SaasHonOsOfferSet | null | undefined; owner: boolean }): React.ReactElement | null {
  const { t, money } = useLocale();
  const [rows, setRows] = useState<Record<string, Row>>({});
  if (!published) return null;
  const offers = published.offers.filter(o => (SAAS_SCHEDULED_OFFER_KINDS as readonly string[]).includes(o.offerKind) && !o.salesStop);
  async function prepare(offerId: string) {
    const prev = rows[offerId], key = prev?.status === 'failed' && prev.error?.uncertain ? prev.key : newKey();
    setRows(r => ({ ...r, [offerId]: { status: 'sending', key } }));
    try { const schedule = await prepareCheckoutTerms(offerId, published!.revision, key); setRows(r => ({ ...r, [offerId]: { status: 'done', key, schedule } })); }
    catch (e) {
      const error = e instanceof UpgradeError ? e : new UpgradeError('UNKNOWN', 0, true);
      setRows(r => ({ ...r, [offerId]: { status: error.code === 'SAAS_VERSION_CONFLICT' || error.status === 409 ? 'already' : 'failed', key, error } }));
    }
  }
  const message = (row: Row | undefined) => !row || row.status === 'idle' ? null
    : row.status === 'sending' ? t('Preparing…')
    : row.status === 'done' ? t('Checkout terms ready. Schools can subscribe at this price.')
    : row.status === 'already' ? t('Checkout terms are already prepared for this price.')
    : row.error?.code === 'FORBIDDEN' ? t('Only the HQ owner can prepare checkout terms.')
    : row.error?.code === 'SAAS_PRICE_TERMS_UNSUPPORTED' ? t('HON cannot offer this price at checkout. A founder price must be below the same plan’s regular price.')
    : row.error?.uncertain ? t('HON could not confirm the result. Try again: it repeats the same request.')
    : t('HON could not prepare checkout terms. Refresh and try again.');
  return <section className={base.panel} data-price-terms="">
    <h3>{t('Checkout terms')}</h3>
    <p>{t('Prepare the exact terms schools agree to when they subscribe. This records terms only: nothing is charged and no checkout opens.')}</p>
    {offers.length === 0 ? <p>{t('No published prices can take checkout terms.')}</p>
      : <ul className={styles.facts}>{offers.map(o => { const row = rows[o.offerId]; return <li key={o.offerId} data-price-terms-offer={o.offerKind}>
        <strong>{o.displayName}</strong> · {money(o.priceMinor,'USD')} {o.billingInterval === 'ANNUAL' ? t('/ year') : t('/ month')}{o.founder ? ` · ${t('Founder price')}` : ''}
        {' '}<button type="button" disabled={!owner || row?.status === 'sending' || row?.status === 'done' || row?.status === 'already'} onClick={() => void prepare(o.offerId)}>
          {row?.status === 'failed' && row.error?.uncertain ? t('Try again') : t('Prepare checkout terms')}</button>
        {message(row) && <p role="status">{message(row)}</p>}
        {row?.schedule && <p className={styles.note}>{row.schedule.disclosureText}</p>}
      </li>; })}</ul>}
  </section>;
}
