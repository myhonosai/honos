'use client';

import React, { useEffect, useRef, useState } from 'react';
import type { ChadLeadPlanFocus, ChadLeadPlanSuggestion, ChadLeadPlanView } from '@hon/contracts';
import { ChadLeadPlanError, chadLeadPlanApi as defaultApi, type ChadLeadPlanApi, type ChadLeadPlanErrorKind, type ChadLeadPlanScope } from './chad-lead-plan-http';
import { BoardCommandError, prepareMove, submitMove } from '../lead-pipeline/http';
import { scheduleTrial, TrialAppointmentAccessError } from '../trial-appointment-http';
import styles from './hon-command.module.css';
import { AgentVoiceBar } from './agent-voice-bar';

/**
 * P9 (0650): lead next steps with Chad. A staff member asks Chad to look over the school's open leads; Chad suggests one next step
 * for up to ten of them: move the lead to another stage of its pipeline, or book a trial in one of the next classes. Nothing changes
 * until the person presses a step. Pressing it runs the ordinary human command as that person (the same stage move as the lead
 * pipeline, the same trial booking as the trials page), then HON records which change it was. Chad never contacts a lead. The
 * server decides who may ask, what Chad sees (stages, days and counts, never names or contacts) and every AI spend rule.
 */
export const CHAD_LEAD_PLAN_NOTICE: Readonly<Record<ChadLeadPlanErrorKind | 'FAILED' | 'BLOCKED' | 'CONFIGURATION_REQUIRED' | 'HELD' | 'REJECTED'
  | 'STEP_DENIED' | 'STEP_CHANGED' | 'STEP_UNKNOWN', string>> = {
  SESSION: 'Your session ended. Sign in again.',
  NO_ACCESS: 'Lead next steps with Chad need Chad’s follow-up assistant, lead read and AI planning access at this school, and an active Complete plan. Nothing was sent.',
  NOT_DONE: 'HON could not find that change made by you since Chad wrote this list. Nothing was recorded.',
  PAUSED: 'AI help is paused or not available for this school right now. Nothing was sent.',
  GONE: 'This list was already finished or dismissed.',
  INVALID: 'That request was not accepted. Nothing was sent.',
  UNKNOWN: 'HON could not confirm what happened. Press the button again to check: the same request is never sent twice.',
  FAILED: 'Chad could not look at the leads this time. Nothing was charged for an answer.',
  BLOCKED: 'The request was stopped before it was sent.',
  CONFIGURATION_REQUIRED: 'Chad is not switched on for this school yet.',
  HELD: 'The answer was lost on the way. It is held for review and is never sent again.',
  REJECTED: 'Chad’s answer could not be used:',
  STEP_DENIED: 'You do not have permission to move leads or book trials here. Nothing changed.',
  STEP_CHANGED: 'This lead or class changed since Chad looked, or it already has a trial. Nothing changed. Ask Chad again for a fresh look.',
  STEP_UNKNOWN: 'HON could not confirm the change. Press the step again: the same request is sent with the same key, never twice.',
};
type NoticeKind = keyof typeof CHAD_LEAD_PLAN_NOTICE;
type Notice = null | { kind: NoticeKind; problems?: readonly string[] };
type State = { state: 'CHECKING' } | { state: 'OFF' } | { state: 'ON'; busy: boolean };
/** The ordinary human commands a step runs. Injected so tests never reach the network. */
export type ChadStepRunner = Readonly<{
  move: (scope: ChadLeadPlanScope, leadId: string, stageId: string, expectedVersion: number, key: string) => Promise<void>;
  book: (scope: ChadLeadPlanScope, leadId: string, slot: { startsAt: string; endsAt: string }, key: string) => Promise<string>;
}>;
export const defaultStepRunner: ChadStepRunner = {
  move: async (scope, leadId, stageId, expectedVersion, key) => { await submitMove(prepareMove(scope, leadId, stageId, expectedVersion, key)); },
  book: async (scope, leadId, slot, key) => (await scheduleTrial(scope.organizationId, scope.schoolId, leadId, { startsAt: slot.startsAt, endsAt: slot.endsAt }, key)).id,
};
const newKey = (): string => globalThis.crypto.randomUUID();
const isOpen = (v: ChadLeadPlanView) => v.status === 'RESULT_RECORDED' || v.status === 'APPLIED';
const stepFailure = (error: unknown): NoticeKind => {
  if (error instanceof BoardCommandError) return error.kind === 'DENIED' ? 'STEP_DENIED' : error.kind === 'SESSION' ? 'SESSION' : error.kind === 'UNCERTAIN' ? 'STEP_UNKNOWN' : 'STEP_CHANGED';
  if (error instanceof TrialAppointmentAccessError) return 'STEP_DENIED';
  if (error instanceof Error && /changed|conflicts|unavailable in this school/i.test(error.message)) return 'STEP_CHANGED';
  return 'STEP_UNKNOWN';
};
/** One step's keys: the command key is kept until the command is confirmed, so a lost answer is retried, never repeated. */
type StepKeys = { command: string; step: string; ran: boolean; appointmentId: string | null };

/** "Monday 23 Nov, 17:00" in the viewer's own time zone. */
export function chadClassTime(startsAt: string): string {
  const d = new Date(startsAt);
  return `${d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' })}, ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
}
export function chadStepLabel(view: ChadLeadPlanView, s: ChadLeadPlanSuggestion): string {
  if (s.action === 'MOVE_STAGE') return `Move to ${view.stages.find((x) => x.ref === s.stage)?.name ?? 'the suggested stage'}`;
  const c = view.classes.find((x) => x.ref === s.slot);
  return c ? `Book a trial: ${c.name}, ${chadClassTime(c.startsAt)}` : 'Book a trial';
}

export function ChadLeadPlanPanel({ scope, api = defaultApi, run = defaultStepRunner }: { scope: ChadLeadPlanScope; api?: ChadLeadPlanApi; run?: ChadStepRunner }): React.ReactElement {
  const [chad, setChad] = useState<State>({ state: 'CHECKING' });
  const [focus, setFocus] = useState<ChadLeadPlanFocus>('ALL_OPEN');
  const [note, setNote] = useState('');
  const [view, setView] = useState<ChadLeadPlanView | null>(null);
  const [working, setWorking] = useState<number | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  // A request whose answer was lost keeps its key: only the identical request may be sent again, never twice.
  const retry = useRef<{ key: string; body: string } | null>(null);
  const steps = useRef<Map<string, StepKeys>>(new Map());
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  useEffect(() => {
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]);
    const owned = () => live.current && !abort.signal.aborted;
    setChad({ state: 'CHECKING' }); setView(null); setNotice(null);
    api.list(scope, signal, owned).then(
      (l) => {
        if (!owned()) return;
        setChad(l.aiAvailable ? { state: 'ON', busy: false } : { state: 'OFF' });
        setView(l.leadPlans.find((p) => p.status === 'RESULT_RECORDED') ?? null);
      },
      () => { if (owned()) setChad({ state: 'OFF' }); });
    return () => { abort.abort(); };
  }, [api, scope.organizationId, scope.schoolId]);

  const fail = (error: unknown) => { const kind = error instanceof ChadLeadPlanError ? error.kind : 'UNKNOWN'; setNotice({ kind }); return kind; };
  const ask = async () => {
    if (chad.state !== 'ON' || chad.busy) return;
    const body = { focus, note: note.trim() }, text = JSON.stringify(body);
    const key = retry.current?.body === text ? retry.current.key : newKey();
    retry.current = { key, body: text };
    setChad({ state: 'ON', busy: true }); setNotice(null);
    try {
      const v = await api.request(scope, body, key, AbortSignal.timeout(90000), () => live.current);
      if (!live.current) return;
      retry.current = null; setChad({ state: 'ON', busy: false });
      if (v.status === 'RESULT_RECORDED') { setView(v); return; }
      setNotice(v.status === 'RESULT_REJECTED' ? { kind: 'REJECTED', problems: v.problems } : v.status === 'UNKNOWN' ? { kind: 'HELD' }
        : v.status === 'BLOCKED' || v.status === 'CONFIGURATION_REQUIRED' ? { kind: v.status } : { kind: 'FAILED' });
    } catch (error) {
      if (!live.current) return;
      if (fail(error) !== 'UNKNOWN') retry.current = null;
      setChad({ state: 'ON', busy: false });
    }
  };
  const doStep = async (n: number) => {
    if (!view || view.status !== 'RESULT_RECORDED' || working !== null) return;
    const s = view.suggestions?.[n], lead = s ? view.leads.find((x) => x.ref === s.lead) : undefined;
    if (!s || !lead || view.applied.some((x) => x.index === n)) return;
    const id = `${view.id}:${n}`;
    const k = steps.current.get(id) ?? { command: newKey(), step: newKey(), ran: false, appointmentId: null };
    steps.current.set(id, k);
    setWorking(n); setNotice(null);
    try {
      if (!k.ran) {
        try {
          if (s.action === 'MOVE_STAGE') {
            const stage = view.stages.find((x) => x.ref === s.stage);
            if (!stage) { setNotice({ kind: 'STEP_CHANGED' }); steps.current.delete(id); return; }
            await run.move(scope, lead.leadId, stage.stageId, lead.leadVersion, k.command);
          } else {
            const slot = view.classes.find((x) => x.ref === s.slot);
            if (!slot) { setNotice({ kind: 'STEP_CHANGED' }); steps.current.delete(id); return; }
            k.appointmentId = await run.book(scope, lead.leadId, slot, k.command);
          }
          k.ran = true;
        } catch (error) {
          const kind = stepFailure(error);
          if (kind !== 'STEP_UNKNOWN') steps.current.delete(id);
          if (live.current) setNotice({ kind });
          return;
        }
      }
      try {
        const v = await api.step(scope, view.id, n, k.appointmentId, k.step, AbortSignal.timeout(30000), () => live.current);
        if (!live.current) return;
        steps.current.delete(id); setView(v);
      } catch (error) {
        if (!live.current) return;
        if (fail(error) !== 'UNKNOWN') k.step = newKey();
      }
    } finally { if (live.current) setWorking(null); }
  };
  const dismiss = () => {
    if (!view || view.status !== 'RESULT_RECORDED') return;
    const before = view; setView(null);
    api.dismiss(scope, before.id, newKey(), AbortSignal.timeout(30000), () => live.current).then(
      () => undefined, (error) => { if (live.current && fail(error) !== 'GONE') setView(before); });
  };
  const busy = (chad.state === 'ON' && chad.busy) || working !== null;

  return <section id="chad-lead-plan" className={styles.alexPlan} aria-labelledby="chad-lead-plan-title" data-chad-lead-plan={chad.state}>
    <h4 id="chad-lead-plan-title">Lead next steps with Chad</h4>
    <p className={styles.meta}>Chad looks over your open leads and suggests one next step for each: move it along the pipeline, or book a trial in one of your next classes. Nothing changes until you press a step, and then it runs as you. Chad never contacts a lead.</p>
    {chad.state === 'CHECKING' ? <p className={styles.meta} role="status">Checking whether Chad is available…</p> : null}
    {chad.state === 'OFF' ? <p className={styles.state} data-state="EMPTY" data-chad-off>Lead next steps with Chad are not available to you here yet.</p> : null}
    {chad.state === 'ON' ? <form className={styles.alexForm} onSubmit={(e) => { e.preventDefault(); void ask(); }}>
      <fieldset><legend>Which leads</legend>
        {(['ALL_OPEN', 'NO_TRIAL_YET'] as const).map((f) => <label key={f}><input type="radio" name="chad-focus" checked={focus === f} onChange={() => setFocus(f)} /> {f === 'ALL_OPEN' ? 'All open leads' : 'Leads with no trial yet'}</label>)}
      </fieldset>
      <label>Anything Chad should know (optional)<textarea value={note} maxLength={300} rows={2} onChange={(e) => setNote(e.target.value)} placeholder="For example: we have space in the Saturday kids class" data-chad-note /></label>
      <AgentVoiceBar agentKey="chad" name="Chad" value={note} max={300} onChange={setNote} answer={view?.summary ?? null} />
      <button type="submit" className={styles.primary} disabled={busy} data-chad-ask>{chad.state === 'ON' && chad.busy ? 'Chad is looking…' : 'Ask Chad'}</button>
    </form> : null}
    {notice ? <div className={styles.note} role="alert" data-chad-notice={notice.kind}>
      <p>{CHAD_LEAD_PLAN_NOTICE[notice.kind]}</p>
      {notice.problems?.length ? <ul>{notice.problems.map((x, n) => <li key={n}>{x}</li>)}</ul> : null}
    </div> : null}
    {view && isOpen(view) ? <ChadLeadPlanResult view={view} working={working} busy={busy} onStep={(n) => void doStep(n)} onDismiss={dismiss} /> : null}
  </section>;
}

/** One list of suggestions as the person sees it. Pure, so it is tested directly. */
export function ChadLeadPlanResult({ view, working, busy, onStep, onDismiss }: { view: ChadLeadPlanView; working: number | null; busy: boolean;
  onStep: (index: number) => void; onDismiss: () => void }): React.ReactElement {
  const open = view.status === 'RESULT_RECORDED';
  return <div data-chad-result={view.status}>
    <p className={styles.note}>Chad wrote this with AI from lead stages, dates and trial counts. Check each step before you press it.</p>
    <p>{view.summary}</p>
    <ul className={styles.rows}>{(view.suggestions ?? []).map((s, n) => {
      const lead = view.leads.find((x) => x.ref === s.lead), done = view.applied.find((c) => c.index === n);
      return <li key={n} className={styles.row} data-chad-suggestion={n}>
        <div>
          <strong>{lead?.name || 'A lead'}</strong>
          <span className={styles.meta}>{chadStepLabel(view, s)}</span>
          <span className={styles.meta}>{s.reason}</span>
        </div>
        <div className={styles.rowStatus}>
          {done ? <a className={styles.inlineLink} href={s.action === 'BOOK_TRIAL' ? '/staff/crm/trials' : '/staff/crm/leads'} data-chad-done={n}>{s.action === 'BOOK_TRIAL' ? 'Trial booked →' : 'Moved →'}</a>
            : open ? <button type="button" className={styles.primary} disabled={busy} onClick={() => onStep(n)} data-chad-step={n}>{working === n ? 'Working…' : chadStepLabel(view, s)}</button> : null}
        </div>
      </li>;
    })}</ul>
    {open ? <div className={styles.alexActions}>
      <button type="button" className={styles.inlineLink} disabled={busy} onClick={onDismiss} data-chad-dismiss>{view.applied.length ? 'Done with this list' : 'Dismiss'}</button>
    </div> : null}
    {view.status === 'APPLIED' ? <p className={styles.meta} data-chad-applied>{view.applied.length === 1 ? '1 step was done' : `${view.applied.length} steps were done`} by you. Chad did not send or change anything else.</p> : null}
  </div>;
}
