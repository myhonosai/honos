import React from 'react';
import type { HqSchoolOwnership, SchoolOwner, SchoolOwnerOwnershipView, SchoolOwnershipNotice } from '@hon/contracts';
import { ownershipText, type OwnershipKey } from './copy';
import styles from './school-ownership.module.css';

type T = (key: OwnershipKey, vars?: Record<string, string>) => string;
const when = (language: string, value: string) => new Date(value).toLocaleDateString(language, { dateStyle: 'medium' });
const moment = (language: string, value: string) => new Date(value).toLocaleString(language, { dateStyle: 'medium', timeStyle: 'short' });

function Owner({ owner, you, language, t, children }: { owner: SchoolOwner; you: boolean; language: string; t: T; children?: React.ReactNode }) {
  return <li className={styles.owner} data-primary={owner.primary ? '' : undefined} data-testid="ownership-owner">
    <div className={styles.who}><strong>{owner.displayName}</strong><span>{owner.email}</span>
      <span>{t('since', { date: when(language, owner.since) })} · {t(owner.viaInvitation ? 'viaInvitation' : 'viaProvisioning')}</span></div>
    <div className={styles.chips}>
      {owner.primary ? <span className={styles.chip} data-kind="primary">{t('primary')}</span> : null}
      {you ? <span className={styles.chip}>{t('you')}</span> : null}
    </div>
    {children}
  </li>;
}
function Notices({ notices, language, t }: { notices: readonly SchoolOwnershipNotice[]; language: string; t: T }) {
  return <article className={styles.card} aria-labelledby="ownership-notices-title">
    <h2 id="ownership-notices-title">{t('noticesTitle')}</h2>
    {notices.length === 0 ? <p className={styles.meta}>{t('noNotices')}</p>
      : <ul className={styles.notices}>{notices.map((n) => <li key={n.noticeId}>
        <span>{t(n.kind, { email: n.invitedEmail ?? '' })}</span><time dateTime={n.occurredAt}>{moment(language, n.occurredAt)}</time></li>)}</ul>}
  </article>;
}

export type SchoolChoice = Readonly<{ schoolId: string; label: string }>;
export type HqSchoolsState = { state: 'LOADING' | 'DENIED' | 'UNAVAILABLE' } | { state: 'READY'; schools: readonly SchoolChoice[] };
export type HqOwnershipState = { state: 'IDLE' | 'LOADING' | 'DENIED' | 'GONE' | 'UNAVAILABLE' } | { state: 'READY'; view: HqSchoolOwnership };
export type OwnershipOutcomeKind = 'SENDING' | 'DONE' | 'UNCHANGED' | 'NOT_LIVE' | 'DENIED' | 'INVALID' | 'GONE' | 'RATE' | 'UNKNOWN';
export type OwnershipOutcome = null | Readonly<{ kind: OwnershipOutcomeKind; name: string }>;
const OUTCOME_KEY: Record<OwnershipOutcomeKind, OwnershipKey> = { SENDING: 'sending', DONE: 'done', UNCHANGED: 'unchanged', NOT_LIVE: 'notLive',
  DENIED: 'cmdDenied', INVALID: 'cmdInvalid', GONE: 'cmdGone', RATE: 'rate', UNKNOWN: 'unknown' };

export type HqOwnershipViewProps = Readonly<{
  language: string; concealed: boolean; schools: HqSchoolsState; selected: string | null; ownership: HqOwnershipState;
  confirming: string | null; outcome: OwnershipOutcome; locked: boolean; canRetry: boolean;
  onSelect?: ((schoolId: string | null) => void) | undefined; onRefresh?: (() => void) | undefined; onReveal?: (() => void) | undefined;
  onAsk?: ((ownerGrantId: string) => void) | undefined; onCancel?: (() => void) | undefined; onConfirm?: (() => void) | undefined; onTryAgain?: (() => void) | undefined;
}>;

/** HQ owner view. Owners, primary and HQ seats come only from the ownership read; HQ seats are never listed as owners. */
export function HqOwnershipView(p: HqOwnershipViewProps): React.ReactElement {
  const t: T = (key, vars) => ownershipText(p.language, key, vars);
  const view = p.ownership.state === 'READY' && p.ownership.view.schoolId.toLowerCase() === p.selected?.toLowerCase() ? p.ownership.view : null;
  const n = (value: number) => new Intl.NumberFormat(p.language).format(value);
  const list = p.schools.state === 'READY' ? p.schools.schools : [];
  return <section className={styles.page} aria-labelledby="hq-ownership-title" data-testid="hq-school-ownership">
    <header className={styles.head}>
      <div><h1 id="hq-ownership-title">{t('hqTitle')}</h1><p className={styles.intro}>{t('hqIntro')}</p></div>
      {!p.concealed && p.selected && p.onRefresh ? <button type="button" className={styles.secondary} onClick={p.onRefresh} disabled={p.ownership.state === 'LOADING'}>{t('refresh')}</button> : null}
    </header>
    <p className={styles.meta}>{t('hqScope')}</p>
    {p.concealed ? <div className={styles.notice} role="status"><p>{t('concealed')}</p>{p.onReveal ? <button type="button" className={styles.secondary} onClick={p.onReveal}>{t('reveal')}</button> : null}</div>
      : p.schools.state === 'LOADING' ? <p className={styles.notice} role="status">{t('schoolsLoading')}</p>
      : p.schools.state === 'DENIED' ? <p className={styles.notice} role="status">{t('schoolsDenied')}</p>
      : p.schools.state === 'UNAVAILABLE' ? <p className={styles.notice} role="status">{t('schoolsUnavailable')}</p>
      : <>
        <label className={styles.field}>{t('schoolLabel')}
          <select value={p.selected ?? ''} disabled={p.locked} onChange={(e) => p.onSelect?.(e.target.value || null)}>
            <option value="">{list.length ? t('schoolChoose') : t('noSchools')}</option>
            {list.map((s) => <option key={s.schoolId} value={s.schoolId}>{s.label}</option>)}
          </select></label>
        {p.outcome ? <div className={styles.notice} role="status" data-testid="ownership-outcome"><p>{t(OUTCOME_KEY[p.outcome.kind], { name: p.outcome.name })}</p>
          {p.canRetry && p.onTryAgain ? <button type="button" className={styles.primary} onClick={p.onTryAgain}>{t('tryAgain')}</button> : null}</div> : null}
        {!p.selected ? <p className={styles.meta}>{t('pick')}</p>
          : p.ownership.state === 'DENIED' ? <p className={styles.notice} role="status">{t('denied')}</p>
          : p.ownership.state === 'GONE' ? <p className={styles.notice} role="status">{t('gone')}</p>
          : p.ownership.state === 'UNAVAILABLE' ? <div className={styles.notice} role="status"><p>{t('unavailable')}</p>
            {p.onRefresh ? <button type="button" className={styles.secondary} onClick={p.onRefresh}>{t('refresh')}</button> : null}</div>
          : !view ? <p className={styles.notice} role="status">{t('loading')}</p>
          : <>
            {view.primaryNeeded ? <p className={`${styles.notice} ${styles.warn}`} role="status" data-testid="ownership-primary-needed">{t('primaryNeeded')}</p> : null}
            <article className={styles.card} aria-labelledby="ownership-owners-title">
              <h2 id="ownership-owners-title">{t('ownersTitle')}</h2>
              {view.owners.length === 0 ? <p className={styles.meta}>{t('noOwners')} <a href="/hq/school-owner-invitations">{t('inviteLink')}</a></p>
                : <ul className={styles.owners}>{view.owners.map((o) => <Owner key={o.ownerGrantId} owner={o} you={false} language={p.language} t={t}>
                  {!o.primary && p.confirming !== o.ownerGrantId ? <button type="button" className={styles.secondary} disabled={p.locked || p.confirming !== null}
                    onClick={() => p.onAsk?.(o.ownerGrantId)}>{t('makePrimary')}</button> : null}
                  {p.confirming === o.ownerGrantId ? <div className={styles.confirm} role="group" aria-label={t('confirmPrimary', { name: o.displayName })}>
                    <p><strong>{t('confirmPrimary', { name: o.displayName })}</strong></p><p className={styles.meta}>{t('confirmHelp')}</p>
                    <div className={styles.row}><button type="button" className={styles.primary} disabled={p.locked} onClick={p.onConfirm}>{t('confirm')}</button>
                      <button type="button" className={styles.secondary} disabled={p.locked} onClick={p.onCancel}>{t('cancel')}</button></div></div> : null}
                </Owner>)}</ul>}
            </article>
            <article className={styles.card} aria-labelledby="ownership-hq-title" data-testid="ownership-hq-access">
              <h2 id="ownership-hq-title">{t('hqAccess')}</h2>
              <p>{view.hqOwnerGrantIds.length ? t('hqSeats', { n: n(view.hqOwnerGrantIds.length) }) : t('hqNone')}</p>
              <p className={styles.meta}>{t('hqSeatsHelp')}</p>
            </article>
            <Notices notices={view.notices} language={p.language} t={t}/>
            <p className={styles.meta}>{t('asOf', { time: moment(p.language, view.asOf) })}</p>
          </>}
      </>}
  </section>;
}

export type OwnerOwnershipState = { state: 'LOADING' | 'DENIED' | 'GONE' | 'UNAVAILABLE' } | { state: 'READY'; view: SchoolOwnerOwnershipView };
export type OwnerOwnershipViewProps = Readonly<{
  language: string; waiting: boolean; concealed: boolean; schoolId: string | null; state: OwnerOwnershipState; onRefresh?: (() => void) | undefined;
}>;

/** School owner view: co-owners, the primary and notices for the verified school. Read only. */
export function OwnerOwnershipView(p: OwnerOwnershipViewProps): React.ReactElement {
  const t: T = (key, vars) => ownershipText(p.language, key, vars);
  const notice = p.waiting ? t('waiting') : p.concealed ? t('concealed') : !p.schoolId ? t('noSchool') : null;
  const view = p.state.state === 'READY' && p.state.view.schoolId.toLowerCase() === p.schoolId?.toLowerCase() ? p.state.view : null;
  return <section className={styles.page} aria-labelledby="owner-ownership-title" data-hon-native="" data-testid="owner-school-ownership">
    <header className={styles.head}>
      <div><h1 id="owner-ownership-title">{t('ownerTitle')}</h1><p className={styles.intro}>{t('ownerIntro')}</p></div>
      {notice === null && p.onRefresh ? <button type="button" className={styles.secondary} onClick={p.onRefresh} disabled={p.state.state === 'LOADING'}>{t('refresh')}</button> : null}
    </header>
    <p className={styles.meta}>{t('ownerScope')}</p>
    {notice ? <p className={styles.notice} role="status">{notice}</p>
      : p.state.state === 'DENIED' ? <p className={styles.notice} role="status">{t('ownerDenied')}</p>
      : p.state.state === 'GONE' ? <p className={styles.notice} role="status">{t('gone')}</p>
      : p.state.state === 'UNAVAILABLE' ? <div className={styles.notice} role="status"><p>{t('unavailable')}</p>
        {p.onRefresh ? <button type="button" className={styles.secondary} onClick={p.onRefresh}>{t('refresh')}</button> : null}</div>
      : !view ? <p className={styles.notice} role="status">{t('loading')}</p>
      : <>
        <article className={styles.card} aria-labelledby="owner-owners-title">
          <h2 id="owner-owners-title">{t('ownersTitle')}</h2>
          {view.primaryOwnerGrantId === null ? <p className={`${styles.notice} ${styles.warn}`} role="status">{t('ownerNoPrimary')}</p> : null}
          <ul className={styles.owners}>{view.owners.map((o) => <Owner key={o.ownerGrantId} owner={o} you={o.ownerGrantId === view.yourOwnerGrantId} language={p.language} t={t}/>)}</ul>
        </article>
        <Notices notices={view.notices} language={p.language} t={t}/>
        <p className={styles.meta}>{t('asOf', { time: moment(p.language, view.asOf) })}</p>
      </>}
  </section>;
}
