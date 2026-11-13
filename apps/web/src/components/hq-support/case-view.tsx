import React from 'react';
import { HQ_SUPPORT_NOTE_MAX, HQ_SUPPORT_PRIORITIES, HQ_SUPPORT_STATUSES, type HqSupportCaseDetail, type HqSupportPriority, type HqSupportStatus, type HqSupportChangeInput, type HqSupportEvent } from '@hon/contracts';
import { supportText, type SupportKey } from './copy';
import type { SupportOutcome } from './model';
import { Facts, Outcome, formatTime, priorityTone, statusTone } from './parts';
import styles from '../hq-access/hq-access.module.css';

export type SupportCaseState = { state: 'LOADING' } | { state: 'DENIED' } | { state: 'GONE' } | { state: 'INVALID' } | { state: 'UNAVAILABLE' }
  | { state: 'READY'; view: HqSupportCaseDetail };
export type ChangeDraft = Readonly<{ status: string; priority: string; assignee: string; note: string }>;
const KEEP = 'KEEP', NOBODY = 'NOBODY';

/** The change form as a closed request for the version that was read, or null when it changes nothing or is not valid. */
export function changeInputFrom(draft: ChangeDraft, view: HqSupportCaseDetail): HqSupportChangeInput | null {
  const c = view.case, input: HqSupportChangeInput = { expectedVersion: c.version };
  if (draft.status !== KEEP) { if (!(HQ_SUPPORT_STATUSES as readonly string[]).includes(draft.status)) return null; if (draft.status !== c.status) input.status = draft.status as HqSupportStatus; }
  if (draft.priority !== KEEP) { if (!(HQ_SUPPORT_PRIORITIES as readonly string[]).includes(draft.priority)) return null; if (draft.priority !== c.priority) input.priority = draft.priority as HqSupportPriority; }
  if (draft.assignee !== KEEP) {
    const to = draft.assignee === NOBODY ? null : view.assignees.find(a => a.principalId === draft.assignee)?.principalId;
    if (to === undefined) return null;
    if (to !== (c.assignee?.principalId ?? null)) input.assigneePrincipalId = to;
  }
  if (input.status === undefined && input.priority === undefined && input.assigneePrincipalId === undefined) return null;
  const note = draft.note.trim();
  if (note.length > HQ_SUPPORT_NOTE_MAX) return null;
  if (note) input.note = note;
  return input;
}

export type SupportCaseViewProps = Readonly<{ language: string; formattingLocale: string; concealed: boolean; state: SupportCaseState; busy: boolean;
  outcome: SupportOutcome; locked: boolean; canRetry: boolean; formKey: number;
  onRefresh: () => void; onReveal: () => void; onNote: (note: string) => void; onChange: (draft: ChangeDraft) => void; onTryAgain: () => void }>;

function EventLine({ e, t, locale }: { e: HqSupportEvent; t: (k: SupportKey, v?: Record<string, string>) => string; locale: string }): React.ReactElement {
  const changes = [
    e.statusFrom && e.statusTo ? t('eventStatus', { from: t(e.statusFrom), to: t(e.statusTo) }) : null,
    e.priorityFrom && e.priorityTo ? t('eventPriority', { from: t(e.priorityFrom), to: t(e.priorityTo) }) : null,
    e.assigneeChanged ? (e.assigneeTo ? t('eventAssignee', { name: e.assigneeTo.displayName }) : t('eventUnassigned')) : null,
  ].filter((x): x is string => x !== null);
  return <li className={styles.card} data-support-event={e.seq}>
    <div className={styles.cardHead}><h3 style={{ margin: 0, fontSize: 15 }}>{`${e.actor.displayName} · ${t(`event${e.kind}` as SupportKey)}`}</h3>
      <span className={styles.meta}>{`${formatTime(locale, e.occurredAt)} UTC`}</span></div>
    {changes.length > 0 && <p className={styles.meta}>{changes.join(' · ')}</p>}
    {e.note !== null && <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{e.note}</p>}
  </li>;
}

/** Presentation only. Every fact comes from the verified server answer. */
export function HqSupportCaseView(props: SupportCaseViewProps): React.ReactElement {
  const { language, formattingLocale, concealed, state, busy, locked } = props;
  const t = (key: SupportKey, vars?: Record<string, string>) => supportText(language, key, vars);
  const head = <header className={styles.head}>
    <div><p className={styles.meta}><a href="/hq/support">{t('back')}</a></p>
      <h1>{state.state === 'READY' && !concealed ? state.view.case.subject : t('caseTitle')}</h1></div>
    {!concealed && <button type="button" className={styles.secondary} disabled={busy || state.state === 'INVALID'} onClick={props.onRefresh}>{t('refresh')}</button>}
  </header>;
  if (concealed) return <section className={styles.access} data-hq-support-case="concealed">{head}
    <div className={styles.notice} role="status"><p>{t('concealed')}</p><button type="button" className={styles.secondary} onClick={props.onReveal}>{t('reveal')}</button></div></section>;
  if (state.state !== 'READY') {
    const key: SupportKey = state.state === 'LOADING' ? 'loadingCase' : state.state === 'DENIED' ? 'denied' : state.state === 'GONE' ? 'gone' : state.state === 'INVALID' ? 'invalid' : 'unavailable';
    return <section className={styles.access} data-hq-support-case={state.state.toLowerCase()} aria-busy={state.state === 'LOADING'}>{head}
      <p className={styles.notice} role="status">{t(key)}</p></section>;
  }
  const v = state.view, c = v.case, closed = c.status === 'CLOSED';
  const onNote = (event: React.FormEvent<HTMLFormElement>) => { event.preventDefault(); props.onNote(String(new FormData(event.currentTarget).get('note') ?? '')); };
  const onChange = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const f = new FormData(event.currentTarget), g = (k: string) => String(f.get(k) ?? '');
    props.onChange({ status: g('status'), priority: g('priority'), assignee: g('assignee'), note: g('note') });
  };
  const done: SupportKey = props.outcome?.kind === 'DONE' && props.outcome.receipt.operation === 'NOTE' ? 'noted' : 'changedOk';
  return <section className={styles.access} data-hq-support-case="ready">{head}
    <article className={styles.card} aria-labelledby="hq-support-case-facts">
      <div className={styles.cardHead}><h2 id="hq-support-case-facts">{t('caseTitle')}</h2>
        <span className={styles.status} data-tone={priorityTone(c.priority)}>{t(c.priority)}</span>
        <span className={styles.status} data-tone={statusTone(c.status)}>{t(c.status)}</span></div>
      <Facts rows={[[t('organization'), c.organizationDisplayName], [t('school'), c.schoolDisplayName ?? t('wholeOrganization')], [t('category'), t(c.category)],
        [t('assignee'), c.assignee?.displayName ?? t('unassigned')], [t('openedBy'), c.openedBy.displayName], [t('opened'), `${formatTime(formattingLocale, c.openedAt)} UTC`],
        [t('updated'), `${formatTime(formattingLocale, c.updatedAt)} UTC`], [t('closed'), c.closedAt ? `${formatTime(formattingLocale, c.closedAt)} UTC` : '—']]}/>
      {c.schoolId && <div className={styles.actions}><a className={styles.secondary} data-hq-message-owners=""
        href={`/hq/communications?${new URLSearchParams({ organizationId: c.organizationId, schoolId: c.schoolId, supportCaseId: c.caseId })}`}>{t('messageOwners')}</a></div>}
    </article>
    <Outcome language={language} outcome={props.outcome} done={done} canRetry={props.canRetry} onTryAgain={props.onTryAgain}/>
    {closed ? <p className={styles.notice}>{t('closedFinal')}</p> : <React.Fragment key={props.formKey}>
      <form className={styles.form} onSubmit={onNote} aria-labelledby="hq-support-note-title" data-support-form="note">
        <h3 id="hq-support-note-title">{t('addNote')}</h3>
        <fieldset className={styles.fields} disabled={locked}>
          <label htmlFor="hq-support-case-note">{t('note')}</label>
          <textarea id="hq-support-case-note" name="note" required rows={3} maxLength={HQ_SUPPORT_NOTE_MAX} aria-describedby="hq-support-case-note-help"/>
          <p id="hq-support-case-note-help" className={styles.meta}>{t('noteHelp')}</p>
        </fieldset>
        <div className={styles.actions}><button type="submit" className={styles.primary} disabled={locked}>{t('submitNote')}</button></div>
      </form>
      <form className={styles.form} onSubmit={onChange} aria-labelledby="hq-support-change-title" data-support-form="change">
        <h3 id="hq-support-change-title">{t('change')}</h3>
        <fieldset className={styles.fields} disabled={locked}>
          <div className={styles.pair}>
            <div><label htmlFor="hq-support-change-status">{t('status')}</label>
              <select id="hq-support-change-status" name="status" defaultValue={KEEP}><option value={KEEP}>{`${t('keep')} (${t(c.status)})`}</option>
                {HQ_SUPPORT_STATUSES.filter(s => s !== c.status).map(s => <option key={s} value={s}>{t(s)}</option>)}</select></div>
            <div><label htmlFor="hq-support-change-priority">{t('priority')}</label>
              <select id="hq-support-change-priority" name="priority" defaultValue={KEEP}><option value={KEEP}>{`${t('keep')} (${t(c.priority)})`}</option>
                {HQ_SUPPORT_PRIORITIES.filter(p => p !== c.priority).map(p => <option key={p} value={p}>{t(p)}</option>)}</select></div>
            <div><label htmlFor="hq-support-change-assignee">{t('assignee')}</label>
              <select id="hq-support-change-assignee" name="assignee" defaultValue={KEEP}>
                <option value={KEEP}>{`${t('keep')} (${c.assignee?.displayName ?? t('unassigned')})`}</option>
                {c.assignee && <option value={NOBODY}>{t('unassigned')}</option>}
                {v.assignees.filter(a => a.principalId !== c.assignee?.principalId).map(a => <option key={a.principalId} value={a.principalId}>{a.displayName}</option>)}
              </select></div>
          </div>
          <label htmlFor="hq-support-change-note">{t('changeNote')}</label>
          <textarea id="hq-support-change-note" name="note" rows={2} maxLength={HQ_SUPPORT_NOTE_MAX}/>
          {c.status === 'RESOLVED' && <p className={styles.meta}>{t('reopenHelp')}</p>}
        </fieldset>
        <div className={styles.actions}><button type="submit" className={styles.primary} disabled={locked}>{t('submitChange')}</button></div>
      </form>
    </React.Fragment>}
    <section aria-labelledby="hq-support-history"><h2 id="hq-support-history" style={{ fontSize: 17 }}>{t('history')}</h2>
      <ol className={styles.list}>{[...v.events].reverse().map(e => <EventLine key={e.seq} e={e} t={t} locale={formattingLocale}/>)}</ol></section>
    <p className={styles.meta}>{t('asOf', { time: formatTime(formattingLocale, v.asOf) })} {t('viewer', { name: v.viewer.displayName })}</p>
  </section>;
}
