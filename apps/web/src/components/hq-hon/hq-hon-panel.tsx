'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { HQ_HON_LIMITS } from '@hon/contracts';
import type { HonReplyMode, HqHonAgentKey, HqHonConversation, HqHonStatus, HqHonTurn, HqHonTurnReceipt } from '@hon/contracts';
import type { Language } from '@hon/design-system';
import { useLocale } from '../localization/provider';
import { MarketingError } from '../hq-marketing/http';
import { hqHonApi, type HqHonApi } from './http';
import { hqHonText, type HqHonCopyKey } from './copy';
import { HonVoiceControls, useHonVoice } from '../hon-command/hon-voice-controls';
import { honVoiceLang, honVoiceReplyText } from '../hon-command/hon-voice';

export type State = { kind: 'LOADING' } | { kind: 'DENIED' } | { kind: 'UNAVAILABLE' } | { kind: 'READY'; view: HqHonConversation };
export type BudgetOutcome = null | { kind: 'SENDING' } | { kind: 'DONE' } | { kind: 'ERROR'; error: MarketingError };
export type Outcome = null | { kind: 'SENDING' } | { kind: 'DONE'; status: HqHonStatus } | { kind: 'ERROR'; error: MarketingError };

/**
 * HQ Ask HON for one agent (HON or an HQ executive). The server decides whether this reader may ask this agent
 * (availableAgents), the budget and every rule; this view only offers the question when the server says so. One question
 * attempt keeps its Idempotency-Key until it has a definitive answer, so a retry never asks twice. Every answer is
 * followed by a fresh read; nothing is cached outside this component.
 */
/**
 * `initialQuestion` pre-fills the question (nothing is sent until Ask is pressed); `compact` leaves out the budget form and
 * shows only the latest few answers, for use beside another page (the contest setup page).
 */
export function HqHonPanel({ agentKey, name, api = hqHonApi, initialQuestion, compact = false, voice = false, startVoice = 0, focusQuestion = false }: { agentKey: HqHonAgentKey; name: string; api?: HqHonApi;
  initialQuestion?: string; compact?: boolean;
  /** The dashboard orb (owner 2026-11-27): talk to this agent by voice; a spoken question takes the same ask path as a typed one. */
  voice?: boolean;
  /** Each new value (a microphone tap on the orb card) starts listening once voice can ask. */
  startVoice?: number;
  /** Put the cursor in the question box when shown. */
  focusQuestion?: boolean }): React.ReactElement {
  return voice ? <HqHonVoicePanel agentKey={agentKey} name={name} api={api} initialQuestion={initialQuestion} compact={compact} startVoice={startVoice} focusQuestion={focusQuestion}/>
    : <HqHonPlainPanel agentKey={agentKey} name={name} api={api} initialQuestion={initialQuestion} compact={compact} focusQuestion={focusQuestion}/>;
}

type PanelProps = { agentKey: HqHonAgentKey; name: string; api: HqHonApi; initialQuestion: string | undefined; compact: boolean; focusQuestion: boolean };

function HqHonPlainPanel(props: PanelProps): React.ReactElement {
  const { preferences, number } = useLocale();
  const ask = useHqHonAsk(props.api, props.agentKey, props.initialQuestion);
  return <HqHonPanelView agentKey={props.agentKey} name={props.name} language={preferences.language} number={number} {...ask.viewProps} compact={props.compact} focusQuestion={props.focusQuestion}/>;
}

function HqHonVoicePanel({ startVoice, ...props }: PanelProps & { startVoice: number }): React.ReactElement {
  const { preferences, number } = useLocale();
  const ask = useHqHonAsk(props.api, props.agentKey, props.initialQuestion);
  const lang = honVoiceLang(preferences.language);
  const askTextRef = useRef(ask.askText); askTextRef.current = ask.askText;
  const canVoice = ask.canAsk;
  const voiceAllowed = useRef(canVoice); voiceAllowed.current = canVoice;
  // No school here: HQ answers are read with this browser's own voice.
  const voice = useHonVoice(lang, (text) => {
    if (!voiceAllowed.current) return false;
    void askTextRef.current(text, true).then((receipt) => voice.reply(honVoiceReplyText(receipt ? receipt.turn : { status: 'FAILED', reply: null }, lang)));
    return true;
  });
  const { talkNow, ready } = voice;
  const started = useRef(0);
  useEffect(() => {
    if (startVoice <= started.current || !ready || !canVoice) return;
    started.current = startVoice; talkNow();
  }, [startVoice, ready, canVoice, talkNow]);
  return <HqHonPanelView agentKey={props.agentKey} name={props.name} language={preferences.language} number={number} {...ask.viewProps} compact={props.compact} focusQuestion={props.focusQuestion}
    voice={<HonVoiceControls {...voice.controls(canVoice)}/>}/>;
}

/**
 * The HQ Ask HON state and its one ask path. A typed question (the form) and a spoken one (voice) both go through askText,
 * with one Idempotency-Key per attempt until a definitive answer. Resolves with the receipt, or null when nothing was answered.
 */
function useHqHonAsk(api: HqHonApi, agentKey: HqHonAgentKey, initialQuestion: string | undefined) {
  const [state, setState] = useState<State>({ kind: 'LOADING' });
  const [question, setQuestion] = useState(initialQuestion ?? '');
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

  const canAsk = state.kind === 'READY' && state.view.availableAgents.includes(agentKey) && state.view.provider === 'CONNECTED'
    && outcome?.kind !== 'SENDING' && !unconfirmed(outcome);

  const askText = useCallback(async (text: string, spoken: boolean): Promise<HqHonTurnReceipt | null> => {
    const q = text.trim();
    if (!q || q.length > 2000 || outcome?.kind === 'SENDING' || unconfirmed(outcome)) return null;
    const body = JSON.stringify([q, mode]);
    // Keep the key only for the same question and mode; anything else is a new attempt.
    if (pending.current?.body !== body) pending.current = { key: crypto.randomUUID(), body };
    const attempt = pending.current;
    setOutcome({ kind: 'SENDING' });
    let receipt: HqHonTurnReceipt | null = null;
    try {
      receipt = await api.ask({ question: q, replyMode: mode, agentKey }, attempt.key, AbortSignal.timeout(60000), () => mounted.current);
      if (!mounted.current) return null;
      // A replay may return a turn that is still answering, held or failed: show its own status, not "Answered.".
      // A spoken question never clears what is typed in the box.
      pending.current = null; if (!spoken) setQuestion(''); setOutcome({ kind: 'DONE', status: receipt.turn.status });
    } catch (error) {
      if (!mounted.current) return null;
      const err = error instanceof MarketingError ? error : new MarketingError('UNKNOWN');
      // UNKNOWN keeps the key: a retry replays the saved turn instead of asking again.
      if (err.kind !== 'UNKNOWN') pending.current = null;
      setOutcome({ kind: 'ERROR', error: err });
    }
    setRefresh(n => n + 1);
    return receipt;
  }, [api, agentKey, mode, outcome]);

  const onAsk = useCallback((e: React.FormEvent) => { e.preventDefault(); void askText(question, false); }, [askText, question]);

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

  return {
    askText, canAsk,
    viewProps: { state, question, mode, outcome, onQuestion: setQuestion, onMode: setMode, onAsk, budgetOutcome, onBudget,
      onRefresh: () => { if (unconfirmed(outcome)) setOutcome(null); if (unconfirmed(budgetOutcome)) setBudgetOutcome(null); setRefresh(n => n + 1); } },
  };
}

/** An unconfirmed result keeps Ask off until a refresh, so editing the question cannot start a second attempt. */
const unconfirmed = (o: Outcome | BudgetOutcome): boolean => o?.kind === 'ERROR' && o.error.kind === 'UNKNOWN';

export type HqHonPanelViewProps = {
  agentKey: HqHonAgentKey; name: string; language: Language; number: (n: number) => string; state: State; question: string; mode: HonReplyMode;
  outcome: Outcome; onQuestion: (v: string) => void; onMode: (m: HonReplyMode) => void; onAsk: (e: React.FormEvent) => void; onRefresh: () => void;
  budgetOutcome: BudgetOutcome; onBudget: (cap: string, reason: string) => void; compact?: boolean;
  /** Voice controls, shown under the question box only while this agent can be asked. */
  voice?: React.ReactNode; focusQuestion?: boolean;
};
/** Pure view: everything it shows comes from the props; it decides nothing. */
export function HqHonPanelView({ agentKey, name, language, number, state, question, mode, outcome, onQuestion, onMode, onAsk, onRefresh, budgetOutcome, onBudget, compact = false, voice = null, focusQuestion = false }: HqHonPanelViewProps): React.ReactElement {
  const t = (key: HqHonCopyKey, p: Readonly<Record<string, string | number>> = {}) => hqHonText(language, key, { name, ...p });
  if (state.kind === 'LOADING') return <section aria-busy="true"><p>{t('loading')}</p></section>;
  if (state.kind === 'DENIED') return <section><p>{t('denied')}</p></section>;
  if (state.kind === 'UNAVAILABLE') return <section><p role="alert">{t('unavailable')}</p><button type="button" onClick={() => onRefresh()}>{t('refresh')}</button></section>;
  const view = state.view, allowed = view.availableAgents.includes(agentKey), connected = view.provider === 'CONNECTED';
  const all = view.turns.filter(turn => turn.agentKey === agentKey), mine = compact ? all.slice(0, 3) : all;
  const b = view.budget;
  return <section aria-labelledby={`hq-hon-${agentKey}-title`} data-hq-hon-agent={agentKey}>
    <h2 id={`hq-hon-${agentKey}-title`}>{t('askTitle')}</h2>
    <p>{t('askIntro')}</p>
    <p>{b.creditCap === null ? t('noBudget') : b.creditCap >= HQ_HON_NO_CAP ? t('budgetNoCap', { used: number(b.usedCredits), held: number(b.heldCredits) }) : t('budget', { available: number(b.availableCredits), cap: number(b.creditCap), used: number(b.usedCredits), held: number(b.heldCredits) })}</p>
    {view.viewer.isOwner && !compact && <BudgetForm agentKey={agentKey} t={t} outcome={budgetOutcome} onBudget={onBudget} onRefresh={onRefresh} language={language}
      history={view.budgetHistory} number={number}/>}
    {!allowed ? <p role="note">{t('notYours')}</p> : !connected ? <p role="note">{t('providerOff')}</p> :
      <form onSubmit={onAsk}>
        <label htmlFor={`hq-hon-${agentKey}-q`}>{t('question')}</label>
        <textarea id={`hq-hon-${agentKey}-q`} autoFocus={focusQuestion} value={question} maxLength={2000} required onChange={e => onQuestion(e.target.value)} aria-describedby={`hq-hon-${agentKey}-help`}/>
        <small id={`hq-hon-${agentKey}-help`}>{t('questionHelp')}</small>
        <fieldset><legend>{t('mode')}</legend>
          {(['STANDARD', 'DETAILED'] as const).map(m => <label key={m}><input type="radio" name={`hq-hon-${agentKey}-mode`} value={m} checked={mode === m} onChange={() => onMode(m)}/>{t(m)}</label>)}
        </fieldset>
        <button type="submit" disabled={outcome?.kind === 'SENDING' || unconfirmed(outcome) || !question.trim()}>{outcome?.kind === 'SENDING' ? t('asking') : t('ask')}</button>
        {voice}
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

/** The highest cap the server accepts (HQ_HON_LIMITS.maxCap, 0263 CHECK credit_cap <= 10,000,000). The owner chose no monthly cap on HQ AI (2026-11-24),
 * so this is offered as one tap; every question still carries its own per-request cost limit on the server. */
export const HQ_HON_NO_CAP = HQ_HON_LIMITS.maxCap;

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
    <fieldset disabled={locked} data-hq-hon-no-cap="">
      <legend>{t('noCapTitle')}</legend>
      <small>{t('noCapHelp')}</small>
      <button type="button" onClick={() => onBudget(String(HQ_HON_NO_CAP), t('noCapReason'))}>{t('noCapButton')}</button>
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
