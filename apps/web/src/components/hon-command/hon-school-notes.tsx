import React, { useCallback, useEffect, useRef, useState } from 'react';
import { HON_SCHOOL_NOTE_LIMITS, type HonSchoolNote } from '@hon/contracts';
import {
  HON_SCHOOL_NOTES_API, HonConversationError, prepareSchoolNote, prepareSchoolNoteDelete,
  type HonConversationFailure, type HonSchool, type HonSchoolNotesApi, type PreparedHonCommand,
} from './hon-conversation-http';
import styles from './hon-conversation.module.css';

/**
 * 0255 "What HON remembers". Short school facts an owner saves on purpose so HON can use them in its answers. Every HON user
 * at the school can read them; only someone the server says may manage them sees add and delete. A write is frozen with its
 * key, so an unknown outcome is retried byte for byte and never saves a second note.
 */
export type NotesPhase = 'LOADING' | 'READY' | 'FORBIDDEN' | 'UNAVAILABLE' | 'SESSION';
export type NotesPending = Readonly<{ kind: 'add' | 'delete'; state: 'SENDING' | Exclude<HonConversationFailure, 'SESSION'>; code: string | null }>;
export interface HonSchoolNotesViewProps {
  phase: NotesPhase;
  notes: readonly HonSchoolNote[];
  canManage: boolean;
  draft: string;
  pending: NotesPending | null;
  onDraft: (text: string) => void;
  onAdd: () => void;
  onDelete: (noteId: string) => void;
  onRetry: () => void;
  onDismiss: () => void;
  onRefresh: () => void;
}

const PHASE_TEXT: Record<Exclude<NotesPhase, 'READY' | 'LOADING'>, string> = {
  FORBIDDEN: 'School notes are not shown: your role does not include HON at this school.',
  UNAVAILABLE: 'School notes could not be loaded. Refresh to try again.',
  SESSION: 'Your session ended. Sign in again to see school notes.',
};
function pendingText(p: NotesPending): string {
  if (p.state === 'SENDING') return p.kind === 'add' ? 'Saving the note…' : 'Deleting the note…';
  if (p.state === 'UNKNOWN') return 'We could not confirm whether this was saved. Retry the same request; it will never save twice.';
  if (p.code === 'HON_SCHOOL_NOTES_FULL') return 'The list is full (20 notes or 2,000 characters). Delete a note first.';
  if (p.code === 'HON_SCHOOL_NOTE_NOT_FOUND') return 'That note was already deleted.';
  if (p.state === 'FORBIDDEN') return 'Your role cannot change school notes.';
  if (p.state === 'INVALID') return 'Notes are about the school only: no emails, phone numbers, links or markup, 3 to 200 characters.';
  return 'This request was already used for something else. Refresh and try again.';
}

export function HonSchoolNotesView(props: HonSchoolNotesViewProps): React.ReactElement {
  const { phase, notes, canManage, pending } = props;
  const used = notes.reduce((sum, n) => sum + [...n.text].length, 0);
  const draftLength = [...props.draft.trim()].length;
  const full = notes.length >= HON_SCHOOL_NOTE_LIMITS.maxNotes || used + draftLength > HON_SCHOOL_NOTE_LIMITS.maxCharacters;
  const busy = pending?.state === 'SENDING' || pending?.state === 'UNKNOWN';
  return <section className={styles.conversation} aria-labelledby="hon-notes-title" data-hon-notes={phase}>
    <div className={styles.head}>
      <h3 id="hon-notes-title">What HON remembers</h3>
      {phase !== 'LOADING' ? <button type="button" className={styles.secondary} onClick={props.onRefresh}>Refresh</button> : null}
    </div>
    <p className={styles.note}>Short facts about this school that HON uses in its answers, such as holiday closures or class lengths. HON only remembers what is saved here. Notes are about the school, never about a student, family or staff member.</p>
    {phase === 'LOADING' ? <p role="status" className={styles.note}>Loading school notes…</p> : null}
    {phase !== 'READY' && phase !== 'LOADING' ? <p role="alert" className={styles.note}>{PHASE_TEXT[phase]}</p> : null}
    {pending ? <div role={pending.state === 'SENDING' ? 'status' : 'alert'} className={styles.pending} data-notes-pending={pending.state}>
      <p>{pendingText(pending)}</p>
      {pending.state === 'UNKNOWN' ? <div className={styles.actions}><button type="button" onClick={props.onRetry}>Retry the same request</button><button type="button" className={styles.secondary} onClick={props.onDismiss}>Stop and refresh</button></div> : null}
      {pending.state !== 'SENDING' && pending.state !== 'UNKNOWN' ? <button type="button" className={styles.secondary} onClick={props.onDismiss}>Dismiss</button> : null}
    </div> : null}
    {phase === 'READY' ? <>
      {notes.length === 0 ? <p className={styles.note}>No notes yet.</p>
        : <ul className={styles.notesList}>{notes.map((n) => <li key={n.id}><span>{n.text}</span>
          {canManage ? <button type="button" className={styles.secondary} data-hon-note-delete="" disabled={busy} aria-label={`Delete note: ${n.text}`} onClick={() => props.onDelete(n.id)}>Delete</button> : null}</li>)}</ul>}
      <p className={styles.meta}>{notes.length} of {HON_SCHOOL_NOTE_LIMITS.maxNotes} notes · {used.toLocaleString()} of {HON_SCHOOL_NOTE_LIMITS.maxCharacters.toLocaleString()} characters{full ? ' · full' : ''}</p>
      {canManage ? <form className={styles.composer} onSubmit={(event) => { event.preventDefault(); if (!full && !busy && draftLength > 0) props.onAdd(); }}>
        <label htmlFor="hon-notes-text">Add a school note</label>
        <textarea id="hon-notes-text" rows={2} maxLength={HON_SCHOOL_NOTE_LIMITS.noteCharacters} value={props.draft} disabled={busy} onChange={(event) => props.onDraft(event.target.value)}
          aria-describedby="hon-notes-help" placeholder="We close the first week of August." />
        <div className={styles.composerRow}><button type="submit" disabled={full || busy || draftLength < HON_SCHOOL_NOTE_LIMITS.minCharacters}>Save note</button></div>
        <p id="hon-notes-help" className={styles.meta}>3 to 200 characters. No emails, phone numbers or links. {full ? 'The list is full: delete a note first.' : ''}</p>
      </form> : <p className={styles.meta}>Only an owner, or staff given permission, can change these notes.</p>}
    </> : null}
  </section>;
}

/** Container for exactly the verified school passed in; a school change remounts it (keyed by the parent). */
export function HonSchoolNotes({ school, api = HON_SCHOOL_NOTES_API }: { school: HonSchool; api?: HonSchoolNotesApi }): React.ReactElement {
  const [phase, setPhase] = useState<NotesPhase>('LOADING');
  const [notes, setNotes] = useState<readonly HonSchoolNote[]>([]);
  const [canManage, setCanManage] = useState(false);
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState<NotesPending | null>(null);
  const prepared = useRef<{ command: PreparedHonCommand; kind: NotesPending['kind'] } | null>(null);
  const reads = useRef<AbortController | null>(null);
  const mounted = useRef(true);

  const load = useCallback(() => {
    reads.current?.abort();
    const abort = new AbortController(); reads.current = abort;
    setPhase('LOADING');
    api.read(school, abort.signal, () => mounted.current && reads.current === abort).then((page) => {
      if (reads.current !== abort) return;
      setNotes(page.notes); setCanManage(page.canManage); setPhase('READY');
    }, (error: unknown) => {
      if (abort.signal.aborted || reads.current !== abort) return;
      const kind = error instanceof HonConversationError ? error.kind : 'UNAVAILABLE';
      setPhase(kind === 'SESSION' ? 'SESSION' : kind === 'FORBIDDEN' ? 'FORBIDDEN' : 'UNAVAILABLE');
    });
  }, [api, school]);

  useEffect(() => { mounted.current = true; load(); return () => { mounted.current = false; reads.current?.abort(); }; }, [load]);

  const run = (command: PreparedHonCommand, kind: NotesPending['kind']) => {
    prepared.current = { command, kind };
    setPending({ kind, state: 'SENDING', code: null });
    api.send(command, () => mounted.current && prepared.current?.command === command).then(() => {
      if (!mounted.current || prepared.current?.command !== command) return;
      prepared.current = null; setPending(null);
      if (kind === 'add') setDraft('');
      load();
    }, (error: unknown) => {
      if (!mounted.current || prepared.current?.command !== command) return;
      const failure = error instanceof HonConversationError ? error : new HonConversationError('UNKNOWN');
      if (failure.kind === 'SESSION') { prepared.current = null; setPending(null); setPhase('SESSION'); return; }
      if (failure.kind !== 'UNKNOWN') prepared.current = null;
      setPending({ kind, state: failure.kind, code: failure.code });
    });
  };

  return <HonSchoolNotesView phase={phase} notes={notes} canManage={canManage} draft={draft} pending={pending} onDraft={setDraft}
    onAdd={() => { try { run(prepareSchoolNote(school, draft), 'add'); } catch { setPending({ kind: 'add', state: 'INVALID', code: null }); } }}
    onDelete={(noteId) => { try { run(prepareSchoolNoteDelete(school, noteId), 'delete'); } catch { /* an invalid id is never sent */ } }}
    onRetry={() => { if (prepared.current) run(prepared.current.command, prepared.current.kind); }}
    onDismiss={() => { prepared.current = null; setPending(null); load(); }}
    onRefresh={load} />;
}
