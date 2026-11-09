'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { CHAMPIONS_CONTEST_STATUSES, type ChampionsContestConfig, type ChampionsContestList, type ChampionsContestStatus } from '@hon/contracts';
import { useLocale } from '../localization/provider';
import { loadHqSchoolDirectory } from '../hq-school-directory-http';
import { contestText, type ContestKey } from './copy';
import { ContestError, contestApi, type ContestApi } from './http';
import { emptyDraft, formatMoney } from './form';
import { useConcealment, useContestCommand, type ContestOutcome } from './model';
import { ContestForm, Outcome, formatDay, statusTone, type SchoolChoices } from './parts';
import styles from '../hq-access/hq-access.module.css';

export type ContestListState = { state: 'LOADING' } | { state: 'DENIED' } | { state: 'UNAVAILABLE' } | { state: 'READY'; view: ChampionsContestList };
export type SchoolsLoader = (signal: AbortSignal) => Promise<SchoolChoices>;
/** Active schools from the HQ directory, as plain choices. A refusal or failure only disables "selected schools". */
export const directorySchools: SchoolsLoader = async signal => {
  try {
    const d = await loadHqSchoolDirectory(signal);
    return { state: 'READY', schools: d.schools.filter(s => s.schoolOperationalStatus === 'ACTIVE')
      .map(s => ({ schoolId: s.schoolId.toLowerCase(), label: `${s.schoolDisplayName} · ${s.organizationDisplayName}` })) };
  } catch { return { state: 'UNAVAILABLE' }; }
};

/**
 * HQ referral contests list and builder. Reads the newest 100 contests (optionally one status), and creates new drafts.
 * Leaving the tab or a session end hides everything and drops the form and any kept command. Each answer is followed by a
 * fresh read; a new draft opens on its own page. The server decides who may read or create, every time.
 */
export function HqContestsList({ api = contestApi, schools: loadSchools = directorySchools, navigate = (href: string) => { window.location.assign(href); } }:
  { api?: ContestApi; schools?: SchoolsLoader; navigate?: (href: string) => void }): React.ReactElement {
  const { preferences, formattingLocale } = useLocale();
  const [filter, setFilter] = useState<ChampionsContestStatus | null>(null);
  const [state, setState] = useState<ContestListState>({ state: 'LOADING' });
  const [refresh, setRefresh] = useState(0);
  const [form, setForm] = useState(false);
  const [schools, setSchools] = useState<SchoolChoices>({ state: 'LOADING' });
  const generation = useRef(0), mounted = useRef(false), dropRef = useRef<() => void>(() => {});
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; }; }, []);
  const { concealed, privacy, reveal } = useConcealment(() => { generation.current++; dropRef.current(); setForm(false); setState({ state: 'LOADING' }); });
  const after = useCallback((outcome: ContestOutcome) => {
    if (outcome?.kind === 'DONE') { setForm(false); navigate(`/hq/growth/contests/${outcome.receipt.contest.contestId}`); return; }
    setRefresh(n => n + 1);
  }, [navigate]);
  const command = useContestCommand(privacy, after);
  dropRef.current = command.drop;

  useEffect(() => {
    if (concealed) return;
    const current = ++generation.current, shown = privacy.current, owned = () => mounted.current && current === generation.current && shown === privacy.current;
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]);
    setState({ state: 'LOADING' });
    api.list(filter, signal, owned).then(view => { if (owned()) setState({ state: 'READY', view }); }, error => {
      if (!owned() || abort.signal.aborted) return;
      const denied = error instanceof ContestError && error.kind === 'DENIED';
      if (denied) dropRef.current();
      setState({ state: denied ? 'DENIED' : 'UNAVAILABLE' });
    });
    return () => { abort.abort(); };
  }, [api, filter, refresh, concealed, privacy]);

  useEffect(() => {
    if (!form || concealed) return;
    const abort = new AbortController(); setSchools({ state: 'LOADING' });
    loadSchools(AbortSignal.any([abort.signal, AbortSignal.timeout(15000)])).then(s => { if (!abort.signal.aborted) setSchools(s); });
    return () => { abort.abort(); };
  }, [form, concealed, loadSchools]);

  const { start, local } = command;
  const onCreate = useCallback((config: ChampionsContestConfig) => {
    start((key, signal, owned) => api.command(null, { action: 'CREATE', ...config }, key, signal, owned));
  }, [api, start]);

  return <HqContestsListView language={preferences.language} formattingLocale={formattingLocale} concealed={concealed} state={state} filter={filter}
    form={form} schools={schools} outcome={command.outcome} locked={command.locked} canRetry={command.canRetry}
    onFilter={setFilter} onRefresh={() => setRefresh(n => n + 1)} onReveal={reveal} onForm={setForm} onCreate={onCreate} onInvalid={() => local('create')}
    onTryAgain={command.tryAgain}/>;
}

export function HqContestsListView(p: Readonly<{ language: string; formattingLocale: string; concealed: boolean; state: ContestListState; filter: ChampionsContestStatus | null;
  form: boolean; schools: SchoolChoices; outcome: ContestOutcome; locked: boolean; canRetry: boolean; onFilter: (f: ChampionsContestStatus | null) => void;
  onRefresh: () => void; onReveal: () => void; onForm: (open: boolean) => void; onCreate: (c: ChampionsContestConfig) => void; onInvalid: () => void; onTryAgain: () => void }>): React.ReactElement {
  const t = (key: ContestKey, vars?: Record<string, string>) => contestText(p.language, key, vars);
  const money = (minor: number) => formatMoney(minor, p.formattingLocale);
  const head = <header className={styles.head}>
    <div><h1>{t('title')}</h1><p className={styles.intro}>{t('intro')}</p></div>
    {!p.concealed && <button type="button" className={styles.secondary} disabled={p.state.state === 'LOADING'} onClick={p.onRefresh}>{t('refresh')}</button>}
  </header>;
  if (p.concealed) return <section className={styles.access} data-hq-contests="concealed">{head}
    <div className={styles.notice} role="status"><p>{t('concealed')}</p><button type="button" className={styles.secondary} onClick={p.onReveal}>{t('reveal')}</button></div></section>;
  if (p.state.state === 'DENIED') return <section className={styles.access} data-hq-contests="denied">{head}<p className={styles.notice} role="status">{t('denied')}</p></section>;
  return <section className={styles.access} data-hq-contests={p.state.state.toLowerCase()} aria-busy={p.state.state === 'LOADING'}>{head}
    <div className={styles.filters} role="group" aria-label={t('filter')}>
      {[null, ...CHAMPIONS_CONTEST_STATUSES].map(s => <button key={s ?? 'ALL'} type="button" aria-pressed={p.filter === s} onClick={() => p.onFilter(s)}>{s ? t(s) : t('filterAll')}</button>)}
    </div>
    {p.form ? <ContestForm language={p.language} formattingLocale={p.formattingLocale} initial={emptyDraft()} schools={p.schools} mode="new" disabled={p.locked}
      onSubmit={p.onCreate} onInvalid={p.onInvalid} onClose={() => p.onForm(false)}/>
      : <div className={styles.actions}><button type="button" className={styles.primary} onClick={() => p.onForm(true)} disabled={p.locked}>{t('newContest')}</button></div>}
    <Outcome language={p.language} outcome={p.outcome} canRetry={p.canRetry} onTryAgain={p.onTryAgain}/>
    {p.state.state === 'LOADING' && <p className={styles.notice} role="status">{t('loading')}</p>}
    {p.state.state === 'UNAVAILABLE' && <p className={styles.notice} role="status">{t('unavailable')}</p>}
    {p.state.state === 'READY' && <>
      {p.state.view.contests.length === 0 && <p className={styles.meta}>{t('none')}</p>}
      <ul className={styles.list}>{p.state.view.contests.map(c => <li key={c.contestId} className={styles.card} data-contest={c.contestId}>
        <div className={styles.cardHead}><h2><a href={`/hq/growth/contests/${c.contestId}`}>{c.name}</a></h2>
          <span className={styles.status} data-tone={statusTone(c.status)}>{t(c.status)}</span></div>
        <p className={styles.meta}>{t('window', { from: formatDay(p.formattingLocale, c.startsAt), to: formatDay(p.formattingLocale, c.endsAt) })}</p>
        <p className={styles.meta}>{t('prizesTotal', { cost: money(c.estimatedPrizeCostMinor) })} {c.budgetMinor === null ? `(${t('noBudget')})` : t('budgetOf', { budget: money(c.budgetMinor) })}</p>
        {c.due !== 'NONE' && <p className={styles.outcome} data-tone="waiting">{t(c.due === 'START_DUE' ? 'dueSTART_DUE' : 'dueEND_DUE')}</p>}
      </li>)}</ul>
      <p className={styles.meta}>{t('listLimit')}</p>
    </>}
  </section>;
}
