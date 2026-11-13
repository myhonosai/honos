'use client';
import React, { useEffect, useState } from 'react';
import type { HqHonAgentKey, HqHonAgentPerformance, HqHonConversation } from '@hon/contracts';
import { useLocale } from '../localization/provider';
import { MarketingError } from '../hq-marketing/http';
import { hqHonApi, type HqHonApi } from './http';
import { hqHonText, type HqHonCopyKey } from './copy';

export const HQ_EXECUTIVE_TABS = ['tasks', 'recommendations', 'approvals', 'performance'] as const;
export type HqExecutiveTab = typeof HQ_EXECUTIVE_TABS[number];
export type Load<T> = { kind: 'LOADING' } | { kind: 'DENIED' } | { kind: 'UNAVAILABLE' } | { kind: 'READY'; value: T };

/** Reads once per mount (and per agent). Fails closed: nothing cached, sampled or inferred is shown. */
function useRead<T>(read: (signal: AbortSignal, owned: () => boolean) => Promise<T>, deps: readonly unknown[]): Load<T> {
  const [state, setState] = useState<Load<T>>({ kind: 'LOADING' });
  useEffect(() => {
    let live = true; const abort = new AbortController(), owned = () => live;
    setState({ kind: 'LOADING' });
    read(AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]), owned).then(value => { if (live) setState({ kind: 'READY', value }); }, error => {
      if (!live || abort.signal.aborted) return;
      setState(error instanceof MarketingError && error.kind === 'DENIED' ? { kind: 'DENIED' } : { kind: 'UNAVAILABLE' });
    });
    return () => { live = false; abort.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return state;
}

/**
 * 0338 (HX-1): the executive workspace sections. Task history is this reader's own recorded questions to this agent (the
 * 0263 read); Performance is this month's HQ-wide aggregate for the agent (0338), gated on the agent's own HQ permission.
 * Recommendations and Approvals say plainly that an HQ executive only answers questions and never acts.
 */
export function HqExecutiveRecords({ agentKey, name, tab, api = hqHonApi }: { agentKey: HqHonAgentKey; name: string; tab: HqExecutiveTab; api?: HqHonApi }): React.ReactElement {
  const { preferences } = useLocale();
  const t = (key: HqHonCopyKey, params: Readonly<Record<string, string | number>> = {}) => hqHonText(preferences.language, key, { name, ...params });
  if (tab === 'recommendations') return <p data-hq-executive-tab="recommendations">{t('recsNone')}</p>;
  if (tab === 'approvals') return <p data-hq-executive-tab="approvals">{t('approvalsNone')}</p>;
  return tab === 'tasks' ? <TaskHistory agentKey={agentKey} api={api} t={t}/> : <Performance agentKey={agentKey} api={api} t={t}/>;
}

export type T = (key: HqHonCopyKey, params?: Readonly<Record<string, string | number>>) => string;

function TaskHistory({ agentKey, api, t }: { agentKey: HqHonAgentKey; api: HqHonApi; t: T }): React.ReactElement {
  const state = useRead<HqHonConversation>((signal, owned) => api.conversation(signal, owned), [api]);
  return <TaskHistoryView agentKey={agentKey} state={state} t={t}/>;
}

export function TaskHistoryView({ agentKey, state, t }: { agentKey: HqHonAgentKey; state: Load<HqHonConversation>; t: T }): React.ReactElement {
  const { number, date } = useLocale();
  if (state.kind === 'LOADING') return <p role="status">{t('loading')}</p>;
  if (state.kind === 'DENIED') return <p>{t('denied')}</p>;
  if (state.kind === 'UNAVAILABLE') return <p role="alert">{t('unavailable')}</p>;
  const turns = state.value.turns.filter(turn => turn.agentKey === agentKey);
  return <section data-hq-executive-tab="tasks" aria-label={t('tasksTitle')}>
    <h3>{t('tasksTitle')}</h3>
    {turns.length === 0 ? <p>{t('tasksNone')}</p> : <table>
      <thead><tr><th scope="col">{t('colAsked')}</th><th scope="col">{t('colQuestion')}</th><th scope="col">{t('colStatus')}</th><th scope="col">{t('colCredits')}</th></tr></thead>
      <tbody>{turns.map(turn => <tr key={turn.turnId}>
        <td>{date(turn.createdAt)}</td>
        <td>{turn.question.length > 120 ? `${turn.question.slice(0, 119)}…` : turn.question}</td>
        <td>{t(turn.status)}</td>
        <td>{turn.chargedCredits === null ? '–' : number(turn.chargedCredits)}</td>
      </tr>)}</tbody>
    </table>}
  </section>;
}

function Performance({ agentKey, api, t }: { agentKey: HqHonAgentKey; api: HqHonApi; t: T }): React.ReactElement {
  const state = useRead<HqHonAgentPerformance>((signal, owned) => api.performance(agentKey, signal, owned), [api, agentKey]);
  return <PerformanceView state={state} t={t}/>;
}

export function PerformanceView({ state, t }: { state: Load<HqHonAgentPerformance>; t: T }): React.ReactElement {
  const { number, date } = useLocale();
  if (state.kind === 'LOADING') return <p role="status">{t('loading')}</p>;
  if (state.kind === 'DENIED') return <p>{t('perfDenied')}</p>;
  if (state.kind === 'UNAVAILABLE') return <p role="alert">{t('perfUnavailable')}</p>;
  const p = state.value;
  const rows: [HqHonCopyKey, number][] = [['perfAsked', p.asked], ['perfAnswered', p.answered], ['perfFailed', p.failed], ['perfReview', p.underReview],
    ['perfInProgress', p.inProgress], ['perfResolved', p.resolved], ['perfAskers', p.askers], ['perfCredits', p.chargedCredits]];
  return <section data-hq-executive-tab="performance" aria-label={t('perfTitle')}>
    <h3>{t('perfTitle')}</h3>
    <p>{t('perfIntro', { month: p.periodStart.slice(0, 7) })}</p>
    {p.asked === 0 ? <p>{t('perfNone')}</p> : <>
      <dl>{rows.map(([k, v]) => <React.Fragment key={k}><dt>{t(k)}</dt><dd>{number(v)}</dd></React.Fragment>)}</dl>
      {p.lastAskedAt && <p>{t('perfLast', { when: date(p.lastAskedAt) })}</p>}
    </>}
  </section>;
}
