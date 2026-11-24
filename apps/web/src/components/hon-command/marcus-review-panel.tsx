'use client';

import React, { useEffect, useRef, useState } from 'react';
import type { MarcusReviewArea, MarcusReviewPeriod, MarcusReviewView } from '@hon/contracts';
import { MarcusReviewError, marcusReviewApi as defaultApi, type MarcusReviewApi, type MarcusReviewErrorKind, type MarcusReviewScope } from './marcus-review-http';
import styles from './hon-command.module.css';

/**
 * P3 (0641): a marketing review with Marcus. A marketing staff member asks Marcus to read the school's own marketing numbers for
 * the last 30 or 90 days; Marcus answers with a summary, findings and next steps. Text only: nothing is created, sent, published
 * or spent. The server decides who may ask, what Marcus sees (counts only, never a person or contact) and every AI spend rule.
 */
export const MARCUS_REVIEW_NOTICE: Readonly<Record<MarcusReviewErrorKind | 'FAILED' | 'BLOCKED' | 'CONFIGURATION_REQUIRED' | 'HELD' | 'REJECTED', string>> = {
  SESSION: 'Your session ended. Sign in again.',
  NO_ACCESS: 'A marketing review needs campaign access, Marcus switched on for you at this school, and an active Complete plan. Nothing was sent.',
  PAUSED: 'AI help is paused or not available for this school right now. Nothing was sent.',
  GONE: 'This review was already dismissed.',
  INVALID: 'That request was not accepted. Nothing was sent.',
  UNKNOWN: 'HON could not confirm what happened. Press the button again to check: the same request is never sent twice.',
  FAILED: 'Marcus could not read the numbers this time. Nothing was charged for an answer.',
  BLOCKED: 'The request was stopped before it was sent.',
  CONFIGURATION_REQUIRED: 'Marcus is not switched on for this school yet.',
  HELD: 'The answer was lost on the way. It is held for review and is never sent again.',
  REJECTED: 'Marcus’s answer could not be used:',
};
export const MARCUS_REVIEW_AREA_LABEL: Readonly<Record<MarcusReviewArea, string>> = { marcus: 'Marcus · campaigns', chad: 'Chad · lead follow-up', lena: 'Lena · content' };
type Notice = null | { kind: keyof typeof MARCUS_REVIEW_NOTICE; problems?: readonly string[] };
type State = { state: 'CHECKING' } | { state: 'OFF' } | { state: 'ON'; busy: boolean };
const newKey = (): string => globalThis.crypto.randomUUID();

export function MarcusReviewPanel({ scope, api = defaultApi }: { scope: MarcusReviewScope; api?: MarcusReviewApi }): React.ReactElement {
  const [marcus, setMarcus] = useState<State>({ state: 'CHECKING' });
  const [period, setPeriod] = useState<MarcusReviewPeriod>('LAST_30_DAYS');
  const [question, setQuestion] = useState('');
  const [view, setView] = useState<MarcusReviewView | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  // A request whose answer was lost keeps its key: only the identical request may be sent again, never twice.
  const retry = useRef<{ key: string; body: string } | null>(null);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  useEffect(() => {
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]);
    const owned = () => live.current && !abort.signal.aborted;
    setMarcus({ state: 'CHECKING' }); setView(null); setNotice(null);
    api.list(scope, signal, owned).then(
      (l) => {
        if (!owned()) return;
        setMarcus(l.aiAvailable ? { state: 'ON', busy: false } : { state: 'OFF' });
        setView(l.reviews.find((r) => r.status === 'RESULT_RECORDED') ?? null);
      },
      () => { if (owned()) setMarcus({ state: 'OFF' }); });
    return () => { abort.abort(); };
  }, [api, scope.organizationId, scope.schoolId]);

  const ask = async () => {
    if (marcus.state !== 'ON' || marcus.busy) return;
    const body = { period, question: question.trim() }, text = JSON.stringify(body);
    const key = retry.current?.body === text ? retry.current.key : newKey();
    retry.current = { key, body: text };
    setMarcus({ state: 'ON', busy: true }); setNotice(null);
    try {
      const v = await api.request(scope, body, key, AbortSignal.timeout(90000), () => live.current);
      if (!live.current) return;
      retry.current = null; setMarcus({ state: 'ON', busy: false });
      if (v.status === 'RESULT_RECORDED') { setView(v); return; }
      setNotice(v.status === 'RESULT_REJECTED' ? { kind: 'REJECTED', problems: v.problems } : v.status === 'UNKNOWN' ? { kind: 'HELD' }
        : v.status === 'BLOCKED' || v.status === 'CONFIGURATION_REQUIRED' ? { kind: v.status } : { kind: 'FAILED' });
    } catch (error) {
      if (!live.current) return;
      const kind = error instanceof MarcusReviewError ? error.kind : 'UNKNOWN';
      setNotice({ kind }); if (kind !== 'UNKNOWN') retry.current = null;
      setMarcus({ state: 'ON', busy: false });
    }
  };
  const dismiss = () => {
    if (!view) return;
    const before = view; setView(null);
    api.dismiss(scope, before.id, newKey(), AbortSignal.timeout(30000), () => live.current).then(
      () => undefined, (error) => { if (!live.current) return; const kind = error instanceof MarcusReviewError ? error.kind : 'UNKNOWN'; if (kind !== 'GONE') { setNotice({ kind }); setView(before); } });
  };
  const busy = marcus.state === 'ON' && marcus.busy;

  return <section id="marcus-review" className={styles.alexPlan} aria-labelledby="marcus-review-title" data-marcus-review={marcus.state}>
    <h4 id="marcus-review-title">Marketing review with Marcus</h4>
    <p className={styles.meta}>Marcus reads your school’s own numbers (new leads by source and campaign, how many were won or registered, and your lead forms) and tells you what is working and what to try next. Marcus creates, sends and spends nothing.</p>
    {marcus.state === 'CHECKING' ? <p className={styles.meta} role="status">Checking whether Marcus is available…</p> : null}
    {marcus.state === 'OFF' ? <p className={styles.state} data-state="EMPTY" data-marcus-off>Marketing reviews with Marcus are not available to you here yet.</p> : null}
    {marcus.state === 'ON' ? <form className={styles.alexForm} onSubmit={(e) => { e.preventDefault(); void ask(); }}>
      <fieldset><legend>Look at</legend>
        {(['LAST_30_DAYS', 'LAST_90_DAYS'] as const).map((p) => <label key={p}><input type="radio" name="marcus-period" checked={period === p} onChange={() => setPeriod(p)} /> {p === 'LAST_30_DAYS' ? 'Last 30 days' : 'Last 90 days'}</label>)}
      </fieldset>
      <label>A question for Marcus (optional)<textarea value={question} maxLength={300} rows={2} onChange={(e) => setQuestion(e.target.value)} placeholder="For example: which campaign should we keep running?" data-marcus-question /></label>
      <button type="submit" className={styles.primary} disabled={busy} data-marcus-ask>{busy ? 'Marcus is reading…' : 'Ask Marcus'}</button>
    </form> : null}
    {notice ? <div className={styles.note} role="alert" data-marcus-notice={notice.kind}>
      <p>{MARCUS_REVIEW_NOTICE[notice.kind]}</p>
      {notice.problems?.length ? <ul>{notice.problems.map((x, n) => <li key={n}>{x}</li>)}</ul> : null}
    </div> : null}
    {view && view.status === 'RESULT_RECORDED' ? <MarcusReviewResult view={view} busy={busy} onDismiss={dismiss} /> : null}
  </section>;
}

/** One review as the person sees it. Pure, so it is tested directly. */
export function MarcusReviewResult({ view, busy, onDismiss }: { view: MarcusReviewView; busy: boolean; onDismiss: () => void }): React.ReactElement {
  return <div data-marcus-result={view.status}>
    <p className={styles.note}>Marcus wrote this with AI from your school’s marketing numbers for the {view.brief.period === 'LAST_90_DAYS' ? 'last 90 days' : 'last 30 days'}. Check it before you act on it.</p>
    <p>{view.summary}</p>
    <h5>What Marcus found</h5>
    <ul className={styles.rows}>{(view.findings ?? []).map((f, n) => <li key={n} className={styles.row} data-marcus-finding={n}>
      <div><strong>{f.title}</strong><span className={styles.meta}>{f.detail}</span></div>
    </li>)}</ul>
    <h5>What to try next</h5>
    <ul className={styles.rows}>{(view.nextSteps ?? []).map((s, n) => <li key={n} className={styles.row} data-marcus-step={n}>
      <div><strong>{s.title}</strong><span className={styles.meta}>{s.detail}</span></div>
      <div className={styles.rowStatus}>{s.area ? <span className={styles.meta} data-marcus-area={s.area}>{MARCUS_REVIEW_AREA_LABEL[s.area]}</span> : null}</div>
    </li>)}</ul>
    <div className={styles.alexActions}>
      <button type="button" className={styles.inlineLink} disabled={busy} onClick={onDismiss} data-marcus-dismiss>Dismiss</button>
    </div>
  </div>;
}
