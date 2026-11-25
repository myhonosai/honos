'use client';

import React, { useEffect, useState } from 'react';
import { useLocale } from '../localization/provider';
import {
  HqCommercialStatusError, loadHqCreditProgramStatus, loadHqPaymentProgramStatus,
  type CommercialStatusFailure, type CreditProgramStatus, type PaymentProgramStatus,
} from './commercial-status-http';
import { HqIcon } from './icon';
import styles from './hq-modern.module.css';

type Read<T> = { kind: 'loading' } | { kind: 'failed'; failure: CommercialStatusFailure } | { kind: 'ready'; value: T };

function useRead<T>(load: (signal: AbortSignal) => Promise<T>): Read<T> {
  const [state, setState] = useState<Read<T>>({ kind: 'loading' });
  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal).then(
      (value) => { if (!controller.signal.aborted) setState({ kind: 'ready', value }); },
      (error: unknown) => { if (!controller.signal.aborted) setState({ kind: 'failed', failure: error instanceof HqCommercialStatusError ? error.kind : 'UNAVAILABLE' }); },
    );
    return () => controller.abort();
  }, [load]);
  return state;
}

function FailureText({ failure }: { failure: CommercialStatusFailure }): React.ReactElement {
  const { t } = useLocale();
  return <span className={styles.badge}>{failure === 'FORBIDDEN' ? t("Your HQ role can't see this") : failure === 'UNAUTHORIZED' ? t("Sign in again to see this") : t("Couldn't load. Try again later.")}</span>;
}

/**
 * Read-only status of the existing HON payment and AI credit programs, as the server reports them. Each read is
 * independent and fails closed; nothing here is cached, sampled or inferred, and no program can be changed.
 */
export function CommercialStatus(): React.ReactElement {
  const { t, date } = useLocale();
  const payments = useRead<PaymentProgramStatus>(loadHqPaymentProgramStatus);
  const credits = useRead<CreditProgramStatus>(loadHqCreditProgramStatus);
  return <section className={`${styles.panel} ${styles.commercialStatus}`} aria-labelledby="hq-commercial-title" aria-busy={payments.kind === 'loading' || credits.kind === 'loading'}>
    <div className={styles.sectionHeader}><h2 id="hq-commercial-title"><HqIcon name="shield" size={18}/>{t("Payments & credits")}</h2><a href="/hq/pricing-offers">{t("Open Plans & Billing")}</a></div>
    <dl className={styles.commercialList}>
      <div>
        <dt>{t("Taking payments")}</dt>
        <dd>{payments.kind === 'loading' ? <span role="status">{t("Loading…")}</span> : payments.kind === 'failed' ? <FailureText failure={payments.failure}/>
          : <><strong data-commercial-state={payments.value.status}>{payments.value.status === 'TEST_MODE' ? t("Test mode") : t("Disabled")}</strong><small>{t("Changed {date}", { date: date(payments.value.changedAt) })}</small></>}</dd>
      </div>
      <div>
        <dt>{t("Real-money checkout")}</dt>
        <dd>{payments.kind === 'loading' ? <span role="status">{t("Loading…")}</span> : payments.kind === 'failed' ? <FailureText failure={payments.failure}/>
          : <><strong data-commercial-state={payments.value.liveMode}>{t("Unavailable")}</strong><small>{payments.value.status === 'TEST_MODE' ? t("Only test checkouts work. A school also needs a published offer.") : t("Checkout is off until payments are turned on.")}</small></>}</dd>
      </div>
      <div>
        <dt>{t("AI credits")}</dt>
        <dd>{credits.kind === 'loading' ? <span role="status">{t("Loading…")}</span> : credits.kind === 'failed' ? <FailureText failure={credits.failure}/>
          : <><strong data-commercial-state={credits.value.status}>{credits.value.status === 'ACTIVE' ? t("Active") : t("Inactive")}</strong><small>{t("Schools can't buy extra credits yet.")}</small></>}</dd>
      </div>
    </dl>
      </section>;
}
