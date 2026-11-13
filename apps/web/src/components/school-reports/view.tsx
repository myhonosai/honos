import React from 'react';
import { schoolReportRetainedPercent, type SchoolReportPeriod, type SchoolReports } from '@hon/contracts';
import { reportsText, type ReportsKey } from './copy';
import base from '../membership-changes/membership-changes.module.css';
import styles from './school-reports.module.css';

export const REPORT_MONTH_CHOICES = [3, 6, 12] as const;
export type ReportsReadState = { state: 'LOADING' | 'DENIED' | 'TIMEZONE' | 'UNAVAILABLE' } | { state: 'READY'; read: SchoolReports };
export type SchoolReportsViewProps = Readonly<{
  language: string; waiting: boolean; concealed: boolean; hasSchool: boolean; months: number; report: ReportsReadState;
  onMonths?: ((months: number) => void) | undefined; onRefresh?: (() => void) | undefined;
}>;
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

function MonthHead({ p, period }: { p: SchoolReportsViewProps; period: SchoolReportPeriod }) {
  const t: T = (key, vars) => reportsText(p.language, key, vars);
  return <th scope="row">{monthLabel(p.language, period.month)}{period.partial ? <span className={styles.partial}>{t('partial')}</span> : null}</th>;
}
function Table({ p, id, title, help, columns, cells }: { p: SchoolReportsViewProps; id: string; title: ReportsKey; help: ReportsKey; columns: ReportsKey[];
  cells: (period: SchoolReportPeriod) => React.ReactNode[] }) {
  const t: T = (key, vars) => reportsText(p.language, key, vars);
  if (p.report.state !== 'READY') return null;
  return <article className={base.card} aria-labelledby={`${id}-title`} data-testid={id}>
    <div className={base.cardHead}><h2 id={`${id}-title`}>{t(title)}</h2></div>
    <p className={base.meta}>{t(help)}</p>
    <div className={styles.scroll}><table className={styles.table}>
      <thead><tr><th scope="col">{t('month')}</th>{columns.map((c) => <th scope="col" key={c}>{t(c)}</th>)}</tr></thead>
      <tbody>{p.report.read.periods.map((period) => <tr key={period.month}><MonthHead p={p} period={period}/>
        {cells(period).map((cell, i) => <td key={i}>{cell}</td>)}</tr>)}</tbody>
    </table></div>
  </article>;
}

function Revenue({ p }: { p: SchoolReportsViewProps }) {
  const t: T = (key, vars) => reportsText(p.language, key, vars);
  if (p.report.state !== 'READY') return null;
  const rows = p.report.read.periods.flatMap((period) => period.revenue.map((line) => ({ period, line })));
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

/** Month by month school reports (R1, 0331): counts and totals only, read again from the server on every change. */
export function SchoolReportsView(p: SchoolReportsViewProps): React.ReactElement {
  const t: T = (key, vars) => reportsText(p.language, key, vars);
  const r = p.report;
  return <main className={base.page} aria-labelledby="school-reports-title" data-shell-private="">
    <header className={base.head}><div><h1 id="school-reports-title">{t('pageTitle')}</h1><p className={base.intro}>{t('pageIntro')}</p></div></header>
    {p.concealed ? <p className={base.meta} role="status">{t('concealed')}</p>
      : p.waiting ? <p className={base.meta} role="status">{t('waiting')}</p>
      : !p.hasSchool ? <p className={base.meta} role="status">{t('noSchool')}</p>
      : <>
        <div className={base.row} role="group" aria-label={t('range')}>
          {REPORT_MONTH_CHOICES.map((m) => <button type="button" key={m} className={base.tab} aria-pressed={p.months === m} disabled={r.state === 'LOADING'}
            onClick={() => p.onMonths?.(m)}>{t('months', { n: m })}</button>)}
        </div>
        {r.state === 'LOADING' ? <p className={base.meta} role="status">{t('loading')}</p>
          : r.state !== 'READY' ? <div className={base.notice} role="alert" data-testid="reports-error">
            <p>{t(r.state === 'DENIED' ? 'denied' : r.state === 'TIMEZONE' ? 'timezone' : 'unavailable')}</p>
            {r.state === 'UNAVAILABLE' ? <button type="button" className={base.primary} onClick={p.onRefresh}>{t('tryAgain')}</button> : null}
          </div>
          : <>
            <p className={base.meta}>{t('asOf', { time: new Date(r.read.generatedAt).toLocaleString(p.language, { dateStyle: 'medium', timeStyle: 'short', timeZone: r.read.timezone }), zone: r.read.timezone })}</p>
            <Table p={p} id="report-attendance" title="attendanceTitle" help="attendanceHelp" columns={['classesHeld', 'checkIns', 'perClass', 'absences', 'studentsAttended']}
              cells={(x) => [n(p.language, x.attendance.classesHeld), n(p.language, x.attendance.checkIns),
                x.attendance.classesHeld ? (x.attendance.checkIns / x.attendance.classesHeld).toLocaleString(p.language, { maximumFractionDigits: 1 }) : t('none'),
                n(p.language, x.attendance.absences), n(p.language, x.attendance.studentsAttended)]}/>
            <Table p={p} id="report-enrollment" title="enrollmentTitle" help="enrollmentHelp" columns={['newLeads', 'leadsWon', 'newMemberships']}
              cells={(x) => [n(p.language, x.enrollment.newLeads), n(p.language, x.enrollment.leadsWon), n(p.language, x.enrollment.newMemberships)]}/>
            <Table p={p} id="report-retention" title="retentionTitle" help="retentionHelp" columns={['activeAtStart', 'activeAtEnd', 'ended', 'retained']}
              cells={(x) => { const pct = schoolReportRetainedPercent(x.retention);
                return [n(p.language, x.retention.activeAtStart), n(p.language, x.retention.activeAtEnd), n(p.language, x.retention.ended), pct === null ? t('none') : `${pct}%`]; }}/>
            {r.read.cancelledWithoutDate > 0 ? <p className={base.meta} data-testid="reports-undated">{t('undated', { n: r.read.cancelledWithoutDate })}</p> : null}
            <Revenue p={p}/>
          </>}
      </>}
  </main>;
}
