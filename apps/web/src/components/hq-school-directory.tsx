'use client';

import { useLocale } from './localization/provider';
import { hqSchoolText, hqSchoolStatus } from './hq-school-management-copy';
import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { hqSchoolLifecycleActionsFor, type HqSchoolDirectory, type HqSchoolDirectoryEntry, type HqSchoolLifecycleAction } from '@hon/contracts';
import { hqSchoolLifecycleText, type HqSchoolLifecycleCopyKey } from './hq-school-lifecycle-copy';
import { HqSchoolLifecycleError, loadHqSchoolArchiveDates, sendHqSchoolLifecycle } from './hq-school-lifecycle-http';
import { HqSchoolDirectoryController, bindHqSchoolDirectoryPrivacy } from './hq-school-directory-controller';
import { useHqModern } from './hq-modern/shell';
import styles from './hq-school-directory.module.css';
import { schoolPlanText } from './hq-school-plan/copy';
import { hqSchoolVisitText } from './hq-school-visit/copy';
import { HqSchoolVisitError, enterSchoolAsHq } from './hq-school-visit/http';
import { rememberHqHint, schoolHomeHref } from './school-switcher/switcher';

function formatDate(value: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone: 'UTC', year: 'numeric', month: 'short', day: 'numeric',
  }).format(new Date(value));
}

type Filter = 'active' | 'paused' | 'archived' | 'all';
type Pending = { school: HqSchoolDirectoryEntry; action: HqSchoolLifecycleAction; key: string } | null;

function matches(school: HqSchoolDirectoryEntry, filter: Filter, query: string): boolean {
  const status = school.schoolOperationalStatus;
  if (filter === 'active' && status === 'ARCHIVED') return false;
  if (filter === 'paused' && status !== 'SUSPENDED') return false;
  if (filter === 'archived' && status !== 'ARCHIVED') return false;
  const q = query.trim().toLocaleLowerCase();
  return !q || school.schoolDisplayName.toLocaleLowerCase().includes(q) || school.organizationDisplayName.toLocaleLowerCase().includes(q);
}

/** Pause and Remove need the acknowledgement; Remove also needs the exact school name typed. */
export function lifecycleConfirmReady(action: HqSchoolLifecycleAction, schoolName: string, typed: string, ack: boolean, busy: boolean): boolean {
  if (busy) return false;
  if ((action === 'PAUSE' || action === 'ARCHIVE') && !ack) return false;
  return action !== 'ARCHIVE' || typed === schoolName;
}

/** Confirm step for one action. Remove needs the exact school name typed plus an acknowledgement. */
export function LifecycleDialog({ pending, busy, error, onCancel, onConfirm }: { pending: NonNullable<Pending>; busy: boolean; error: string; onCancel: () => void; onConfirm: (confirmName?: string) => void }): React.ReactElement {
  const { preferences } = useLocale();
  const l = (key: HqSchoolLifecycleCopyKey) => hqSchoolLifecycleText(preferences.language, key);
  const [typed, setTyped] = useState('');
  const [ack, setAck] = useState(false);
  const { action, school } = pending;
  const title = l(action === 'PAUSE' ? 'pauseTitle' : action === 'RESUME' ? 'resumeTitle' : action === 'ARCHIVE' ? 'removeTitle' : 'restoreTitle');
  const body = l(action === 'PAUSE' ? 'pauseBody' : action === 'RESUME' ? 'resumeBody' : action === 'ARCHIVE' ? 'removeBody' : 'restoreBody');
  const needsAck = action === 'PAUSE' || action === 'ARCHIVE';
  const ready = lifecycleConfirmReady(action, school.schoolDisplayName, typed, ack, busy);
  return <div className={styles.dialogBackdrop}><section role="dialog" aria-modal="true" aria-labelledby="hq-school-lifecycle-title" className={styles.dialog} data-lifecycle-dialog={action}>
    <h3 id="hq-school-lifecycle-title">{title}</h3>
    <p><strong>{school.schoolDisplayName}</strong></p>
    <p>{body}</p>
    {action === 'ARCHIVE' && <label className={styles.field}>{l('removeType')}<input autoComplete="off" spellCheck={false} value={typed} onChange={event => setTyped(event.target.value)} data-confirm-name /></label>}
    {needsAck && <label className={styles.check}><input type="checkbox" checked={ack} onChange={event => setAck(event.target.checked)} />{l(action === 'ARCHIVE' ? 'removeAck' : 'pauseAck')}</label>}
    {error && <p role="alert" className={styles.error}>{error}</p>}
    <div className={styles.dialogButtons}>
      <button type="button" onClick={onCancel} disabled={busy}>{l('cancel')}</button>
      <button type="button" className={action === 'ARCHIVE' ? styles.danger : styles.primaryButton} disabled={!ready} onClick={() => onConfirm(action === 'ARCHIVE' ? typed : undefined)}>{busy ? l('working') : l(action === 'PAUSE' ? 'pause' : action === 'RESUME' ? 'resume' : action === 'ARCHIVE' ? 'remove' : 'restore')}</button>
    </div>
  </section></div>;
}

function RowMenu({ school, onPick, onGoInside }: { school: HqSchoolDirectoryEntry; onPick: (action: HqSchoolLifecycleAction) => void; onGoInside?: () => void }): React.ReactElement {
  const { preferences } = useLocale();
  const l = (key: HqSchoolLifecycleCopyKey) => hqSchoolLifecycleText(preferences.language, key);
  const label = (action: HqSchoolLifecycleAction) => l(action === 'PAUSE' ? 'pause' : action === 'RESUME' ? 'resume' : action === 'ARCHIVE' ? 'remove' : 'restore');
  return <details className={styles.menu}>
    <summary aria-label={`${l('actions')} ${school.schoolDisplayName}`}>⋯</summary>
    <div role="menu">
      {school.schoolOperationalStatus === 'ACTIVE' && onGoInside && <button type="button" role="menuitem" data-action="ENTER"
        onClick={event => { (event.currentTarget.closest('details') as HTMLDetailsElement | null)?.removeAttribute('open'); onGoInside(); }}>{hqSchoolVisitText(preferences.language, 'goInside')}</button>}
      {school.schoolOperationalStatus !== 'ARCHIVED' && <a role="menuitem" href={`/hq/schools/${encodeURIComponent(school.schoolId)}`}>{l('open')}</a>}
      {school.schoolOperationalStatus !== 'ARCHIVED' && <a role="menuitem" data-menu="plan" href={`/hq/schools/${encodeURIComponent(school.schoolId)}#plan`}>{schoolPlanText(preferences.language, 'menuPlan')}</a>}
      {hqSchoolLifecycleActionsFor(school.schoolOperationalStatus).map(action => <button key={action} type="button" role="menuitem" data-action={action}
        className={action === 'ARCHIVE' ? styles.dangerText : undefined} onClick={event => { (event.currentTarget.closest('details') as HTMLDetailsElement | null)?.removeAttribute('open'); onPick(action); }}>{label(action)}</button>)}
    </div>
  </details>;
}

export function DirectoryTable({ directory, archives = {}, onChanged = () => {} }: { directory: HqSchoolDirectory; archives?: Readonly<Record<string, string>>; onChanged?: () => void }): React.ReactElement {
  const { preferences, formattingLocale } = useLocale();
  const t = (key: Parameters<typeof hqSchoolText>[1]) => hqSchoolText(preferences.language, key);
  const l = (key: HqSchoolLifecycleCopyKey) => hqSchoolLifecycleText(preferences.language, key);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('active');
  const [pending, setPending] = useState<Pending>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [entering, setEntering] = useState<{ schoolId: string; key: string } | null>(null);
  const [retryEnter, setRetryEnter] = useState<{ schoolId: string; key: string } | null>(null);
  if (directory.schools.length === 0) {
    return <section className={styles.state}><p className={styles.eyebrow}>{t('directoryEmptyEyebrow')}</p><h2>{t('directoryEmpty')}</h2><p>{t('directoryEmptyHelp')}</p></section>;
  }
  const rows = directory.schools.filter(school => matches(school, filter, query));
  const confirm = async (confirmName?: string) => {
    if (!pending || busy) return;
    setBusy(true); setError('');
    try {
      await sendHqSchoolLifecycle(pending.school.schoolId, { action: pending.action, expectedStatus: pending.school.schoolOperationalStatus, ...(confirmName === undefined ? {} : { confirmName }) }, pending.key);
      setPending(null); setNotice(l('done')); onChanged();
    } catch (failure) {
      const reason = failure instanceof HqSchoolLifecycleError ? failure.reason : 'unavailable';
      const message = l(reason === 'signedOut' ? 'failSignedOut' : reason === 'forbidden' ? 'failForbidden' : reason === 'nameMismatch' ? 'failNameMismatch' : reason === 'changed' ? 'failChanged'
        : reason === 'billingActive' ? 'failBillingActive' : reason === 'unknown' ? 'failUnknown' : 'failUnavailable');
      // An unknown outcome keeps the same key so a retry can never apply twice; anything else starts fresh.
      if (reason === 'changed') { setPending(null); setNotice(message); onChanged(); }
      else { setError(message); if (reason !== 'unknown') setPending(current => current && { ...current, key: crypto.randomUUID() }); }
    } finally { setBusy(false); }
  };

  // Go inside: a 4-hour, logged HQ support visit, then the school's own home page (David, 2026-11-25).
  const goInside = async (school: HqSchoolDirectoryEntry) => {
    if (entering) return;
    // An unknown outcome is retried with the same key, so a retry can never open two visits.
    const key = retryEnter?.schoolId === school.schoolId ? retryEnter.key : crypto.randomUUID();
    setEntering({ schoolId: school.schoolId, key }); setRetryEnter(null); setError(''); setNotice(hqSchoolVisitText(preferences.language, 'going'));
    try {
      const receipt = await enterSchoolAsHq(school.schoolId, key);
      rememberHqHint(true);
      window.location.assign(schoolHomeHref(receipt));
    } catch (failure) {
      const reason = failure instanceof HqSchoolVisitError ? failure.reason : 'unavailable';
      setNotice(hqSchoolVisitText(preferences.language, reason === 'signedOut' ? 'failSignedOut' : reason === 'forbidden' ? 'failForbidden' : reason === 'unknown' ? 'failUnknown' : 'failUnavailable'));
      if (reason === 'unknown') setRetryEnter({ schoolId: school.schoolId, key });
      setEntering(null);
    }
  };

  return <section className={styles.section} aria-labelledby="hq-schools-directory-title">
    <header><p className={styles.eyebrow}>{t('directoryTableEyebrow')}</p><h2 id="hq-schools-directory-title">{t('directorySchools')}</h2><p>{t('directoryTableHelp')}</p></header>
    <div className={styles.toolbar}>
      <input type="search" aria-label={l('search')} placeholder={l('search')} value={query} onChange={event => setQuery(event.target.value)} data-school-search />
      <label>{l('filter')} <select value={filter} onChange={event => setFilter(event.target.value as Filter)} data-school-filter>
        <option value="active">{l('filterActive')}</option><option value="paused">{l('filterPaused')}</option><option value="archived">{l('filterArchived')}</option><option value="all">{l('filterAll')}</option>
      </select></label>
    </div>
    <p className={styles.notice} role="status" aria-live="polite" hidden={!notice}>{notice}</p>
    <div className={styles.tableWrap} role="region" aria-label={t('directoryTableLabel')} tabIndex={0}>
      <table>
        <thead><tr><th>{t('directorySchool')}</th><th>{t('directoryOrganization')}</th><th>{t('directoryOperationalStatus')}</th><th>{t('directoryCurrentTier')}</th><th>{t('directoryCreated')}</th><th><span className={styles.announcement}>{l('actions')}</span></th></tr></thead>
        <tbody>{rows.map((school) => <tr key={school.schoolId} data-school-row={school.schoolOperationalStatus}>
          <td>{school.schoolOperationalStatus === 'ARCHIVED' ? <strong>{school.schoolDisplayName}</strong> : <a className={styles.rowLink} href={`/hq/schools/${encodeURIComponent(school.schoolId)}`} aria-label={`${t('directoryOpen')}: ${school.schoolDisplayName}`}><strong>{school.schoolDisplayName}</strong></a>}</td>
          <td>{school.organizationDisplayName}</td>
          <td><span className={styles[`status_${school.schoolOperationalStatus}`]}>{hqSchoolStatus(preferences.language, school.schoolOperationalStatus)}</span>
            {school.schoolOperationalStatus === 'ARCHIVED' && archives[school.schoolId] && <small>{l('erasesOn')} {formatDate(archives[school.schoolId]!, formattingLocale)}</small>}</td>
          <td>{school.entitlementTier ?? <span className={styles.unavailable}>{t('directoryNoTier')}</span>}</td>
          <td>{formatDate(school.createdAt, formattingLocale)}</td>
          <td><RowMenu school={school} onGoInside={() => void goInside(school)} onPick={action => { setNotice(''); setError(''); setPending({ school, action, key: crypto.randomUUID() }); }} /></td>
        </tr>)}</tbody>
      </table>
      {rows.length === 0 && <p className={styles.empty}>{l('noMatches')}</p>}
    </div>
    {pending && <LifecycleDialog key={`${pending.school.schoolId}:${pending.action}`} pending={pending} busy={busy} error={error} onCancel={() => { if (!busy) { setPending(null); setError(''); } }} onConfirm={confirmName => void confirm(confirmName)} />}
  </section>;
}

export function HqSchoolDirectory(): React.ReactElement {
  const [controller] = useState(() => new HqSchoolDirectoryController());
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot, controller.snapshot);
  const facts = useRef<HTMLDivElement>(null);
  // Density follows the shared HQ View control; it never changes the directory, access or data fields.
  const { view } = useHqModern();
  const { preferences } = useLocale();
  const t = (key: Parameters<typeof hqSchoolText>[1]) => hqSchoolText(preferences.language, key);

  const [archives, setArchives] = useState<Readonly<Record<string, string>>>({});
  useEffect(() => {
    if (state.kind !== 'ready') return;
    const abort = new AbortController();
    loadHqSchoolArchiveDates(abort.signal).then(result => setArchives(Object.fromEntries(result.archives.map(row => [row.schoolId, row.eraseAfter])))).catch(() => setArchives({}));
    return () => abort.abort();
  }, [state.kind, state.directory]);

  useEffect(() => {
    void controller.start();
    const unbind = bindHqSchoolDirectoryPrivacy(controller, () => { if (facts.current) { facts.current.hidden = true; facts.current.inert = true; } }, window, document);
    return () => { unbind(); controller.stop(); };
  }, [controller]);

  return <div className={`${styles.page} ${styles[`presentation_${view}`]}`} data-hq-directory data-hq-directory-busy={state.busy}>
    <header className={styles.header}><p className={styles.eyebrow}>{t('directoryEyebrow')}</p><h2>{t('directoryTitle')}</h2><p>{t('directoryIntro')}</p></header>
    <aside className={styles.notice}><strong>{t('directoryFactsTitle')}</strong><p>{t('directoryFactsLimit')}</p></aside>
    <p className={styles.announcement} role="status" aria-live="polite" aria-atomic="true">{state.kind === 'ready' ? `${t('directorySchools')}: ${state.directory?.schools.length ?? 0}` : t(state.kind === 'loading' ? 'directoryLoading' : state.kind === 'unauthorized' ? 'directorySignIn' : state.kind === 'forbidden' ? 'directoryDenied' : state.kind === 'concealed' ? 'directoryConcealed' : 'directoryUnavailable')}</p>
    {state.kind === 'loading' && <section className={styles.state}><p className={styles.eyebrow}>{t('directoryLoadingEyebrow')}</p><h2>{t('directoryLoading')}</h2><p>{t('directoryLoadingHelp')}</p></section>}
    {state.kind === 'unauthorized' && <section className={styles.state}><p className={styles.eyebrow}>{t('directoryAccountRequired')}</p><h2>{t('directorySignIn')}</h2><p>{t('directorySignInHelp')}</p><a className={styles.primaryLink} href="/auth/login">{t('signIn')}</a></section>}
    {state.kind === 'forbidden' && <section className={styles.state}><p className={styles.eyebrow}>{t('directoryDeniedEyebrow')}</p><h2>{t('directoryDenied')}</h2><p>{t('directoryDeniedHelp')}</p></section>}
    {state.kind === 'unavailable' && <section className={styles.state}><p className={styles.eyebrow}>{t('directoryUnavailableEyebrow')}</p><h2>{t('directoryUnavailable')}</h2><p>{t('directoryUnavailableHelp')}</p></section>}
    {state.kind === 'concealed' && <section className={styles.state}><h2>{t('directoryConcealed')}</h2><p>{t('directoryConcealedHelp')}</p></section>}
    {state.kind !== 'loading' && state.kind !== 'ready' && state.kind !== 'concealed' && <button type="button" className={styles.primaryLink} disabled={state.busy} onClick={() => void controller.load()}>{t('directoryRead')}</button>}
    <div key={controller.revision()} ref={facts} data-hq-directory-facts hidden={state.kind !== 'ready'} inert={state.kind !== 'ready'}>{state.kind === 'ready' && state.directory && <DirectoryTable directory={state.directory} archives={archives} onChanged={() => void controller.load()} />}</div>
  </div>;
}
