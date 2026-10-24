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
  return <span className={styles.badge}>{failure === 'FORBIDDEN' ? t("Not available for this HQ account") : failure === 'UNAUTHORIZED' ? t("Sign in again to verify") : t("Could not be verified")}</span>;
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
    <div className={styles.sectionHeader}><h2 id="hq-commercial-title"><HqIcon name="shield" size={18}/>{t("Commercial programs")}</h2><span className={styles.badge}>{t("Read-only · server reported")}</span></div>
    <dl className={styles.commercialList}>
      <div>
        <dt>{t("Payment program")}</dt>
        <dd>{payments.kind === 'loading' ? <span role="status">{t("Verifying…")}</span> : payments.kind === 'failed' ? <FailureText failure={payments.failure}/>
          : <><strong data-commercial-state={payments.value.status}>{payments.value.status === 'TEST_MODE' ? t("Test mode") : t("Disabled")}</strong><small>{t("Changed {date}", { date: date(payments.value.changedAt) })}</small></>}</dd>
      </div>
      <div>
        <dt>{t("Live checkout")}</dt>
        <dd>{payments.kind === 'loading' ? <span role="status">{t("Verifying…")}</span> : payments.kind === 'failed' ? <FailureText failure={payments.failure}/>
          : <><strong data-commercial-state={payments.value.liveMode}>{t("Unavailable")}</strong><small>{payments.value.status === 'TEST_MODE' ? t("Only test-mode checkouts can run, and each still needs a published offer and an eligible school.") : t("No checkout can start while the payment program is disabled.")}</small></>}</dd>
      </div>
      <div>
        <dt>{t("AI credit program")}</dt>
        <dd>{credits.kind === 'loading' ? <span role="status">{t("Verifying…")}</span> : credits.kind === 'failed' ? <FailureText failure={credits.failure}/>
          : <><strong data-commercial-state={credits.value.status}>{credits.value.status === 'ACTIVE' ? t("Active") : t("Inactive")}</strong><small>{t("Top-ups unavailable · overage and purchases disabled")}</small></>}</dd>
      </div>
    </dl>
    <p className={styles.finePrint}>{t("Nothing on this panel changes billing, checkout or credits.")}</p>
  </section>;
}
