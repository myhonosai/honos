import React from 'react';
import {
  SCHOOL_DASHBOARD_RANGES, schoolDashboardWinRate, type SchoolDashboard, type SchoolDashboardIncome, type SchoolDashboardKpis, type SchoolDashboardRange,
} from '@hon/contracts';
import { dashboardText, type DashboardKey } from './dashboard-copy';
import { money } from './view';
import base from '../membership-changes/membership-changes.module.css';
import styles from './dashboard.module.css';

/**
 * Reports dashboard (R3, 0371): range chips, KPI cards against the previous equal range, income over time, belt mix,
 * open leads by stage and won vs lost. Counts and totals only, read from the server on every range change.
 */
export type DashboardReadState = { state: 'LOADING' | 'DENIED' | 'TIMEZONE' | 'UNAVAILABLE' } | { state: 'READY'; read: SchoolDashboard };
export type SchoolDashboardViewProps = Readonly<{
  language: string; range: SchoolDashboardRange; dashboard: DashboardReadState;
  /** The pages the cards link to; a link shows only when the school menu has that page. */
  links: Readonly<Partial<Record<'memberships' | 'trials' | 'leads' | 'receivables' | 'progress' | 'renewals' | 'goal' | 'revenue', string>>>;
  onRange?: ((range: SchoolDashboardRange) => void) | undefined; onRefresh?: (() => void) | undefined;
}>;
type T = (key: DashboardKey, vars?: Readonly<Record<string, string | number>>) => string;

const net = (line: SchoolDashboardIncome) => line.paymentsMinor - line.refundsMinor;
/** The currency with the most activity in the range (then the previous range), so the chart and trend use one currency. */
export function primaryCurrency(read: SchoolDashboard): string | null {
  const lines = read.kpis.income.length ? read.kpis.income : read.previous?.kpis.income ?? [];
  return [...lines].sort((a, b) => (b.paymentsMinor + b.refundsMinor) - (a.paymentsMinor + a.refundsMinor) || a.currency.localeCompare(b.currency))[0]?.currency ?? null;
}
const day = (language: string, iso: string, timeZone: string) => new Date(iso).toLocaleDateString(language, { dateStyle: 'medium', timeZone });
/** A calendar label for a series point (already in school time). */
export function pointLabel(language: string, start: string, bucket: SchoolDashboard['series']['bucket']): string {
  const date = new Date(`${start}T00:00:00Z`);
  return bucket === 'MONTH' ? date.toLocaleDateString(language, { month: 'short', year: 'numeric', timeZone: 'UTC' })
    : date.toLocaleDateString(language, { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function Trend({ t, now, before, points = false }: { t: T; now: number; before: number | null | undefined; points?: boolean }) {
  if (before === null || before === undefined) return null;
  const delta = now - before;
  const text = delta === 0 ? t('same') : t(delta > 0 ? (points ? 'upPoints' : 'up') : (points ? 'downPoints' : 'down'), { n: Math.abs(delta).toLocaleString() });
  return <span className={styles.trend} data-trend={delta > 0 ? 'up' : delta < 0 ? 'down' : 'same'}>
    <span aria-hidden="true">{delta > 0 ? '▲' : delta < 0 ? '▼' : '•'}</span> {text}</span>;
}

function Kpi({ id, label, help, value, sub, trend, href, t }: { id: string; label: DashboardKey; help: DashboardKey; value: string; sub?: string | undefined;
  trend: React.ReactNode; href?: string | undefined; t: T }) {
  return <li className={styles.kpi} data-kpi={id}>
    <span className={styles.kpiLabel}>{t(label)}</span>
    <strong className={styles.kpiValue}>{value}</strong>
    {sub ? <small>{sub}</small> : null}
    {trend}
    <small className={styles.kpiHelp}>{t(help)}</small>
    {href ? <a href={href} className={styles.details}>{t('details')} →</a> : null}
  </li>;
}

function Kpis({ p, read, t }: { p: SchoolDashboardViewProps; read: SchoolDashboard; t: T }) {
  const k = read.kpis, before: SchoolDashboardKpis | undefined = read.previous?.kpis;
  const n = (value: number) => value.toLocaleString(p.language);
  const rate = schoolDashboardWinRate(k), beforeRate = before ? schoolDashboardWinRate(before) : null;
  const currency = primaryCurrency(read);
  const income = currency ? k.income.find((x) => x.currency === currency) : undefined;
  const beforeIncome = currency && before ? before.income.find((x) => x.currency === currency) : undefined;
  const others = k.income.filter((x) => x.currency !== currency).map((x) => money(p.language, x.currency, net(x)));
  return <ul className={styles.kpis} aria-label={t('rangeLabel')}>
    <Kpi id="active" label="kpiActive" help="kpiActiveHelp" value={n(k.activeStudents)} trend={<Trend t={t} now={k.activeStudents} before={before?.activeStudents}/>} href={p.links.memberships} t={t}/>
    <Kpi id="new" label="kpiNew" help="kpiNewHelp" value={n(k.newStudents)} trend={<Trend t={t} now={k.newStudents} before={before?.newStudents}/>} href={p.links.memberships} t={t}/>
    <Kpi id="appointments" label="kpiAppointments" help="kpiAppointmentsHelp" value={n(k.appointments)} trend={<Trend t={t} now={k.appointments} before={before?.appointments}/>} href={p.links.trials} t={t}/>
    <Kpi id="conversion" label="kpiConversion" help="kpiConversionHelp" value={rate === null ? '—' : `${rate}%`}
      sub={rate === null ? t('noClosed') : t('conversionOf', { won: n(k.leadsWon), closed: n(k.leadsWon + k.leadsLost) })}
      trend={rate === null ? null : <Trend t={t} now={rate} before={beforeRate} points/>} href={p.links.leads} t={t}/>
    <Kpi id="income" label="kpiIncome" help="kpiIncomeHelp" value={income && currency ? money(p.language, currency, net(income)) : t('noIncome')}
      sub={others.length ? t('otherCurrencies', { list: others.join(' · ') }) : undefined}
      trend={currency && read.previous ? <IncomeTrend t={t} language={p.language} currency={currency} now={income ? net(income) : 0} before={beforeIncome ? net(beforeIncome) : 0}/> : null}
      href={p.links.receivables} t={t}/>
  </ul>;
}

function IncomeTrend({ t, language, currency, now, before }: { t: T; language: string; currency: string; now: number; before: number }) {
  const delta = now - before;
  const text = delta === 0 ? t('same') : t(delta > 0 ? 'up' : 'down', { n: money(language, currency, Math.abs(delta)) });
  return <span className={styles.trend} data-trend={delta > 0 ? 'up' : delta < 0 ? 'down' : 'same'}><span aria-hidden="true">{delta > 0 ? '▲' : delta < 0 ? '▼' : '•'}</span> {text}</span>;
}

/** Net income per bucket in one currency: thin bars from a zero baseline (refund-heavy buckets go below it). */
function IncomeChart({ p, read, t }: { p: SchoolDashboardViewProps; read: SchoolDashboard; t: T }) {
  const currency = primaryCurrency(read);
  const points = read.series.points.map((point) => {
    const line = currency ? point.income.find((x) => x.currency === currency) : undefined;
    return { start: point.start, label: pointLabel(p.language, point.start, read.series.bucket), payments: line?.paymentsMinor ?? 0, refunds: line?.refundsMinor ?? 0,
      value: line ? net(line) : 0 };
  });
  const max = Math.max(0, ...points.map((x) => x.value)), min = Math.min(0, ...points.map((x) => x.value));
  const span = max - min || 1, W = 640, H = 180, gap = 2, slot = W / points.length, bar = Math.max(2, Math.min(28, slot - gap));
  const zero = H * (max / span);
  const fmt = (minor: number) => currency ? money(p.language, currency, minor) : '—';
  const other = read.series.points.some((point) => point.income.some((x) => x.currency !== currency));
  return <article className={base.card} aria-labelledby="dash-income-title" data-testid="dash-income">
    <div className={base.cardHead}><h2 id="dash-income-title">{t('incomeTitle')}</h2><span className={base.meta}>{t(`income${read.series.bucket}` as DashboardKey)}</span></div>
    {max > 0 ? <p className={base.meta} data-testid="dash-income-top">{t('incomeTop', { amount: fmt(max) })}</p> : null}
    {read.series.truncated ? <p className={base.meta}>{t('incomeTruncated')}</p> : null}
    {other && currency ? <p className={base.meta}>{t('incomeOnly', { currency })}</p> : null}
    <figure className={styles.chart}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`${t('incomeTitle')}: ${points[0]?.label ?? ''} – ${points.at(-1)?.label ?? ''}`}>
        <line x1="0" x2={W} y1={zero} y2={zero} className={styles.baseline}/>
        {points.map((x, i) => {
          const h = Math.max(x.value === 0 ? 0 : 2, Math.abs(x.value) / span * H);
          return <g key={x.start} className={styles.slot}>
            <rect x={i * slot} y="0" width={slot} height={H} className={styles.hit}><title>{`${x.label}: ${fmt(x.value)}`}</title></rect>
            {h > 0 ? <rect x={i * slot + (slot - bar) / 2} y={x.value >= 0 ? zero - h : zero} width={bar} height={h} rx="2" className={x.value >= 0 ? styles.bar : styles.barNegative}/> : null}
          </g>;
        })}
      </svg>
      <figcaption className={styles.axis}><span>{points[0]?.label}</span><span>{points.at(-1)?.label}</span></figcaption>
    </figure>
    <details className={styles.table}><summary>{t('chartTable')}</summary>
      <table><thead><tr><th scope="col">{t('colPeriod')}</th><th scope="col">{t('colPayments')}</th><th scope="col">{t('colRefunds')}</th><th scope="col">{t('colNet')}</th></tr></thead>
        <tbody>{points.map((x) => <tr key={x.start}><th scope="row">{x.label}</th><td>{fmt(x.payments)}</td><td>{fmt(x.refunds)}</td><td>{fmt(x.value)}</td></tr>)}</tbody></table>
    </details>
  </article>;
}

function Bars({ rows, max }: { rows: { key: string; label: string; value: number; color?: string | null; text: string }[]; max: number }) {
  return <dl className={styles.bars}>{rows.map((row) => <div key={row.key}>
    <dt>{row.color !== undefined ? <i className={styles.swatch} style={{ background: row.color ?? 'transparent' }} data-empty={row.color ? undefined : ''} aria-hidden="true"/> : null}{row.label}</dt>
    <dd><span className={styles.track}><span style={{ width: `${Math.max(2, Math.round(row.value / Math.max(1, max) * 100))}%` }}/></span><b title={row.text}>{row.value.toLocaleString()}</b></dd>
  </div>)}</dl>;
}

function Belts({ p, read, t }: { p: SchoolDashboardViewProps; read: SchoolDashboard; t: T }) {
  const groups = new Map<string, { name: string; ranks: SchoolDashboard['belts']['ranks'] }>();
  for (const r of read.belts.ranks) { const g = groups.get(r.curriculumId) ?? { name: r.curriculum, ranks: [] }; g.ranks.push(r); groups.set(r.curriculumId, g); }
  const max = Math.max(1, ...read.belts.ranks.map((r) => r.students));
  return <article className={base.card} aria-labelledby="dash-belts-title" data-testid="dash-belts">
    <div className={base.cardHead}><h2 id="dash-belts-title">{t('beltsTitle')}</h2>{p.links.progress ? <a href={p.links.progress}>{t('details')} →</a> : null}</div>
    <p className={base.meta}>{t('beltsHelp')}</p>
    {read.belts.ranks.length === 0 ? <p className={base.meta}>{t('beltsEmpty')}</p> : [...groups.entries()].map(([id, g]) => <section key={id} className={styles.group}>
      {groups.size > 1 ? <h3>{g.name}</h3> : null}
      <Bars max={max} rows={g.ranks.map((r) => ({ key: r.rankId, label: r.rank, value: r.students, color: r.color, text: t('students', { n: r.students }) }))}/>
    </section>)}
    {read.belts.unranked > 0 ? <p className={base.meta}>{t('unranked', { n: read.belts.unranked.toLocaleString(p.language) })}</p> : null}
    {read.belts.truncated ? <p className={base.meta}>{t('beltsTruncated')}</p> : null}
  </article>;
}

function Pipeline({ p, read, t }: { p: SchoolDashboardViewProps; read: SchoolDashboard; t: T }) {
  const pipelines = new Set(read.pipeline.stages.map((s) => s.pipelineId)).size;
  const max = Math.max(1, ...read.pipeline.stages.map((s) => s.leads));
  return <article className={base.card} aria-labelledby="dash-pipeline-title" data-testid="dash-pipeline">
    <div className={base.cardHead}><h2 id="dash-pipeline-title">{t('pipelineTitle')}</h2>{p.links.leads ? <a href={p.links.leads}>{t('details')} →</a> : null}</div>
    <p className={base.meta}>{t('pipelineHelp')}</p>
    {read.pipeline.stages.length === 0 ? <p className={base.meta}>{t('pipelineEmpty')}</p>
      : <Bars max={max} rows={read.pipeline.stages.map((s) => ({ key: s.stageId, label: pipelines > 1 ? `${s.pipeline} · ${s.stage}` : s.stage, value: s.leads, text: t('leads', { n: s.leads }) }))}/>}
  </article>;
}

function Wins({ read, t }: { read: SchoolDashboard; t: T }) {
  const { leadsWon: won, leadsLost: lost } = read.kpis, rate = schoolDashboardWinRate(read.kpis), total = won + lost;
  return <article className={base.card} aria-labelledby="dash-wins-title" data-testid="dash-wins">
    <div className={base.cardHead}><h2 id="dash-wins-title">{t('winsTitle')}</h2>{rate !== null ? <strong>{t('winRate', { n: rate })}</strong> : null}</div>
    <p className={base.meta}>{t('winsHelp')}</p>
    {total === 0 ? <p className={base.meta}>{t('noClosed')}</p> : <>
      <div className={styles.split} aria-hidden="true">
        {won ? <span className={styles.won} style={{ flexGrow: won }}/> : null}{lost ? <span className={styles.lost} style={{ flexGrow: lost }}/> : null}
      </div>
      <dl className={styles.legend}><div><dt><i className={styles.won}/>{t('won')}</dt><dd>{won.toLocaleString()}</dd></div><div><dt><i className={styles.lost}/>{t('lost')}</dt><dd>{lost.toLocaleString()}</dd></div></dl>
    </>}
  </article>;
}

function PlanAhead({ p, t }: { p: SchoolDashboardViewProps; t: T }) {
  const items = ([['renewals', 'renewals', 'renewalsLine'], ['goal', 'goal', 'goalLine'], ['revenue', 'revenue', 'revenueLine']] as const).filter(([key]) => p.links[key]);
  if (!items.length) return null;
  return <article className={base.card} aria-labelledby="dash-next-title" data-testid="dash-next">
    <div className={base.cardHead}><h2 id="dash-next-title">{t('nextTitle')}</h2></div>
    <ul className={styles.next}>{items.map(([key, title, line]) => <li key={key} data-next={key}><a href={p.links[key]}><strong>{t(title)}</strong><span>{t(line)}</span></a></li>)}</ul>
  </article>;
}

export function SchoolDashboardView(p: SchoolDashboardViewProps): React.ReactElement {
  const t: T = (key, vars) => dashboardText(p.language, key, vars);
  const d = p.dashboard;
  return <section className={styles.dashboard} aria-label={t('viewOverview')} data-testid="reports-dashboard">
    <div className={base.tabs} role="group" aria-label={t('rangeLabel')}>
      {SCHOOL_DASHBOARD_RANGES.map((range) => <button type="button" key={range} className={base.tab} aria-pressed={p.range === range} disabled={d.state === 'LOADING'}
        onClick={() => p.onRange?.(range)}>{t(range)}</button>)}
    </div>
    {d.state === 'LOADING' ? <p className={base.meta} role="status">{t('loading')}</p>
      : d.state !== 'READY' ? null
      : <>
        <p className={base.meta} data-testid="dash-span">
          {d.read.from === null ? t('spanAll', { to: day(p.language, d.read.to, d.read.timezone), zone: d.read.timezone })
            : t('span', { from: day(p.language, d.read.from, d.read.timezone), to: day(p.language, new Date(Date.parse(d.read.to) - 1).toISOString(), d.read.timezone), zone: d.read.timezone })}
          {' · '}{d.read.previous ? t('vsPrevious', { from: day(p.language, d.read.previous.from, d.read.timezone),
            to: day(p.language, new Date(Date.parse(d.read.previous.to) - 1).toISOString(), d.read.timezone) }) : t('noCompare')}
        </p>
        <Kpis p={p} read={d.read} t={t}/>
        <IncomeChart p={p} read={d.read} t={t}/>
        <div className={styles.grid}>
          <Belts p={p} read={d.read} t={t}/>
          <Pipeline p={p} read={d.read} t={t}/>
          <Wins read={d.read} t={t}/>
          <PlanAhead p={p} t={t}/>
        </div>
      </>}
  </section>;
}
