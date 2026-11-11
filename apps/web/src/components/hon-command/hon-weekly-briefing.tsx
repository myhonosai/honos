import React, { useCallback, useEffect, useRef, useState } from 'react';
import { SCHOOL_BRIEFING_HOURS, type SchoolBriefing } from '@hon/contracts';
import {
  HON_SCHOOL_BRIEFING_API, HonConversationError, prepareBriefingSettings, prepareMyBriefing,
  type HonConversationFailure, type HonSchool, type HonSchoolBriefingApi, type PreparedHonCommand,
} from './hon-conversation-http';
import styles from './hon-conversation.module.css';

/**
 * 0257 "Weekly briefing", part 1. The owner turns the Monday summary on and picks the hour; each staff member turns
 * "Email me" on for themselves; anyone with the Command Center permission can preview their own email. Nothing is sent
 * from here, and sending itself is not built yet. A save is frozen with its key, so an unknown outcome is retried byte for byte.
 */
export type BriefingPhase = 'LOADING' | 'READY' | 'FORBIDDEN' | 'UNAVAILABLE' | 'SESSION';
export type BriefingPending = Readonly<{ state: 'SENDING' | Exclude<HonConversationFailure, 'SESSION'>; code: string | null }>;
export type BriefingPreviewState =
  | { state: 'IDLE' | 'LOADING' | 'FORBIDDEN' | 'UNAVAILABLE' }
  | { state: 'READY'; subject: string; text: string };
export interface HonWeeklyBriefingViewProps {
  phase: BriefingPhase;
  briefing: SchoolBriefing;
  draft: { enabled: boolean; sendHour: number };
  preview: BriefingPreviewState;
  pending: BriefingPending | null;
  onDraft: (draft: { enabled: boolean; sendHour: number }) => void;
  onSaveSettings: () => void;
  onEmail: (email: boolean) => void;
  onPreview: () => void;
  onRetry: () => void;
  onDismiss: () => void;
  onRefresh: () => void;
}

const HOURS = Array.from({ length: SCHOOL_BRIEFING_HOURS.max - SCHOOL_BRIEFING_HOURS.min + 1 }, (_, i) => SCHOOL_BRIEFING_HOURS.min + i);
const hourLabel = (h: number) => `${h}:00 AM`;
const PHASE_TEXT: Record<Exclude<BriefingPhase, 'READY' | 'LOADING'>, string> = {
  FORBIDDEN: 'Not shown: your role does not include HON or the Command Center at this school.',
  UNAVAILABLE: 'The weekly briefing could not be loaded. Refresh to try again.',
  SESSION: 'Your session ended. Sign in again to see this setting.',
};
function pendingText(p: BriefingPending): string {
  if (p.state === 'SENDING') return 'Saving…';
  if (p.state === 'UNKNOWN') return 'We could not confirm whether this was saved. Retry the same request; it is safe to repeat.';
  if (p.state === 'FORBIDDEN') return 'Your role does not allow this change. Only the school owner can change the schedule, and Email me needs the Command Center permission.';
  if (p.state === 'INVALID') return 'Choose on or off and an hour from 6:00 to 11:00 AM.';
  return 'This request was already used for something else. Refresh and try again.';
}

export function HonWeeklyBriefingView(props: HonWeeklyBriefingViewProps): React.ReactElement {
  const { phase, briefing, draft, preview, pending } = props;
  const busy = pending?.state === 'SENDING' || pending?.state === 'UNKNOWN';
  const changed = draft.enabled !== briefing.enabled || draft.sendHour !== briefing.sendHour;
  const emailLocked = busy || (!briefing.me.email && !briefing.me.canSubscribe);
  return <section className={styles.conversation} aria-labelledby="hon-briefing-title" data-hon-briefing={phase}>
    <div className={styles.head}>
      <h3 id="hon-briefing-title">Weekly briefing</h3>
      {phase !== 'LOADING' ? <button type="button" className={styles.secondary} onClick={props.onRefresh}>Refresh</button> : null}
    </div>
    <p className={styles.note}>Every Monday at the hour the owner picks (school time), HON can email a short summary of this school&apos;s Command Center numbers to staff who turn on Email me. Counts only, never names, and no AI. Nothing is sent yet: sending starts only after email is connected and approved. Text messages come later, with phone verification.</p>
    {phase === 'LOADING' ? <p role="status" className={styles.note}>Loading…</p> : null}
    {phase !== 'READY' && phase !== 'LOADING' ? <p role="alert" className={styles.note}>{PHASE_TEXT[phase]}</p> : null}
    {pending ? <div role={pending.state === 'SENDING' ? 'status' : 'alert'} className={styles.pending} data-briefing-pending={pending.state}>
      <p>{pendingText(pending)}</p>
      {pending.state === 'UNKNOWN' ? <div className={styles.actions}><button type="button" onClick={props.onRetry}>Retry the same request</button><button type="button" className={styles.secondary} onClick={props.onDismiss}>Stop and refresh</button></div> : null}
      {pending.state !== 'SENDING' && pending.state !== 'UNKNOWN' ? <button type="button" className={styles.secondary} onClick={props.onDismiss}>Dismiss</button> : null}
    </div> : null}
    {phase === 'READY' && briefing.canManage ? <form className={styles.composer} onSubmit={(event) => { event.preventDefault(); if (!busy && changed) props.onSaveSettings(); }}>
      <fieldset className={styles.modes} disabled={busy}><legend>Schedule (owner)</legend>
        <label><input type="checkbox" name="hon-briefing-enabled" checked={draft.enabled} onChange={(e) => props.onDraft({ ...draft, enabled: e.currentTarget.checked })} />Send the weekly briefing</label>
        <label>Mondays at <select name="hon-briefing-hour" value={draft.sendHour} onChange={(e) => props.onDraft({ ...draft, sendHour: Number(e.currentTarget.value) })}>
          {HOURS.map((h) => <option key={h} value={h}>{hourLabel(h)}</option>)}
        </select></label>
      </fieldset>
      <div className={styles.composerRow}><button type="submit" disabled={busy || !changed}>Save schedule</button></div>
    </form> : null}
    {phase === 'READY' && !briefing.canManage ? <p className={styles.meta}>{briefing.enabled ? `On, Mondays at ${hourLabel(briefing.sendHour)}` : 'Off'}. Only the school owner can change this.</p> : null}
    {phase === 'READY' ? <div className={styles.composer}>
      <label><input type="checkbox" name="hon-briefing-email" checked={briefing.me.email} disabled={emailLocked} onChange={(e) => props.onEmail(e.currentTarget.checked)} />Email me (to my own account email)</label>
      {!briefing.me.canSubscribe ? <p className={styles.meta}>Email me needs the Command Center permission at this school.{briefing.me.email ? ' You can still turn it off.' : ''}</p> : null}
      {briefing.me.canSubscribe ? <div className={styles.composerRow}><button type="button" className={styles.secondary} disabled={preview.state === 'LOADING'} onClick={props.onPreview}>Show my preview</button></div> : null}
      {preview.state === 'LOADING' ? <p role="status" className={styles.note}>Building your preview…</p> : null}
      {preview.state === 'FORBIDDEN' ? <p role="alert" className={styles.note}>The preview needs the Command Center permission at this school.</p> : null}
      {preview.state === 'UNAVAILABLE' ? <p role="alert" className={styles.note}>The preview could not be built. Try again.</p> : null}
      {preview.state === 'READY' ? <div data-briefing-preview="READY"><p className={styles.meta}><strong>{preview.subject}</strong></p><pre className={styles.note}>{preview.text}</pre><p className={styles.meta}>This is how your email would look today. Nothing was sent.</p></div> : null}
    </div> : null}
  </section>;
}

const EMPTY: SchoolBriefing = { enabled: false, sendHour: SCHOOL_BRIEFING_HOURS.default, canManage: false, me: { email: false, canSubscribe: false } };

/** Container for exactly the verified school passed in; a school change remounts it (keyed by the parent). */
export function HonWeeklyBriefing({ school, api = HON_SCHOOL_BRIEFING_API }: { school: HonSchool; api?: HonSchoolBriefingApi }): React.ReactElement {
  const [phase, setPhase] = useState<BriefingPhase>('LOADING');
  const [briefing, setBriefing] = useState<SchoolBriefing>(EMPTY);
  const [draft, setDraft] = useState({ enabled: EMPTY.enabled, sendHour: EMPTY.sendHour });
  const [preview, setPreview] = useState<BriefingPreviewState>({ state: 'IDLE' });
  const [pending, setPending] = useState<BriefingPending | null>(null);
  const prepared = useRef<PreparedHonCommand | null>(null);
  const reads = useRef<AbortController | null>(null);
  const previews = useRef<AbortController | null>(null);
  const mounted = useRef(true);

  const show = (view: SchoolBriefing) => { setBriefing(view); setDraft({ enabled: view.enabled, sendHour: view.sendHour }); };
  const load = useCallback(() => {
    reads.current?.abort();
    const abort = new AbortController(); reads.current = abort;
    setPhase('LOADING');
    api.read(school, abort.signal, () => mounted.current && reads.current === abort).then((view) => {
      if (reads.current !== abort) return;
      show(view); setPhase('READY');
    }, (error: unknown) => {
      if (abort.signal.aborted || reads.current !== abort) return;
      const kind = error instanceof HonConversationError ? error.kind : 'UNAVAILABLE';
      setPhase(kind === 'SESSION' ? 'SESSION' : kind === 'FORBIDDEN' ? 'FORBIDDEN' : 'UNAVAILABLE');
    });
  }, [api, school]);

  useEffect(() => { mounted.current = true; load(); return () => { mounted.current = false; reads.current?.abort(); previews.current?.abort(); }; }, [load]);

  const run = (command: PreparedHonCommand) => {
    prepared.current = command;
    setPending({ state: 'SENDING', code: null });
    api.send(command, () => mounted.current && prepared.current === command).then((receipt) => {
      if (!mounted.current || prepared.current !== command) return;
      prepared.current = null; setPending(null); show(receipt.record);
    }, (error: unknown) => {
      if (!mounted.current || prepared.current !== command) return;
      const failure = error instanceof HonConversationError ? error : new HonConversationError('UNKNOWN');
      if (failure.kind === 'SESSION') { prepared.current = null; setPending(null); setPhase('SESSION'); return; }
      if (failure.kind !== 'UNKNOWN') prepared.current = null;
      setPending({ state: failure.kind, code: failure.code });
    });
  };
  const attempt = (make: () => PreparedHonCommand) => { try { run(make()); } catch { setPending({ state: 'INVALID', code: null }); } };
  const loadPreview = () => {
    previews.current?.abort();
    const abort = new AbortController(); previews.current = abort;
    setPreview({ state: 'LOADING' });
    api.preview(school, abort.signal, () => mounted.current && previews.current === abort).then((value) => {
      if (previews.current === abort) setPreview({ state: 'READY', subject: value.subject, text: value.text });
    }, (error: unknown) => {
      if (abort.signal.aborted || previews.current !== abort) return;
      const kind = error instanceof HonConversationError ? error.kind : 'UNAVAILABLE';
      if (kind === 'SESSION') { setPreview({ state: 'IDLE' }); setPhase('SESSION'); return; }
      setPreview({ state: kind === 'FORBIDDEN' ? 'FORBIDDEN' : 'UNAVAILABLE' });
    });
  };

  return <HonWeeklyBriefingView phase={phase} briefing={briefing} draft={draft} preview={preview} pending={pending} onDraft={setDraft}
    onSaveSettings={() => attempt(() => prepareBriefingSettings(school, draft.enabled, draft.sendHour))}
    onEmail={(email) => attempt(() => prepareMyBriefing(school, email))}
    onPreview={loadPreview}
    onRetry={() => { if (prepared.current) run(prepared.current); }}
    onDismiss={() => { prepared.current = null; setPending(null); load(); }}
    onRefresh={() => { setPreview({ state: 'IDLE' }); load(); }} />;
}
