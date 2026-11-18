import React from 'react';
import { schoolReportRetainedPercent, sumSchoolReportLocations, type SchoolReportLocations, type SchoolReportTotals, type SchoolReports } from '@hon/contracts';
import { reportsText, type ReportsKey } from './copy';
import base from '../membership-changes/membership-changes.module.css';
import styles from './school-reports.module.css';

export const REPORT_MONTH_CHOICES = [3, 6, 12] as const;
type Failed = { state: 'LOADING' | 'DENIED' | 'TIMEZONE' | 'TOO_MANY' | 'UNAVAILABLE' };
export type ReportsReadState = Failed | { state: 'READY'; read: SchoolReports };
export type LocationsReadState = Failed | { state: 'READY'; read: SchoolReportLocations };
export type ReportsScopeChoice = 'THIS' | 'ALL';
export type SchoolReportsViewProps = Readonly<{
  language: string; waiting: boolean; concealed: boolean; hasSchool: boolean; months: number; report: ReportsReadState;
  /** R2 (0332): this school, or every location where the reader may see reports. */
  scope?: ReportsScopeChoice | undefined; locations?: LocationsReadState | undefined; locationMonth?: string | null | undefined;
  onMonths?: ((months: number) => void) | undefined; onRefresh?: (() => void) | undefined;
  onScope?: ((scope: ReportsScopeChoice) => void) | undefined; onLocationMonth?: ((month: string) => void) | undefined;
}>;
type Row = Pick<SchoolReportTotals, 'month' | 'partial' | 'attendance' | 'enrollment' | 'retention' | 'revenue'>;
type T = (key: ReportsKey, vars?: Readonly<Record<string, string | number>>) => string;

/** A school-time month label such as "Nov 2026"; the month is a calendar label, never shifted by the viewer's time zone. */
export function monthLabel(language: string, month: string): string {
  return new Date(`${month}-01T00:00:00Z`).toLocaleDateString(language, { month: 'short', year: 'numeric', timeZone: 'UTC' });
}
/** Minor units to a currency amount with the currency's own number of decimals. */
export function money(language: string, currency: string, minor: number): string {
  let format: Intl.NumberFormat;
  try { format = new Intl.NumberFormat(language, { style: 'currency', currency }); } catch { format = new Intl.NumberFormat('en', { style: 'currency', currency }); }
  const digits = format.resolvedOptions().maximumFractionDigits ?? 2;
  return format.format(minor / 10 ** digits);
}
const n = (language: string, value: number) => value.toLocaleString(language);

function MonthHead({ p, period }: { p: SchoolReportsViewProps; period: Row }) {
  const t: T = (key, vars) => reportsText(p.language, key, vars);
  return <th scope="row">{monthLabel(p.language, period.month)}{period.partial ? <span className={styles.partial}>{t('partial')}</span> : null}</th>;
}
function Table({ p, rows, id, title, help, columns, cells }: { p: SchoolReportsViewProps; rows: readonly Row[]; id: string; title: ReportsKey; help: ReportsKey; columns: ReportsKey[];
  cells: (period: Row) => React.ReactNode[] }) {
  const t: T = (key, vars) => reportsText(p.language, key, vars);
  return <article className={base.card} aria-labelledby={`${id}-title`} data-testid={id}>
    <div className={base.cardHead}><h2 id={`${id}-title`}>{t(title)}</h2></div>
    <p className={base.meta}>{t(help)}</p>
    <div className={styles.scroll}><table className={styles.table}>
      <thead><tr><th scope="col">{t('month')}</th>{columns.map((c) => <th scope="col" key={c}>{t(c)}</th>)}</tr></thead>
      <tbody>{rows.map((period) => <tr key={period.month}><MonthHead p={p} period={period}/>
        {cells(period).map((cell, i) => <td key={i}>{cell}</td>)}</tr>)}</tbody>
    </table></div>
  </article>;
}

function Revenue({ p, periods }: { p: SchoolReportsViewProps; periods: readonly Row[] }) {
  const t: T = (key, vars) => reportsText(p.language, key, vars);
  const rows = periods.flatMap((period) => period.revenue.map((line) => ({ period, line })));
  return <article className={base.card} aria-labelledby="report-revenue-title" data-testid="report-revenue">
    <div className={base.cardHead}><h2 id="report-revenue-title">{t('revenueTitle')}</h2></div>
    <p className={base.meta}>{t('revenueHelp')}</p>
    {rows.length === 0 ? <p className={base.meta}>{t('noRevenue')}</p> : <div className={styles.scroll}><table className={styles.table}>
      <thead><tr>{(['month', 'currency', 'billed', 'recorded', 'online', 'refunds', 'net'] as ReportsKey[]).map((c) => <th scope="col" key={c}>{t(c)}</th>)}</tr></thead>
      <tbody>{rows.map(({ period, line }) => <tr key={`${period.month}-${line.currency}`}><MonthHead p={p} period={period}/>
        <td>{line.currency}</td><td>{money(p.language, line.currency, line.billedMinor)}</td><td>{money(p.language, line.currency, line.recordedPaymentsMinor)}</td>
        <td>{money(p.language, line.currency, line.onlinePaymentsMinor)}</td><td>{money(p.language, line.currency, line.refundsMinor)}</td>
        <td>{money(p.language, line.currency, line.recordedPaymentsMinor + line.onlinePaymentsMinor - line.refundsMinor)}</td></tr>)}</tbody>
    </table></div>}
  </article>;
}

const net = (line: Row['revenue'][number]) => line.recordedPaymentsMinor + line.onlinePaymentsMinor - line.refundsMinor;

/** The four month tables for one school, or for every location added up. */
function Reports({ p, rows, undated }: { p: SchoolReportsViewProps; rows: readonly Row[]; undated: number }) {
  const t: T = (key, vars) => reportsText(p.language, key, vars);
  return <>
    <Table p={p} rows={rows} id="report-attendance" title="attendanceTitle" help="attendanceHelp" columns={['classesHeld', 'checkIns', 'perClass', 'absences', 'studentsAttended']}
      cells={(x) => [n(p.language, x.attendance.classesHeld), n(p.language, x.attendance.checkIns),
        x.attendance.classesHeld ? (x.attendance.checkIns / x.attendance.classesHeld).toLocaleString(p.language, { maximumFractionDigits: 1 }) : t('none'),
        n(p.language, x.attendance.absences), n(p.language, x.attendance.studentsAttended)]}/>
    <Table p={p} rows={rows} id="report-enrollment" title="enrollmentTitle" help="enrollmentHelp" columns={['newLeads', 'leadsWon', 'newMemberships']}
      cells={(x) => [n(p.language, x.enrollment.newLeads), n(p.language, x.enrollment.leadsWon), n(p.language, x.enrollment.newMemberships)]}/>
    <Table p={p} rows={rows} id="report-retention" title="retentionTitle" help="retentionHelp" columns={['activeAtStart', 'activeAtEnd', 'ended', 'retained']}
      cells={(x) => { const pct = schoolReportRetainedPercent(x.retention);
        return [n(p.language, x.retention.activeAtStart), n(p.language, x.retention.activeAtEnd), n(p.language, x.retention.ended), pct === null ? t('none') : `${pct}%`]; }}/>
    {undated > 0 ? <p className={base.meta} data-testid="reports-undated">{t('undated', { n: undated })}</p> : null}
    <Revenue p={p} periods={rows}/>
  </>;
}

/** R2 (0332): one month, every location side by side. */
function ByLocation({ p, read }: { p: SchoolReportsViewProps; read: SchoolReportLocations }) {
  const t: T = (key, vars) => reportsText(p.language, key, vars);
  const months = read.locations[0]?.periods.map((x) => x.month) ?? [];
  const fallback = [...months].reverse().find((m) => read.locations.every((l) => !l.periods.find((x) => x.month === m)?.partial)) ?? months.at(-1) ?? '';
  const month = p.locationMonth && months.includes(p.locationMonth) ? p.locationMonth : fallback;
  return <article className={base.card} aria-labelledby="report-by-location-title" data-testid="report-by-location">
    <div className={base.cardHead}><h2 id="report-by-location-title">{t('byLocationTitle')}</h2>
      <label className={base.field}>{t('pickMonth')}
        <select value={month} onChange={(e) => p.onLocationMonth?.(e.currentTarget.value)}>
          {months.map((m) => <option key={m} value={m}>{monthLabel(p.language, m)}</option>)}
        </select></label></div>
    <p className={base.meta}>{t('byLocationHelp')}</p>
    <div className={styles.scroll}><table className={styles.table}>
      <thead><tr>{(['location', 'classesHeld', 'checkIns', 'newLeads', 'newMemberships', 'activeAtEnd', 'retained', 'net'] as ReportsKey[]).map((c) => <th scope="col" key={c}>{t(c)}</th>)}</tr></thead>
      <tbody>{read.locations.map((l) => { const x = l.periods.find((y) => y.month === month); if (!x) return null; const pct = schoolReportRetainedPercent(x.retention);
        return <tr key={l.schoolId}><th scope="row">{l.schoolName}{x.partial ? <span className={styles.partial}>{t('partial')}</span> : null}</th>
          <td>{n(p.language, x.attendance.classesHeld)}</td><td>{n(p.language, x.attendance.checkIns)}</td><td>{n(p.language, x.enrollment.newLeads)}</td>
          <td>{n(p.language, x.enrollment.newMemberships)}</td><td>{n(p.language, x.retention.activeAtEnd)}</td><td>{pct === null ? t('none') : `${pct}%`}</td>
          <td>{x.revenue.length ? x.revenue.map((line) => money(p.language, line.currency, net(line))).join(' · ') : t('none')}</td></tr>; })}</tbody>
    </table></div>
  </article>;
}

function failure(t: T, state: Failed['state']): string {
  return t(state === 'DENIED' ? 'denied' : state === 'TIMEZONE' ? 'timezone' : state === 'TOO_MANY' ? 'tooMany' : 'unavailable');
}

/** Month by month school reports (R1, 0331), and the same across locations (R2, 0332): counts and totals only, read again from the server on every change. */
export function SchoolReportsView(p: SchoolReportsViewProps): React.ReactElement {
  const t: T = (key, vars) => reportsText(p.language, key, vars);
  const scope = p.scope ?? 'THIS';
  const r: ReportsReadState | LocationsReadState = scope === 'ALL' ? p.locations ?? { state: 'LOADING' } : p.report;
  return <main className={base.page} aria-labelledby="school-reports-title" data-shell-private="">
    <header className={base.head}><div><h1 id="school-reports-title">{t('pageTitle')}</h1><p className={base.intro}>{t(scope === 'ALL' ? 'locationsIntro' : 'pageIntro')}</p></div></header>
    {p.concealed ? <p className={base.meta} role="status">{t('concealed')}</p>
      : p.waiting ? <p className={base.meta} role="status">{t('waiting')}</p>
      : !p.hasSchool ? <p className={base.meta} role="status">{t('noSchool')}</p>
      : <>
        <div className={base.row}>
          <div className={base.tabs} role="group" aria-label={t('scopeAll')}>
            {(['THIS', 'ALL'] as const).map((s) => <button type="button" key={s} className={base.tab} aria-pressed={scope === s} disabled={r.state === 'LOADING'}
              onClick={() => p.onScope?.(s)}>{t(s === 'THIS' ? 'scopeThis' : 'scopeAll')}</button>)}
          </div>
          <div className={base.tabs} role="group" aria-label={t('range')}>
            {REPORT_MONTH_CHOICES.map((m) => <button type="button" key={m} className={base.tab} aria-pressed={p.months === m} disabled={r.state === 'LOADING'}
              onClick={() => p.onMonths?.(m)}>{t('months', { n: m })}</button>)}
          </div>
        </div>
        {r.state === 'LOADING' ? <p className={base.meta} role="status">{t('loading')}</p>
          : r.state !== 'READY' ? <div className={base.notice} role="alert" data-testid="reports-error">
            <p>{failure(t, r.state)}</p>
            {r.state === 'UNAVAILABLE' ? <button type="button" className={base.primary} onClick={p.onRefresh}>{t('tryAgain')}</button> : null}
          </div>
          : 'periods' in r.read ? <>
            <p className={base.meta}>{t('asOf', { time: new Date(r.read.generatedAt).toLocaleString(p.language, { dateStyle: 'medium', timeStyle: 'short', timeZone: r.read.timezone }), zone: r.read.timezone })}</p>
            <Reports p={p} rows={r.read.periods} undated={r.read.cancelledWithoutDate}/>
          </> : <>
            <p className={base.meta} data-testid="locations-count">{t('locationsCount', { n: r.read.locations.length })}</p>
            {r.read.locations.length < 2 ? <p className={base.meta}>{t('oneLocation')}</p> : null}
            <ByLocation p={p} read={r.read}/>
            <Reports p={p} rows={sumSchoolReportLocations(r.read.locations)} undated={r.read.locations.reduce((sum, l) => sum + l.cancelledWithoutDate, 0)}/>
          </>}
      </>}
  </main>;
}
