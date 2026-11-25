'use client';

import React, { useEffect, useRef, useState } from 'react';
import type { JordanFollowUpFocus, JordanFollowUpSuggestion, JordanFollowUpView } from '@hon/contracts';
import { JordanFollowUpError, jordanFollowUpApi as defaultApi, type JordanFollowUpApi, type JordanFollowUpErrorKind, type JordanFollowUpScope } from './jordan-follow-up-http';
import styles from './hon-command.module.css';
import { AgentVoiceBar } from './agent-voice-bar';

/**
 * P2 (0640): follow-through with Jordan. A team manager asks Jordan to look over open or overdue tasks; Jordan suggests up to ten
 * changes. Nothing happens until the person ticks suggestions and presses Apply: each runs through Work as that person. The server
 * decides who may ask, what Jordan sees (task titles and staff as S1, S2…, never names) and every AI spend rule.
 */
export const JORDAN_FOLLOW_UP_NOTICE: Readonly<Record<JordanFollowUpErrorKind | 'FAILED' | 'BLOCKED' | 'CONFIGURATION_REQUIRED' | 'HELD' | 'REJECTED', string>> = {
  SESSION: 'Your session ended. Sign in again.',
  NO_ACCESS: 'Follow-through with Jordan needs class schedule and team task management, Jordan switched on for you at this school, and an active Complete plan. Nothing was sent.',
  ASSIGNEE: 'Someone in these suggestions can no longer take tasks at this school. Nothing was applied. Ask Jordan again.',
  CHANGED: 'A task changed after Jordan read it. Nothing was applied. Ask Jordan again for a fresh look.',
  PAUSED: 'AI help is paused or not available for this school right now. Nothing was sent.',
  GONE: 'These suggestions were already used or dismissed.',
  INVALID: 'That request was not accepted. Nothing was sent.',
  UNKNOWN: 'HON could not confirm what happened. Press the button again to check: the same request is never sent twice.',
  FAILED: 'Jordan could not look at the tasks this time. Nothing was charged for an answer.',
  BLOCKED: 'The request was stopped before it was sent.',
  CONFIGURATION_REQUIRED: 'Jordan is not switched on for this school yet.',
  HELD: 'The answer was lost on the way. It is held for review and is never sent again.',
  REJECTED: 'Jordan’s answer could not be used:',
};
type Notice = null | { kind: keyof typeof JORDAN_FOLLOW_UP_NOTICE; problems?: readonly string[] };
type State = { state: 'CHECKING' } | { state: 'OFF' } | { state: 'ON'; busy: boolean };
const newKey = (): string => globalThis.crypto.randomUUID();
const isOpen = (v: JordanFollowUpView) => v.status === 'RESULT_RECORDED' || v.status === 'APPLIED';
const dayText = (days: number | null): string => days === null ? 'no due date' : days === 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`;
const PRIORITY: Readonly<Record<string, string>> = { LOW: 'low', NORMAL: 'normal', HIGH: 'high' };

/** What one suggestion does, in plain words. */
export function jordanSuggestionText(s: JordanFollowUpSuggestion, staffName: (ref: string | null) => string): string {
  switch (s.action) {
    case 'RESCHEDULE': return `Move the due date to ${dayText(s.dueInDays)}`;
    case 'REASSIGN': return `Give it to ${staffName(s.assignee)}`;
    case 'REPRIORITIZE': return `Set priority to ${PRIORITY[s.priority ?? 'NORMAL']}`;
    case 'FOLLOW_UP': return `Add a check-in task for you, due ${dayText(s.dueInDays)}`;
  }
}

export function JordanFollowUpPanel({ scope, api = defaultApi }: { scope: JordanFollowUpScope; api?: JordanFollowUpApi }): React.ReactElement {
  const [jordan, setJordan] = useState<State>({ state: 'CHECKING' });
  const [focus, setFocus] = useState<JordanFollowUpFocus>('OVERDUE');
  const [note, setNote] = useState('');
  const [view, setView] = useState<JordanFollowUpView | null>(null);
  const [ticked, setTicked] = useState<readonly number[]>([]);
  const [notice, setNotice] = useState<Notice>(null);
  // A request whose answer was lost keeps its key: only the identical request may be sent again, never twice.
  const retry = useRef<{ key: string; body: string } | null>(null);
  const applyKey = useRef<{ key: string; body: string } | null>(null);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  useEffect(() => {
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]);
    const owned = () => live.current && !abort.signal.aborted;
    setJordan({ state: 'CHECKING' }); setView(null); setNotice(null);
    api.list(scope, signal, owned).then(
      (l) => {
        if (!owned()) return;
        setJordan(l.aiAvailable ? { state: 'ON', busy: false } : { state: 'OFF' });
        const latest = l.followUps.find((p) => p.mine && p.status === 'RESULT_RECORDED') ?? null;
        setView(latest); setTicked(latest?.suggestions?.map((_, n) => n) ?? []);
      },
      () => { if (owned()) setJordan({ state: 'OFF' }); });
    return () => { abort.abort(); };
  }, [api, scope.organizationId, scope.schoolId]);

  const fail = (error: unknown) => { const kind = error instanceof JordanFollowUpError ? error.kind : 'UNKNOWN'; setNotice({ kind }); return kind; };
  const ask = async () => {
    if (jordan.state !== 'ON' || jordan.busy) return;
    const body = { focus, note: note.trim() }, text = JSON.stringify(body);
    const key = retry.current?.body === text ? retry.current.key : newKey();
    retry.current = { key, body: text };
    setJordan({ state: 'ON', busy: true }); setNotice(null);
    try {
      const v = await api.request(scope, body, key, AbortSignal.timeout(90000), () => live.current);
      if (!live.current) return;
      retry.current = null; setJordan({ state: 'ON', busy: false });
      if (v.status === 'RESULT_RECORDED') { setView(v); setTicked(v.suggestions?.map((_, n) => n) ?? []); return; }
      setNotice(v.status === 'RESULT_REJECTED' ? { kind: 'REJECTED', problems: v.problems } : v.status === 'UNKNOWN' ? { kind: 'HELD' }
        : v.status === 'BLOCKED' || v.status === 'CONFIGURATION_REQUIRED' ? { kind: v.status } : { kind: 'FAILED' });
    } catch (error) {
      if (!live.current) return;
      if (fail(error) !== 'UNKNOWN') retry.current = null;
      setJordan({ state: 'ON', busy: false });
    }
  };
  const apply = async () => {
    if (!view || view.status !== 'RESULT_RECORDED' || !view.mine || !ticked.length || (jordan.state === 'ON' && jordan.busy)) return;
    const picked = [...ticked].sort((a, b) => a - b), text = `${view.id}:${picked.join(',')}`;
    const key = applyKey.current?.body === text ? applyKey.current.key : newKey();
    applyKey.current = { key, body: text };
    setJordan({ state: 'ON', busy: true }); setNotice(null);
    try {
      const v = await api.apply(scope, view.id, picked, key, AbortSignal.timeout(30000), () => live.current);
      if (!live.current) return;
      applyKey.current = null; setView(v);
    } catch (error) { if (live.current && fail(error) !== 'UNKNOWN') applyKey.current = null; }
    finally { if (live.current) setJordan({ state: 'ON', busy: false }); }
  };
  const dismiss = () => {
    if (!view || view.status !== 'RESULT_RECORDED' || !view.mine) return;
    const before = view; setView(null);
    api.dismiss(scope, before.id, newKey(), AbortSignal.timeout(30000), () => live.current).then(
      () => undefined, (error) => { if (live.current && fail(error) !== 'GONE') setView(before); });
  };
  const busy = jordan.state === 'ON' && jordan.busy;

  return <section id="jordan-follow-up" className={styles.alexPlan} aria-labelledby="jordan-follow-up-title" data-jordan-follow-up={jordan.state}>
    <h4 id="jordan-follow-up-title">Follow through with Jordan</h4>
    <p className={styles.meta}>Jordan looks over the team’s open tasks and suggests new due dates, owners, priorities or check-ins. Nothing changes until you tick the suggestions you want and press Apply.</p>
    {jordan.state === 'CHECKING' ? <p className={styles.meta} role="status">Checking whether Jordan is available…</p> : null}
    {jordan.state === 'OFF' ? <p className={styles.state} data-state="EMPTY" data-jordan-off>Jordan follow-through is not available to you here yet.</p> : null}
    {jordan.state === 'ON' ? <form className={styles.alexForm} onSubmit={(e) => { e.preventDefault(); void ask(); }}>
      <fieldset><legend>Look at</legend>
        {(['OVERDUE', 'OPEN'] as const).map((f) => <label key={f}><input type="radio" name="jordan-focus" checked={focus === f} onChange={() => setFocus(f)} /> {f === 'OVERDUE' ? 'Overdue tasks' : 'All open tasks'}</label>)}
      </fieldset>
      <label>Anything Jordan should know (optional)<textarea value={note} maxLength={300} rows={2} onChange={(e) => setNote(e.target.value)} placeholder="For example: the belt test is Saturday" data-jordan-note /></label>
      <AgentVoiceBar agentKey="jordan" name="Jordan" value={note} max={300} onChange={setNote} answer={view?.summary ?? null} />
      <button type="submit" className={styles.primary} disabled={busy} data-jordan-ask>{busy && !view ? 'Jordan is looking…' : 'Ask Jordan'}</button>
    </form> : null}
    {notice ? <div className={styles.note} role="alert" data-jordan-notice={notice.kind}>
      <p>{JORDAN_FOLLOW_UP_NOTICE[notice.kind]}</p>
      {notice.problems?.length ? <ul>{notice.problems.map((x, n) => <li key={n}>{x}</li>)}</ul> : null}
    </div> : null}
    {view && isOpen(view) ? <JordanFollowUpResult view={view} ticked={ticked} busy={busy} onTick={(n, on) => setTicked(on ? [...ticked, n] : ticked.filter((x) => x !== n))}
      onApply={() => void apply()} onDismiss={dismiss} /> : null}
  </section>;
}

/** One list of suggestions as the person sees it. Pure, so it is tested directly. */
export function JordanFollowUpResult({ view, ticked, busy, onTick, onApply, onDismiss }: { view: JordanFollowUpView; ticked: readonly number[]; busy: boolean;
  onTick: (index: number, on: boolean) => void; onApply: () => void; onDismiss: () => void }): React.ReactElement {
  const staffName = (ref: string | null) => ref === null ? 'no one' : view.staff.find((s) => s.ref === ref)?.name || 'a staff member';
  const title = (ref: string) => view.items.find((i) => i.ref === ref)?.title ?? 'A task';
  const open = view.status === 'RESULT_RECORDED' && view.mine;
  return <div data-jordan-result={view.status}>
    <p className={styles.note}>Jordan wrote this with AI from your open tasks. Check it before you apply anything.</p>
    <p>{view.summary}</p>
    <ul className={styles.rows}>{(view.suggestions ?? []).map((s, n) => {
      const done = view.applied.find((c) => c.index === n);
      return <li key={n} className={styles.row} data-jordan-suggestion={n}>
        <div>
          {open
            ? <label><input type="checkbox" checked={ticked.includes(n)} onChange={(e) => onTick(n, e.target.checked)} data-jordan-tick={n} /> <strong>{title(s.item)}</strong></label>
            : <strong>{title(s.item)}</strong>}
          <span className={styles.meta}>{jordanSuggestionText(s, staffName)}</span>
          <span className={styles.meta}>{s.reason}</span>
        </div>
        <div className={styles.rowStatus}>
          {done ? <a className={styles.inlineLink} href="/staff/work" data-jordan-done={n}>Done in Work →</a> : null}
        </div>
      </li>;
    })}</ul>
    {open ? <div className={styles.alexActions}>
      <button type="button" className={styles.primary} disabled={busy || !ticked.length} onClick={onApply} data-jordan-apply>{busy ? 'Applying…' : `Apply ${ticked.length === 1 ? '1 suggestion' : `${ticked.length} suggestions`}`}</button>
      <button type="button" className={styles.inlineLink} disabled={busy} onClick={onDismiss} data-jordan-dismiss>Dismiss</button>
    </div> : null}
    {view.status === 'APPLIED' ? <p className={styles.meta} data-jordan-applied>{view.applied.length === 1 ? '1 suggestion was applied' : `${view.applied.length} suggestions were applied`} in Work. Jordan did not send or change anything else.</p> : null}
  </div>;
}
