import React from 'react';
import type { HqSupportPriority, HqSupportStatus } from '@hon/contracts';
import { supportText, type SupportKey } from './copy';
import type { SupportOutcome } from './model';
import styles from '../hq-access/hq-access.module.css';

export const statusTone = (s: HqSupportStatus) => s === 'OPEN' ? 'waiting' : s === 'WAITING_ON_SCHOOL' ? 'waiting' : 'ready';
export const priorityTone = (p: HqSupportPriority) => p === 'URGENT' ? 'blocked' : p === 'HIGH' ? 'waiting' : 'ready';
export const formatTime = (locale: string, iso: string) =>
  new Intl.DateTimeFormat(locale, { timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));

export function Facts({ rows }: { rows: readonly [string, React.ReactNode][] }): React.ReactElement {
  return <dl className={styles.facts}>{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>;
}

/** The answer to the last command, worded only from what the server said. */
export function Outcome({ language, outcome, done, canRetry, onTryAgain, children }: { language: string; outcome: SupportOutcome; done: SupportKey;
  canRetry: boolean; onTryAgain: () => void; children?: React.ReactNode }): React.ReactElement | null {
  if (!outcome) return null;
  const t = (key: SupportKey) => supportText(language, key);
  if (outcome.kind === 'SENDING') return <p className={styles.outcome} role="status" data-support-outcome="sending">{t('sending')}</p>;
  if (outcome.kind === 'DONE') return <div className={styles.outcome} data-tone="ok" role="status" data-support-outcome="done"><p>{t(done)}</p>{children}</div>;
  if (outcome.kind === 'UNKNOWN') return <div className={styles.outcome} data-tone="waiting" role="alert" data-support-outcome="unknown"><p>{t('unknown')}</p>
    {canRetry && <button type="button" className={styles.secondary} onClick={onTryAgain}>{t('tryAgain')}</button>}</div>;
  const key: SupportKey = outcome.kind === 'CHANGED' ? 'changed' : outcome.kind === 'KEY_REUSED' ? 'keyReused' : outcome.kind === 'DENIED' ? 'deniedCommand'
    : outcome.kind === 'INVALID' ? 'invalidCommand' : outcome.kind === 'GONE' ? 'goneCommand' : outcome.kind === 'LOCAL_INVALID' ? (outcome.form === 'open' ? 'localInvalid' : outcome.form === 'note' ? 'localInvalidNote' : 'localInvalidChange')
    : outcome.code === 'SUPPORT_ASSIGNEE_NOT_ELIGIBLE' ? 'refusedAssignee' : 'refusedNoChange';
  return <p className={styles.outcome} data-tone="blocked" role="alert" data-support-outcome={outcome.kind.toLowerCase()}>{t(key)}</p>;
}
