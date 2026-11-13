'use client';
import React, { useEffect, useState } from 'react';
import type { HqSchoolHealth, HqSchoolHealthFacts } from '@hon/contracts';
import { healthText, type HealthKey } from './copy';
import { HealthError, healthApi, type HealthApi } from './http';
import styles from '../hq-access/hq-access.module.css';

/** The signals as plain labels. An empty list says so in words. */
export function HealthSignals({ language, signals }: { language: string; signals: readonly string[] }): React.ReactElement {
  const t = (key: HealthKey) => healthText(language, key);
  if (signals.length === 0) return <p className={styles.meta} data-health-signals="none">{t('noSignals')}</p>;
  return <ul aria-label={t('signalsLabel')} data-health-signals={signals.join(' ')} style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', listStyle: 'none', padding: 0, margin: 0 }}>
    {signals.map(s => <li key={s}><span className={styles.status} data-tone="waiting">{t(s as HealthKey)}</span></li>)}
  </ul>;
}

/** Counts only, exactly as the verified answer gives them. */
export function HealthTable({ language, formattingLocale, health, id }: { language: string; formattingLocale: string; health: HqSchoolHealthFacts; id: string }): React.ReactElement {
  const t = (key: HealthKey) => healthText(language, key);
  const date = (iso: string) => new Intl.DateTimeFormat(formattingLocale, { timeZone: 'UTC', year: 'numeric', month: 'short', day: 'numeric' }).format(new Date(iso));
  const h = health, dash = t('notCompared');
  const rows: [HealthKey, string, string][] = [
    ['visits', String(h.attendance.last30Days), String(h.attendance.previous30Days)],
    ['newLeads', String(h.leads.newLast30Days), String(h.leads.newPrevious30Days)],
    ['classesHeld', String(h.classes.heldLast30Days), dash],
    ['bookings', String(h.bookingsLast30Days), dash],
    ['wonLeads', String(h.leads.wonLast30Days), dash],
  ];
  return <>
    <div role="region" aria-labelledby={id} tabIndex={0} style={{ overflowX: 'auto' }}>
      <table><thead><tr><th scope="col">{t('metric')}</th><th scope="col">{t('last30')}</th><th scope="col">{t('previous30')}</th></tr></thead>
        <tbody>{rows.map(([k, now, before]) => <tr key={k}><th scope="row">{t(k)}</th><td>{now}</td><td>{before}</td></tr>)}</tbody></table>
    </div>
    <dl className={styles.facts}>
      {([['activeStudents', String(h.activeStudents)], ['upcoming', String(h.classes.scheduledNext14Days)], ['openLeads', String(h.leads.open)],
        ['openCases', String(h.openSupportCases)], ['lastVisit', h.attendance.lastRecordedAt ? `${date(h.attendance.lastRecordedAt)} UTC` : t('never')]] as [HealthKey, string][])
        .map(([k, v]) => <div key={k}><dt>{t(k)}</dt><dd>{v}</dd></div>)}
    </dl>
  </>;
}

type CardState = { state: 'LOADING' } | { state: 'DENIED' } | { state: 'GONE' } | { state: 'INVALID' } | { state: 'UNAVAILABLE' } | { state: 'READY'; view: HqSchoolHealth };

/**
 * The health card on the school detail page. It reads once when shown; the detail page unmounts it whenever the page is
 * concealed or refreshed, so every showing is a fresh read.
 */
export function HqSchoolHealthCard({ schoolId, language, formattingLocale, api = healthApi }: { schoolId: string; language: string; formattingLocale: string; api?: HealthApi }): React.ReactElement {
  const t = (key: HealthKey, vars?: Record<string, string>) => healthText(language, key, vars);
  const [state, setState] = useState<CardState>({ state: 'LOADING' });
  useEffect(() => {
    let live = true; const owned = () => live;
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]);
    setState({ state: 'LOADING' });
    api.school(schoolId, signal, owned).then(view => { if (live) setState({ state: 'READY', view }); }, (error) => {
      if (!live || abort.signal.aborted) return;
      const kind = error instanceof HealthError ? error.kind : 'UNKNOWN';
      setState({ state: kind === 'DENIED' ? 'DENIED' : kind === 'GONE' ? 'GONE' : kind === 'INVALID' ? 'INVALID' : 'UNAVAILABLE' });
    });
    return () => { live = false; abort.abort(); };
  }, [api, schoolId]);
  const time = (iso: string) => new Intl.DateTimeFormat(formattingLocale, { timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
  return <article className={styles.card} aria-labelledby="hq-sd-health" data-hq-school-health={state.state.toLowerCase()} aria-busy={state.state === 'LOADING'}>
    <div className={styles.cardHead}><h2 id="hq-sd-health">{t('cardTitle')}</h2>
      {state.state === 'READY' && state.view.health.signals.length > 0 && <span className={styles.status} data-tone="waiting">{state.view.health.signals.length}</span>}</div>
    <p className={styles.meta}>{t('cardIntro')}</p>
    {state.state === 'READY' ? <>
      <HealthSignals language={language} signals={state.view.health.signals}/>
      <HealthTable language={language} formattingLocale={formattingLocale} health={state.view.health} id="hq-sd-health"/>
      <p className={styles.meta}>{t('asOf', { time: time(state.view.asOf) })}</p>
    </> : <p className={styles.notice} role="status">{t(state.state === 'LOADING' ? 'loading' : state.state === 'DENIED' ? 'denied' : state.state === 'GONE' ? 'gone'
      : state.state === 'INVALID' ? 'invalid' : 'unavailable')}</p>}
  </article>;
}
