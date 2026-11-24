'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { CONVERSATION_AI_LIMITS, CONVERSATION_AI_TEST_LIMITS, type ConversationAiTestState, type ConversationAiTestView } from '@hon/contracts';
import { TrainAiAccessError, TrainAiRefusal, askTestQuestion, commandAttempt, loadTestChat, type TrainAiScope } from './http';
import type { TryItCopy } from './try-it-copy';
import s from './setup.module.css';

const newKey = () => crypto.randomUUID();

/**
 * CE2 "Try it" (0667). A staff member asks a question a family might send and sees how the AI answers from the school's
 * training. Nothing is sent to anyone. "Use a better answer" saves a coaching card through the 0420 item save (onCoach).
 * The server decides who may test (conversation.ai.configure, Chad, the Complete plan) and meters every answer (S4).
 */
export function TryIt({ scope, copy, samples, canConfigure, onAnswered, onCoach }: {
  scope: TrainAiScope; copy: TryItCopy; samples: readonly string[]; canConfigure: boolean;
  onAnswered: (answered: boolean) => void; onCoach: (question: string, answer: string) => Promise<boolean>;
}): React.ReactElement {
  const [state, setState] = useState<ConversationAiTestState | null>(null), [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [coaching, setCoaching] = useState<{ id: string; text: string } | null>(null);
  // An unconfirmed ask keeps its key, so asking the same question again never pays for a second answer.
  const attempt = useRef<{ fingerprint: string; key: string } | null>(null), generation = useRef(0);
  const scopeKey = `${scope.organizationId}/${scope.schoolId}`;

  const load = useCallback(async () => {
    const token = ++generation.current;
    try {
      const next = await loadTestChat(scope);
      if (generation.current !== token) return;
      setState(next); onAnswered(next.tests.some(t => t.status === 'ANSWERED'));
    } catch (problem) {
      if (generation.current !== token) return;
      setError(problem instanceof TrainAiAccessError ? copy.denied : copy.refused);
    }
  }, [scopeKey]); // eslint-disable-line react-hooks/exhaustive-deps -- reload on a new school only
  useEffect(() => { setState(null); attempt.current = null; void load(); }, [load]);

  async function ask(event: React.FormEvent | null, text = question) {
    event?.preventDefault();
    const q = text.trim();
    if (!q || q.length > CONVERSATION_AI_TEST_LIMITS.question) { setError(copy.invalid); return; }
    attempt.current = commandAttempt(`ask:${q}`, attempt.current, newKey);
    const token = generation.current;
    setAsking(true); setError(''); setNotice('');
    try {
      const view = await askTestQuestion(scope, q, attempt.current.key);
      if (generation.current !== token) return;
      attempt.current = null; setQuestion('');
      setState(prev => prev ? { ...prev, tests: [view, ...prev.tests.filter(t => t.id !== view.id)].slice(0, CONVERSATION_AI_TEST_LIMITS.recent) } : prev);
      if (view.status === 'ANSWERED') onAnswered(true);
    } catch (problem) {
      if (generation.current !== token) return;
      if (problem instanceof TrainAiRefusal) { attempt.current = null; setError(problem.code === 'CONVERSATION_AI_TEST_BUSY' ? copy.busy : copy.invalid); }
      else if (problem instanceof TrainAiAccessError) { attempt.current = null; setError(problem.code === 'CONVERSATION_AI_TEST_SPEND_STOPPED' ? copy.unavailable.PAUSED : problem.code === 'CONVERSATION_AI_TEST_UNAVAILABLE' ? copy.unavailable.NOT_INCLUDED : copy.denied); void load(); }
      else setError(copy.unknown);
    } finally { if (generation.current === token) setAsking(false); }
  }

  async function saveCoaching(test: ConversationAiTestView) {
    if (!coaching) return;
    if (await onCoach(test.question, coaching.text.trim())) { setCoaching(null); setNotice(copy.betterSaved); }
  }

  if (!canConfigure) return <section className={s.card}><h2>{copy.title}</h2><p className={s.meta}>{copy.readOnly}</p></section>;
  const open = state?.mode === 'AI';
  const coachOk = (text: string) => text.trim().length > 0 && text.trim().length <= CONVERSATION_AI_LIMITS.body;

  return <>
    <section className={s.card} aria-labelledby="ca-try">
      <h2 id="ca-try">{copy.title}</h2>
      <p className={s.meta}>{copy.intro}</p>
      {state && !open && state.reason && <p className={s.flash} data-tone="WARN" role="status">{copy.unavailable[state.reason]}</p>}
      <form className={s.form} onSubmit={e => void ask(e)}>
        <div className={s.field}><label htmlFor="ca-try-q">{copy.label}</label>
          <textarea id="ca-try-q" rows={2} value={question} maxLength={CONVERSATION_AI_TEST_LIMITS.question} disabled={!open || asking}
            placeholder={copy.placeholder} onChange={e => setQuestion(e.target.value)} /></div>
        <div className={s.actions}><button type="submit" className={s.primary} disabled={!open || asking || !question.trim()}>{asking ? copy.asking : copy.ask}</button></div>
      </form>
      {open && <div className={s.chipsBox}><span className={s.meta}>{copy.samples}</span>
        <div className={s.chips}>{samples.slice(0, 4).map(q => <button key={q} type="button" className={s.toggleChip} disabled={asking} onClick={() => { setQuestion(q); void ask(null, q); }}>{q}</button>)}</div></div>}
      <p className={s.meta}>{copy.privacy}</p>
      <div aria-live="polite">{error && <p className={s.flash} data-tone="ERROR" role="alert">{error}</p>}
        {notice && <p className={s.flash} data-tone="OK" role="status">{notice}</p>}</div>
    </section>
    {state && <section className={s.card} aria-labelledby="ca-try-history"><h3 id="ca-try-history">{copy.history}</h3>
      {state.tests.length === 0 ? <p className={s.meta}>{copy.empty}</p> : <ol className={s.chat}>{state.tests.map(t => <li key={t.id} className={s.turn}>
        <p className={s.bubble} data-who="you"><small>{copy.you}</small>{t.question}</p>
        {t.status === 'ANSWERED' && t.reply !== null
          ? <div className={s.bubble} data-who="ai"><small>{copy.ai}</small>{t.reply}{t.needsStaff && <><br /><span className={s.badge}>{copy.needsStaff}</span></>}</div>
          : <p className={s.note}>{t.status === 'WORKING' ? copy.working : copy.reason[t.reason ?? 'NOT_ANSWERED']}</p>}
        {coaching?.id === t.id
          ? <form className={s.form} onSubmit={e => { e.preventDefault(); void saveCoaching(t); }}>
            <div className={s.field}><label htmlFor={`ca-coach-${t.id}`}>{copy.betterLabel}</label>
              <textarea id={`ca-coach-${t.id}`} rows={3} value={coaching.text} maxLength={CONVERSATION_AI_LIMITS.body} onChange={e => setCoaching({ id: t.id, text: e.target.value })} /></div>
            <div className={s.actions}><button type="submit" className={s.primary} disabled={!coachOk(coaching.text)}>{copy.betterSave}</button>
              <button type="button" className={s.ghost} onClick={() => setCoaching(null)}>{copy.cancel}</button></div></form>
          : <div className={s.actions}><button type="button" className={s.ghost} onClick={() => setCoaching({ id: t.id, text: t.reply ?? '' })}>{copy.better}</button></div>}
      </li>)}</ol>}
    </section>}
  </>;
}
