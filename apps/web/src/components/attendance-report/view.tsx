import React from 'react';
import { attendanceReportPercent, type AttendanceReport, type AttendanceReportClass, type AttendanceReportStudent } from '@hon/contracts';
import { attendanceReportText, type AttendanceReportKey } from './copy';
import base from '../membership-changes/membership-changes.module.css';
import styles from './report.module.css';

/**
 * Attendance report (AR1, 0633), modelled on the owner's Manus CRM Attendance > Stats tab: participation cards, one week of
 * check-ins by class time, class averages by schedule, participation by program and students missing check-in for 2+ weeks.
 * Pure view: everything shown comes from one verified server read; nothing here writes, sends or charges.
 */
export type AttendanceReportReadState = { state: 'LOADING' | 'DENIED' | 'TIMEZONE' | 'UNAVAILABLE' } | { state: 'READY'; read: AttendanceReport };
export type StudentFilter = 'MISSING' | 'ALL';
export type AttendanceReportViewProps = Readonly<{
  language: string; waiting: boolean; concealed: boolean; hasSchool: boolean; report: AttendanceReportReadState;
  /** The month the class averages use: 'YYYY-MM' or 'ALL'. */
  month: string; filter: StudentFilter; search: string; busy?: boolean | undefined;
  /** The Contacts page, when the school menu has it. */
  contactsHref?: string | undefined;
  /** The past-attendance import page, when the school menu has it. */
  importHref?: string | undefined;
  onWeek?: ((week: string | undefined) => void) | undefined; onMonth?: ((month: string) => void) | undefined;
  onFilter?: ((filter: StudentFilter) => void) | undefined; onSearch?: ((search: string) => void) | undefined; onRefresh?: (() => void) | undefined;
}>;
type T = (key: AttendanceReportKey, vars?: Readonly<Record<string, string | number>>) => string;

export const MISSING_DAYS = 14;
export const MAX_SERIES = 8;
const DAY_MS = 86400000;
const utc = (date: string) => Date.parse(`${date}T00:00:00Z`);
/** Shifts a school-time calendar date by whole days. */
export function shiftDay(date: string, days: number): string { return new Date(utc(date) + days * DAY_MS).toISOString().slice(0, 10); }
/** Whole days from one school-time date to another. */
export function daysBetween(from: string, to: string): number { return Math.round((utc(to) - utc(from)) / DAY_MS); }
/** A class time such as "4:15 PM"; a calendar label, never shifted by the viewer's time zone. */
export function timeLabel(language: string, time: string): string {
  return new Date(`2000-01-01T${time}:00Z`).toLocaleTimeString(language, { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' });
}
export function dateLabel(language: string, date: string, year = false): string {
  return new Date(utc(date)).toLocaleDateString(language, { month: 'short', day: 'numeric', ...(year ? { year: 'numeric' } : {}), timeZone: 'UTC' });
}
/** A weekday name from 1 = Monday ... 7 = Sunday. */
export function weekdayLabel(language: string, weekday: number, width: 'short' | 'long' = 'short'): string {
  return new Date(Date.UTC(2024, 0, weekday)).toLocaleDateString(language, { weekday: width, timeZone: 'UTC' });
}
export function monthLabel(language: string, month: string): string {
  return new Date(`${month}-01T00:00:00Z`).toLocaleDateString(language, { month: 'long', year: 'numeric', timeZone: 'UTC' });
}
/** This month and the 11 before it, newest first, as 'YYYY-MM'. */
export function monthChoices(localToday: string): string[] {
  const year = Number(localToday.slice(0, 4)), month = Number(localToday.slice(5, 7));
  return Array.from({ length: 12 }, (_, i) => new Date(Date.UTC(year, month - 1 - i, 1)).toISOString().slice(0, 7));
}

export type WeekChart = Readonly<{
  /** Class times in clock order; 'OTHER' (last) holds the times beyond the eight busiest. */
  series: readonly string[];
  /** One entry per day, Monday first: check-ins per series entry. */
  days: readonly { date: string; values: readonly number[]; total: number; held: boolean }[];
  max: number; total: number; busiestTime: { time: string; checkIns: number } | null; busiestDay: { date: string; checkIns: number } | null;
}>;
/** Lays one week of sessions out as day groups of class-time bars. A colour belongs to a class time, never to its rank. */
export function weekChart(week: AttendanceReport['week']): WeekChart {
  const byTime = new Map<string, number>();
  for (const s of week.sessions) byTime.set(s.time, (byTime.get(s.time) ?? 0) + s.checkIns);
  let times = [...byTime.keys()].sort();
  let other = false;
  if (times.length > MAX_SERIES) {
    const keep = new Set([...byTime.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, MAX_SERIES - 1).map(([time]) => time));
    times = times.filter((time) => keep.has(time)); other = true;
  }
  const series = other ? [...times, 'OTHER'] : times;
  const index = new Map(times.map((time, i) => [time, i] as const));
  const days = Array.from({ length: 7 }, (_, d) => {
    const date = shiftDay(week.start, d), values = series.map(() => 0);
    let held = false;
    for (const s of week.sessions) if (s.date === date) { held = true; const i = index.get(s.time) ?? series.length - 1; values[i] = (values[i] ?? 0) + s.checkIns; }
    return { date, values, total: values.reduce((a, b) => a + b, 0), held };
  });
  const total = days.reduce((a, d) => a + d.total, 0);
  const topTime = [...byTime.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  const topDay = [...days].sort((a, b) => b.total - a.total || a.date.localeCompare(b.date))[0];
  return { series, days, max: Math.max(0, ...days.flatMap((d) => d.values)), total,
    busiestTime: topTime && topTime[1] > 0 ? { time: topTime[0], checkIns: topTime[1] } : null,
    busiestDay: topDay && topDay.total > 0 ? { date: topDay.date, checkIns: topDay.total } : null };
}

/** Students with no check-in, or none for 14 days or more, longest absent first (the server's order). */
export function missingStudents(read: AttendanceReport): AttendanceReportStudent[] {
  return read.students.items.filter((s) => s.lastCheckIn === null || daysBetween(s.lastCheckIn, read.localToday) >= MISSING_DAYS);
}
const fullName = (s: AttendanceReportStudent) => `${s.givenName} ${s.familyName}`.trim();
const average = (row: AttendanceReportClass) => Math.round((row.checkIns / row.sessionsWithCheckIns) * 10) / 10;

function Kpi({ id, label, value, sub, action }: { id: string; label: string; value: string; sub: string; action?: React.ReactNode }) {
  return <li className={styles.kpi} data-kpi={id}><span className={styles.kpiLabel}>{label}</span><strong className={styles.kpiValue}>{value}</strong><small>{sub}</small>{action}</li>;
}

function Kpis({ p, read, t }: { p: AttendanceReportViewProps; read: AttendanceReport; t: T }) {
  const { activeStudents: n, attended7Days: a7, attended30Days: a30 } = read.participation;
  const num = (value: number) => value.toLocaleString(p.language);
  const pct = (a: number) => { const x = attendanceReportPercent(a, n); return x === null ? '—' : `${x}%`; };
  const of = (a: number) => n === 0 ? t('kpiNone') : t('kpiOf', { a: num(a), n: num(n) });
  const missing = (a: number) => n - a > 0 ? <a href="#attendance-report-students" className={styles.details} onClick={() => p.onFilter?.('ALL')}>{t('viewMissing', { n: num(n - a) })}</a> : null;
  return <ul className={styles.kpis}>
    <Kpi id="d7" label={t('kpi7')} value={pct(a7)} sub={of(a7)} action={missing(a7)}/>
    <Kpi id="d30" label={t('kpi30')} value={pct(a30)} sub={of(a30)} action={missing(a30)}/>
    <Kpi id="saved" label={t('kpiSaved')} value={num(read.savedCheckIns)} sub={t('kpiSavedHelp')}
      action={p.importHref ? <a href={p.importHref} className={styles.details}>{t('importHistory')}</a> : null}/>
    <Kpi id="active" label={t('kpiActive')} value={num(n)} sub={t('kpiActiveHelp')}/>
  </ul>;
}

function Week({ p, read, t }: { p: AttendanceReportViewProps; read: AttendanceReport; t: T }) {
  const chart = weekChart(read.week), W = 700, H = 180, group = W / 7, pad = 14;
  const slot = (group - pad * 2) / Math.max(1, chart.series.length), bar = Math.max(3, Math.min(22, slot - 2));
  const name = (time: string) => time === 'OTHER' ? t('otherTimes') : timeLabel(p.language, time);
  const thisWeek = read.localToday >= read.week.start && read.localToday <= read.week.end;
  const quiet = chart.days.filter((d) => !d.held && d.date <= read.localToday).map((d) => weekdayLabel(p.language, (new Date(utc(d.date)).getUTCDay() || 7), 'long'));
  const range = t('weekRange', { from: dateLabel(p.language, read.week.start), to: dateLabel(p.language, read.week.end, true) });
  return <article className={base.card} aria-labelledby="ar-week-title" data-testid="ar-week">
    <div className={base.cardHead}><h2 id="ar-week-title">{t('weekTitle')}</h2>
      <div className={styles.weekNav}>
        <button type="button" className={styles.navButton} aria-label={t('weekPrev')} disabled={p.busy} onClick={() => p.onWeek?.(shiftDay(read.week.start, -7))}>←</button>
        <span data-testid="ar-week-range">{thisWeek ? `${t('weekThis')} · ${range}` : range}</span>
        <button type="button" className={styles.navButton} aria-label={t('weekNext')} disabled={p.busy || thisWeek} onClick={() => p.onWeek?.(shiftDay(read.week.start, 7) > read.localToday ? undefined : shiftDay(read.week.start, 7))}>→</button>
        {thisWeek ? null : <button type="button" className={styles.linkButton} disabled={p.busy} onClick={() => p.onWeek?.(undefined)}>{t('weekThis')}</button>}
      </div>
    </div>
    {read.week.sessions.length === 0 ? <p className={base.meta}>{t('weekEmpty')}</p> : <>
      {chart.total === 0 ? <p className={base.meta}>{t('weekNoCheckIns')}</p> : null}
      <figure className={styles.chart}>
        <div className={styles.plot}>
          <span className={styles.yMax} aria-hidden="true">{chart.max.toLocaleString(p.language)}</span>
          <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`${t('weekTitle')}: ${range}`}>
            <line x1="0" x2={W} y1="1" y2="1" className={styles.grid}/><line x1="0" x2={W} y1={H / 2} y2={H / 2} className={styles.grid}/>
            <line x1="0" x2={W} y1={H} y2={H} className={styles.baseline}/>
            {chart.days.map((d, di) => <g key={d.date}>
              {d.values.map((value, si) => {
                const h = value === 0 ? 0 : Math.max(3, value / Math.max(1, chart.max) * (H - 4)), x = di * group + pad + si * slot + (slot - bar) / 2;
                const label = `${weekdayLabel(p.language, di + 1, 'long')} · ${name(chart.series[si] ?? '')}: ${t('checkIns', { n: value.toLocaleString(p.language) })}`;
                return <g key={si} className={styles.slot}>
                  <rect x={di * group + pad + si * slot} y="0" width={slot} height={H} className={styles.hit}><title>{label}</title></rect>
                  {h > 0 ? <path d={`M${x},${H} V${H - h + 3} Q${x},${H - h} ${x + 3},${H - h} H${x + bar - 3} Q${x + bar},${H - h} ${x + bar},${H - h + 3} V${H} Z`} data-series={si} className={styles.bar}/> : null}
                </g>;
              })}
            </g>)}
          </svg>
        </div>
        <div className={styles.days} aria-hidden="true">{chart.days.map((d, di) => <span key={d.date}>{weekdayLabel(p.language, di + 1)}<small>{d.total > 0 ? d.total.toLocaleString(p.language) : ''}</small></span>)}</div>
        <figcaption><ul className={styles.legend}>{chart.series.map((time, si) => <li key={time}><i data-series={si} aria-hidden="true"/>{name(time)}</li>)}</ul></figcaption>
      </figure>
      <ul className={styles.insights}>
        {chart.busiestTime ? <li data-insight="time"><span>{t('busiestTime')}</span><strong>{timeLabel(p.language, chart.busiestTime.time)}</strong><small>{t('checkInsWeek', { n: chart.busiestTime.checkIns.toLocaleString(p.language) })}</small></li> : null}
        {chart.busiestDay ? <li data-insight="day"><span>{t('busiestDay')}</span><strong>{weekdayLabel(p.language, new Date(utc(chart.busiestDay.date)).getUTCDay() || 7, 'long')}</strong><small>{t('checkIns', { n: chart.busiestDay.checkIns.toLocaleString(p.language) })}</small></li> : null}
        {quiet.length > 0 && quiet.length < 7 ? <li data-insight="quiet"><span>{t('quietDays')}</span><strong>{quiet.join(', ')}</strong></li> : null}
      </ul>
      <details className={styles.table}><summary>{t('chartTable')}</summary>
        <table><thead><tr><th scope="col">{t('colTime')}</th>{chart.days.map((d, di) => <th scope="col" key={d.date}>{weekdayLabel(p.language, di + 1)}</th>)}</tr></thead>
          <tbody>{chart.series.map((time, si) => <tr key={time}><th scope="row">{name(time)}</th>{chart.days.map((d) => <td key={d.date}>{d.values[si]}</td>)}</tr>)}
            <tr><th scope="row">{t('total')}</th>{chart.days.map((d) => <td key={d.date}>{d.total}</td>)}</tr></tbody></table>
      </details>
    </>}
  </article>;
}

function Classes({ p, read, t }: { p: AttendanceReportViewProps; read: AttendanceReport; t: T }) {
  const rows = read.classes.rows, times = [...new Set(rows.map((r) => r.time))].sort(), days = [...new Set(rows.map((r) => r.weekday))].sort((a, b) => a - b);
  const months = monthChoices(read.localToday);
  return <article className={base.card} aria-labelledby="ar-classes-title" data-testid="ar-classes">
    <div className={base.cardHead}><h2 id="ar-classes-title">{t('classesTitle')}</h2>
      <label className={styles.pick}>{t('monthLabel')} <select value={p.month} disabled={p.busy} onChange={(event) => p.onMonth?.(event.target.value)}>
        <option value="ALL">{t('monthAll')}</option>
        {(months.includes(p.month) || p.month === 'ALL' ? months : [p.month, ...months]).map((m) => <option key={m} value={m}>{monthLabel(p.language, m)}</option>)}
      </select></label>
    </div>
    <p className={base.meta}>{t('classesHelp')}</p>
    {rows.length === 0 ? <p className={base.meta}>{t('classesEmpty')}</p> : <div className={styles.scroll}><table className={styles.schedule}>
      <thead><tr><th scope="col">{t('colTime')}</th>{days.map((d) => <th scope="col" key={d}>{weekdayLabel(p.language, d, 'long')}</th>)}</tr></thead>
      <tbody>{times.map((time) => <tr key={time}><th scope="row">{timeLabel(p.language, time)}</th>
        {days.map((d) => { const cell = rows.filter((r) => r.time === time && r.weekday === d); return <td key={d}>{cell.length === 0 ? <span className={styles.none} aria-hidden="true">—</span>
          : cell.map((r) => <div key={r.name} className={styles.klass} data-empty={r.checkIns === 0 ? '' : undefined}>
            <b>{r.name}</b>
            {r.checkIns === 0 ? <small>{t('noCheckIns')}</small>
              : <small><strong>{t('avg', { n: average(r).toLocaleString(p.language) })}</strong> · {r.sessionsWithCheckIns === 1 ? t('oneSession') : t('sessions', { n: r.sessionsWithCheckIns.toLocaleString(p.language) })}</small>}
          </div>)}</td>; })}</tr>)}</tbody>
    </table></div>}
    {read.classes.truncated ? <p className={base.meta}>{t('classesTruncated')}</p> : null}
  </article>;
}

function Programs({ p, read, t }: { p: AttendanceReportViewProps; read: AttendanceReport; t: T }) {
  return <article className={base.card} aria-labelledby="ar-programs-title" data-testid="ar-programs">
    <div className={base.cardHead}><h2 id="ar-programs-title">{t('programsTitle')}</h2></div>
    <p className={base.meta}>{t('programsHelp')}</p>
    {read.programs.length === 0 ? <p className={base.meta}>{t('programsEmpty')}</p> : <dl className={styles.bars}>{read.programs.map((g) => {
      const pct = attendanceReportPercent(g.attended30Days, g.activeStudents) ?? 0;
      return <div key={g.programId ?? 'none'}><dt>{g.name ?? t('noProgram')}</dt>
        <dd><span className={styles.track}><span style={{ width: `${pct}%` }}/></span><b>{t('programLine', { pct, a: g.attended30Days.toLocaleString(p.language), n: g.activeStudents.toLocaleString(p.language) })}</b></dd></div>;
    })}</dl>}
  </article>;
}

function Students({ p, read, t }: { p: AttendanceReportViewProps; read: AttendanceReport; t: T }) {
  const missing = missingStudents(read), never = missing.filter((s) => s.lastCheckIn === null).length;
  const pool = p.filter === 'MISSING' ? missing : read.students.items;
  const needle = p.search.trim().toLocaleLowerCase(p.language);
  const shown = needle ? pool.filter((s) => fullName(s).toLocaleLowerCase(p.language).includes(needle)) : pool;
  const num = (value: number) => value.toLocaleString(p.language);
  const status = (s: AttendanceReportStudent): [string, 'never' | 'absent' | 'ok'] => {
    if (s.lastCheckIn === null) return [t('statusNever'), 'never'];
    const days = daysBetween(s.lastCheckIn, read.localToday);
    if (days >= MISSING_DAYS) return [t('statusAbsent', { n: num(days) }), 'absent'];
    return [days <= 0 ? t('statusToday') : days === 1 ? t('statusYesterday') : t('statusRecent', { n: num(days) }), 'ok'];
  };
  return <article className={base.card} aria-labelledby="ar-students-title" data-testid="ar-students" id="attendance-report-students">
    <div className={base.cardHead}><h2 id="ar-students-title">{t('missingTitle')}</h2>{p.contactsHref ? <a href={p.contactsHref}>{t('openContacts')} →</a> : null}</div>
    <p className={base.meta}>{t('missingHelp')}</p>
    <ul className={styles.summary} data-testid="ar-missing-summary">
      <li>{t('summaryNeed', { n: num(missing.length) })}</li>
      <li>{t('summaryAbsent', { n: num(missing.length - never) })}</li>
      <li>{t('summaryNever', { n: num(never) })}</li>
    </ul>
    <div className={styles.tools}>
      <div className={styles.toggle} role="group" aria-label={t('filterLabel')}>
        {(['MISSING', 'ALL'] as const).map((f) => <button key={f} type="button" aria-pressed={p.filter === f} onClick={() => p.onFilter?.(f)}>{t(f === 'MISSING' ? 'filterMissing' : 'filterAll')}</button>)}
      </div>
      <input type="search" className={styles.search} value={p.search} placeholder={t('search')} aria-label={t('search')} maxLength={80} onChange={(event) => p.onSearch?.(event.target.value)}/>
    </div>
    {shown.length === 0 ? <p className={base.meta}>{needle ? t('noMatch') : read.students.items.length === 0 ? t('studentsEmpty') : t('missingEmpty')}</p>
      : <div className={styles.scroll}><table className={styles.students}>
        <thead><tr><th scope="col">{t('colStudent')}</th><th scope="col">{t('colProgram')}</th><th scope="col">{t('colRank')}</th><th scope="col">{t('colLast')}</th><th scope="col">{t('colStatus')}</th></tr></thead>
        <tbody>{shown.map((s) => { const [text, tone] = status(s); return <tr key={s.studentProfileId}>
          <th scope="row">{fullName(s)}</th><td>{s.program ?? '—'}</td><td>{s.rank ?? '—'}</td>
          <td>{s.lastCheckIn === null ? t('never') : dateLabel(p.language, s.lastCheckIn, true)}</td>
          <td><span className={styles.status} data-tone={tone}>{text}</span></td></tr>; })}</tbody>
      </table></div>}
    {read.students.truncated ? <p className={base.meta}>{t('studentsTruncated')}</p> : null}
  </article>;
}

export function AttendanceReportView(p: AttendanceReportViewProps): React.ReactElement {
  const t: T = (key, vars) => attendanceReportText(p.language, key, vars);
  const head = <header className={base.head}><div><h1>{t('pageTitle')}</h1><p className={base.meta}>{t('pageIntro')}</p></div>
    {p.report.state !== 'LOADING' && p.onRefresh ? <button type="button" className={styles.linkButton} disabled={p.busy} onClick={p.onRefresh}>{t('refresh')}</button> : null}</header>;
  const note = (key: AttendanceReportKey, role: 'status' | 'alert' = 'status') => <main className={base.page} data-testid="attendance-report">{head}<p className={base.notice} role={role}>{t(key)}</p></main>;
  if (p.concealed) return note('concealed');
  if (p.waiting) return note('waiting');
  if (!p.hasSchool) return note('noSchool');
  if (p.report.state === 'LOADING') return note('loading');
  if (p.report.state === 'DENIED') return note('denied', 'alert');
  if (p.report.state === 'TIMEZONE') return note('timezone', 'alert');
  if (p.report.state !== 'READY') return note('unavailable', 'alert');
  const read = p.report.read;
  const time = new Date(read.generatedAt).toLocaleString(p.language, { dateStyle: 'medium', timeStyle: 'short', timeZone: read.timezone });
  return <main className={base.page} data-testid="attendance-report" aria-busy={p.busy || undefined}>
    {head}
    <p className={base.meta}>{t('asOf', { time, zone: read.timezone })}</p>
    <div className={styles.report}>
      <Kpis p={p} read={read} t={t}/>
      <Week p={p} read={read} t={t}/>
      <Classes p={p} read={read} t={t}/>
      <Programs p={p} read={read} t={t}/>
      <Students p={p} read={read} t={t}/>
    </div>
  </main>;
}
