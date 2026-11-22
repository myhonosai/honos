'use client';

import React, { useEffect, useRef, useState } from 'react';
import type { MayaRenewalView, MayaRenewalWindow } from '@hon/contracts';
import { MayaRenewalError, mayaRenewalApi as defaultApi, type MayaRenewalApi, type MayaRenewalErrorKind, type MayaRenewalScope } from './maya-renewal-http';
import styles from './hon-command.module.css';
import { AgentVoiceBar } from './agent-voice-bar';

/**
 * P5 (0646): renewal prep with Maya. A staff member asks Maya to look over memberships ending in the next 30 or 60 days; Maya
 * suggests a priority and a talking point for up to ten of them. Nothing happens until the person ticks suggestions and presses
 * Open reviews: each becomes an open renewal review as that person. Maya never contacts a family. The server decides who may ask,
 * what Maya sees (numbers only, never names, contacts or amounts) and every AI spend rule.
 */
export const MAYA_RENEWAL_NOTICE: Readonly<Record<MayaRenewalErrorKind | 'FAILED' | 'BLOCKED' | 'CONFIGURATION_REQUIRED' | 'HELD' | 'REJECTED', string>> = {
  SESSION: 'Your session ended. Sign in again.',
  NO_ACCESS: 'Renewal prep with Maya needs Maya switched on for you, membership read and renewal review access at this school, and an active Complete plan. Nothing was sent.',
  REVIEW_OPEN: 'One of these memberships already has an open renewal review. Nothing was applied. Untick it and try again.',
  CHANGED: 'A membership changed or ended after Maya read it. Nothing was applied. Ask Maya again for a fresh look.',
  PAUSED: 'AI help is paused or not available for this school right now. Nothing was sent.',
  GONE: 'These suggestions were already used or dismissed.',
  INVALID: 'That request was not accepted. Nothing was sent.',
  UNKNOWN: 'HON could not confirm what happened. Press the button again to check: the same request is never sent twice.',
  FAILED: 'Maya could not look at the renewals this time. Nothing was charged for an answer.',
  BLOCKED: 'The request was stopped before it was sent.',
  CONFIGURATION_REQUIRED: 'Maya is not switched on for this school yet.',
  HELD: 'The answer was lost on the way. It is held for review and is never sent again.',
  REJECTED: 'Maya’s answer could not be used:',
};
type Notice = null | { kind: keyof typeof MAYA_RENEWAL_NOTICE; problems?: readonly string[] };
type State = { state: 'CHECKING' } | { state: 'OFF' } | { state: 'ON'; busy: boolean };
const newKey = (): string => globalThis.crypto.randomUUID();
const isOpen = (v: MayaRenewalView) => v.status === 'RESULT_RECORDED' || v.status === 'APPLIED';
export const MAYA_PRIORITY_LABEL: Readonly<Record<string, string>> = { HIGH: 'High priority', NORMAL: 'Normal priority', LOW: 'Low priority' };

export function MayaRenewalPanel({ scope, api = defaultApi }: { scope: MayaRenewalScope; api?: MayaRenewalApi }): React.ReactElement {
  const [maya, setMaya] = useState<State>({ state: 'CHECKING' });
  const [range, setRange] = useState<MayaRenewalWindow>('NEXT_30_DAYS');
  const [note, setNote] = useState('');
  const [view, setView] = useState<MayaRenewalView | null>(null);
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
    setMaya({ state: 'CHECKING' }); setView(null); setNotice(null);
    api.list(scope, signal, owned).then(
      (l) => {
        if (!owned()) return;
        setMaya(l.aiAvailable ? { state: 'ON', busy: false } : { state: 'OFF' });
        const latest = l.renewalPreps.find((p) => p.status === 'RESULT_RECORDED') ?? null;
        setView(latest); setTicked(latest?.suggestions?.map((_, n) => n) ?? []);
      },
      () => { if (owned()) setMaya({ state: 'OFF' }); });
    return () => { abort.abort(); };
  }, [api, scope.organizationId, scope.schoolId]);

  const fail = (error: unknown) => { const kind = error instanceof MayaRenewalError ? error.kind : 'UNKNOWN'; setNotice({ kind }); return kind; };
  const ask = async () => {
    if (maya.state !== 'ON' || maya.busy) return;
    const body = { window: range, note: note.trim() }, text = JSON.stringify(body);
    const key = retry.current?.body === text ? retry.current.key : newKey();
    retry.current = { key, body: text };
    setMaya({ state: 'ON', busy: true }); setNotice(null);
    try {
      const v = await api.request(scope, body, key, AbortSignal.timeout(90000), () => live.current);
      if (!live.current) return;
      retry.current = null; setMaya({ state: 'ON', busy: false });
      if (v.status === 'RESULT_RECORDED') { setView(v); setTicked(v.suggestions?.map((_, n) => n) ?? []); return; }
      setNotice(v.status === 'RESULT_REJECTED' ? { kind: 'REJECTED', problems: v.problems } : v.status === 'UNKNOWN' ? { kind: 'HELD' }
        : v.status === 'BLOCKED' || v.status === 'CONFIGURATION_REQUIRED' ? { kind: v.status } : { kind: 'FAILED' });
    } catch (error) {
      if (!live.current) return;
      if (fail(error) !== 'UNKNOWN') retry.current = null;
      setMaya({ state: 'ON', busy: false });
    }
  };
  const apply = async () => {
    if (!view || view.status !== 'RESULT_RECORDED' || !ticked.length || (maya.state === 'ON' && maya.busy)) return;
    const picked = [...ticked].sort((a, b) => a - b), text = `${view.id}:${picked.join(',')}`;
    const key = applyKey.current?.body === text ? applyKey.current.key : newKey();
    applyKey.current = { key, body: text };
    setMaya({ state: 'ON', busy: true }); setNotice(null);
    try {
      const v = await api.apply(scope, view.id, picked, key, AbortSignal.timeout(30000), () => live.current);
      if (!live.current) return;
      applyKey.current = null; setView(v);
    } catch (error) { if (live.current && fail(error) !== 'UNKNOWN') applyKey.current = null; }
    finally { if (live.current) setMaya({ state: 'ON', busy: false }); }
  };
  const dismiss = () => {
    if (!view || view.status !== 'RESULT_RECORDED') return;
    const before = view; setView(null);
    api.dismiss(scope, before.id, newKey(), AbortSignal.timeout(30000), () => live.current).then(
      () => undefined, (error) => { if (live.current && fail(error) !== 'GONE') setView(before); });
  };
  const busy = maya.state === 'ON' && maya.busy;

  return <section id="maya-renewal" className={styles.alexPlan} aria-labelledby="maya-renewal-title" data-maya-renewal={maya.state}>
    <h4 id="maya-renewal-title">Renewal prep with Maya</h4>
    <p className={styles.meta}>Maya looks over memberships that end soon and suggests who to talk to first and what to say. Nothing changes until you tick the ones you want and press Open reviews. Maya never contacts a family.</p>
    {maya.state === 'CHECKING' ? <p className={styles.meta} role="status">Checking whether Maya is available…</p> : null}
    {maya.state === 'OFF' ? <p className={styles.state} data-state="EMPTY" data-maya-off>Maya renewal prep is not available to you here yet.</p> : null}
    {maya.state === 'ON' ? <form className={styles.alexForm} onSubmit={(e) => { e.preventDefault(); void ask(); }}>
      <fieldset><legend>Memberships ending in</legend>
        {(['NEXT_30_DAYS', 'NEXT_60_DAYS'] as const).map((w) => <label key={w}><input type="radio" name="maya-window" checked={range === w} onChange={() => setRange(w)} /> {w === 'NEXT_30_DAYS' ? 'The next 30 days' : 'The next 60 days'}</label>)}
      </fieldset>
      <label>Anything Maya should know (optional)<textarea value={note} maxLength={300} rows={2} onChange={(e) => setNote(e.target.value)} placeholder="For example: summer break starts in three weeks" data-maya-note /></label>
      <AgentVoiceBar agentKey="maya" name="Maya" value={note} max={300} onChange={setNote} answer={view?.summary ?? null} />
      <button type="submit" className={styles.primary} disabled={busy} data-maya-ask>{busy && !view ? 'Maya is looking…' : 'Ask Maya'}</button>
    </form> : null}
    {notice ? <div className={styles.note} role="alert" data-maya-notice={notice.kind}>
      <p>{MAYA_RENEWAL_NOTICE[notice.kind]}</p>
      {notice.problems?.length ? <ul>{notice.problems.map((x, n) => <li key={n}>{x}</li>)}</ul> : null}
    </div> : null}
    {view && isOpen(view) ? <MayaRenewalResult view={view} ticked={ticked} busy={busy} onTick={(n, on) => setTicked(on ? [...ticked, n] : ticked.filter((x) => x !== n))}
      onApply={() => void apply()} onDismiss={dismiss} /> : null}
  </section>;
}

/** One list of suggestions as the person sees it. Pure, so it is tested directly. */
export function MayaRenewalResult({ view, ticked, busy, onTick, onApply, onDismiss }: { view: MayaRenewalView; ticked: readonly number[]; busy: boolean;
  onTick: (index: number, on: boolean) => void; onApply: () => void; onDismiss: () => void }): React.ReactElement {
  const member = (ref: string) => view.memberships.find((m) => m.ref === ref);
  const open = view.status === 'RESULT_RECORDED';
  return <div data-maya-result={view.status}>
    <p className={styles.note}>Maya wrote this with AI from membership dates and attendance. Check it before you open any review.</p>
    <p>{view.summary}</p>
    <ul className={styles.rows}>{(view.suggestions ?? []).map((s, n) => {
      const m = member(s.membership), done = view.applied.find((c) => c.index === n);
      const name = m?.name || 'A member';
      return <li key={n} className={styles.row} data-maya-suggestion={n}>
        <div>
          {open
            ? <label><input type="checkbox" checked={ticked.includes(n)} onChange={(e) => onTick(n, e.target.checked)} data-maya-tick={n} /> <strong>{name}</strong></label>
            : <strong>{name}</strong>}
          <span className={styles.meta}>{MAYA_PRIORITY_LABEL[s.priority]}{m ? ` · term ends ${m.termEndsOn}` : ''}</span>
          <span>{s.talkingPoint}</span>
          <span className={styles.meta}>{s.reason}</span>
        </div>
        <div className={styles.rowStatus}>
          {done ? <a className={styles.inlineLink} href="/staff/billing/renewals" data-maya-done={n}>Review open →</a> : null}
        </div>
      </li>;
    })}</ul>
    {open ? <div className={styles.alexActions}>
      <button type="button" className={styles.primary} disabled={busy || !ticked.length} onClick={onApply} data-maya-apply>{busy ? 'Opening…' : `Open ${ticked.length === 1 ? '1 review' : `${ticked.length} reviews`}`}</button>
      <button type="button" className={styles.inlineLink} disabled={busy} onClick={onDismiss} data-maya-dismiss>Dismiss</button>
    </div> : null}
    {view.status === 'APPLIED' ? <p className={styles.meta} data-maya-applied>{view.applied.length === 1 ? '1 renewal review was opened' : `${view.applied.length} renewal reviews were opened`} in Renewals. Maya did not send or change anything else.</p> : null}
  </div>;
}
