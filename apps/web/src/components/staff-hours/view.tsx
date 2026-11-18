import React from 'react';
import { summarizeTimesheet, type MyTimeClock, type TimeClockAction, type TimeEntry, type TimesheetPerson, type TimesheetWeek } from '@hon/contracts';
import { addDays } from '../school-calendar/range';
import { hoursCopy, type HoursCopy, type HoursOutcomeKind } from './copy';
import { timeOf, type EntryDraft, type EntryField } from './format';
import page from '../membership-changes/membership-changes.module.css';
import styles from './staff-hours.module.css';

export type ClockRead = { state: 'LOADING' | 'DENIED' | 'UNAVAILABLE' } | { state: 'READY'; clock: MyTimeClock };
export type SheetRead = { state: 'LOADING' | 'DENIED' | 'UNAVAILABLE' } | { state: 'READY'; week: TimesheetWeek };
export type HoursOutcome = null | Readonly<{ kind: HoursOutcomeKind }>;
export type StaffHoursViewProps = Readonly<{
  language: string; waiting: boolean; concealed: boolean; hasSchool: boolean;
  clock: ClockRead; sheet: SheetRead; weekStart: string;
  draft: EntryDraft | null; problems: readonly string[]; outcome: HoursOutcome; locked: boolean; canRetry: boolean;
  onPunch?: ((action: TimeClockAction) => void) | undefined; onWeek?: ((step: -1 | 0 | 1) => void) | undefined;
  onAdd?: ((principalId: string) => void) | undefined; onFix?: ((entry: TimeEntry) => void) | undefined;
  onEdit?: ((field: EntryField, value: string) => void) | undefined;
  onSave?: (() => void) | undefined; onClose?: (() => void) | undefined;
  onDecide?: ((person: TimesheetPerson, action: 'APPROVE' | 'REOPEN') => void) | undefined; onExport?: (() => void) | undefined;
  onRefresh?: (() => void) | undefined; onTryAgain?: (() => void) | undefined;
}>;

const CALM: readonly HoursOutcomeKind[] = ['SAVING', 'PUNCHED', 'SAVED', 'APPROVED_WEEK', 'REOPENED'];
const at = (date: string) => { const [y, m, d] = date.split('-').map(Number) as [number, number, number]; return new Date(Date.UTC(y, m - 1, d)); };
function dayLabel(language: string, date: string): string {
  try { return at(date).toLocaleDateString(language, { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }); } catch { return date; }
}
function entryText(c: HoursCopy, e: TimeEntry, zone: string, language: string): string {
  const from = `${dayLabel(language, e.localDate)} ${timeOf(e.clockInAt, zone, language)}`;
  return e.clockOutAt ? c.inOut(from, timeOf(e.clockOutAt, zone, language)) : c.stillIn(from);
}

function ClockCard({ p, c, clock }: { p: StaffHoursViewProps; c: HoursCopy; clock: MyTimeClock }): React.ReactElement {
  const open = clock.open;
  const approved = clock.approval?.status === 'APPROVED';
  const status = !open ? c.offClock : c.onClock(timeOf(open.clockInAt, clock.timezone, p.language));
  const summary = summarizeTimesheet(clock.entries);
  const button = (action: TimeClockAction, label: string) =>
    <button type="button" className={page.primary} disabled={p.locked} onClick={() => p.onPunch?.(action)} data-punch={action}>{label}</button>;
  return <section className={styles.card} aria-labelledby="time-clock-title" data-testid="time-clock" data-clock={!open ? 'OFF' : 'ON'}>
    <h2 id="time-clock-title">{c.clockTitle}</h2>
    <p className={styles.status} role="status">{status}</p>
    {clock.todayShifts.length
      ? clock.todayShifts.map(s => <p key={s.shiftId} className={page.meta}>{c.todayShift(`${timeOf(s.startsAt, clock.timezone, p.language)} – ${timeOf(s.endsAt, clock.timezone, p.language)}${s.position ? ` · ${s.position}` : ''}`)}</p>)
      : <p className={page.meta}>{c.noShiftToday}</p>}
    <div className={page.row}>
      {!open ? (approved ? <p className={page.meta} data-testid="clock-approved">{c.weekApproved}</p> : button('CLOCK_IN', c.clockIn))
        : button('CLOCK_OUT', c.clockOut)}
    </div>
    <p className={page.meta}>{c.serverTime}</p>
    <h3>{c.thisWeek} · {c.hours(summary.workedMinutes)}</h3>
    {clock.entries.length === 0 ? <p className={page.meta}>{c.noEntries}</p>
      : <ul className={styles.entries} data-testid="my-entries">{clock.entries.map(e => <li key={e.entryId}>{entryText(c, e, clock.timezone, p.language)}
        {e.workedMinutes !== null ? ` · ${c.hours(e.workedMinutes)}` : ''}{e.origin === 'MANAGER' ? ` · ${c.byManager}` : ''}</li>)}</ul>}
  </section>;
}

function Sheet({ p, c, week }: { p: StaffHoursViewProps; c: HoursCopy; week: TimesheetWeek }): React.ReactElement {
  return <section className={styles.card} aria-labelledby="timesheets-title" data-testid="timesheets">
    <h2 id="timesheets-title">{c.sheetTitle}</h2>
    <nav className={page.row} aria-label={c.sheetTitle}>
      <button type="button" className={page.secondary} disabled={p.locked} onClick={() => p.onWeek?.(-1)} data-week="previous">{c.previous}</button>
      <button type="button" className={page.secondary} disabled={p.locked} onClick={() => p.onWeek?.(0)} data-week="this">{c.current}</button>
      <button type="button" className={page.secondary} disabled={p.locked} onClick={() => p.onWeek?.(1)} data-week="next">{c.next}</button>
      <strong data-testid="week-label">{c.weekOf(`${dayLabel(p.language, week.weekStart)} – ${dayLabel(p.language, addDays(week.weekStart, 6))}`)}</strong>
      <button type="button" className={page.secondary} disabled={p.locked || week.people.length === 0} onClick={p.onExport} data-action="export">{c.exportCsv}</button>
    </nav>
    <p className={page.meta}>{c.timezone(week.timezone)} · {c.noPay}</p>
    {week.people.length === 0 ? <p className={page.meta}>{c.noStaff}</p> : <div className={styles.scroll}>
      <table className={styles.grid} data-testid="timesheet-grid">
        <thead><tr><th scope="col">{c.person}</th><th scope="col">{c.entries}</th><th scope="col">{c.worked}</th><th scope="col">{c.scheduled}</th>
          <th scope="col">{c.checks}</th><th scope="col">{c.status}</th></tr></thead>
        <tbody>{week.people.map(person => {
          const s = summarizeTimesheet(person.entries), approved = person.approval?.status === 'APPROVED';
          return <tr key={person.principalId} data-person={person.principalId}>
            <th scope="row">{person.displayName}</th>
            <td><ul className={styles.entries}>{person.entries.map(e => <li key={e.entryId} data-entry={e.entryId}>
              <span>{entryText(c, e, week.timezone, p.language)}{e.origin === 'MANAGER' ? ` · ${c.byManager}` : ''}</span>
              {!approved ? <button type="button" className={styles.small} disabled={p.locked} onClick={() => p.onFix?.(e)} data-fix={e.entryId}>{c.fixEntry}</button> : null}
            </li>)}</ul>
              {!approved ? <button type="button" className={styles.small} disabled={p.locked} onClick={() => p.onAdd?.(person.principalId)} data-add={person.principalId}>{c.addEntry(person.displayName)}</button> : null}</td>
            <td className={styles.total} data-worked={person.principalId}>{c.hours(s.workedMinutes)}</td>
            <td data-scheduled={person.principalId}>{c.hours(person.scheduledMinutes)}</td>
            <td data-checks={person.principalId}>{s.flags.length ? <ul className={styles.flags}>{s.flags.map(f => <li key={f} data-flag={f}>{c.flags[f]}</li>)}</ul> : '–'}</td>
            <td><span className={approved ? styles.approved : styles.tag} data-approval={person.principalId}>{approved ? c.approvedTag : c.openTag}</span>
              <button type="button" className={styles.small} disabled={p.locked} onClick={() => p.onDecide?.(person, approved ? 'REOPEN' : 'APPROVE')}
                data-decide={`${person.principalId}/${approved ? 'REOPEN' : 'APPROVE'}`}>{approved ? c.reopen : c.approve}</button></td>
          </tr>;
        })}</tbody>
      </table>
    </div>}
    {p.draft ? <form className={page.form} aria-labelledby="entry-form-title" data-testid="entry-form" onSubmit={e => { e.preventDefault(); p.onSave?.(); }}>
      <h3 id="entry-form-title">{p.draft.entryId ? c.formFix : c.formAdd}</h3>
      <div className={styles.fields}>
        <label>{c.fieldPerson}
          <select value={p.draft.staffPrincipalId} disabled={p.locked || p.draft.entryId !== null} onChange={e => p.onEdit?.('staffPrincipalId', e.target.value)} data-field="staffPrincipalId">
            {week.people.map(s => <option key={s.principalId} value={s.principalId}>{s.displayName}</option>)}
          </select></label>
        <label>{c.fieldIn}<input type="datetime-local" value={p.draft.clockIn} disabled={p.locked} onChange={e => p.onEdit?.('clockIn', e.target.value)} data-field="clockIn"/></label>
        <label>{c.fieldOut}<input type="datetime-local" value={p.draft.clockOut} disabled={p.locked} onChange={e => p.onEdit?.('clockOut', e.target.value)} data-field="clockOut"/></label>
      </div>
      <label className={styles.reason}>{c.fieldReason}<textarea maxLength={300} rows={2} value={p.draft.reason} placeholder={c.reasonHint} disabled={p.locked}
        onChange={e => p.onEdit?.('reason', e.target.value)} data-field="reason"/></label>
      {p.problems.length ? <ul className={styles.problems} data-testid="entry-problems">{p.problems.map(x => <li key={x}>{x}</li>)}</ul> : null}
      <div className={page.row}>
        <button type="submit" className={page.primary} disabled={p.locked || p.problems.length > 0} data-entry-action="save">{c.save}</button>
        <button type="button" className={page.secondary} disabled={p.locked} onClick={p.onClose} data-entry-action="close">{c.close}</button>
      </div>
    </form> : null}
    <p className={page.meta}>{c.permissionsHint} <a href="/staff/roles">Roles &amp; permissions</a></p>
  </section>;
}

/** Staff > Hours (0478): pure, every state comes from props. The time clock for oneself, timesheets for managers. */
export function StaffHoursView(p: StaffHoursViewProps): React.ReactElement {
  const c = hoursCopy(p.language);
  const loading = p.clock.state === 'LOADING' || p.sheet.state === 'LOADING';
  const denied = p.clock.state === 'DENIED' && p.sheet.state === 'DENIED';
  const failed = !loading && !denied && p.clock.state !== 'READY' && p.sheet.state !== 'READY';
  return <section className={page.page} aria-labelledby="staff-hours-title" data-staff-hours={denied ? 'DENIED' : loading ? 'LOADING' : 'READY'}>
    <header className={page.head}><div>
      <h1 id="staff-hours-title">{c.pageTitle}</h1>
      <p className={page.intro}>{c.intro}</p>
    </div></header>
    {p.concealed ? <p className={page.notice} role="status">{c.hidden}</p>
      : p.waiting ? <p className={page.notice} role="status">{c.checking}</p>
      : !p.hasSchool ? <p className={page.notice} role="status">{c.chooseSchool}</p>
      : <>
        {p.outcome ? <div className={`${page.notice} ${CALM.includes(p.outcome.kind) ? '' : page.warn}`} role="status" data-testid="hours-outcome" data-outcome={p.outcome.kind}>
          <p>{c.outcomes[p.outcome.kind]}</p>
          {p.canRetry ? <button type="button" className={page.primary} onClick={p.onTryAgain}>{c.tryAgain}</button> : null}
        </div> : null}
        {loading ? <p className={page.meta} role="status">{c.reading}</p>
          : denied ? <p className={page.meta} role="status">{c.denied}</p>
          : failed ? <div className={page.row}><p className={page.meta} role="status">{c.unavailable}</p>
            <button type="button" className={page.secondary} disabled={p.locked} onClick={p.onRefresh}>{c.refresh}</button></div>
          : <>
            {p.clock.state === 'READY' ? <ClockCard p={p} c={c} clock={p.clock.clock}/> : p.clock.state === 'UNAVAILABLE' ? <p className={page.meta}>{c.unavailable}</p> : null}
            {p.sheet.state === 'READY' ? <Sheet p={p} c={c} week={p.sheet.week}/> : p.sheet.state === 'UNAVAILABLE' ? <p className={page.meta}>{c.unavailable}</p> : null}
            <button type="button" className={page.secondary} disabled={p.locked} onClick={p.onRefresh}>{c.refresh}</button>
          </>}
      </>}
  </section>;
}
