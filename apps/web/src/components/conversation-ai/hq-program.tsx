'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { CONVERSATION_AI_LIMITS, CONVERSATION_AI_PROGRAM_STATUSES, type ConversationAiProgram, type ConversationAiProgramStatus } from '@hon/contracts';
import { useLocale } from '../localization/provider';
import { trainAiCopy } from './copy';
import { TrainAiAccessError, TrainAiRefusal, commandAttempt, loadProgram, setProgram } from './http';
import s from '../testing-registration.module.css';

/**
 * HQ: the one Conversation AI program switch (OFF, TEST_MODE, LIVE). The database decides who may read it (HQ readers)
 * and who may change it (a human HQ owner), and keeps every change with its reason. It starts OFF; LIVE is an owner decision.
 */
export function HqConversationAiProgram(): React.ReactElement {
  const { preferences, date } = useLocale();
  const copy = trainAiCopy(preferences.language);
  const [program, setProgramState] = useState<ConversationAiProgram | null>(null);
  const [next, setNext] = useState<ConversationAiProgramStatus>('OFF'), [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const attempt = useRef<{ fingerprint: string; key: string } | null>(null), mounted = useRef(true);

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      const value = await loadProgram();
      if (!mounted.current) return;
      setProgramState(value); setNext(CONVERSATION_AI_PROGRAM_STATUSES.find(x => x !== value.status) ?? 'OFF'); setError('');
    } catch (problem) {
      if (!mounted.current) return;
      setProgramState(null);
      setError(problem instanceof TrainAiAccessError ? (problem.reason === 'SESSION' ? copy.sessionEnded : copy.hqDenied) : copy.unavailable);
    } finally { if (mounted.current) setBusy(false); }
  }, [copy]);
  useEffect(() => { mounted.current = true; void refresh(); return () => { mounted.current = false; }; }, []); // eslint-disable-line react-hooks/exhaustive-deps -- load once

  const reasonOk = reason.trim() === reason && reason.length >= CONVERSATION_AI_LIMITS.reasonMin && reason.length <= CONVERSATION_AI_LIMITS.reasonMax && !/[\u0000-\u001f\u007f]/.test(reason);
  async function change(event: React.FormEvent) {
    event.preventDefault();
    if (!program || !reasonOk || next === program.status) return;
    const input = { status: next, expectedVersion: program.version, reason };
    attempt.current = commandAttempt(JSON.stringify(input), attempt.current, () => crypto.randomUUID());
    setBusy(true); setError(''); setNotice('');
    try {
      const receipt = await setProgram(input, attempt.current.key);
      if (!mounted.current) return;
      attempt.current = null; setReason(''); setNotice(copy.hqSaved(copy.program[receipt.status]));
      await refresh();
    } catch (problem) {
      if (!mounted.current) return;
      if (problem instanceof TrainAiRefusal) { attempt.current = null; setError(copy.refusal[problem.code] ?? copy.unavailable); }
      else if (problem instanceof TrainAiAccessError) { attempt.current = null; setError(problem.reason === 'SESSION' ? copy.sessionEnded : copy.hqDenied); }
      else setError(copy.hqUnknown);
    } finally { if (mounted.current) setBusy(false); }
  }

  return <main className={s.page}><div className={s.shell}>
    <header className={s.header}><h1>{copy.hqTitle}</h1><p>{copy.hqIntro}</p></header>
    <div aria-live="polite">{busy && !program && <p role="status">{copy.loading}</p>}
      {error && <div className={s.error} role="alert"><strong>{copy.hqTitle}</strong><p>{error}</p></div>}
      {notice && <p className={s.notice} role="status">{notice}</p>}</div>
    {program && <>
      <section className={s.card} aria-labelledby="hq-cai-now"><h2 id="hq-cai-now">{copy.hqStatus}</h2>
        <p><strong>{copy.program[program.status]}</strong></p>
        <p className={s.subtle}>{copy.hqSchools(program.schoolsEnabled)} · {date(program.updatedAt)}{program.updatedBy ? ` · ${program.updatedBy}` : ''}</p>
        <p className={s.actions}><button type="button" disabled={busy} onClick={() => void refresh()}>{copy.refresh}</button></p>
      </section>
      <section className={s.card} aria-labelledby="hq-cai-change"><h2 id="hq-cai-change">{copy.hqChange}</h2>
        <form onSubmit={e => void change(e)}>
          <fieldset><legend>{copy.hqChange}</legend>
            {CONVERSATION_AI_PROGRAM_STATUSES.filter(x => x !== program.status).map(x => <label key={x}>
              <input type="radio" name="hq-cai-status" value={x} checked={next === x} disabled={busy} onChange={() => setNext(x)} /> {copy.program[x]}</label>)}</fieldset>
          {next === 'LIVE' && <p className={s.error} role="note">{copy.hqLiveWarning}</p>}
          <label htmlFor="hq-cai-reason">{copy.hqReason}</label>
          <textarea id="hq-cai-reason" rows={3} value={reason} maxLength={CONVERSATION_AI_LIMITS.reasonMax} disabled={busy} aria-describedby="hq-cai-reason-hint" onChange={e => setReason(e.target.value)} />
          <p id="hq-cai-reason-hint" className={s.subtle}>{copy.hqReasonHint}</p>
          <p className={s.actions}><button type="submit" disabled={busy || !reasonOk || next === program.status}>{copy.hqSave}</button></p>
        </form>
      </section>
      <section className={s.card} aria-labelledby="hq-cai-history"><h2 id="hq-cai-history">{copy.hqHistory}</h2>
        {program.recentChanges.length === 0 ? <p className={s.empty}>{copy.hqNoHistory}</p> : <ol className={s.list}>{program.recentChanges.map(c => <li key={c.version}>
          <p><strong>{copy.program[c.from]} → {copy.program[c.to]}</strong> <span className={s.subtle}>· {date(c.changedAt)}{c.changedBy ? ` · ${c.changedBy}` : ''}</span></p>
          <p>{c.reason}</p></li>)}</ol>}
      </section>
    </>}
  </div></main>;
}
