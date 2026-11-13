'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { HqSchoolsNeedingAttention } from '@hon/contracts';
import { useLocale } from '../localization/provider';
import { HON_SESSION_INVALIDATED_EVENT } from '../session-invalidation';
import { healthText, type HealthKey } from './copy';
import { HealthError, healthApi, type HealthApi } from './http';
import { HealthSignals, HealthTable } from './parts';
import styles from '../hq-access/hq-access.module.css';

export type AttentionState = { state: 'LOADING' } | { state: 'DENIED' } | { state: 'UNAVAILABLE' } | { state: 'READY'; view: HqSchoolsNeedingAttention };
const FIRST = 50, MAX = 200;

/**
 * Schools needing attention (B-HQ-2b). Read only. Leaving the tab (blur, hidden tab, page hide) or a session end hides
 * every school and retires the read; "Show again" reads fresh. The server decides who may read, on every read.
 */
export function HqSchoolsAttention({ api = healthApi }: { api?: HealthApi }): React.ReactElement {
  const { preferences, formattingLocale } = useLocale();
  const [state, setState] = useState<AttentionState>({ state: 'LOADING' });
  const [concealed, setConcealed] = useState(false);
  const [limit, setLimit] = useState(FIRST);
  const [refresh, setRefresh] = useState(0);
  const generation = useRef(0), mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; }; }, []);

  useEffect(() => {
    const conceal = () => { generation.current++; setConcealed(true); setLimit(FIRST); setState({ state: 'LOADING' }); };
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
    api.attention(limit, signal, owned).then(view => { if (owned()) setState({ state: 'READY', view }); }, (error) => {
      if (!owned() || abort.signal.aborted) return;
      setState({ state: error instanceof HealthError && error.kind === 'DENIED' ? 'DENIED' : 'UNAVAILABLE' });
    });
    return () => { abort.abort(); };
  }, [api, limit, refresh, concealed]);

  return <HqSchoolsAttentionView language={preferences.language} formattingLocale={formattingLocale} concealed={concealed} state={state}
    onRefresh={useCallback(() => setRefresh(n => n + 1), [])} onReveal={useCallback(() => setConcealed(false), [])} onShowMore={useCallback(() => setLimit(MAX), [])}/>;
}

export function HqSchoolsAttentionView(props: Readonly<{ language: string; formattingLocale: string; concealed: boolean; state: AttentionState;
  onRefresh: () => void; onReveal: () => void; onShowMore: () => void }>): React.ReactElement {
  const { language, formattingLocale, concealed, state } = props;
  const t = (key: HealthKey, vars?: Record<string, string>) => healthText(language, key, vars);
  const time = (iso: string) => new Intl.DateTimeFormat(formattingLocale, { timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
  const head = <header className={styles.head}>
    <div><p className={styles.meta}><a href="/hq/schools">{t('back')}</a></p><h1>{t('title')}</h1><p className={styles.intro}>{t('intro')}</p></div>
    {!concealed && <button type="button" className={styles.secondary} disabled={state.state === 'LOADING'} onClick={props.onRefresh}>{t('refresh')}</button>}
  </header>;
  if (concealed) return <section className={styles.access} data-hq-attention="concealed">{head}
    <div className={styles.notice} role="status"><p>{t('concealed')}</p><button type="button" className={styles.secondary} onClick={props.onReveal}>{t('reveal')}</button></div></section>;
  if (state.state !== 'READY') return <section className={styles.access} data-hq-attention={state.state.toLowerCase()} aria-busy={state.state === 'LOADING'}>{head}
    <p className={styles.notice} role="status">{t(state.state === 'LOADING' ? 'loading' : state.state === 'DENIED' ? 'denied' : 'unavailable')}</p></section>;
  const v = state.view;
  return <section className={styles.access} data-hq-attention="ready">{head}
    <p className={styles.notice} role="status">{t('summary', { flagged: String(v.flagged), checked: String(v.checked) })}</p>
    {v.schools.length === 0 && <p className={styles.meta}>{t('none')}</p>}
    {v.schools.map((s, i) => {
      const id = `hq-att-${i}`;
      return <article key={s.schoolId} className={styles.card} aria-labelledby={id} data-attention-school={s.schoolId}>
        <div className={styles.cardHead}><div><h2 id={id}>{s.schoolDisplayName}</h2><p className={styles.meta}>{s.organizationDisplayName}</p></div>
          <span className={styles.status} data-tone="waiting">{s.health.signals.length}</span></div>
        <HealthSignals language={language} signals={s.health.signals}/>
        <details><summary>{t('details')}</summary>
          <HealthTable language={language} formattingLocale={formattingLocale} health={s.health} id={id}/></details>
        <div className={styles.actions}><a className={styles.secondary} href={`/hq/schools/${s.schoolId}`}>{t('openSchool')}</a>
          {s.health.openSupportCases > 0 && <a className={styles.secondary} href="/hq/support">{t('openSupport')}</a>}</div>
      </article>;
    })}
    {v.truncated && <div className={styles.notice}><p>{t('truncated', { limit: String(v.limit) })}</p>
      {v.limit < MAX && <button type="button" className={styles.secondary} onClick={props.onShowMore}>{t('showMore', { limit: String(MAX) })}</button>}</div>}
    <p className={styles.meta}>{t('supportOnlyNote')}</p>
    <p className={styles.meta}>{t('asOf', { time: time(v.asOf) })}</p>
  </section>;
}
