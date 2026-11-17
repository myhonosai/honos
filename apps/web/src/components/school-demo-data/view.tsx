import React from 'react';
import type { SchoolDemoDataCountKey, SchoolDemoDataView } from '@hon/contracts';
import { demoCopy, type DemoOutcomeKind } from './copy';
import styles from '../membership-changes/membership-changes.module.css';

export type DemoReadState = { state: 'LOADING' | 'DENIED' | 'UNAVAILABLE' } | { state: 'READY'; read: SchoolDemoDataView };
export type DemoOutcome = null | Readonly<{ kind: DemoOutcomeKind; tables?: readonly string[] }>;
export type SchoolDemoDataSettingsViewProps = Readonly<{
  language: string; waiting: boolean; concealed: boolean; hasSchool: boolean;
  read: DemoReadState; outcome: DemoOutcome; locked: boolean; canRetry: boolean; confirming: boolean;
  onLoad?: (() => void) | undefined; onAskRemove?: (() => void) | undefined; onConfirmRemove?: (() => void) | undefined; onCancelRemove?: (() => void) | undefined;
  onRefresh?: (() => void) | undefined; onTryAgain?: (() => void) | undefined;
}>;

const instant = (language: string, value: string) => { try { return new Date(value).toLocaleString(language, { dateStyle: 'medium', timeStyle: 'short' }); } catch { return value; } };
/** People first, then money, then classes. */
const COUNT_ORDER: readonly SchoolDemoDataCountKey[] = ['students', 'families', 'guardians', 'adultStudents', 'memberships', 'invoices', 'overdueInvoices', 'payments',
  'programs', 'classes', 'classSessions', 'attendance', 'leads'];
const CALM: readonly DemoOutcomeKind[] = ['LOADING', 'REMOVING', 'LOADED', 'REMOVED'];

/** Settings > Demo data (0446): pure, every state comes from props. Remove always asks once before it sends. */
export function SchoolDemoDataSettingsView(p: SchoolDemoDataSettingsViewProps): React.ReactElement {
  const c = demoCopy(p.language), read = p.read;
  const view = read.state === 'READY' ? read.read : null;
  return <section className={styles.page} aria-labelledby="school-demo-data-title" data-demo-data={view?.status ?? read.state}>
    <header className={styles.head}><div>
      <h1 id="school-demo-data-title">{c.pageTitle}</h1>
      <p className={styles.intro}>{c.pageIntro}</p>
    </div></header>
    {p.concealed ? <p className={styles.notice} role="status">{c.hidden}</p>
      : p.waiting ? <p className={styles.notice} role="status">{c.checking}</p>
      : !p.hasSchool ? <p className={styles.notice} role="status">{c.chooseSchool}</p>
      : <>
        {p.outcome ? <div className={`${styles.notice} ${CALM.includes(p.outcome.kind) ? '' : styles.warn}`} role="status" data-testid="demo-outcome" data-outcome={p.outcome.kind}>
          <p>{c.outcomes[p.outcome.kind]}</p>
          {p.outcome.kind === 'IN_USE' ? <><p><strong>{c.inUseTitle}.</strong> {c.inUseLead}</p>
            {p.outcome.tables && p.outcome.tables.length > 0 ? <ul data-testid="demo-in-use">{p.outcome.tables.map(t => <li key={t}>{c.table(t)}</li>)}</ul> : null}</> : null}
          {p.canRetry ? <button type="button" className={styles.primary} onClick={p.onTryAgain}>{c.tryAgain}</button> : null}
        </div> : null}
        {read.state === 'LOADING' ? <p className={styles.meta} role="status">{c.reading}</p>
          : read.state === 'DENIED' ? <p className={styles.meta} role="status">{c.denied}</p>
          : !view ? <div className={styles.row}><p className={styles.meta} role="status">{c.unavailable}</p>
            <button type="button" className={styles.secondary} disabled={p.locked} onClick={p.onRefresh}>{c.refresh}</button></div>
          : view.status === 'NONE' ? <article className={styles.form} aria-label={c.noneTitle}>
            <h2>{c.noneTitle}</h2>
            <p className={styles.meta}>{c.noneLead}</p>
            <ul>{c.includes.map(line => <li key={line}>{line}</li>)}</ul>
            <ul className={styles.meta}>{c.safety.map(line => <li key={line}>{line}</li>)}</ul>
            {view.lastRemovedAt ? <p className={styles.meta}>{c.lastRemoved(instant(p.language, view.lastRemovedAt))}</p> : null}
            <div className={styles.row}>
              <button type="button" className={styles.primary} disabled={p.locked} onClick={p.onLoad} data-demo-action="load">{c.load}</button>
              <button type="button" className={styles.secondary} disabled={p.locked} onClick={p.onRefresh}>{c.refresh}</button>
            </div>
          </article>
          : <article className={styles.form} aria-label={c.loadedTitle}>
            <h2>{c.loadedTitle}</h2>
            <p className={styles.meta}>{c.loadedLead(instant(p.language, view.loadedAt))}</p>
            <h3>{c.countsTitle}</h3>
            <dl data-testid="demo-counts" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))', gap: 8, margin: 0 }}>
              {COUNT_ORDER.map(key => <div key={key} data-count={key}><dt className={styles.meta}>{c.counts[key]}</dt><dd style={{ margin: 0, fontSize: 20, fontWeight: 800 }}>{view.counts[key]}</dd></div>)}
            </dl>
            {p.confirming ? <div className={`${styles.notice} ${styles.warn}`} role="alertdialog" aria-labelledby="demo-confirm-title" data-testid="demo-confirm">
              <p id="demo-confirm-title"><strong>{c.confirmTitle}</strong></p>
              <p>{c.confirmLead}</p>
              <div className={styles.row}>
                <button type="button" className={styles.primary} disabled={p.locked} onClick={p.onConfirmRemove} data-demo-action="confirm-remove" autoFocus>{c.confirmYes}</button>
                <button type="button" className={styles.secondary} disabled={p.locked} onClick={p.onCancelRemove}>{c.confirmNo}</button>
              </div>
            </div> : <div className={styles.row}>
              <button type="button" className={styles.secondary} disabled={p.locked} onClick={p.onAskRemove} data-demo-action="remove">{c.remove}</button>
              <button type="button" className={styles.secondary} disabled={p.locked} onClick={p.onRefresh}>{c.refresh}</button>
            </div>}
          </article>}
      </>}
  </section>;
}
