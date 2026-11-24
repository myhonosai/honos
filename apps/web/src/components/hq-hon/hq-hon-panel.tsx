'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { HonReplyMode, HqHonAgentKey, HqHonConversation, HqHonStatus, HqHonTurn } from '@hon/contracts';
import type { Language } from '@hon/design-system';
import { useLocale } from '../localization/provider';
import { MarketingError } from '../hq-marketing/http';
import { hqHonApi, type HqHonApi } from './http';
import { hqHonText, type HqHonCopyKey } from './copy';

export type State = { kind: 'LOADING' } | { kind: 'DENIED' } | { kind: 'UNAVAILABLE' } | { kind: 'READY'; view: HqHonConversation };
export type BudgetOutcome = null | { kind: 'SENDING' } | { kind: 'DONE' } | { kind: 'ERROR'; error: MarketingError };
export type Outcome = null | { kind: 'SENDING' } | { kind: 'DONE'; status: HqHonStatus } | { kind: 'ERROR'; error: MarketingError };

/**
 * HQ Ask HON for one agent (HON or an HQ executive). The server decides whether this reader may ask this agent
 * (availableAgents), the budget and every rule; this view only offers the question when the server says so. One question
 * attempt keeps its Idempotency-Key until it has a definitive answer, so a retry never asks twice. Every answer is
 * followed by a fresh read; nothing is cached outside this component.
 */
export function HqHonPanel({ agentKey, name, api = hqHonApi }: { agentKey: HqHonAgentKey; name: string; api?: HqHonApi }): React.ReactElement {
  const { preferences, number } = useLocale();
  const [state, setState] = useState<State>({ kind: 'LOADING' });
  const [question, setQuestion] = useState('');
  const [mode, setMode] = useState<HonReplyMode>('STANDARD');
  const [outcome, setOutcome] = useState<Outcome>(null);
  const [refresh, setRefresh] = useState(0);
  const [budgetOutcome, setBudgetOutcome] = useState<BudgetOutcome>(null);
  const budgetPending = useRef<{ key: string; body: string } | null>(null);
  const mounted = useRef(false), generation = useRef(0), pending = useRef<{ key: string; body: string } | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; }; }, []);

  useEffect(() => {
    const current = ++generation.current, owned = () => mounted.current && current === generation.current;
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]);
    api.conversation(signal, owned).then(view => { if (owned()) setState({ kind: 'READY', view }); }, error => {
      if (!owned() || abort.signal.aborted) return;
      setState(error instanceof MarketingError && error.kind === 'DENIED' ? { kind: 'DENIED' } : { kind: 'UNAVAILABLE' });
    });
    return () => abort.abort();
  }, [api, refresh]);

  const onAsk = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    const q = question.trim();
    if (!q || q.length > 2000 || outcome?.kind === 'SENDING' || unconfirmed(outcome)) return;
    const body = JSON.stringify([q, mode]);
    // Keep the key only for the same question and mode; anything else is a new attempt.
    if (pending.current?.body !== body) pending.current = { key: crypto.randomUUID(), body };
    const attempt = pending.current;
    setOutcome({ kind: 'SENDING' });
    try {
      const receipt = await api.ask({ question: q, replyMode: mode, agentKey }, attempt.key, AbortSignal.timeout(60000), () => mounted.current);
      if (!mounted.current) return;
      // A replay may return a turn that is still answering, held or failed: show its own status, not "Answered.".
      pending.current = null; setQuestion(''); setOutcome({ kind: 'DONE', status: receipt.turn.status });
    } catch (error) {
      if (!mounted.current) return;
      const err = error instanceof MarketingError ? error : new MarketingError('UNKNOWN');
      // UNKNOWN keeps the key: a retry replays the saved turn instead of asking again.
      if (err.kind !== 'UNKNOWN') pending.current = null;
      setOutcome({ kind: 'ERROR', error: err });
    }
    setRefresh(n => n + 1);
  }, [api, agentKey, mode, question, outcome]);

  // HQ owner only (the server decides). The same cap, reason and version keep one key until a definitive answer.
  const onBudget = useCallback(async (capText: string, reasonText: string) => {
    if (state.kind !== 'READY' || budgetOutcome?.kind === 'SENDING' || unconfirmed(budgetOutcome)) return;
    const cap = /^\d{1,8}$/.test(capText.trim()) ? Number(capText.trim()) : NaN, reason = reasonText.replace(/\s+/g, ' ').trim();
    const b = state.view.budget, input = { periodStart: b.periodStart, creditCap: cap, expectedVersion: b.version, reason };
    const body = JSON.stringify(input);
    if (budgetPending.current?.body !== body) budgetPending.current = { key: crypto.randomUUID(), body };
    const attempt = budgetPending.current;
    setBudgetOutcome({ kind: 'SENDING' });
    try {
      await api.setBudget(input, attempt.key, AbortSignal.timeout(30000), () => mounted.current);
      if (!mounted.current) return;
      budgetPending.current = null; setBudgetOutcome({ kind: 'DONE' });
    } catch (error) {
      if (!mounted.current) return;
      const err = error instanceof MarketingError ? error : new MarketingError('UNKNOWN');
      if (err.kind !== 'UNKNOWN') budgetPending.current = null;
      setBudgetOutcome({ kind: 'ERROR', error: err });
    }
    setRefresh(n => n + 1);
  }, [api, state, budgetOutcome]);

  return <HqHonPanelView agentKey={agentKey} name={name} language={preferences.language} number={number} state={state} question={question} mode={mode}
    outcome={outcome} onQuestion={setQuestion} onMode={setMode} onAsk={onAsk} onRefresh={() => { if (unconfirmed(outcome)) setOutcome(null); if (unconfirmed(budgetOutcome)) setBudgetOutcome(null); setRefresh(n => n + 1); }}
    budgetOutcome={budgetOutcome} onBudget={onBudget}/>;
}

/** An unconfirmed result keeps Ask off until a refresh, so editing the question cannot start a second attempt. */
const unconfirmed = (o: Outcome | BudgetOutcome): boolean => o?.kind === 'ERROR' && o.error.kind === 'UNKNOWN';

export type HqHonPanelViewProps = {
  agentKey: HqHonAgentKey; name: string; language: Language; number: (n: number) => string; state: State; question: string; mode: HonReplyMode;
  outcome: Outcome; onQuestion: (v: string) => void; onMode: (m: HonReplyMode) => void; onAsk: (e: React.FormEvent) => void; onRefresh: () => void;
  budgetOutcome: BudgetOutcome; onBudget: (cap: string, reason: string) => void;
};
/** Pure view: everything it shows comes from the props; it decides nothing. */
export function HqHonPanelView({ agentKey, name, language, number, state, question, mode, outcome, onQuestion, onMode, onAsk, onRefresh, budgetOutcome, onBudget }: HqHonPanelViewProps): React.ReactElement {
  const t = (key: HqHonCopyKey, p: Readonly<Record<string, string | number>> = {}) => hqHonText(language, key, { name, ...p });
  if (state.kind === 'LOADING') return <section aria-busy="true"><p>{t('loading')}</p></section>;
  if (state.kind === 'DENIED') return <section><p>{t('denied')}</p></section>;
  if (state.kind === 'UNAVAILABLE') return <section><p role="alert">{t('unavailable')}</p><button type="button" onClick={() => onRefresh()}>{t('refresh')}</button></section>;
  const view = state.view, allowed = view.availableAgents.includes(agentKey), connected = view.provider === 'CONNECTED';
  const mine = view.turns.filter(turn => turn.agentKey === agentKey);
  const b = view.budget;
  return <section aria-labelledby={`hq-hon-${agentKey}-title`} data-hq-hon-agent={agentKey}>
    <h2 id={`hq-hon-${agentKey}-title`}>{t('askTitle')}</h2>
    <p>{t('askIntro')}</p>
    <p>{b.creditCap === null ? t('noBudget') : t('budget', { available: number(b.availableCredits), cap: number(b.creditCap), used: number(b.usedCredits), held: number(b.heldCredits) })}</p>
    {view.viewer.isOwner && <BudgetForm agentKey={agentKey} t={t} outcome={budgetOutcome} onBudget={onBudget} onRefresh={onRefresh} language={language}
      history={view.budgetHistory} number={number}/>}
    {!allowed ? <p role="note">{t('notYours')}</p> : !connected ? <p role="note">{t('providerOff')}</p> :
      <form onSubmit={onAsk}>
        <label htmlFor={`hq-hon-${agentKey}-q`}>{t('question')}</label>
        <textarea id={`hq-hon-${agentKey}-q`} value={question} maxLength={2000} required onChange={e => onQuestion(e.target.value)} aria-describedby={`hq-hon-${agentKey}-help`}/>
        <small id={`hq-hon-${agentKey}-help`}>{t('questionHelp')}</small>
        <fieldset><legend>{t('mode')}</legend>
          {(['STANDARD', 'DETAILED'] as const).map(m => <label key={m}><input type="radio" name={`hq-hon-${agentKey}-mode`} value={m} checked={mode === m} onChange={() => onMode(m)}/>{t(m)}</label>)}
        </fieldset>
        <button type="submit" disabled={outcome?.kind === 'SENDING' || unconfirmed(outcome) || !question.trim()}>{outcome?.kind === 'SENDING' ? t('asking') : t('ask')}</button>
      </form>}
    <div aria-live="polite">{outcome?.kind === 'DONE' && <p>{outcome.status === 'ANSWERED' ? t('DONE') : t(outcome.status)}</p>}
      {outcome?.kind === 'ERROR' && <p role="alert">{outcome.error.kind === 'REFUSED' && outcome.error.code
        ? t('REFUSED', { reason: hqHonText(language, outcome.error.code as HqHonCopyKey) })
        : t((['DENIED', 'GONE'].includes(outcome.error.kind) ? 'denied' : outcome.error.kind) as HqHonCopyKey)}</p>}
      {unconfirmed(outcome) && <button type="button" onClick={() => onRefresh()}>{t('refresh')}</button>}</div>
    <h3>{t('history')}</h3>
    {mine.length === 0 ? <p>{t('none')}</p> : <ol>{mine.map(turn => <TurnItem key={turn.turnId} turn={turn} t={t}/>)}</ol>}
  </section>;
}

function BudgetForm({ agentKey, t, outcome, onBudget, onRefresh, language, history, number }: { agentKey: string; t: (k: HqHonCopyKey, p?: Readonly<Record<string, string | number>>) => string;
  outcome: BudgetOutcome; onBudget: (cap: string, reason: string) => void; onRefresh: () => void; language: Language; history: HqHonConversation['budgetHistory']; number: (n: number) => string }): React.ReactElement {
  const locked = outcome?.kind === 'SENDING' || unconfirmed(outcome), id = `hq-hon-${agentKey}-budget`;
  const submit = (e: React.FormEvent<HTMLFormElement>) => { e.preventDefault(); const f = new FormData(e.currentTarget);
    onBudget(String(f.get('creditCap') ?? ''), String(f.get('reason') ?? '')); };
  return <form onSubmit={submit} aria-labelledby={`${id}-title`} data-hq-hon-budget-form="">
    <h3 id={`${id}-title`}>{t('setBudget')}</h3>
    <fieldset disabled={locked}>
      <label htmlFor={`${id}-cap`}>{t('capLabel')}</label>
      <input id={`${id}-cap`} name="creditCap" required inputMode="numeric" pattern="[0-9]{1,8}" autoComplete="off" aria-describedby={`${id}-help`}/>
      <small id={`${id}-help`}>{t('capHelp')}</small>
      <label htmlFor={`${id}-reason`}>{t('reasonLabel')}</label>
      <input id={`${id}-reason`} name="reason" required minLength={3} maxLength={300} autoComplete="off"/>
      <button type="submit">{outcome?.kind === 'SENDING' ? t('savingBudget') : t('saveBudget')}</button>
    </fieldset>
    <div aria-live="polite">{outcome?.kind === 'DONE' && <p>{t('budgetSaved')}</p>}
      {outcome?.kind === 'ERROR' && <p role="alert">{outcome.error.kind === 'REFUSED' && outcome.error.code
        ? t('budgetNotSaved', { reason: hqHonText(language, outcome.error.code as HqHonCopyKey) })
        : t((['DENIED', 'GONE'].includes(outcome.error.kind) ? 'denied' : outcome.error.kind) as HqHonCopyKey)}</p>}
      {unconfirmed(outcome) && <button type="button" onClick={() => onRefresh()}>{t('refresh')}</button>}</div>
    {history.length > 0 && <><h4>{t('budgetHistory')}</h4><ul>{history.map(h => <li key={`${h.periodStart}-${h.version}`}>
      {t('budgetHistoryRow', { month: h.periodStart.slice(0, 7), cap: number(h.creditCap), name: h.actor.displayName, reason: h.reason })}</li>)}</ul></>}
  </form>;
}

function TurnItem({ turn, t }: { turn: HqHonTurn; t: (k: HqHonCopyKey, p?: Readonly<Record<string, string | number>>) => string }): React.ReactElement {
  return <li data-turn-status={turn.status}>
    <p><strong>{turn.question}</strong></p>
    <p>{t(turn.status)}{turn.chargedCredits !== null ? ` · ${t('charged', { n: turn.chargedCredits })}` : ''}</p>
    {turn.status === 'ANSWERED' && (turn.concealed ? <p>{t('concealed')}</p> : <p style={{ whiteSpace: 'pre-wrap' }}>{turn.reply}</p>)}
    {turn.status === 'ANSWERED' && turn.truncated && !turn.concealed && <small>{t('truncated')}</small>}
  </li>;
}
