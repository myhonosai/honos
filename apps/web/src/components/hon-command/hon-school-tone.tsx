import React, { useCallback, useEffect, useRef, useState } from 'react';
import { HON_AI_TONES, HON_AI_TONE_LABELS, type HonAiTone } from '@hon/contracts';
import {
  HON_SCHOOL_TONE_API, HonConversationError, prepareSchoolTone,
  type HonConversationFailure, type HonSchool, type HonSchoolToneApi, type PreparedHonCommand,
} from './hon-conversation-http';
import styles from './hon-conversation.module.css';

/**
 * 0256 "How HON talks". The owner picks one of four closed tones for HON and Kai at this school; everyone else sees it
 * read-only. A save is frozen with its key, so an unknown outcome is retried byte for byte.
 */
export type TonePhase = 'LOADING' | 'READY' | 'FORBIDDEN' | 'UNAVAILABLE' | 'SESSION';
export type TonePending = Readonly<{ state: 'SENDING' | Exclude<HonConversationFailure, 'SESSION'>; code: string | null }>;
export interface HonSchoolToneViewProps {
  phase: TonePhase;
  tone: HonAiTone;
  canManage: boolean;
  choice: HonAiTone;
  pending: TonePending | null;
  onChoose: (tone: HonAiTone) => void;
  onSave: () => void;
  onRetry: () => void;
  onDismiss: () => void;
  onRefresh: () => void;
}

const HINT: Readonly<Record<HonAiTone, string>> = {
  STANDARD: 'Clear and plain, as HON answers today.',
  FRIENDLY_COACH: 'Warm and encouraging, like a coach on the mat.',
  STRAIGHT_TO_THE_POINT: 'The answer first, no greetings or filler.',
  FORMAL: 'Professional and polished, no slang.',
};
const PHASE_TEXT: Record<Exclude<TonePhase, 'READY' | 'LOADING'>, string> = {
  FORBIDDEN: 'Not shown: your role does not include HON or Kai at this school.',
  UNAVAILABLE: 'The tone could not be loaded. Refresh to try again.',
  SESSION: 'Your session ended. Sign in again to see this setting.',
};
function pendingText(p: TonePending): string {
  if (p.state === 'SENDING') return 'Saving…';
  if (p.state === 'UNKNOWN') return 'We could not confirm whether this was saved. Retry the same request; it is safe to repeat.';
  if (p.state === 'FORBIDDEN') return 'Only the school owner can change how HON talks.';
  if (p.state === 'INVALID') return 'Choose one of the four tones.';
  return 'This request was already used for something else. Refresh and try again.';
}

export function HonSchoolToneView(props: HonSchoolToneViewProps): React.ReactElement {
  const { phase, tone, canManage, choice, pending } = props;
  const busy = pending?.state === 'SENDING' || pending?.state === 'UNKNOWN';
  return <section className={styles.conversation} aria-labelledby="hon-tone-title" data-hon-tone={phase}>
    <div className={styles.head}>
      <h3 id="hon-tone-title">How HON talks</h3>
      {phase !== 'LOADING' ? <button type="button" className={styles.secondary} onClick={props.onRefresh}>Refresh</button> : null}
    </div>
    <p className={styles.note}>The voice HON and Kai use for this school. The tone never changes the facts: HON still answers only from your records and never acts on its own.</p>
    {phase === 'LOADING' ? <p role="status" className={styles.note}>Loading…</p> : null}
    {phase !== 'READY' && phase !== 'LOADING' ? <p role="alert" className={styles.note}>{PHASE_TEXT[phase]}</p> : null}
    {pending ? <div role={pending.state === 'SENDING' ? 'status' : 'alert'} className={styles.pending} data-tone-pending={pending.state}>
      <p>{pendingText(pending)}</p>
      {pending.state === 'UNKNOWN' ? <div className={styles.actions}><button type="button" onClick={props.onRetry}>Retry the same request</button><button type="button" className={styles.secondary} onClick={props.onDismiss}>Stop and refresh</button></div> : null}
      {pending.state !== 'SENDING' && pending.state !== 'UNKNOWN' ? <button type="button" className={styles.secondary} onClick={props.onDismiss}>Dismiss</button> : null}
    </div> : null}
    {phase === 'READY' && canManage ? <form className={styles.composer} onSubmit={(event) => { event.preventDefault(); if (!busy && choice !== tone) props.onSave(); }}>
      <fieldset className={styles.modes} disabled={busy}><legend>Tone</legend>
        {HON_AI_TONES.map((key) => <label key={key}><input type="radio" name="hon-tone" value={key} checked={choice === key} onChange={() => props.onChoose(key)} />{HON_AI_TONE_LABELS[key]} <small>{HINT[key]}</small></label>)}
      </fieldset>
      <div className={styles.composerRow}><button type="submit" disabled={busy || choice === tone}>Save tone</button></div>
    </form> : null}
    {phase === 'READY' && !canManage ? <p className={styles.meta}>Current tone: <strong>{HON_AI_TONE_LABELS[tone]}</strong>. Only the school owner can change this.</p> : null}
  </section>;
}

/** Container for exactly the verified school passed in; a school change remounts it (keyed by the parent). */
export function HonSchoolTone({ school, api = HON_SCHOOL_TONE_API }: { school: HonSchool; api?: HonSchoolToneApi }): React.ReactElement {
  const [phase, setPhase] = useState<TonePhase>('LOADING');
  const [tone, setTone] = useState<HonAiTone>('STANDARD');
  const [choice, setChoice] = useState<HonAiTone>('STANDARD');
  const [canManage, setCanManage] = useState(false);
  const [pending, setPending] = useState<TonePending | null>(null);
  const prepared = useRef<PreparedHonCommand | null>(null);
  const reads = useRef<AbortController | null>(null);
  const mounted = useRef(true);

  const load = useCallback(() => {
    reads.current?.abort();
    const abort = new AbortController(); reads.current = abort;
    setPhase('LOADING');
    api.read(school, abort.signal, () => mounted.current && reads.current === abort).then((view) => {
      if (reads.current !== abort) return;
      setTone(view.tone); setChoice(view.tone); setCanManage(view.canManage); setPhase('READY');
    }, (error: unknown) => {
      if (abort.signal.aborted || reads.current !== abort) return;
      const kind = error instanceof HonConversationError ? error.kind : 'UNAVAILABLE';
      setPhase(kind === 'SESSION' ? 'SESSION' : kind === 'FORBIDDEN' ? 'FORBIDDEN' : 'UNAVAILABLE');
    });
  }, [api, school]);

  useEffect(() => { mounted.current = true; load(); return () => { mounted.current = false; reads.current?.abort(); }; }, [load]);

  const run = (command: PreparedHonCommand) => {
    prepared.current = command;
    setPending({ state: 'SENDING', code: null });
    api.send(command, () => mounted.current && prepared.current === command).then(() => {
      if (!mounted.current || prepared.current !== command) return;
      prepared.current = null; setPending(null); load();
    }, (error: unknown) => {
      if (!mounted.current || prepared.current !== command) return;
      const failure = error instanceof HonConversationError ? error : new HonConversationError('UNKNOWN');
      if (failure.kind === 'SESSION') { prepared.current = null; setPending(null); setPhase('SESSION'); return; }
      if (failure.kind !== 'UNKNOWN') prepared.current = null;
      setPending({ state: failure.kind, code: failure.code });
    });
  };

  return <HonSchoolToneView phase={phase} tone={tone} canManage={canManage} choice={choice} pending={pending} onChoose={setChoice}
    onSave={() => { try { run(prepareSchoolTone(school, choice)); } catch { setPending({ state: 'INVALID', code: null }); } }}
    onRetry={() => { if (prepared.current) run(prepared.current); }}
    onDismiss={() => { prepared.current = null; setPending(null); load(); }}
    onRefresh={load} />;
}
