'use client';

import React, { useEffect, useRef, useState } from 'react';
import type { AlexPlanArea, AlexPlanHorizon, AlexPlanView } from '@hon/contracts';
import { AlexPlanError, alexPlanApi as defaultApi, type AlexPlanApi, type AlexPlanErrorKind, type AlexPlanScope } from './alex-plan-http';
import styles from './hon-command.module.css';

/**
 * P1 (0639): plan with Alex. The owner gives a goal; Alex suggests up to eight tasks for named staff. Nothing happens until
 * the person ticks tasks and presses Create tasks: each becomes an ordinary task in Work, created by that person. The server
 * decides who may ask, what Alex sees (school numbers and staff as S1, S2…, never names) and every AI spend rule.
 */
const AREA: Readonly<Record<AlexPlanArea, { label: string; href: string }>> = {
  chad: { label: 'Chad · leads', href: '/staff/crm/leads' },
  maya: { label: 'Maya · retention', href: '/staff/retention/at-risk' },
  marcus: { label: 'Marcus · marketing', href: '/staff/marketing/campaigns' },
  jordan: { label: 'Jordan · operations', href: '/staff/schedule/sessions' },
  claire: { label: 'Claire · numbers', href: '/staff/dashboard' },
  lena: { label: 'Lena · creative', href: '/staff/marketing/campaigns' },
};
const PRIORITY: Readonly<Record<string, string>> = { LOW: 'Low', NORMAL: 'Normal', HIGH: 'High' };
export const ALEX_PLAN_NOTICE: Readonly<Record<AlexPlanErrorKind | 'FAILED' | 'BLOCKED' | 'CONFIGURATION_REQUIRED' | 'HELD' | 'REJECTED', string>> = {
  SESSION: 'Your session ended. Sign in again.',
  NO_ACCESS: 'Planning with Alex needs reports, task creation and Alex switched on for you at this school, and an active Complete plan. Nothing was sent.',
  ASSIGN: 'Giving a task to someone else needs permission to manage the team’s tasks. Untick those tasks, or ask an owner. Nothing was created.',
  ASSIGNEE: 'Someone in this plan can no longer take tasks at this school. Nothing was created. Ask Alex again for a fresh plan.',
  PAUSED: 'AI help is paused or not available for this school right now. Nothing was sent.',
  GONE: 'That plan was already used or dismissed.',
  INVALID: 'That request was not accepted. Nothing was sent.',
  UNKNOWN: 'HON could not confirm what happened. Press the button again to check: the same request is never sent twice.',
  FAILED: 'Alex could not write a plan this time. Nothing was charged for an answer.',
  BLOCKED: 'The request was stopped before it was sent.',
  CONFIGURATION_REQUIRED: 'Alex is not switched on for this school yet.',
  HELD: 'The answer was lost on the way. It is held for review and is never sent again.',
  REJECTED: 'Alex’s answer could not be used:',
};
type Notice = null | { kind: keyof typeof ALEX_PLAN_NOTICE; problems?: readonly string[] };
type Alex = { state: 'CHECKING' } | { state: 'OFF' } | { state: 'ON'; busy: boolean };
const newKey = (): string => globalThis.crypto.randomUUID();
const open = (v: AlexPlanView) => v.status === 'RESULT_RECORDED' || v.status === 'APPLIED';
const dueText = (days: number | null): string => days === null ? 'No due date' : days === 0 ? 'Due today' : days === 1 ? 'Due tomorrow' : `Due in ${days} days`;

export function AlexPlanPanel({ scope, api = defaultApi }: { scope: AlexPlanScope; api?: AlexPlanApi }): React.ReactElement {
  const [alex, setAlex] = useState<Alex>({ state: 'CHECKING' });
  const [goal, setGoal] = useState('');
  const [horizon, setHorizon] = useState<AlexPlanHorizon>('WEEK');
  const [view, setView] = useState<AlexPlanView | null>(null);
  const [ticked, setTicked] = useState<readonly number[]>([]);
  const [notice, setNotice] = useState<Notice>(null);
  // A request whose answer was lost keeps its key: only the identical request may be sent again, never twice.
  const retry = useRef<{ key: string; body: string } | null>(null);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  useEffect(() => {
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]);
    const owned = () => live.current && !abort.signal.aborted;
    setAlex({ state: 'CHECKING' }); setView(null); setNotice(null);
    api.list(scope, signal, owned).then(
      (l) => {
        if (!owned()) return;
        setAlex(l.aiAvailable ? { state: 'ON', busy: false } : { state: 'OFF' });
        const latest = l.plans.find((p) => p.mine && p.status === 'RESULT_RECORDED') ?? null;
        setView(latest); setTicked(latest?.tasks?.map((_, n) => n) ?? []);
      },
      () => { if (owned()) setAlex({ state: 'OFF' }); });
    return () => { abort.abort(); };
  }, [api, scope.organizationId, scope.schoolId]);

  const fail = (error: unknown) => { const kind = error instanceof AlexPlanError ? error.kind : 'UNKNOWN'; setNotice({ kind }); return kind; };
  const ask = async () => {
    if (alex.state !== 'ON' || alex.busy || !goal.trim()) return;
    const body = { goal: goal.trim(), horizon }, text = JSON.stringify(body);
    const key = retry.current?.body === text ? retry.current.key : newKey();
    retry.current = { key, body: text };
    setAlex({ state: 'ON', busy: true }); setNotice(null);
    try {
      const v = await api.request(scope, body, key, AbortSignal.timeout(90000), () => live.current);
      if (!live.current) return;
      retry.current = null; setAlex({ state: 'ON', busy: false });
      if (v.status === 'RESULT_RECORDED') { setView(v); setTicked(v.tasks?.map((_, n) => n) ?? []); return; }
      setNotice(v.status === 'RESULT_REJECTED' ? { kind: 'REJECTED', problems: v.problems } : v.status === 'UNKNOWN' ? { kind: 'HELD' }
        : v.status === 'BLOCKED' || v.status === 'CONFIGURATION_REQUIRED' ? { kind: v.status } : { kind: 'FAILED' });
    } catch (error) {
      if (!live.current) return;
      if (fail(error) !== 'UNKNOWN') retry.current = null;
      setAlex({ state: 'ON', busy: false });
    }
  };
  // Creating keeps its key while the outcome is unknown, so pressing again can only replay the same create.
  const createKey = useRef<{ key: string; body: string } | null>(null);
  const create = async () => {
    if (!view || view.status !== 'RESULT_RECORDED' || !view.mine || !ticked.length || (alex.state === 'ON' && alex.busy)) return;
    const picked = [...ticked].sort((a, b) => a - b), text = `${view.id}:${picked.join(',')}`;
    const key = createKey.current?.body === text ? createKey.current.key : newKey();
    createKey.current = { key, body: text };
    setAlex({ state: 'ON', busy: true }); setNotice(null);
    try {
      const v = await api.create(scope, view.id, picked, key, AbortSignal.timeout(30000), () => live.current);
      if (!live.current) return;
      createKey.current = null; setView(v);
    } catch (error) { if (live.current && fail(error) !== 'UNKNOWN') createKey.current = null; }
    finally { if (live.current) setAlex({ state: 'ON', busy: false }); }
  };
  const dismiss = () => {
    if (!view || view.status !== 'RESULT_RECORDED' || !view.mine) return;
    const before = view; setView(null);
    api.dismiss(scope, before.id, newKey(), AbortSignal.timeout(30000), () => live.current).then(
      () => undefined, (error) => { if (live.current && fail(error) !== 'GONE') setView(before); });
  };
  const busy = alex.state === 'ON' && alex.busy;

  return <section id="alex-plan" className={styles.alexPlan} aria-labelledby="alex-plan-title" data-alex-plan={alex.state}>
    <h4 id="alex-plan-title">Plan with Alex</h4>
    <p className={styles.meta}>Tell Alex what you want done. Alex reads this school’s numbers and who can take tasks, and suggests up to eight tasks. Nothing is created, sent or changed until you tick the tasks you want and press Create tasks.</p>
    {alex.state === 'CHECKING' ? <p className={styles.meta} role="status">Checking whether Alex is available…</p> : null}
    {alex.state === 'OFF' ? <p className={styles.state} data-state="EMPTY" data-alex-off>Alex planning is not available to you here yet.</p> : null}
    {alex.state === 'ON' ? <form className={styles.alexForm} onSubmit={(e) => { e.preventDefault(); void ask(); }}>
      <label>Goal<textarea value={goal} maxLength={500} rows={2} onChange={(e) => setGoal(e.target.value)} placeholder="For example: get ten more trial bookings before the belt test" data-alex-goal /></label>
      <fieldset><legend>For</legend>
        {(['WEEK', 'MONTH'] as const).map((h) => <label key={h}><input type="radio" name="alex-horizon" checked={horizon === h} onChange={() => setHorizon(h)} /> {h === 'WEEK' ? 'This week' : 'This month'}</label>)}
      </fieldset>
      <button type="submit" className={styles.primary} disabled={busy || !goal.trim()} data-alex-ask>{busy && !view ? 'Alex is planning…' : 'Ask Alex for a plan'}</button>
    </form> : null}
    {notice ? <div className={styles.note} role="alert" data-alex-notice={notice.kind}>
      <p>{ALEX_PLAN_NOTICE[notice.kind]}</p>
      {notice.problems?.length ? <ul>{notice.problems.map((x, n) => <li key={n}>{x}</li>)}</ul> : null}
    </div> : null}
    {view && open(view) ? <AlexPlanResult view={view} ticked={ticked} busy={busy} onTick={(n, on) => setTicked(on ? [...ticked, n] : ticked.filter((x) => x !== n))}
      onCreate={() => void create()} onDismiss={dismiss} /> : null}
  </section>;
}

/** One plan as the person sees it: tick tasks and create them, or see what was created. Pure, so it is tested directly. */
export function AlexPlanResult({ view, ticked, busy, onTick, onCreate, onDismiss }: { view: AlexPlanView; ticked: readonly number[]; busy: boolean;
  onTick: (index: number, on: boolean) => void; onCreate: () => void; onDismiss: () => void }): React.ReactElement {
  const name = (ref: string | null) => ref === null ? 'Anyone' : view.staff.find((s) => s.ref === ref)?.name || 'A staff member';
  return <div data-alex-result={view.status}>
    <p className={styles.note}>Alex wrote this with AI from your school’s numbers. Check it before you create anything.</p>
    <p className={styles.meta}>Goal: {view.brief.goal} · {view.brief.horizon === 'WEEK' ? 'this week' : 'this month'}</p>
    <p>{view.summary}</p>
    <ul className={styles.rows}>{(view.tasks ?? []).map((t, n) => {
      const made = view.created.find((c) => c.index === n);
      return <li key={n} className={styles.row} data-alex-task={n}>
        <div>
          {view.status === 'RESULT_RECORDED' && view.mine
            ? <label><input type="checkbox" checked={ticked.includes(n)} onChange={(e) => onTick(n, e.target.checked)} data-alex-tick={n} /> <strong>{t.title}</strong></label>
            : <strong>{t.title}</strong>}
          <span className={styles.meta}>{t.description}</span>
          <span className={styles.meta}>{name(t.assignee)} · {dueText(t.dueInDays)} · {PRIORITY[t.priority]} priority</span>
        </div>
        <div className={styles.rowStatus}>
          {t.area ? <a className={styles.inlineLink} href={AREA[t.area].href}>{AREA[t.area].label} →</a> : null}
          {made ? <a className={styles.inlineLink} href="/staff/work" data-alex-made={n}>Created in Work →</a> : null}
        </div>
      </li>;
    })}</ul>
    {view.status === 'RESULT_RECORDED' && view.mine ? <div className={styles.alexActions}>
      <button type="button" className={styles.primary} disabled={busy || !ticked.length} onClick={onCreate} data-alex-create>{busy ? 'Creating…' : `Create ${ticked.length === 1 ? '1 task' : `${ticked.length} tasks`}`}</button>
      <button type="button" className={styles.inlineLink} disabled={busy} onClick={onDismiss} data-alex-dismiss>Dismiss</button>
    </div> : null}
    {view.status === 'APPLIED' ? <p className={styles.meta} data-alex-applied>{view.created.length === 1 ? '1 task was created' : `${view.created.length} tasks were created`} in Work. Alex did not send or change anything else.</p> : null}
  </div>;
}
