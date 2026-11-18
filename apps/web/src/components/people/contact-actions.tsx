import React, { useEffect, useRef, useState } from 'react';
import type { SchoolContactArchiveState, SchoolContactCard, SchoolContactMergePreview, SchoolContactRow } from '@hon/contracts';
import { actionText, type ActionKey } from './contact-actions-copy';
import { contactsText } from './contacts-copy';
import { ContactAdminError, NO_CONTACT_FILTERS, contactAdminApi, contactsApi, type ContactAdminApi, type ContactAdminFailure, type ContactsApi } from './contacts-http';
import type { PeopleScope } from './http';
import styles from './people.module.css';

/** What changed, so the page can read the list and the card again (and open the kept person after a merge). */
export type ContactChange = Readonly<{ kind: 'ARCHIVED' | 'RESTORED' }> | Readonly<{ kind: 'MERGED'; keepPersonId: string }>;
type T = (key: ActionKey, vars?: Readonly<Record<string, string | number>>) => string;
type Failure = ContactAdminFailure;
const failureOf = (error: unknown): Failure => error instanceof ContactAdminError ? error.failure : { kind: 'UNKNOWN', blockers: [] };
const nameOf = (p: { givenName: string; familyName: string }) => `${p.givenName} ${p.familyName}`;
/** Two people with the same name are told apart by their email or phone, so "keep which one" is never ambiguous. */
function labels(p: SchoolContactMergePreview): { keep: string; merge: string } {
  const same = nameOf(p.keep) === nameOf(p.merge);
  const label = (x: SchoolContactMergePreview['keep']) => same && (x.email || x.phoneE164) ? `${nameOf(x)} (${x.email ?? x.phoneE164})` : nameOf(x);
  return { keep: label(p.keep), merge: label(p.merge) };
}

type Mode =
  | Readonly<{ kind: 'IDLE' }>
  | Readonly<{ kind: 'ARCHIVE'; restore: boolean; phase: 'LOADING' | 'READY' | 'SENDING'; state?: SchoolContactArchiveState; failure?: Failure }>
  | Readonly<{ kind: 'FIND'; phase: 'IDLE' | 'LOADING' | 'READY'; query: string; rows: readonly SchoolContactRow[]; failure?: Failure }>
  | Readonly<{ kind: 'MERGE'; phase: 'LOADING' | 'READY' | 'SENDING'; keep: string; merge: string; preview?: SchoolContactMergePreview; failure?: Failure }>;

/**
 * Delete (archive), restore and merge for the open contact (C3, 0515). Every step reads first and shows what would happen and
 * what blocks it, in words; the command repeats the exact versions (and the merge plan hash) that read showed. The server
 * decides who may do this: a role without people.archive or people.merge sees "Your role doesn't include this."
 */
export function ContactActions({ language, scope, card, onChanged, api = contactAdminApi, contacts = contactsApi }: {
  language: string; scope: PeopleScope; card: SchoolContactCard; onChanged: (change: ContactChange, notice: string) => void; api?: ContactAdminApi; contacts?: ContactsApi;
}): React.ReactElement {
  const t: T = (key, vars) => actionText(language, key, vars);
  const [mode, setMode] = useState<Mode>({ kind: 'IDLE' });
  // A step answers only while it is still the one shown; cancel, a new step or unmount retires it.
  const step = useRef(0), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; step.current++; }; }, []);
  const begin = () => ++step.current;
  const live = (n: number) => mounted.current && n === step.current;
  const me = card.person, myName = nameOf(me), archived = card.overview.segment === 'ARCHIVED';

  const openArchive = (restore: boolean) => {
    const n = begin();
    setMode({ kind: 'ARCHIVE', restore, phase: 'LOADING' });
    api.archiveState(scope, me.personId, AbortSignal.timeout(15000)).then(
      state => { if (live(n)) setMode({ kind: 'ARCHIVE', restore, phase: 'READY', state }); },
      error => { if (live(n)) setMode({ kind: 'ARCHIVE', restore, phase: 'READY', failure: failureOf(error) }); });
  };
  const sendArchive = (restore: boolean, state: SchoolContactArchiveState) => {
    const n = begin();
    setMode({ kind: 'ARCHIVE', restore, phase: 'SENDING', state });
    api.archive(scope, me.personId, state.person.version, restore, AbortSignal.timeout(30000)).then(
      () => { if (live(n)) setMode({ kind: 'IDLE' }); onChanged({ kind: restore ? 'RESTORED' : 'ARCHIVED' }, t(restore ? 'restored' : 'deleted', { name: myName })); },
      error => { if (live(n)) setMode({ kind: 'ARCHIVE', restore, phase: 'READY', state, failure: failureOf(error) }); });
  };
  const find = (query: string) => {
    const n = begin(), q = query.trim();
    if (!q) { setMode({ kind: 'FIND', phase: 'IDLE', query, rows: [] }); return; }
    setMode({ kind: 'FIND', phase: 'LOADING', query, rows: [] });
    contacts.list(scope, { ...NO_CONTACT_FILTERS, query: q }, null, false, AbortSignal.timeout(15000)).then(
      page => { if (live(n)) setMode({ kind: 'FIND', phase: 'READY', query, rows: page.rows.filter(r => r.personId !== me.personId).slice(0, 10) }); },
      () => { if (live(n)) setMode({ kind: 'FIND', phase: 'READY', query, rows: [], failure: { kind: 'UNKNOWN', blockers: [] } }); });
  };
  const preview = (keep: string, merge: string) => {
    const n = begin();
    setMode({ kind: 'MERGE', phase: 'LOADING', keep, merge });
    api.mergePreview(scope, keep, merge, AbortSignal.timeout(15000)).then(
      p => { if (live(n)) setMode({ kind: 'MERGE', phase: 'READY', keep, merge, preview: p }); },
      error => { if (live(n)) setMode({ kind: 'MERGE', phase: 'READY', keep, merge, failure: failureOf(error) }); });
  };
  const sendMerge = (p: SchoolContactMergePreview) => {
    const n = begin(), keep = p.keep.personId, merge = p.merge.personId;
    setMode({ kind: 'MERGE', phase: 'SENDING', keep, merge, preview: p });
    api.merge(scope, p, AbortSignal.timeout(30000)).then(
      () => { if (live(n)) setMode({ kind: 'IDLE' }); onChanged({ kind: 'MERGED', keepPersonId: keep }, t('merged', labels(p))); },
      error => { if (live(n)) setMode({ kind: 'MERGE', phase: 'READY', keep, merge, preview: p, failure: failureOf(error) }); });
  };
  const cancel = () => { begin(); setMode({ kind: 'IDLE' }); };

  const cancelButton = <button type="button" className={styles.secondary} onClick={cancel}>{t('cancel')}</button>;
  let body: React.ReactNode = null;
  if (mode.kind === 'ARCHIVE') {
    const s = mode.state, blockers = s ? (mode.restore ? s.restoreBlockers : s.archiveBlockers) : [];
    body = <div className={styles.subsection} data-testid="contact-archive">
      <h3>{t(mode.restore ? 'restoreTitle' : 'deleteTitle', { name: myName })}</h3>
      {mode.phase === 'LOADING' ? <p className={styles.meta} role="status">{t('checking')}</p> : null}
      {mode.failure ? <Problem t={t} failure={mode.failure} merge="" title={mode.restore ? 'cannotRestore' : 'cannotDelete'} name={myName}/> : null}
      {s && !mode.failure && blockers.length ? <Blockers t={t} title={t(mode.restore ? 'cannotRestore' : 'cannotDelete', { name: myName })} codes={blockers} merge=""/> : null}
      {s && !mode.failure && !blockers.length ? <p className={styles.meta}>{t(mode.restore ? 'restoreHelp' : 'deleteHelp', { name: myName })}</p> : null}
      <div className={styles.actions}>
        {s && !mode.failure && !blockers.length ? <button type="button" className={styles.primary} disabled={mode.phase === 'SENDING'} data-testid="contact-archive-confirm"
          onClick={() => sendArchive(mode.restore, s)}>{mode.phase === 'SENDING' ? t('sending') : t(mode.restore ? 'restoreConfirm' : 'deleteConfirm')}</button> : null}
        {mode.failure && mode.failure.kind !== 'DENIED' && mode.failure.kind !== 'SESSION' ? <button type="button" className={styles.secondary} onClick={() => openArchive(mode.restore)}>{t('tryAgain')}</button> : null}
        {mode.phase === 'SENDING' ? null : cancelButton}
      </div>
    </div>;
  } else if (mode.kind === 'FIND') {
    body = <div className={styles.subsection} data-testid="contact-merge-find">
      <h3>{t('findTitle', { name: myName })}</h3>
      <form className={styles.search} role="search" onSubmit={e => { e.preventDefault(); find(String(new FormData(e.currentTarget).get('duplicate') ?? '')); }}>
        <label htmlFor="contact-merge-q">{t('findLabel')}</label>
        <div className={styles.actions}>
          <input id="contact-merge-q" name="duplicate" type="search" maxLength={100} defaultValue={mode.query} autoComplete="off"/>
          <button type="submit" className={styles.secondary} disabled={mode.phase === 'LOADING'}>{mode.phase === 'LOADING' ? t('finding') : t('find')}</button>
        </div>
      </form>
      {mode.failure ? <p className={styles.meta} role="alert">{t('unknown')}</p> : null}
      {mode.phase === 'READY' && !mode.failure && !mode.rows.length ? <p className={styles.meta}>{t('noMatches')}</p> : null}
      {mode.rows.length ? <ul className={styles.plain}>{mode.rows.map(r => <li key={r.personId} className={styles.choice}>
        <span><strong>{nameOf(r)}</strong> · {contactsText(language, `row${r.segment}`)}{r.email ? ` · ${r.email}` : ''}{r.phoneE164 ? ` · ${r.phoneE164}` : ''}</span>
        <button type="button" className={styles.secondary} onClick={() => preview(me.personId, r.personId)}>{t('pick')}</button></li>)}</ul> : null}
      <div className={styles.actions}>{cancelButton}</div>
    </div>;
  } else if (mode.kind === 'MERGE') {
    const p = mode.preview, { keep: keepName, merge: mergeName } = p ? labels(p) : { keep: '', merge: '' };
    const vars = { keep: keepName, merge: mergeName };
    const moved = p ? (['leads', 'familyLinks', 'billingAccounts', 'consents', 'conversations'] as const).filter(k => p.moves[k] > 0) : [];
    body = <div className={styles.subsection} data-testid="contact-merge-preview">
      {p ? <h3>{t('mergeTitle', vars)}</h3> : null}
      {mode.phase === 'LOADING' ? <p className={styles.meta} role="status">{t('previewing')}</p> : null}
      {mode.failure ? <Problem t={t} failure={mode.failure} merge={mergeName} keep={keepName} title="cannotMerge" name=""/> : null}
      {p ? <>
        <dl className={styles.facts2}>
          <div><dt>{t('keeps')}</dt><dd>{keepName}</dd></div>
          <div><dt>{t('mergesAway')}</dt><dd>{mergeName}</dd></div>
        </dl>
        {p.blockers.length && !mode.failure ? <Blockers t={t} title={t('cannotMerge')} codes={p.blockers} merge={mergeName} keep={keepName}/> : null}
        {!p.blockers.length ? <>
          <p className={styles.meta}>{t('moves', vars)}</p>
          {moved.length ? <ul className={styles.plain}>{moved.map(k => <li key={k}>{t(`m_${k}`, { n: p.moves[k] })}</li>)}</ul> : <p className={styles.meta}>{t('nothingMoves')}</p>}
          {p.stays.consents || p.stays.messages ? <><p className={styles.meta}>{t('stays', vars)}</p><ul className={styles.plain}>
            {p.stays.consents ? <li>{t('s_consents', { ...vars, n: p.stays.consents })}</li> : null}
            {p.stays.messages ? <li>{t('s_messages', { n: p.stays.messages })}</li> : null}</ul></> : null}
          <p className={styles.meta}>{t('mergeHelp')}</p>
        </> : null}
      </> : null}
      <div className={styles.actions}>
        {p && !p.blockers.length && !mode.failure ? <button type="button" className={styles.primary} disabled={mode.phase === 'SENDING'} data-testid="contact-merge-confirm"
          onClick={() => sendMerge(p)}>{mode.phase === 'SENDING' ? t('sending') : t('mergeConfirm')}</button> : null}
        {mode.phase === 'READY' && (!mode.failure || mode.failure.kind === 'BLOCKED' || mode.failure.kind === 'STALE')
          ? <button type="button" className={styles.secondary} data-testid="contact-merge-swap" onClick={() => preview(mode.merge, mode.keep)}>{t('swap', { merge: mergeName || '…' })}</button> : null}
        {mode.failure?.kind === 'STALE' || mode.failure?.kind === 'UNKNOWN'
          ? <button type="button" className={styles.secondary} onClick={() => preview(mode.keep, mode.merge)}>{t('tryAgain')}</button> : null}
        {mode.phase === 'SENDING' ? null : cancelButton}
      </div>
    </div>;
  }

  return <section className={styles.contactActions} aria-label={t('actionsLabel')} data-testid="contact-actions">
    {mode.kind === 'IDLE' ? <div className={styles.actions}>
      {archived
        ? <button type="button" className={styles.secondary} data-testid="contact-restore" onClick={() => openArchive(true)}>{t('restore')}</button>
        : <>
          <button type="button" className={styles.secondary} data-testid="contact-merge" onClick={() => { begin(); setMode({ kind: 'FIND', phase: 'IDLE', query: '', rows: [] }); }}>{t('merge')}</button>
          <button type="button" className={styles.danger} data-testid="contact-delete" onClick={() => openArchive(false)}>{t('delete')}</button>
        </>}
    </div> : body}
  </section>;
}

function Blockers({ t, title, codes, merge, keep = '' }: { t: T; title: string; codes: readonly string[]; merge: string; keep?: string }): React.ReactElement {
  return <div className={styles.blockers} role="note"><p>{title}</p>
    <ul>{codes.map(c => <li key={c}>{t(`b_${c}` as ActionKey, { merge, keep })}</li>)}</ul></div>;
}
function Problem({ t, failure, merge, keep = '', title, name }: { t: T; failure: Failure; merge: string; keep?: string; title: ActionKey; name: string }): React.ReactElement {
  if (failure.kind === 'BLOCKED' && failure.blockers.length) return <Blockers t={t} title={t(title, { name })} codes={failure.blockers} merge={merge} keep={keep}/>;
  const key: ActionKey = failure.kind === 'DENIED' ? 'denied' : failure.kind === 'MISSING' ? 'missing' : failure.kind === 'STALE' ? 'stale'
    : failure.kind === 'SESSION' ? 'session' : 'unknown';
  return <p className={styles.meta} role="alert">{t(key)}</p>;
}
