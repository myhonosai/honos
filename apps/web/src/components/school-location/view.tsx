import React from 'react';
import type { SchoolLocationView } from '@hon/contracts';
import type { LocationErrorKind } from './http';
import type { LocationDraft, LocationField } from './draft';
import { AddressFields } from './address-fields';
import { FaceCheckInNoticeView } from './notice';
import { locationCopy } from './copy';
import styles from '../membership-changes/membership-changes.module.css';

export type LocationReadState = { state: 'LOADING' | 'DENIED' | 'UNAVAILABLE' } | { state: 'READY'; read: SchoolLocationView };
export type LocationOutcome = null | Readonly<{ kind: 'SENDING' | 'DONE' | LocationErrorKind }>;
export type SchoolLocationSettingsViewProps = Readonly<{
  language: string; waiting: boolean; concealed: boolean; hasSchool: boolean;
  read: LocationReadState; draft: LocationDraft | null; dirty: boolean; problems: readonly string[]; outcome: LocationOutcome; locked: boolean; canRetry: boolean;
  onEdit?: ((field: LocationField, value: string) => void) | undefined; onSave?: (() => void) | undefined; onDiscard?: (() => void) | undefined;
  onRefresh?: (() => void) | undefined; onTryAgain?: (() => void) | undefined;
}>;

const instant = (language: string, value: string) => new Date(value).toLocaleString(language, { dateStyle: 'medium', timeStyle: 'short' });

/** Settings > School location: pure, every state comes from props. The notice shown is the saved one, never the draft. */
export function SchoolLocationSettingsView(p: SchoolLocationSettingsViewProps): React.ReactElement {
  const c = locationCopy(p.language), read = p.read;
  return <section className={styles.page} aria-labelledby="school-location-title">
    <header className={styles.head}><div>
      <h1 id="school-location-title">{c.pageTitle}</h1>
      <p className={styles.intro}>{c.pageIntro}</p>
    </div></header>
    {p.concealed ? <p className={styles.notice} role="status">{c.hidden}</p>
      : p.waiting ? <p className={styles.notice} role="status">{c.checking}</p>
      : !p.hasSchool ? <p className={styles.notice} role="status">{c.chooseSchool}</p>
      : <>
        {p.outcome ? <div className={`${styles.notice} ${['DONE', 'SENDING'].includes(p.outcome.kind) ? '' : styles.warn}`} role="status" data-testid="location-outcome">
          <p>{c.outcomes[p.outcome.kind]}</p>
          {p.canRetry ? <button type="button" className={styles.primary} onClick={p.onTryAgain}>{c.tryAgain}</button> : null}
        </div> : null}
        {read.state === 'LOADING' ? <p className={styles.meta} role="status">{c.reading}</p>
          : read.state === 'DENIED' ? <p className={styles.meta} role="status">{c.denied}</p>
          : read.state !== 'READY' || !p.draft ? <p className={styles.meta} role="status">{c.unavailable}</p>
          : <article className={styles.form} aria-label={c.pageTitle}>
            <div className={styles.row}><p className={styles.meta}>{read.read.location ? c.version(read.read.location.version, instant(p.language, read.read.location.updatedAt)) : c.notSet}</p>
              <button type="button" className={styles.secondary} disabled={p.locked || p.dirty} onClick={p.onRefresh}>{c.refresh}</button></div>
            <AddressFields draft={p.draft} language={p.language} disabled={p.locked} fieldClassName={styles.field} onEdit={(f, v) => p.onEdit?.(f, v)} />
            {p.problems.length > 0 && p.dirty ? <div className={`${styles.notice} ${styles.warn}`} role="status" data-testid="location-problems"><p>{c.fix}</p>
              <ul>{p.problems.map((x, i) => <li key={i}>{x}</li>)}</ul></div> : null}
            <div className={styles.actions}>
              <button type="button" className={styles.primary} disabled={p.locked || p.problems.length > 0 || !p.dirty} onClick={p.onSave}>{c.save}</button>
              {p.dirty ? <button type="button" className={styles.secondary} disabled={p.locked} onClick={p.onDiscard}>{c.discard}</button> : null}
            </div>
            <FaceCheckInNoticeView notice={read.read.faceCheckInNotice} language={p.language} className={styles.notice} />
          </article>}
      </>}
  </section>;
}
