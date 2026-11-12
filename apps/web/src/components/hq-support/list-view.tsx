import React from 'react';
import { HQ_SUPPORT_CATEGORIES, HQ_SUPPORT_NOTE_MAX, HQ_SUPPORT_PRIORITIES, HQ_SUPPORT_STATUSES, HQ_SUPPORT_SUBJECT_MAX,
  type HqSupportCase, type HqSupportCaseList, type HqSupportListFilter, type HqSupportOpenInput, type HqSupportSchools } from '@hon/contracts';
import { supportText, type SupportKey } from './copy';
import type { SupportOutcome } from './model';
import { Facts, Outcome, formatTime, priorityTone, statusTone } from './parts';
import styles from '../hq-access/hq-access.module.css';

export type SupportListState = { state: 'LOADING' } | { state: 'DENIED' } | { state: 'UNAVAILABLE' }
  | { state: 'READY'; view: HqSupportCaseList; cases: readonly HqSupportCase[]; loadingMore: boolean; moreFailed: boolean };
export type SchoolsState = { state: 'IDLE' } | { state: 'LOADING' } | { state: 'FAILED' } | { state: 'READY'; view: HqSupportSchools };
export type OpenDraft = Readonly<{ target: string; subject: string; category: string; priority: string; note: string }>;

/** The person's form as a closed request, or null when it is not one. The target names an organization or one of its schools. */
export function openInputFrom(draft: OpenDraft, schools: HqSupportSchools | null): HqSupportOpenInput | null {
  if (!schools) return null;
  const [kind, id] = draft.target.split(':');
  const school = kind === 'school' ? schools.schools.find(s => s.schoolId === id) : undefined;
  const org = kind === 'org' ? schools.schools.find(s => s.organizationId === id) : school;
  if (!org) return null;
  const subject = draft.subject.trim(), note = draft.note.trim();
  if (subject.length < 3 || subject.length > HQ_SUPPORT_SUBJECT_MAX || note.length < 1 || note.length > HQ_SUPPORT_NOTE_MAX) return null;
  if (!(HQ_SUPPORT_CATEGORIES as readonly string[]).includes(draft.category) || !(HQ_SUPPORT_PRIORITIES as readonly string[]).includes(draft.priority)) return null;
  return { organizationId: org.organizationId, schoolId: school ? school.schoolId : null, subject, category: draft.category as HqSupportOpenInput['category'],
    priority: draft.priority as HqSupportOpenInput['priority'], note };
}

export type SupportListViewProps = Readonly<{ language: string; formattingLocale: string; concealed: boolean; state: SupportListState;
  filter: HqSupportListFilter | null; formOpen: boolean; schools: SchoolsState; outcome: SupportOutcome; locked: boolean; canRetry: boolean;
  onFilter: (f: HqSupportListFilter | null) => void; onMore: () => void; onRefresh: () => void; onReveal: () => void; onForm: (open: boolean) => void;
  onOpen: (draft: OpenDraft) => void; onTryAgain: () => void }>;

const FILTERS: readonly (HqSupportListFilter | null)[] = ['ACTIVE', ...HQ_SUPPORT_STATUSES, null];

function OpenForm(props: SupportListViewProps): React.ReactElement {
  const { language, schools, locked } = props;
  const t = (key: SupportKey) => supportText(language, key);
  if (schools.state !== 'READY') return <div className={styles.form}><h3>{t('openCase')}</h3>
    <p className={styles.meta} role="status">{t(schools.state === 'FAILED' ? 'schoolsFailed' : 'schoolsLoading')}</p>
    <div className={styles.actions}><button type="button" className={styles.secondary} onClick={() => props.onForm(false)}>{t('cancel')}</button></div></div>;
  const orgs = new Map<string, { name: string; schools: { id: string; name: string }[] }>();
  for (const s of schools.view.schools) {
    const o = orgs.get(s.organizationId) ?? { name: s.organizationDisplayName, schools: [] };
    o.schools.push({ id: s.schoolId, name: s.schoolDisplayName }); orgs.set(s.organizationId, o);
  }
  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const f = new FormData(event.currentTarget), v = (k: string) => String(f.get(k) ?? '');
    props.onOpen({ target: v('target'), subject: v('subject'), category: v('category'), priority: v('priority'), note: v('note') });
  };
  return <form className={styles.form} onSubmit={submit} aria-labelledby="hq-support-open-title" data-support-form="open">
    <h3 id="hq-support-open-title">{t('openCase')}</h3>
    <fieldset className={styles.fields} disabled={locked}>
      <label htmlFor="hq-support-target">{t('schoolPick')}</label>
      <select id="hq-support-target" name="target" required defaultValue="">
        <option value="" disabled>{t('schoolPickNone')}</option>
        {[...orgs].map(([id, o]) => <optgroup key={id} label={o.name || id}>
          <option value={`org:${id}`}>{`${o.name} · ${t('wholeOrganization')}`}</option>
          {o.schools.map(s => <option key={s.id} value={`school:${s.id}`}>{s.name || s.id}</option>)}
        </optgroup>)}
      </select>
      {schools.view.truncated && <p className={styles.meta}>{t('schoolsTruncated')}</p>}
      <label htmlFor="hq-support-subject">{t('subject')}</label>
      <input id="hq-support-subject" name="subject" required minLength={3} maxLength={HQ_SUPPORT_SUBJECT_MAX} aria-describedby="hq-support-subject-help" autoComplete="off"/>
      <p id="hq-support-subject-help" className={styles.meta}>{t('subjectHelp')}</p>
      <div className={styles.pair}>
        <div><label htmlFor="hq-support-category">{t('category')}</label>
          <select id="hq-support-category" name="category" defaultValue="ACCOUNT_ACCESS">{HQ_SUPPORT_CATEGORIES.map(c => <option key={c} value={c}>{t(c)}</option>)}</select></div>
        <div><label htmlFor="hq-support-priority">{t('priority')}</label>
          <select id="hq-support-priority" name="priority" defaultValue="NORMAL">{HQ_SUPPORT_PRIORITIES.map(p => <option key={p} value={p}>{t(p)}</option>)}</select></div>
      </div>
      <label htmlFor="hq-support-note">{t('firstNote')}</label>
      <textarea id="hq-support-note" name="note" required rows={4} maxLength={HQ_SUPPORT_NOTE_MAX} aria-describedby="hq-support-note-help"/>
      <p id="hq-support-note-help" className={styles.meta}>{t('noteHelp')}</p>
    </fieldset>
    <div className={styles.actions}><button type="submit" className={styles.primary} disabled={locked}>{t('submitOpen')}</button>
      <button type="button" className={styles.secondary} disabled={locked} onClick={() => props.onForm(false)}>{t('cancel')}</button></div>
  </form>;
}

/** Presentation only. Every fact comes from the verified server answer. */
export function HqSupportListView(props: SupportListViewProps): React.ReactElement {
  const { language, formattingLocale, concealed, state, filter } = props;
  const t = (key: SupportKey, vars?: Record<string, string>) => supportText(language, key, vars);
  const head = <header className={styles.head}>
    <div><h1>{t('title')}</h1><p className={styles.intro}>{t('intro')}</p></div>
    {!concealed && <button type="button" className={styles.secondary} disabled={state.state === 'LOADING'} onClick={props.onRefresh}>{t('refresh')}</button>}
  </header>;
  if (concealed) return <section className={styles.access} data-hq-support="concealed">{head}
    <div className={styles.notice} role="status"><p>{t('concealed')}</p><button type="button" className={styles.secondary} onClick={props.onReveal}>{t('reveal')}</button></div></section>;
  if (state.state !== 'READY') return <section className={styles.access} data-hq-support={state.state.toLowerCase()} aria-busy={state.state === 'LOADING'}>{head}
    <p className={styles.notice} role="status">{t(state.state === 'LOADING' ? 'loading' : state.state === 'DENIED' ? 'denied' : 'unavailable')}</p></section>;
  const v = state.view, s = v.summary;
  const count = (f: HqSupportListFilter | null) => f === null ? s.OPEN + s.WAITING_ON_SCHOOL + s.RESOLVED + s.CLOSED : f === 'ACTIVE' ? s.OPEN + s.WAITING_ON_SCHOOL : s[f];
  const done = props.outcome?.kind === 'DONE' ? props.outcome.receipt.case : null;
  return <section className={styles.access} data-hq-support="ready">{head}
    <p className={styles.meta}>{t('viewer', { name: v.viewer.displayName })}</p>
    <Facts rows={[[t('summaryUrgent'), String(s.urgentActive)], [t('summaryUnassigned'), String(s.unassignedActive)]]}/>
    <div className={styles.filters} role="group" aria-label={t('filterLabel')}>
      {FILTERS.map(f => <button key={f ?? 'ALL'} type="button" aria-pressed={filter === f} onClick={() => props.onFilter(f)}>
        {t(f === null ? 'filterALL' : f === 'ACTIVE' ? 'filterACTIVE' : f)}<span>{count(f)}</span></button>)}
    </div>
    <Outcome language={language} outcome={props.outcome} done="opened_ok" canRetry={props.canRetry} onTryAgain={props.onTryAgain}>
      {done && <a className={styles.secondary} href={`/hq/support/${done.caseId}`}>{t('viewCase')}</a>}</Outcome>
    {props.formOpen ? <OpenForm {...props}/> : <div className={styles.actions}>
      <button type="button" className={styles.primary} disabled={props.locked} onClick={() => props.onForm(true)}>{t('openCase')}</button></div>}
    {state.cases.length === 0 ? <p className={styles.notice}>{t('none')}</p> : <ul className={styles.list} aria-label={t('title')}>
      {state.cases.map(c => <li key={c.caseId} className={styles.card} data-support-case={c.caseId}>
        <div className={styles.cardHead}><h2><a href={`/hq/support/${c.caseId}`}>{c.subject}</a></h2>
          <span className={styles.status} data-tone={priorityTone(c.priority)}>{t(c.priority)}</span>
          <span className={styles.status} data-tone={statusTone(c.status)}>{t(c.status)}</span></div>
        <Facts rows={[[t('organization'), c.organizationDisplayName], [t('school'), c.schoolDisplayName ?? t('wholeOrganization')],
          [t('category'), t(c.category)], [t('assignee'), c.assignee?.displayName ?? t('unassigned')],
          [t('opened'), `${formatTime(formattingLocale, c.openedAt)} UTC`], [t('updated'), `${formatTime(formattingLocale, c.updatedAt)} UTC`],
          [t('notes'), String(c.noteCount)], [t('openedBy'), c.openedBy.displayName]]}/>
      </li>)}
    </ul>}
    {state.moreFailed && <p className={styles.meta} role="alert">{t('moreFailed')}</p>}
    {v.nextCursor && <div className={styles.actions}><button type="button" className={styles.secondary} disabled={state.loadingMore} onClick={props.onMore}>{t('more')}</button></div>}
    <p className={styles.meta}>{t('asOf', { time: formatTime(formattingLocale, v.asOf) })}</p>
  </section>;
}
