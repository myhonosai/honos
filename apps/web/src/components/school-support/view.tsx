import React from 'react';
import { SUPPORT_MESSAGE_MAX, SUPPORT_SUBJECT_MAX, SUPPORT_TOPICS, supportTextOk, type SupportRequest, type SupportRequestList, type SupportTopic } from '@hon/contracts';
import { supportText, type SupportKey } from './copy';
import type { SupportErrorKind } from './http';
import styles from './support.module.css';

type T = (key: SupportKey, vars?: Record<string, string>) => string;
export type ListState = { state: 'LOADING' | 'DENIED' | 'UNAVAILABLE' } | { state: 'READY'; list: SupportRequestList };
export type SupportDraft = Readonly<{ topic: SupportTopic | null; subject: string; message: string }>;
export type SupportAction = 'submit' | 'message';
export type SupportOutcome = null | Readonly<{ kind: 'SENDING' | 'DONE' | SupportErrorKind; action: SupportAction }>;
export const EMPTY_DRAFT: SupportDraft = { topic: null, subject: '', message: '' };

/** Whether a draft is what the server accepts, so the button only enables when it is. */
export const draftReady = (d: SupportDraft) => d.topic !== null && supportTextOk(d.subject, 3, SUPPORT_SUBJECT_MAX) && supportTextOk(d.message, 1, SUPPORT_MESSAGE_MAX);
/** Leading or trailing spaces and hidden characters are the only things a person can fix that length does not show. */
const textBad = (v: string) => v !== '' && v !== v.trim() || /[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v);

export type SupportViewProps = Readonly<{
  language: string; locale: string; waiting: boolean; concealed: boolean; hasSchool: boolean; pageHint: string | null;
  list: ListState; draft: SupportDraft; replyTo: string | null; replyText: string; outcome: SupportOutcome; locked: boolean; canRetry: boolean;
  onRefresh?: (() => void) | undefined; onDraft?: ((next: SupportDraft) => void) | undefined; onSubmit?: (() => void) | undefined;
  onReplyTo?: ((requestId: string | null) => void) | undefined; onReplyText?: ((text: string) => void) | undefined; onReply?: (() => void) | undefined;
  onTryAgain?: (() => void) | undefined;
}>;

const when = (locale: string, iso: string) => { try { return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso)); } catch { return iso; } };

function RequestCard({ r, t, p }: { r: SupportRequest; t: T; p: SupportViewProps }): React.ReactElement {
  const replying = p.replyTo === r.requestId, closed = r.status === 'CLOSED';
  const help = r.status === 'WAITING_ON_SCHOOL' ? 'waitingHelp' : r.status === 'RESOLVED' ? 'resolvedHelp' : r.status === 'CLOSED' ? 'closedHelp' : null;
  return <li className={styles.step} data-request={r.requestId} data-status={r.status}>
    <div className={styles.stepMain}>
      <strong>{r.subject}</strong>
      <div className={styles.chips}><span className={styles.chip} data-state={r.status}>{t(`st_${r.status}`)}</span><span className={styles.chip}>{t(`t_${r.topic}`)}</span></div>
      <span className={styles.meta}>{t('opened', { time: when(p.locale, r.openedAt) })} · {t('updated', { time: when(p.locale, r.updatedAt) })}</span>
      {help && <p className={r.status === 'WAITING_ON_SCHOOL' ? styles.warnText : styles.meta}>{t(help)}</p>}
      <ol className={styles.messages}>{r.messages.map((m) => <li key={m.seq}><span className={styles.meta}>{m.author} · {when(p.locale, m.at)}</span>{m.note}</li>)}</ol>
      {replying && <form className={styles.form} onSubmit={(e) => { e.preventDefault(); if (supportTextOk(p.replyText, 1, SUPPORT_MESSAGE_MAX)) p.onReply?.(); }}>
        <label className={styles.field}>{t('replyLabel')}<textarea rows={4} maxLength={SUPPORT_MESSAGE_MAX} value={p.replyText} disabled={p.locked} onChange={(e) => p.onReplyText?.(e.target.value)} /></label>
        {textBad(p.replyText) && <p className={styles.warnText} role="alert">{t('textProblem')}</p>}
        <div className={styles.row}><button type="submit" className={styles.primary} disabled={p.locked || !supportTextOk(p.replyText, 1, SUPPORT_MESSAGE_MAX)}>{p.locked ? t('sending') : t('sendReply')}</button>
          <button type="button" className={styles.secondary} disabled={p.locked} onClick={() => p.onReplyTo?.(null)}>{t('cancel')}</button></div>
      </form>}
    </div>
    {!closed && !replying && <div className={styles.row}><button type="button" className={styles.secondary} disabled={p.locked} onClick={() => p.onReplyTo?.(r.requestId)}>{t('reply')}</button></div>}
  </li>;
}

/** Pure view: what is shown is either the server's verified list or this person's unsent draft. */
export function SupportView(p: SupportViewProps): React.ReactElement {
  const t: T = (key, vars) => supportText(p.language, key, vars);
  const head = <div className={styles.head}><div><h1>{t('title')}</h1><p className={styles.intro}>{t('intro')}</p></div>
    {p.list.state === 'READY' && <button type="button" className={styles.secondary} disabled={p.locked} onClick={p.onRefresh}>{t('refresh')}</button>}</div>;
  if (p.waiting) return <section className={styles.page}>{head}<p className={styles.meta} role="status">{t('waiting')}</p></section>;
  if (p.concealed) return <section className={styles.page}>{head}<p className={styles.notice}>{t('concealed')}</p></section>;
  if (!p.hasSchool) return <section className={styles.page}>{head}<p className={styles.notice}>{t('noSchool')}</p></section>;
  if (p.list.state !== 'READY') return <section className={styles.page}>{head}
    {p.list.state === 'LOADING' ? <p className={styles.meta} role="status">{t('loading')}</p>
      : <div className={styles.notice} role="alert"><p>{t(p.list.state === 'DENIED' ? 'denied' : 'unavailable')}</p>
        {p.list.state === 'UNAVAILABLE' && <button type="button" className={styles.secondary} onClick={p.onRefresh}>{t('refresh')}</button>}</div>}
  </section>;
  const d = p.draft, set = (patch: Partial<SupportDraft>) => p.onDraft?.({ ...d, ...patch }), o = p.outcome;
  return <section className={styles.page}>
    {head}
    {o && o.kind !== 'SENDING' && <div className={`${styles.notice} ${o.kind === 'DONE' ? '' : styles.warn}`} role={o.kind === 'DONE' ? 'status' : 'alert'} data-support-outcome={o.kind}>
      <p>{o.kind === 'DONE' ? t(o.action === 'submit' ? 'done_submit' : 'done_message') : t(`e_${o.kind}`)}</p>
      {p.canRetry && <button type="button" className={styles.primary} onClick={p.onTryAgain}>{t('tryAgain')}</button>}</div>}
    <div className={styles.card} data-support-ask>
      <h2>{t('askTitle')}</h2>
      <form className={styles.form} onSubmit={(e) => { e.preventDefault(); if (draftReady(d)) p.onSubmit?.(); }}>
        <fieldset className={styles.fieldset} disabled={p.locked}><legend>{t('topic')}</legend>
          <div className={styles.grid}>{SUPPORT_TOPICS.map((k) => <label key={k} className={styles.check}>
            <input type="radio" name="topic" checked={d.topic === k} onChange={() => set({ topic: k })} />{t(`t_${k}`)}</label>)}</div>
        </fieldset>
        <label className={styles.field}>{t('subject')}<input maxLength={SUPPORT_SUBJECT_MAX} value={d.subject} disabled={p.locked} onChange={(e) => set({ subject: e.target.value })} />
          <span className={styles.meta}>{t('subjectHelp')}</span></label>
        <label className={styles.field}>{t('message')}<textarea rows={6} maxLength={SUPPORT_MESSAGE_MAX} value={d.message} disabled={p.locked} onChange={(e) => set({ message: e.target.value })} />
          <span className={styles.meta}>{t('messageHelp')}</span></label>
        {(textBad(d.subject) || textBad(d.message)) && <p className={styles.warnText} role="alert">{t('textProblem')}</p>}
        {p.pageHint && <p className={styles.meta} data-support-page>{t('fromPage', { page: p.pageHint })}</p>}
        <p className={styles.meta}>{t('privacy')}</p>
        <div className={styles.row}><button type="submit" className={styles.primary} disabled={p.locked || !draftReady(d)}>{p.locked && o?.action === 'submit' ? t('sending') : t('send')}</button></div>
      </form>
    </div>
    <div className={styles.card} data-support-list>
      <h2>{t('listTitle')}</h2><p className={styles.meta}>{t('replies')}</p>
      {p.list.list.requests.length === 0 ? <p className={styles.meta}>{t('none')}</p>
        : <ol className={styles.steps}>{p.list.list.requests.map((r) => <RequestCard key={r.requestId} r={r} t={t} p={p} />)}</ol>}
    </div>
  </section>;
}
