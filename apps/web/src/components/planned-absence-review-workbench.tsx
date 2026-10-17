'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { PlannedAbsenceReviewDecision, PlannedAbsenceReviewQueue, PlannedAbsenceReviewQueueItem } from '@hon/contracts';
import { createReviewAttempt, decidePlannedAbsence, loadPlannedAbsenceReviewQueue, PlannedAbsenceReviewAccessError, type ReviewAttempt } from './planned-absence-review-http';
import styles from './attendance-workbench.module.css';

export function PlannedAbsenceReviewWorkbench(): React.ReactElement {
  const [queue, setQueue] = useState<PlannedAbsenceReviewQueue | null>(null), [selected, setSelected] = useState<PlannedAbsenceReviewQueueItem | null>(null);
  const [decision, setDecision] = useState<PlannedAbsenceReviewDecision>('APPROVED'), [note, setNote] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [uncertain, setUncertain] = useState(false);
  const generation = useRef(0), controller = useRef<AbortController | null>(null), retry = useRef<ReviewAttempt | null>(null), running = useRef(false);
  const clear = useCallback(() => {
    ++generation.current; controller.current?.abort(); controller.current = null; running.current = false;
    setQueue(null); setSelected(null); retry.current = null; setUncertain(false); setBusy(false); setNotice(''); setError('');
  }, []);
  useEffect(() => {
    const hide = () => { clear(); setNote(''); setDecision('APPROVED'); setError('Review content and retry were cleared. Load explicitly to reverify current human school access.'); };
    const visibility = () => { if (document.visibilityState === 'hidden') hide(); };
    document.addEventListener('visibilitychange', visibility); window.addEventListener('blur', hide); window.addEventListener('pagehide', hide); window.addEventListener('hon:session-changed', hide);
    return () => { ++generation.current; controller.current?.abort(); retry.current = null; document.removeEventListener('visibilitychange', visibility); window.removeEventListener('blur', hide); window.removeEventListener('pagehide', hide); window.removeEventListener('hon:session-changed', hide); };
  }, [clear]);
  async function load(): Promise<void> {
    if (running.current) return;
    clear(); const token = generation.current, abort = new AbortController(); controller.current = abort; running.current = true; setBusy(true);
    try { const value = await loadPlannedAbsenceReviewQueue(abort.signal); if (generation.current === token) setQueue(value); }
    catch (failure) { if (generation.current === token) { clear(); setNote(''); setError(failure instanceof Error ? failure.message : 'No verified queue.'); } }
    finally { if (generation.current === token) { running.current = false; controller.current = null; setBusy(false); } }
  }
  async function send(exactRetry = false): Promise<void> {
    if (running.current || !queue || !selected || !note.trim()) return;
    const token = generation.current;
    try {
      if (!exactRetry) retry.current = createReviewAttempt(queue, selected, { decision, reviewNote: note, expectedVersion: selected.version }, crypto.randomUUID());
      const attempt = retry.current;
      if (!attempt) return;
      const abort = new AbortController(); controller.current = abort; running.current = true; setBusy(true); setError(''); setNotice('');
      const receipt = await decidePlannedAbsence(attempt, abort.signal);
      if (generation.current !== token) return;
      clear(); setNote('');
      setNotice(`Request ${receipt.id}: ${receipt.status}, version ${receipt.version}, recorded ${receipt.reviewedAt}. Decision record only. Reload the queue explicitly for another request.`);
    } catch (failure) {
      if (generation.current !== token) return;
      if (failure instanceof PlannedAbsenceReviewAccessError) { clear(); setNote(''); }
      else setUncertain(Boolean(retry.current));
      setError(failure instanceof Error ? failure.message : 'No verified decision.');
    } finally { if (generation.current === token) { running.current = false; controller.current = null; setBusy(false); } }
  }
  return <main className={styles.page}>
    <nav aria-label="Staff navigation"><a href="/staff/attendance">Attendance workbench</a><a href="/core">HON Core</a><a href="/auth/login">Sign in</a></nav>
    <header><p>DIRECT HUMAN STAFF / PLANNED ABSENCE REVIEW</p><h1>Planned absence review</h1><p>One current server-authorized school, with <code>schedule.planned_absence.review</code> and active entitlement. At most 50 currently SUBMITTED requests, oldest submitted first. There is no directory, history, count, export or school selector.</p></header>
    <aside className={styles.warning}><strong>Decision record only.</strong><p>Approval or decline does not change attendance, booking, makeup, messages, provider, payment, AI, Action Engine or automation state. Parent history remains its redacted recorded status and timestamp view; neither reviewer identity nor private review note is sent to parents.</p></aside>
    {error && <p role="alert" className={styles.error}>{error}</p>}{notice && <p role="status" className={styles.notice}>{notice}</p>}
    <section><h2>Prepare a human decision</h2><p>Review the facts before deciding. Changing either draft input clears queue, detail and retry; explicitly reload and select the request again. No decision is submitted by loading or selecting.</p>
      <label>Decision<select disabled={busy} value={decision} onChange={event => { clear(); setDecision(event.target.value as PlannedAbsenceReviewDecision); }}><option value="APPROVED">Approve</option><option value="DECLINED">Decline</option></select></label>
      <label>Private required review note (maximum 1000 characters)<textarea disabled={busy} autoComplete="off" maxLength={1000} value={note} onChange={event => { clear(); setNote(event.target.value); }} /></label>
      <div className={styles.actions}><button disabled={busy} type="button" onClick={() => void load()}>Load current submitted requests</button><button type="button" onClick={() => { clear(); setNote(''); }}>Clear review content</button></div>
    </section>
    {!queue && !busy && <p>No verified review queue is loaded.</p>}{busy && <p role="status">Verifying current human school authority…</p>}
    {queue && <section><h2>Current submitted requests</h2><p>Authorized school <code>{queue.schoolId}</code>. This bounded snapshot is not a count of all requests. Every decision and retry rechecks live authority and the existing submitted-state/version rules.</p>
      {queue.items.length === 0 ? <p>No currently submitted requests returned.</p> : <ul>{queue.items.map(item => <li key={item.id}><dl><dt>Request</dt><dd><code>{item.id}</code></dd><dt>Student profile</dt><dd><code>{item.studentProfileId}</code></dd><dt>Absence (UTC)</dt><dd>{item.startsAt} to {item.endsAt}</dd><dt>Submitted reason</dt><dd>{item.reason ?? 'No reason submitted'}</dd><dt>Current / expected version</dt><dd>{item.version}</dd><dt>Submitted (UTC)</dt><dd>{item.submittedAt}</dd></dl><button type="button" disabled={busy || uncertain} onClick={() => { setSelected(item); retry.current = null; setUncertain(false); setError(''); setNotice(''); }}>Review request {item.id}</button></li>)}</ul>}
    </section>}
    {selected && <section><h2>Confirm one direct-human decision</h2><p>Request <code>{selected.id}</code> · expected version {selected.version} · {decision}. The server is authoritative; the snapshot does not reserve or approve the request.</p><p>Your private note is required and never included in parent history.</p>
      <button type="button" disabled={busy || uncertain || !note.trim() || note.length > 1000} onClick={() => void send()}>Record {decision} decision</button>
      {uncertain && retry.current && <aside><strong>Decision unverified.</strong><p>Only this exact request, version, note, decision and key are retained in memory. Do not create a different decision to resolve uncertainty. Changing inputs, refreshing, hiding or leaving clears this attempt. No automatic retry occurs.</p><button disabled={busy} type="button" onClick={() => void send(true)}>Retry exact retained decision</button></aside>}
    </section>}
  </main>;
}
