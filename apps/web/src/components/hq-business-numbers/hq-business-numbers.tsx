'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { HqBusinessNumbers } from '@hon/contracts';
import { useLocale } from '../localization/provider';
import { HON_SESSION_INVALIDATED_EVENT } from '../session-invalidation';
import { businessText, type BusinessKey } from './copy';
import { BusinessError, businessApi, type BusinessApi } from './http';
import styles from '../hq-access/hq-access.module.css';
import own from './hq-business-numbers.module.css';

export type BusinessState = { state: 'LOADING' } | { state: 'DENIED' } | { state: 'UNAVAILABLE' } | { state: 'READY'; view: HqBusinessNumbers };
export const BUSINESS_RANGES = [3, 6, 12] as const;
const FIRST = 6;

/**
 * HQ business numbers (B-HQ-3). Read only. Leaving the tab (blur, hidden tab, page hide) or a session end hides the
 * numbers and retires the read; "Show again" reads fresh. The server decides who may read, on every read.
 */
export function HqBusinessNumbersPage({ api = businessApi }: { api?: BusinessApi }): React.ReactElement {
  const { preferences, formattingLocale } = useLocale();
  const [state, setState] = useState<BusinessState>({ state: 'LOADING' });
  const [concealed, setConcealed] = useState(false);
  const [months, setMonths] = useState<number>(FIRST);
  const [refresh, setRefresh] = useState(0);
  const generation = useRef(0), mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; }; }, []);

  useEffect(() => {
    const conceal = () => { generation.current++; setConcealed(true); setState({ state: 'LOADING' }); };
    const visibility = () => { if (document.visibilityState === 'hidden') conceal(); };
    window.addEventListener('blur', conceal); document.addEventListener('visibilitychange', visibility); window.addEventListener('pagehide', conceal);
    window.addEventListener(HON_SESSION_INVALIDATED_EVENT, conceal);
    return () => { window.removeEventListener('blur', conceal); document.removeEventListener('visibilitychange', visibility); window.removeEventListener('pagehide', conceal);
      window.removeEventListener(HON_SESSION_INVALIDATED_EVENT, conceal); };
  }, []);

  useEffect(() => {
    if (concealed) return;
    const current = ++generation.current, owned = () => mounted.current && current === generation.current;
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(20000)]);
    setState({ state: 'LOADING' });
    api.numbers(months, signal, owned).then(view => { if (owned()) setState({ state: 'READY', view }); }, (error) => {
      if (!owned() || abort.signal.aborted) return;
      setState({ state: error instanceof BusinessError && error.kind === 'DENIED' ? 'DENIED' : 'UNAVAILABLE' });
    });
    return () => { abort.abort(); };
  }, [api, months, refresh, concealed]);

  return <HqBusinessNumbersView language={preferences.language} formattingLocale={formattingLocale} concealed={concealed} state={state} months={months}
    onRefresh={useCallback(() => setRefresh(n => n + 1), [])} onReveal={useCallback(() => setConcealed(false), [])} onMonths={setMonths}/>;
}

export function HqBusinessNumbersView(props: Readonly<{ language: string; formattingLocale: string; concealed: boolean; state: BusinessState; months: number;
  onRefresh: () => void; onReveal: () => void; onMonths: (months: number) => void }>): React.ReactElement {
  const { language, formattingLocale, concealed, state } = props;
  const t = (key: BusinessKey, vars?: Record<string, string>) => businessText(language, key, vars);
  const n = (value: number) => new Intl.NumberFormat(formattingLocale).format(value);
  const money = (minor: number) => new Intl.NumberFormat(formattingLocale, { style: 'currency', currency: 'USD' }).format(minor / 100);
  const time = (iso: string) => new Intl.DateTimeFormat(formattingLocale, { timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
  const monthName = (key: string) => new Intl.DateTimeFormat(formattingLocale, { timeZone: 'UTC', year: 'numeric', month: 'short' }).format(new Date(`${key}-01T00:00:00Z`));
  const head = <header className={styles.head}>
    <div><p className={styles.meta}><a href="/hq/revenue">{t('back')}</a></p><h1>{t('title')}</h1><p className={styles.intro}>{t('intro')}</p></div>
    {!concealed && <button type="button" className={styles.secondary} disabled={state.state === 'LOADING'} onClick={props.onRefresh}>{t('refresh')}</button>}
  </header>;
  const banner = <p className={styles.notice} role="note" data-business-test-mode="">{t('testMode')}</p>;
  if (concealed) return <section className={styles.access} data-hq-business="concealed">{head}
    <div className={styles.notice} role="status"><p>{t('concealed')}</p><button type="button" className={styles.secondary} onClick={props.onReveal}>{t('reveal')}</button></div></section>;
  const range = <div className={styles.actions} role="group" aria-label={t('range')}>
    {BUSINESS_RANGES.map(m => <button key={m} type="button" className={styles.secondary} aria-pressed={props.months === m} disabled={state.state === 'LOADING'}
      onClick={() => props.onMonths(m)}>{t('months', { n: String(m) })}</button>)}</div>;
  if (state.state !== 'READY') return <section className={styles.access} data-hq-business={state.state.toLowerCase()} aria-busy={state.state === 'LOADING'}>{head}{banner}
    <p className={styles.notice} role="status">{t(state.state === 'LOADING' ? 'loading' : state.state === 'DENIED' ? 'denied' : 'unavailable')}</p></section>;
  const v = state.view, c = v.current;
  const facts: [BusinessKey, string, string?][] = [
    ['mrr', money(c.mrrMinor)], ['arr', money(c.arrMinor)],
    ['paying', n(c.payingSchools), `${t('payingSplit', { monthly: n(c.payingByInterval.MONTHLY), annual: n(c.payingByInterval.ANNUAL) })}; ${t('sourceSplit', { binding: n(c.payingBySource.SCHEDULE_BINDING), v1: n(c.payingBySource.V1_SUBSCRIPTION) })}`],
    ['trials', n(c.activeTrials)], ['lifetime', n(c.lifetimeSchools)], ['unpriced', n(c.unpricedActiveRecords)],
    ['review', n(c.bindingsNeedingReview)], ['suspended', n(c.suspendedSubscriptions)],
  ];
  const cols: [BusinessKey, keyof HqBusinessNumbers['months'][number]][] = [['newSchools', 'newSchools'], ['signups', 'publicSignups'], ['trialsStarted', 'trialsStarted'],
    ['newPaying', 'newPayingSchools'], ['conversions', 'trialConversions'], ['stopped', 'stoppedPayingSchools']];
  return <section className={styles.access} data-hq-business="ready">{head}{banner}
    <article className={styles.card} aria-labelledby="hq-biz-now">
      <div className={styles.cardHead}><h2 id="hq-biz-now">{t('currentTitle')}</h2></div>
      <dl className={styles.facts}>{facts.map(([k, value, detail]) => <div key={k} className={own.fact} data-business-fact={k}><dt>{t(k)}</dt><dd>{value}</dd>
        {detail && <dd className={styles.meta}>{detail}</dd>}</div>)}</dl>
    </article>
    <article className={styles.card} aria-labelledby="hq-biz-months">
      <div className={styles.cardHead}><h2 id="hq-biz-months">{t('monthsTitle')}</h2>{range}</div>
      <div role="region" aria-labelledby="hq-biz-months" tabIndex={0} style={{ overflowX: 'auto' }}>
        <table className={own.table}><thead><tr><th scope="col">{t('month')}</th>{cols.map(([k]) => <th key={k} scope="col">{t(k)}</th>)}</tr></thead>
          <tbody>{[...v.months].reverse().map(m => <tr key={m.month} data-business-month={m.month}>
            <th scope="row">{m.monthToDate ? t('toDate', { month: monthName(m.month) }) : monthName(m.month)}</th>
            {cols.map(([k, f]) => <td key={k}>{n(m[f] as number)}</td>)}</tr>)}</tbody></table>
      </div>
    </article>
    <p className={styles.meta}>{t('rules')}</p>
    <p className={styles.meta} data-business-no-churn="">{t('noChurn')}</p>
    <p className={styles.meta}>{t('asOf', { time: time(v.asOf) })}</p>
  </section>;
}
