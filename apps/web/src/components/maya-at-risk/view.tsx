import React from 'react';
import type { MayaAtRiskStudent, MayaAtRiskStudents, MayaNextStep, MayaRiskFactor, MayaRiskLevel } from '@hon/contracts';
import styles from '../membership-changes/membership-changes.module.css';

export type MayaListState = { state: 'LOADING' | 'DENIED' | 'UNAVAILABLE' }
  | { state: 'READY'; read: MayaAtRiskStudents; items: readonly MayaAtRiskStudent[]; nextAfter: string | null; more: 'IDLE' | 'LOADING' | 'FAILED' };
export type MayaAtRiskViewProps = Readonly<{
  language: string; waiting: boolean; concealed: boolean; hasSchool: boolean; list: MayaListState;
  onRefresh?: (() => void) | undefined; onMore?: (() => void) | undefined;
  /** 0284: the per-student "Ask Maya" control (omitted in static previews). */
  renderAsk?: ((student: MayaAtRiskStudent) => React.ReactNode) | undefined;
}>;

export const LEVEL_LABEL: Record<MayaRiskLevel, string> = { HIGH: 'High risk', MEDIUM: 'Medium risk', WATCH: 'Watch' };
export const STEP_LABEL: Record<MayaNextStep, string> = {
  CALL_TO_CHECK_IN: 'Call the family to check in',
  INVITE_BACK_TO_CLASS: 'Invite them back to a class this week',
  PLAN_PROGRESS_TALK: 'Plan a talk about their next rank',
  REVIEW_TUITION_BALANCE: 'Review the tuition balance with them',
  DISCUSS_RENEWAL: 'Talk with them about renewing',
};
const STATE_LABEL: Record<MayaAtRiskStudent['membershipState'], string> = { ACTIVE: 'Active', FROZEN: 'Paused', CANCELLATION_PENDING: 'Cancellation pending' };
const day = (language: string, value: string) => new Date(`${value}T00:00:00Z`).toLocaleDateString(language, { dateStyle: 'medium', timeZone: 'UTC' });
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** One plain sentence per factor, from the recorded numbers only. */
export function factorText(language: string, factor: MayaRiskFactor): string {
  switch (factor.code) {
    case 'LONG_ABSENCE': return factor.neverAttended ? 'Has not attended a class since joining.'
      : `No class attended in ${plural(factor.daysSinceLastAttendance ?? 0, 'day', 'days')}.`;
    case 'ATTENDANCE_DROP': return `Attendance dropped: ${plural(factor.last28Days, 'class', 'classes')} in the last 4 weeks, ${factor.previous28Days} in the 4 weeks before.`;
    case 'NO_RANK_PROGRESS': return `No rank promotion in ${plural(factor.daysSinceProgress, 'day', 'days')}.`;
    case 'TUITION_OVERDUE': return `${plural(factor.overdueInvoiceCount, 'invoice is', 'invoices are')} overdue on this student's membership or family billing account.`;
    case 'TERM_ENDING': return factor.cancellationPending ? 'A cancellation is pending.' : `Membership term ends ${day(language, factor.termEndsOn ?? '')}.`;
  }
}

export function MayaAtRiskView(p: MayaAtRiskViewProps): React.ReactElement {
  const list = p.list;
  return <section className={styles.page} aria-labelledby="maya-title" aria-busy={p.waiting || list.state === 'LOADING'} data-testid="maya-at-risk">
    <header>
      <h1 id="maya-title">Students at risk</h1>
      <p className={styles.meta}>Maya, your retention specialist, checks every active, paused and cancelling membership for long absences, falling attendance,
        no rank progress, overdue tuition and terms that are ending. The score ranks who to reach first; it is not a prediction. Nothing is sent or changed from this page.</p>
    </header>
    {p.concealed || p.waiting || !p.hasSchool ? <p className={styles.meta} role="status">{p.concealed ? 'Hidden while this window is in the background.'
        : p.waiting ? 'Checking your school…' : 'Choose a school to see its students at risk.'}</p>
      : <article className={styles.card} aria-labelledby="maya-list-title">
        <div className={styles.cardHead}><h2 id="maya-list-title">Who to reach first</h2>
          <button type="button" className={styles.secondary} disabled={list.state === 'LOADING'} onClick={p.onRefresh}>Refresh</button></div>
        {list.state === 'LOADING' ? <p className={styles.meta} role="status">Maya is reading attendance, rank, tuition and term records…</p>
          : list.state === 'DENIED' ? <p className={styles.meta} role="status">You need the retention review permission at this school to see students at risk.</p>
          : list.state !== 'READY' ? <p className={styles.meta} role="status">The list is not available right now. Nothing changed.</p>
          : <>
            <p className={styles.meta} data-testid="maya-counts">
              {list.read.counts.HIGH + list.read.counts.MEDIUM + list.read.counts.WATCH === 0 ? 'No student is at risk right now.'
                : `${list.read.counts.HIGH} high risk · ${list.read.counts.MEDIUM} medium risk · ${list.read.counts.WATCH} to watch`}
              {list.read.tuitionChecked ? '' : ' · Tuition is not included because you do not have billing access.'}
            </p>
            <ul className={styles.list}>
              {list.items.map((s) => <li key={s.membershipId} data-testid="maya-student">
                <h3>{s.givenName} {s.familyName} <span className={styles.meta}>· {LEVEL_LABEL[s.level]} ({s.score}/100) · {STATE_LABEL[s.membershipState]}</span></h3>
                <ul>{s.factors.map((f) => <li key={f.code}>{factorText(p.language, f)}</li>)}</ul>
                <p><strong>Suggested next step:</strong> {STEP_LABEL[s.suggestedNextStep]}</p>
                {p.renderAsk ? p.renderAsk(s) : null}
              </li>)}
            </ul>
            {list.nextAfter ? <button type="button" className={styles.secondary} disabled={list.more === 'LOADING'} onClick={p.onMore}>
              {list.more === 'LOADING' ? 'Loading…' : list.more === 'FAILED' ? 'Could not load more. Try again' : 'Show more'}</button> : null}
            <p className={styles.meta}>To record a review for one membership, use <a href="/staff/retention/review">Retention review</a>.</p>
          </>}
      </article>}
  </section>;
}
