'use client';

import React, { useEffect, useState } from 'react';
import type { SaasHonOsSchoolOffer, SaasPriceAcceptancePreview, SaasScheduleBinding, SaasSchoolPriceSchedules } from '@hon/contracts';
import { useLocale } from '../localization/provider';
import { newKey, previewTerms, readSchoolPriceSchedules, subscribe, UpgradeError, type SubscribeKeys } from '../plan-upgrade/http';
import type { SchoolAccount } from './http';
import styles from './subscription.module.css';

/**
 * Plan builder piece 5 (owner 2026-11-28: "limited but opens up when they opt in to regular subscription"). The Upgrade
 * button lands here. The school owner picks a HON OS price, reads the exact terms HQ prepared, agrees, and HON records the
 * subscription and starts the test-mode schedule. Locks lift only after the server verifies the first payment; this page
 * never grants access. While payments are not connected (payment program not in test mode) nothing is sent at all, so no
 * agreement is recorded that a later real subscription would trip over.
 */
type Phase = { kind: 'idle' } | { kind: 'loading' } | { kind: 'review'; preview: SaasPriceAcceptancePreview }
  | { kind: 'sending'; preview: SaasPriceAcceptancePreview } | { kind: 'done'; binding: SaasScheduleBinding }
  | { kind: 'failed'; preview: SaasPriceAcceptancePreview | null; error: UpgradeError };
const KIND_ORDER = ['REGULAR_MONTHLY', 'REGULAR_ANNUAL', 'FOUNDER_MONTHLY', 'FOUNDER_ANNUAL'] as const;

export function SubscribeToPlan({ account, offers }: { account: SchoolAccount | null; offers: readonly SaasHonOsSchoolOffer[] | null }): React.ReactElement {
  const { t, money } = useLocale();
  const schoolId = account?.context.schoolId ?? null;
  const open = account?.plan.payments.status === 'TEST_MODE';
  const [schedules, setSchedules] = useState<SaasSchoolPriceSchedules | null>(null);
  const [readFailed, setReadFailed] = useState(false);
  const [chosen, setChosen] = useState<string | null>(null);
  const [agreed, setAgreed] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [keys, setKeys] = useState<Record<string, SubscribeKeys>>({});

  useEffect(() => {
    setSchedules(null); setReadFailed(false); setPhase({ kind: 'idle' });
    if (!schoolId || !open) return;
    let live = true;
    readSchoolPriceSchedules(schoolId).then(s => { if (live) setSchedules(s); }, () => { if (live) setReadFailed(true); });
    return () => { live = false; };
  }, [schoolId, open]);

  const scheduleOf = (offerId: string) => schedules?.schedules.find(s => s.offerId.toLowerCase() === offerId.toLowerCase()) ?? null;
  const choices = (offers ?? []).filter(o => (KIND_ORDER as readonly string[]).includes(o.offerKind) && scheduleOf(o.offerId))
    .sort((a, b) => KIND_ORDER.indexOf(a.offerKind as typeof KIND_ORDER[number]) - KIND_ORDER.indexOf(b.offerKind as typeof KIND_ORDER[number]));
  const selected = choices.find(o => o.offerId === chosen) ?? choices.find(o => o.offerKind === 'REGULAR_MONTHLY') ?? choices[0] ?? null;
  const busy = phase.kind === 'loading' || phase.kind === 'sending';

  async function review() {
    if (!schoolId || !selected) return;
    const schedule = scheduleOf(selected.offerId); if (!schedule) return;
    setAgreed(false); setPhase({ kind: 'loading' });
    try { setPhase({ kind: 'review', preview: await previewTerms(schoolId, schedule.scheduleId) }); }
    catch (e) { setPhase({ kind: 'failed', preview: null, error: e instanceof UpgradeError ? e : new UpgradeError('UNAVAILABLE') }); }
  }
  async function confirm(preview: SaasPriceAcceptancePreview) {
    if (!schoolId) return;
    const id = preview.schedule.scheduleId;
    const k = keys[id] ?? { accept: newKey(), generation: newKey(), binding: newKey() };
    setKeys(prev => ({ ...prev, [id]: k })); setPhase({ kind: 'sending', preview });
    try { setPhase({ kind: 'done', binding: await subscribe(schoolId, preview, k) }); }
    catch (e) { setPhase({ kind: 'failed', preview, error: e instanceof UpgradeError ? e : new UpgradeError('UNKNOWN', 0, true) }); }
  }

  const priceLine = (o: SaasHonOsSchoolOffer) => `${money(o.priceMinor)} ${o.billingInterval === 'ANNUAL' ? t('/ year') : t('/ month')}`;
  const failure = (e: UpgradeError) => e.code === 'SAAS_SCHEDULE_PROVIDER_UNAVAILABLE' || e.code === 'SAAS_SCHEDULE_BINDING_RECONCILIATION_REQUIRED' || e.status === 503
    ? t('Subscribing is not available yet: payments are not connected. Nothing was charged.')
    : e.code === 'FORBIDDEN' ? t('Only someone allowed to buy for this school can subscribe.')
    : e.code === 'SAAS_PRICE_ACCEPTANCE_BLOCKED' || e.code === 'SAAS_OFFER_NOT_AVAILABLE' ? t('This price is no longer available. Refresh the page to see current prices.')
    : e.uncertain ? t('HON could not confirm the result. Try again: it repeats the same request and never subscribes twice.')
    : t('HON could not load this step. Nothing was charged. Try again in a moment.');

  return <section id="subscribe" className={styles.honOsPrices} aria-labelledby="subscribe-title" data-plan-subscribe="">
    <p className={styles.kicker}>{t('SUBSCRIBE')}</p>
    <h2 id="subscribe-title">{t('Subscribe to HON OS')}</h2>
    <p className={styles.small}>{t('Subscribing unlocks every feature your plan includes, once your first payment is verified.')}</p>
    {!account ? <p className={styles.small} role="status">{t('Verifying your school…')}</p>
      : !open ? <p className={styles.small} role="status" data-subscribe-unavailable="">{t('Subscribing is not available yet: payments are not connected. Nothing is charged on this page.')}</p>
      : readFailed ? <p className={styles.small} role="status">{t('HON could not load the checkout terms. Only someone allowed to buy for this school can subscribe.')}</p>
      : !schedules ? <p className={styles.small} role="status">{t('Loading checkout terms…')}</p>
      : choices.length === 0 ? <p className={styles.small} role="status">{t('HQ has not prepared checkout terms for these prices yet.')}</p>
      : <>
        <fieldset className={styles.offers} disabled={busy || phase.kind === 'done'}><legend>{t('Choose a price')}</legend>
          {choices.map(o => <label key={o.offerId} className={selected?.offerId === o.offerId ? styles.chosenOffer : ''}>
            <input type="radio" name="subscribe-offer" value={o.offerId} checked={selected?.offerId === o.offerId}
              onChange={() => { setChosen(o.offerId); setAgreed(false); setPhase({ kind: 'idle' }); }}/>
            <span><strong>{o.displayName}</strong><small>{priceLine(o)}{o.founder ? ` · ${t('Founder price')}` : ''}</small></span></label>)}
        </fieldset>
        {(phase.kind === 'idle' || phase.kind === 'loading' || (phase.kind === 'failed' && !phase.preview)) &&
          <button type="button" className={styles.primary} disabled={busy || !selected} onClick={() => void review()} data-subscribe-review="">
            {phase.kind === 'loading' ? t('Loading terms…') : t('Review terms')}</button>}
        {(phase.kind === 'review' || phase.kind === 'sending' || (phase.kind === 'failed' && phase.preview)) && (() => {
          const preview = phase.kind === 'failed' ? phase.preview! : phase.preview;
          return <div data-subscribe-terms="">
            <p>{preview.schedule.disclosureText}</p>
            <p className={styles.small}>{t('Refund window: {days} days.', { days: preview.schedule.refundTerms.windowDays })}</p>
            {preview.blockers.length > 0 ? <p className={styles.small} role="alert">{preview.blockers.includes('ALREADY_ACCEPTED')
              ? t('Your school already agreed to these terms. HQ will finish setting up your subscription.')
              : t('This price is not available for your school right now.')}</p>
              : <><label className={styles.confirm}><input type="checkbox" checked={agreed} disabled={busy} onChange={e => setAgreed(e.target.checked)}/>
                <span>{t('I am allowed to buy for this school, and I agree to these prices and terms.')}</span></label>
                <button type="button" className={styles.primary} disabled={!agreed || busy} onClick={() => void confirm(preview)} data-subscribe-confirm="">
                  {phase.kind === 'sending' ? t('Subscribing…') : phase.kind === 'failed' && phase.error.uncertain ? t('Try again') : t('Subscribe')}</button></>}
          </div>;
        })()}
        {phase.kind === 'done' && <p role="status" data-subscribe-done="">{t('Subscription started in test mode. Your features unlock once HON verifies your first payment.')}</p>}
      </>}
    {phase.kind === 'failed' && <p className={styles.small} role="alert" data-subscribe-error={phase.error.code}>{failure(phase.error)}</p>}
    <p className={styles.small}>{t('HON never collects card details here. A started subscription is not proof of payment.')}</p>
  </section>;
}
