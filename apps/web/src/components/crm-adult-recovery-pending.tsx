'use client';

import React, { useEffect, useRef } from 'react';
import type { LeadListItem } from '@hon/contracts';
import styles from './crm-adult-flow.module.css';

/** Loading/error presentation only. Recovery is started by the parent's explicit click handler. */
export function CrmAdultRecoveryPending({ row, busy, error, onRetry, onCancel }: {
  row: LeadListItem; busy: boolean; error: string; onRetry(): void; onCancel(): void;
}): React.ReactElement {
  const heading = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => { heading.current?.focus(); }, []);
  return <section className={styles.flow} aria-labelledby="adult-recovery-title" aria-busy={busy}>
    <header><p>ADULT CRM SETUP</p><h2 id="adult-recovery-title" ref={heading} tabIndex={-1}>Resume setup for {row.givenName} {row.familyName}</h2>
      <button type="button" onClick={onCancel}>Close adult setup</button></header>
    {busy && <p role="status">Checking saved setup… No registration, account or membership is being created.</p>}
    {error && <p role="alert" className={styles.error}>{error}</p>}
    {!busy && <button type="button" onClick={onRetry}>Retry setup read</button>}
  </section>;
}
