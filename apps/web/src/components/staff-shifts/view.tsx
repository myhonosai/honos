import React from 'react';
import { shiftWithinAvailability, staffShiftMinutes, type StaffShift, type StaffShiftWeek } from '@hon/contracts';
import { addDays, daysOf } from '../school-calendar/range';
import { shiftCopy, type ShiftOutcomeKind } from './copy';
import type { ShiftDraft, ShiftField } from './draft';
import page from '../membership-changes/membership-changes.module.css';
import styles from './staff-shifts.module.css';

export type ShiftReadState = { state: 'LOADING' | 'DENIED' | 'UNAVAILABLE' } | { state: 'READY'; week: StaffShiftWeek };
export type ShiftOutcome = null | Readonly<{ kind: ShiftOutcomeKind }>;
export type StaffShiftsViewProps = Readonly<{
  language: string; waiting: boolean; concealed: boolean; hasSchool: boolean; today: string;
  weekStart: string; read: ShiftReadState; showCancelled: boolean;
  draft: ShiftDraft | null; problems: readonly string[]; confirmingCancel: boolean;
  outcome: ShiftOutcome; locked: boolean; canRetry: boolean;
  onWeek?: ((step: -1 | 0 | 1) => void) | undefined; onToggleCancelled?: (() => void) | undefined;
  onAdd?: ((principalId: string, date: string) => void) | undefined; onOpen?: ((shift: StaffShift) => void) | undefined;
  onEdit?: ((field: ShiftField, value: string) => void) | undefined; onSave?: (() => void) | undefined; onClose?: (() => void) | undefined;
  onAskCancel?: (() => void) | undefined; onConfirmCancel?: (() => void) | undefined; onKeep?: (() => void) | undefined;
  onRefresh?: (() => void) | undefined; onTryAgain?: (() => void) | undefined;
}>;

const CALM: readonly ShiftOutcomeKind[] = ['SAVING', 'SAVED', 'CANCELLED'];
const at = (date: string) => { const [y, m, d] = date.split('-').map(Number) as [number, number, number]; return new Date(Date.UTC(y, m - 1, d)); };
function dayLabel(language: string, date: string, style: 'short' | 'long' = 'short'): string {
  try { return at(date).toLocaleDateString(language, { timeZone: 'UTC', weekday: style, month: 'short', day: 'numeric' }); } catch { return date; }
}
function timeLabel(language: string, hhmm: string): string {
  if (hhmm === '24:00') return language === 'ko' ? '자정' : language === 'es' ? 'medianoche' : 'midnight';
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  try { return new Date(Date.UTC(2000, 0, 1, h, m)).toLocaleTimeString(language, { timeZone: 'UTC', hour: 'numeric', minute: '2-digit' }); } catch { return hhmm; }
}
const minutes = (s: StaffShift) => staffShiftMinutes(s.start, s.end) ?? 0;

/** Staff > Shifts (0467): pure, every state comes from props. Managers add and change shifts; view_own sees one row. */
export function StaffShiftsView(p: StaffShiftsViewProps): React.ReactElement {
  const c = shiftCopy(p.language), read = p.read;
  const week = read.state === 'READY' ? read.week : null;
  const manage = week?.mode === 'MANAGE';
  const days = daysOf({ start: p.weekStart, end: addDays(p.weekStart, 7) });
  const shown = week ? week.shifts.filter(s => p.showCancelled || s.status === 'SCHEDULED') : [];
  const windows = new Map(week?.availability.map(a => [a.principalId, a.windows]) ?? []);
  const scheduled = (filter: (s: StaffShift) => boolean) => week ? week.shifts.filter(s => s.status === 'SCHEDULED' && filter(s)).reduce((n, s) => n + minutes(s), 0) : 0;
  return <section className={page.page} aria-labelledby="staff-shifts-title" data-staff-shifts={week?.mode ?? read.state}>
    <header className={page.head}><div>
      <h1 id="staff-shifts-title">{c.pageTitle}</h1>
      <p className={page.intro}>{week && !manage ? c.ownIntro : c.manageIntro}</p>
    </div></header>
    {p.concealed ? <p className={page.notice} role="status">{c.hidden}</p>
      : p.waiting ? <p className={page.notice} role="status">{c.checking}</p>
      : !p.hasSchool ? <p className={page.notice} role="status">{c.chooseSchool}</p>
      : <>
        <nav className={page.row} aria-label={c.weekOf(`${dayLabel(p.language, days[0]!, 'long')} – ${dayLabel(p.language, days[6]!, 'long')}`)}>
          <button type="button" className={page.secondary} disabled={p.locked} onClick={() => p.onWeek?.(-1)} data-week="previous">{c.previous}</button>
          <button type="button" className={page.secondary} disabled={p.locked} onClick={() => p.onWeek?.(0)} data-week="this">{c.thisWeek}</button>
          <button type="button" className={page.secondary} disabled={p.locked} onClick={() => p.onWeek?.(1)} data-week="next">{c.next}</button>
          <strong data-testid="week-label">{c.weekOf(`${dayLabel(p.language, days[0]!)} – ${dayLabel(p.language, days[6]!)}`)}</strong>
        </nav>
        {p.outcome ? <div className={`${page.notice} ${CALM.includes(p.outcome.kind) ? '' : page.warn}`} role="status" data-testid="shift-outcome" data-outcome={p.outcome.kind}>
          <p>{c.outcomes[p.outcome.kind]}</p>
          {p.canRetry ? <button type="button" className={page.primary} onClick={p.onTryAgain}>{c.tryAgain}</button> : null}
        </div> : null}
        {read.state === 'LOADING' ? <p className={page.meta} role="status">{c.reading}</p>
          : read.state === 'DENIED' ? <p className={page.meta} role="status">{c.denied}</p>
          : !week ? <div className={page.row}><p className={page.meta} role="status">{c.unavailable}</p>
            <button type="button" className={page.secondary} disabled={p.locked} onClick={p.onRefresh}>{c.refresh}</button></div>
          : <>
            <div className={page.row}>
              <p className={page.meta}>{c.timezone(week.timezone)}</p>
              <label className={page.meta}><input type="checkbox" checked={p.showCancelled} onChange={p.onToggleCancelled} data-toggle="cancelled"/> {c.showCancelled}</label>
              <button type="button" className={page.secondary} disabled={p.locked} onClick={p.onRefresh}>{c.refresh}</button>
            </div>
            {week.staff.length === 0 ? <p className={page.meta}>{c.noStaff}</p> : <div className={styles.scroll}>
              <table className={styles.grid} data-testid="shift-grid">
                <thead><tr><th scope="col">{c.person}</th>
                  {days.map(d => <th key={d} scope="col" className={d === p.today ? styles.today : undefined}>{dayLabel(p.language, d)}</th>)}
                  <th scope="col">{c.total}</th></tr></thead>
                <tbody>{week.staff.map(person => <tr key={person.principalId} data-person={person.principalId}>
                  <th scope="row">{person.displayName}</th>
                  {days.map(d => <td key={d} className={d === p.today ? styles.today : undefined}><div className={styles.cell}>
                    {shown.filter(s => s.staffPrincipalId === person.principalId && s.date === d).map(s => {
                      const range = `${timeLabel(p.language, s.start)} – ${timeLabel(p.language, s.end)}`;
                      const outside = manage && s.status === 'SCHEDULED' && !shiftWithinAvailability(s, windows.get(s.staffPrincipalId));
                      const body = <><span className={styles.time}>{range}</span>{s.position ? <span>{s.position}</span> : null}
                        {s.status === 'CANCELLED' ? <span className={styles.tag}>{c.cancelledTag}</span> : null}
                        {outside ? <span className={styles.tag} data-outside="">{c.outsideAvailability}</span> : null}</>;
                      return manage && s.status === 'SCHEDULED'
                        ? <button key={s.shiftId} type="button" className={styles.shift} data-shift={s.shiftId} data-status={s.status} disabled={p.locked}
                          aria-label={c.edit(person.displayName, range)} onClick={() => p.onOpen?.(s)}>{body}</button>
                        : <div key={s.shiftId} className={styles.shift} data-shift={s.shiftId} data-status={s.status}>{body}</div>;
                    })}
                    {manage ? <button type="button" className={styles.add} disabled={p.locked} aria-label={c.addFor(person.displayName, dayLabel(p.language, d, 'long'))}
                      onClick={() => p.onAdd?.(person.principalId, d)} data-add={`${person.principalId}/${d}`}>+</button> : null}
                  </div></td>)}
                  <td className={styles.total} data-total={person.principalId}>{c.hours(scheduled(s => s.staffPrincipalId === person.principalId))}</td>
                </tr>)}</tbody>
                <tfoot><tr><th scope="row">{c.dayTotal}</th>
                  {days.map(d => <td key={d} data-day-total={d}>{c.hours(scheduled(s => s.date === d))}</td>)}
                  <td className={styles.total} data-week-total="">{c.hours(scheduled(() => true))}</td></tr></tfoot>
              </table>
            </div>}
            {week.shifts.length === 0 && week.staff.length > 0 ? <p className={page.meta}>{c.noShifts}</p> : null}
            {manage ? <p className={page.meta}>{c.permissionsHint} <a href="/staff/roles">Roles &amp; permissions</a></p> : null}
            {manage && p.draft ? <form className={page.form} aria-labelledby="shift-form-title" data-testid="shift-form" onSubmit={e => { e.preventDefault(); p.onSave?.(); }}>
              <h2 id="shift-form-title">{p.draft.shiftId ? c.formEdit : c.formAdd}</h2>
              <div className={styles.fields}>
                <label>{c.fieldPerson}
                  <select value={p.draft.staffPrincipalId} disabled={p.locked || p.draft.shiftId !== null} onChange={e => p.onEdit?.('staffPrincipalId', e.target.value)} data-field="staffPrincipalId">
                    {week.staff.map(s => <option key={s.principalId} value={s.principalId}>{s.displayName}</option>)}
                  </select></label>
                <label>{c.fieldDate}<input type="date" value={p.draft.date} disabled={p.locked} onChange={e => p.onEdit?.('date', e.target.value)} data-field="date"/></label>
                <label>{c.fieldStart}<input type="time" step={300} value={p.draft.start} disabled={p.locked} onChange={e => p.onEdit?.('start', e.target.value)} data-field="start"/></label>
                <label>{c.fieldEnd}<input type="time" step={300} value={p.draft.end === '24:00' ? '00:00' : p.draft.end} disabled={p.locked} onChange={e => p.onEdit?.('end', e.target.value)} data-field="end"/></label>
                <label>{c.fieldPosition}<input type="text" maxLength={40} value={p.draft.position} placeholder={c.positionHint} disabled={p.locked} onChange={e => p.onEdit?.('position', e.target.value)} data-field="position"/></label>
                <label>{c.fieldNote}<textarea maxLength={300} rows={2} value={p.draft.note} disabled={p.locked} onChange={e => p.onEdit?.('note', e.target.value)} data-field="note"/></label>
              </div>
              {p.problems.length ? <ul className={styles.problems} data-testid="shift-problems">{p.problems.map(x => <li key={x}>{x}</li>)}</ul> : null}
              {p.confirmingCancel ? <div className={`${page.notice} ${page.warn}`} role="alertdialog" aria-labelledby="shift-cancel-title" data-testid="shift-confirm-cancel">
                <p id="shift-cancel-title"><strong>{c.cancelShift}?</strong></p>
                <div className={page.row}>
                  <button type="button" className={page.primary} disabled={p.locked} onClick={p.onConfirmCancel} data-shift-action="confirm-cancel" autoFocus>{c.confirmCancel}</button>
                  <button type="button" className={page.secondary} disabled={p.locked} onClick={p.onKeep}>{c.keepShift}</button>
                </div>
              </div> : <div className={page.row}>
                <button type="submit" className={page.primary} disabled={p.locked || p.problems.length > 0} data-shift-action="save">{c.save}</button>
                {p.draft.shiftId ? <button type="button" className={page.secondary} disabled={p.locked} onClick={p.onAskCancel} data-shift-action="cancel">{c.cancelShift}</button> : null}
                <button type="button" className={page.secondary} disabled={p.locked} onClick={p.onClose} data-shift-action="close">{c.close}</button>
              </div>}
            </form> : null}
          </>}
      </>}
  </section>;
}
