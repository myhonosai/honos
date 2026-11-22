'use client';

import React, { useEffect, useRef, useState } from 'react';
import type { ClaireKpiCode, ClaireKpiNumber, ClaireKpiPeriod, ClaireKpiView } from '@hon/contracts';
import { ClaireKpiError, claireKpiApi as defaultApi, type ClaireKpiApi, type ClaireKpiErrorKind, type ClaireKpiScope } from './claire-kpi-http';
import styles from './hon-command.module.css';
import { AgentVoiceBar } from './agent-voice-bar';

/**
 * P4 (0643): a KPI report with Claire. A reporting user picks the last 7 or 30 days; the server counts nine KPIs for that window
 * and the one before it and Claire adds notes, things to watch and next actions. The numbers on screen are always the counted
 * ones, never Claire's. Text only: nothing is created, sent or changed. The server decides who may ask and every AI spend rule.
 */
export const CLAIRE_KPI_NOTICE: Readonly<Record<ClaireKpiErrorKind | 'FAILED' | 'BLOCKED' | 'CONFIGURATION_REQUIRED' | 'HELD' | 'REJECTED', string>> = {
  SESSION: 'Your session ended. Sign in again.',
  NO_ACCESS: 'A KPI report needs reporting access, Claire switched on for you at this school, and an active Complete plan. Nothing was sent.',
  PAUSED: 'AI help is paused or not available for this school right now. Nothing was sent.',
  GONE: 'This report was already dismissed.',
  INVALID: 'That request was not accepted. Nothing was sent.',
  UNKNOWN: 'HON could not confirm what happened. Press the button again to check: the same request is never sent twice.',
  FAILED: 'Claire could not write the report this time. Nothing was charged for an answer.',
  BLOCKED: 'The request was stopped before it was sent.',
  CONFIGURATION_REQUIRED: 'Claire is not switched on for this school yet.',
  HELD: 'The answer was lost on the way. It is held for review and is never sent again.',
  REJECTED: 'Claire’s notes could not be used:',
};
export const CLAIRE_KPI_LABEL: Readonly<Record<ClaireKpiCode, string>> = {
  NEW_LEADS: 'New leads', WON_LEADS: 'Leads won', LOST_LEADS: 'Leads lost', REGISTRATIONS: 'Registrations', NEW_MEMBERSHIPS: 'New memberships',
  ENDED_MEMBERSHIPS: 'Memberships ended', CLASSES_ATTENDED: 'Classes attended', STUDENTS_ATTENDING: 'Students attending', ACTIVE_MEMBERSHIPS: 'Active memberships now',
};
type Notice = null | { kind: keyof typeof CLAIRE_KPI_NOTICE; problems?: readonly string[] };
type State = { state: 'CHECKING' } | { state: 'OFF' } | { state: 'ON'; busy: boolean };
const newKey = (): string => globalThis.crypto.randomUUID();

/** The change against the window before, in plain words. */
export function claireKpiChange(k: ClaireKpiNumber): string {
  if (k.previous === null) return 'now';
  const d = k.current - k.previous;
  return d === 0 ? `same as before (${k.previous})` : `${d > 0 ? 'up' : 'down'} ${Math.abs(d)} from ${k.previous}`;
}

export function ClaireKpiPanel({ scope, api = defaultApi }: { scope: ClaireKpiScope; api?: ClaireKpiApi }): React.ReactElement {
  const [claire, setClaire] = useState<State>({ state: 'CHECKING' });
  const [period, setPeriod] = useState<ClaireKpiPeriod>('LAST_7_DAYS');
  const [focus, setFocus] = useState('');
  const [view, setView] = useState<ClaireKpiView | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  // A request whose answer was lost keeps its key: only the identical request may be sent again, never twice.
  const retry = useRef<{ key: string; body: string } | null>(null);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  useEffect(() => {
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]);
    const owned = () => live.current && !abort.signal.aborted;
    setClaire({ state: 'CHECKING' }); setView(null); setNotice(null);
    api.list(scope, signal, owned).then(
      (l) => {
        if (!owned()) return;
        setClaire(l.aiAvailable ? { state: 'ON', busy: false } : { state: 'OFF' });
        setView(l.reports.find((r) => r.status === 'RESULT_RECORDED') ?? null);
      },
      () => { if (owned()) setClaire({ state: 'OFF' }); });
    return () => { abort.abort(); };
  }, [api, scope.organizationId, scope.schoolId]);

  const ask = async () => {
    if (claire.state !== 'ON' || claire.busy) return;
    const body = { period, focus: focus.trim() }, text = JSON.stringify(body);
    const key = retry.current?.body === text ? retry.current.key : newKey();
    retry.current = { key, body: text };
    setClaire({ state: 'ON', busy: true }); setNotice(null);
    try {
      const v = await api.request(scope, body, key, AbortSignal.timeout(90000), () => live.current);
      if (!live.current) return;
      retry.current = null; setClaire({ state: 'ON', busy: false });
      if (v.status === 'RESULT_RECORDED') { setView(v); return; }
      setNotice(v.status === 'RESULT_REJECTED' ? { kind: 'REJECTED', problems: v.problems } : v.status === 'UNKNOWN' ? { kind: 'HELD' }
        : v.status === 'BLOCKED' || v.status === 'CONFIGURATION_REQUIRED' ? { kind: v.status } : { kind: 'FAILED' });
    } catch (error) {
      if (!live.current) return;
      const kind = error instanceof ClaireKpiError ? error.kind : 'UNKNOWN';
      setNotice({ kind }); if (kind !== 'UNKNOWN') retry.current = null;
      setClaire({ state: 'ON', busy: false });
    }
  };
  const dismiss = () => {
    if (!view) return;
    const before = view; setView(null);
    api.dismiss(scope, before.id, newKey(), AbortSignal.timeout(30000), () => live.current).then(
      () => undefined, (error) => { if (!live.current) return; const kind = error instanceof ClaireKpiError ? error.kind : 'UNKNOWN'; if (kind !== 'GONE') { setNotice({ kind }); setView(before); } });
  };
  const busy = claire.state === 'ON' && claire.busy;

  return <section id="claire-kpi" className={styles.alexPlan} aria-labelledby="claire-kpi-title" data-claire-kpi={claire.state}>
    <h4 id="claire-kpi-title">KPI report with Claire</h4>
    <p className={styles.meta}>HON counts nine school KPIs (leads, registrations, memberships and attendance) for the period you pick and the one before it. Claire explains what changed and what to do next. Nothing is sent or changed.</p>
    {claire.state === 'CHECKING' ? <p className={styles.meta} role="status">Checking whether Claire is available…</p> : null}
    {claire.state === 'OFF' ? <p className={styles.state} data-state="EMPTY" data-claire-off>KPI reports with Claire are not available to you here yet.</p> : null}
    {claire.state === 'ON' ? <form className={styles.alexForm} onSubmit={(e) => { e.preventDefault(); void ask(); }}>
      <fieldset><legend>Report on</legend>
        {(['LAST_7_DAYS', 'LAST_30_DAYS'] as const).map((p) => <label key={p}><input type="radio" name="claire-period" checked={period === p} onChange={() => setPeriod(p)} /> {p === 'LAST_7_DAYS' ? 'Last 7 days' : 'Last 30 days'}</label>)}
      </fieldset>
      <label>Anything Claire should focus on (optional)<textarea value={focus} maxLength={300} rows={2} onChange={(e) => setFocus(e.target.value)} placeholder="For example: are we keeping our students?" data-claire-focus /></label>
      <AgentVoiceBar agentKey="claire" name="Claire" value={focus} max={300} onChange={setFocus} answer={view?.summary ?? null} />
      <button type="submit" className={styles.primary} disabled={busy} data-claire-ask>{busy ? 'Claire is writing…' : 'Ask Claire for a report'}</button>
    </form> : null}
    {notice ? <div className={styles.note} role="alert" data-claire-notice={notice.kind}>
      <p>{CLAIRE_KPI_NOTICE[notice.kind]}</p>
      {notice.problems?.length ? <ul>{notice.problems.map((x, n) => <li key={n}>{x}</li>)}</ul> : null}
    </div> : null}
    {view && view.status === 'RESULT_RECORDED' ? <ClaireKpiResult view={view} busy={busy} onDismiss={dismiss} /> : null}
  </section>;
}

/** One report as the person sees it: the counted numbers, with Claire's note beside each. Pure, so it is tested directly. */
export function ClaireKpiResult({ view, busy, onDismiss }: { view: ClaireKpiView; busy: boolean; onDismiss: () => void }): React.ReactElement {
  const days = view.brief.period === 'LAST_30_DAYS' ? 30 : 7;
  return <div data-claire-result={view.status}>
    <p className={styles.note}>The numbers are counted by HON for the last {days} days against the {days} days before. Claire wrote the notes with AI; check them before you act.</p>
    <p>{view.summary}</p>
    <ul className={styles.rows}>{view.kpis.map((k) => {
      const note = view.notes?.find((n) => n.kpi === k.kpi);
      return <li key={k.kpi} className={styles.row} data-claire-kpi-row={k.kpi}>
        <div><strong>{CLAIRE_KPI_LABEL[k.kpi]}: {k.current}</strong><span className={styles.meta}>{claireKpiChange(k)}</span>
          {note ? <span className={styles.meta} data-claire-note={k.kpi}>{note.note}</span> : null}</div>
      </li>;
    })}</ul>
    {view.watch?.length ? <><h5>Keep an eye on</h5><ul className={styles.rows}>{view.watch.map((w, n) => <li key={n} className={styles.row} data-claire-watch={n}>
      <div><strong>{w.title}</strong><span className={styles.meta}>{w.detail}</span></div></li>)}</ul></> : null}
    <h5>What to do next</h5>
    <ul className={styles.rows}>{(view.actions ?? []).map((x, n) => <li key={n} className={styles.row} data-claire-action={n}>
      <div><strong>{x.title}</strong><span className={styles.meta}>{x.detail}</span></div></li>)}</ul>
    <div className={styles.alexActions}>
      <button type="button" className={styles.inlineLink} disabled={busy} onClick={onDismiss} data-claire-dismiss>Dismiss</button>
    </div>
  </div>;
}
