'use client';

import React, { useEffect, useRef, useState, type FormEvent } from 'react';
import type { CurriculumProgressStatus, StaffCurriculumEnrollmentDetails } from '@hon/contracts';
import { CurriculumProgressAccessError, CurriculumProgressUncertainError, HUMAN_PROGRESS_STATUSES, loadCurriculumEnrollment, prepareCurriculumObservation,
  submitCurriculumObservation, validateCurriculumObservationDraft, validateCurriculumProgressIds, type CurriculumProgressKnownIds, type CurriculumObservationReceipt, type PreparedCurriculumObservation } from './curriculum-progress-workbench-http';
import styles from './curriculum-look/plain-page.module.css';
import { useShellSchoolInto } from './school-shell/page-school';
import { EnrollmentPicker, IdFields } from './school-pickers/pickers';
import type { PickerEnrollment } from './school-pickers/http';

const EMPTY_IDS: CurriculumProgressKnownIds = { organizationId: '', schoolId: '', curriculumId: '', enrollmentId: '' };
const LABELS: Record<keyof CurriculumProgressKnownIds, string> = { organizationId: 'Organization ID', schoolId: 'School ID', curriculumId: 'Program ID', enrollmentId: 'Student enrollment ID' };
/** Plain words for the stored codes; the codes themselves are what the API receives. */
export const STATUS: Record<CurriculumProgressStatus, string> = { NOT_STARTED: 'Not started', PRACTICING: 'Practicing', DEMONSTRATED: 'Shown in class', MET: 'Met', NOT_MET: 'Not yet' };
const KIND: Record<string, string> = { TECHNIQUE: 'Technique', KNOWLEDGE: 'Knowledge', CHARACTER: 'Character', ATTENDANCE: 'Attendance', PRACTICE: 'Practice at home', INSTRUCTOR_JUDGMENT: "Instructor's call", CUSTOM: 'Other' };

/** One current enrollment and one appended human observation. No placement or history command. */
export function CurriculumProgressWorkbench(): React.ReactElement {
  const [ids, setIds] = useState<CurriculumProgressKnownIds>(EMPTY_IDS);
  const shellSchool = useShellSchoolInto(school => setIds(current => ({ ...current, organizationId: school.organizationId, schoolId: school.schoolId })));
  const [snapshot, setSnapshot] = useState<StaffCurriculumEnrollmentDetails | null>(null);
  const [picked, setPicked] = useState<PickerEnrollment | null>(null);
  const [requirementId, setRequirementId] = useState('');
  const [chosenStatus, setChosenStatus] = useState('');
  const [note, setNote] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState<PreparedCurriculumObservation | null>(null);
  const [receipt, setReceipt] = useState<CurriculumObservationReceipt | null>(null);
  const [error, setError] = useState('');
  const active = useRef(false);
  const mounted = useRef(true);
  const epoch = useRef(0);
  const attempted = useRef(false);
  const retained = useRef<PreparedCurriculumObservation | null>(null);
  const currentSnapshot = useRef<StaffCurriculumEnrollmentDetails | null>(null);
  // Cleanup only: no request, UUID allocation, timer or automatic refresh.
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; epoch.current++; retained.current = null; currentSnapshot.current = null; }; }, []);
  const renderedEpoch = epoch.current;
  let validIds = false; let validDraft = false;
  try { validateCurriculumProgressIds(ids); validIds = true; } catch { /* local syntax only */ }
  try { if (snapshot) { validateCurriculumObservationDraft(ids, snapshot, requirementId, chosenStatus, note); validDraft = true; } } catch { /* no verified draft */ }

  function clearDraft(): void { setRequirementId(''); setChosenStatus(''); setNote(''); setConfirmed(false); }
  function clearSnapshot(): void { currentSnapshot.current = null; setSnapshot(null); }
  function reset(): void {
    epoch.current++; attempted.current = false; retained.current = null; clearSnapshot(); clearDraft(); setRetry(null); setReceipt(null); setError('');
  }
  function edit(change: () => void, scope = false): void {
    if (active.current || !mounted.current) return;
    epoch.current++; retained.current = null;
    if (scope || attempted.current) { clearSnapshot(); clearDraft(); }
    attempted.current = false; setRetry(null); setReceipt(null); setConfirmed(false); setError(''); change();
  }
  function discard(): void { if (active.current || !mounted.current) return; reset(); setPicked(null); setIds(EMPTY_IDS); }
  function accessLoss(): void { reset(); setIds(EMPTY_IDS); }
  async function load(): Promise<void> {
    if (active.current || !mounted.current || renderedEpoch !== epoch.current) return;
    try { validateCurriculumProgressIds(ids); } catch { setError('Pick a student first.'); return; }
    reset(); const generation = epoch.current; active.current = true; setBusy(true);
    try {
      const returned = await loadCurriculumEnrollment(ids);
      if (mounted.current && generation === epoch.current) { currentSnapshot.current = returned; setSnapshot(returned); }
    } catch (caught) {
      if (!mounted.current || generation !== epoch.current) return;
      if (caught instanceof CurriculumProgressAccessError) accessLoss();
      setError(caught instanceof Error ? caught.message : 'That student could not be loaded. Refresh to try again.');
    } finally { active.current = false; if (mounted.current) setBusy(false); }
  }
  async function send(command: PreparedCurriculumObservation): Promise<void> {
    if (active.current || !mounted.current) return;
    const generation = epoch.current; active.current = true; attempted.current = true; retained.current = null;
    clearSnapshot(); clearDraft(); setRetry(null); setReceipt(null); setError(''); setBusy(true);
    try {
      const returned = await submitCurriculumObservation(command);
      if (mounted.current && generation === epoch.current) setReceipt(returned);
    } catch (caught) {
      if (!mounted.current || generation !== epoch.current) return;
      if (caught instanceof CurriculumProgressAccessError) accessLoss();
      else if (caught instanceof CurriculumProgressUncertainError) { retained.current = command; setRetry(command); }
      setError(caught instanceof Error ? caught.message : 'That save could not be confirmed. Load the student again to check.');
    } finally { active.current = false; if (mounted.current) setBusy(false); }
  }
  function submit(event: FormEvent): void {
    event.preventDefault();
    if (active.current || attempted.current || !confirmed || !mounted.current || renderedEpoch !== epoch.current || !snapshot || currentSnapshot.current !== snapshot) return;
    try {
      validateCurriculumObservationDraft(ids, snapshot, requirementId, chosenStatus, note);
      void send(prepareCurriculumObservation(ids, snapshot, requirementId, chosenStatus as CurriculumProgressStatus, note, crypto.randomUUID()));
    } catch { setError('Choose what they worked on and how it went. Notes can be up to 2000 characters. Nothing was saved.'); }
  }
  function retryExact(command: PreparedCurriculumObservation): void {
    if (retained.current !== command || active.current || !mounted.current) return;
    void send(command);
  }

  const who = picked ? `${picked.givenName} ${picked.familyName}` : 'This student';
  const shown = (r: { definition: { label: string } }) => r.definition.label;
  return <main className={styles.page}>
    <header><p>Ranks &amp; curriculum</p><h1>Curriculum progress</h1>
      <p>Pick a student, then mark how they are doing on each thing their belt needs.</p>
    </header>
    <aside data-plain-note=""><strong>Marking something as met is your note only. It never promotes a student.</strong></aside>
    <section aria-labelledby="enrollment-read"><h2 id="enrollment-read">Student</h2>
      <fieldset disabled={busy}>
        {shellSchool && <EnrollmentPicker scope={shellSchool} purpose="progress" value={ids.enrollmentId} disabled={busy}
          onPick={item => edit(() => { setPicked(item ?? null); setIds(current => ({ ...current, curriculumId: item?.curriculumId ?? '', enrollmentId: item?.enrollmentId ?? '' })); }, true)} />}
        <IdFields manual={!shellSchool}><div className={styles.grid}>{(Object.keys(LABELS) as (keyof CurriculumProgressKnownIds)[]).filter(field => !shellSchool || (field !== 'organizationId' && field !== 'schoolId')).map(field =>
        <label key={field}>{LABELS[field]}<input name={field} required autoComplete="off" spellCheck={false} maxLength={36} value={ids[field]} onChange={event => edit(() => setIds({ ...ids, [field]: event.target.value }), true)} /></label>)}</div></IdFields>
        <div className={styles.row}><button type="button" data-primary="" disabled={!validIds} onClick={() => void load()}>Show what their belt needs</button><button type="button" onClick={discard}>Start over</button></div>
      </fieldset>
    </section>
    {busy && <p role="status" className={styles.meta}>Loading…</p>}
    {error && <p role="alert" className={styles.error}>{error}</p>}
    {!snapshot && <p className={styles.meta}>Pick a student to see what their belt needs.</p>}
    {snapshot && <section aria-label="Current belt" className={styles.record}>
      <h2>{who}{picked?.currentRankName ? `: ${picked.currentRankName}` : ''}</h2>
      {picked?.curriculumName && <p className={styles.meta}>{picked.curriculumName}{picked.nextRankName ? ` · Next belt: ${picked.nextRankName}` : ''}</p>}
      <h3>What this belt needs</h3>
      {snapshot.enrollment.currentRankId === null && <p className={styles.meta}>This student has no belt yet. Place them on a belt in <a href="/staff/curriculum/ranks">Rank setup</a>.</p>}
      {snapshot.requirements.length === 0 && snapshot.enrollment.currentRankId !== null && <p className={styles.meta}>Nothing is listed for this belt yet. Add what it needs in <a href="/staff/curriculum/ranks">Rank setup</a>.</p>}
      {snapshot.requirements.map(r => <article key={r.id}>
        <h3>{shown(r)}</h3>
        <p className={styles.meta}>{KIND[r.kind] ?? r.kind} · {r.required ? 'Needed for the next belt' : 'Optional'}</p>
        <p>{r.status ? STATUS[r.status] : 'Not marked yet'}{r.recordedAt ? ` · marked ${r.recordedAt.slice(0, 10)}` : ''}</p>
      </article>)}
      {snapshot.enrollment.status !== 'ACTIVE' && <p className={styles.meta}>This student is no longer active in this program, so nothing can be marked.</p>}
      {snapshot.enrollment.status === 'ACTIVE' && snapshot.enrollment.currentRankId !== null && snapshot.requirements.length > 0 && <form onSubmit={submit}>
        <fieldset disabled={busy}><legend>Mark progress</legend>
          <div className={styles.grid}>
          <label>What they worked on<select name="requirementId" required value={requirementId} onChange={event => edit(() => setRequirementId(event.target.value))}>
            <option value="">Choose one</option>{snapshot.requirements.map(r => <option key={r.id} value={r.id}>{shown(r)}</option>)}</select></label>
          <label>How it went<select name="observationStatus" required value={chosenStatus} onChange={event => edit(() => setChosenStatus(event.target.value))}>
            <option value="">Choose one</option>{HUMAN_PROGRESS_STATUSES.map(s => <option key={s} value={s}>{STATUS[s]}</option>)}</select></label>
          </div>
          <label>Note for staff (optional)<textarea name="instructorNote" autoComplete="off" maxLength={2000} value={note} onChange={event => edit(() => setNote(event.target.value))} /></label>
          <label className={styles.check}><input name="confirmObservation" type="checkbox" checked={confirmed} disabled={!validDraft} onChange={event => { if (mounted.current && !active.current && renderedEpoch === epoch.current) setConfirmed(event.target.checked); }} />I saw this in class.</label>
          <button type="submit" disabled={!validDraft || !confirmed}>Save</button>
        </fieldset></form>}
    </section>}
    {retry && <div className={styles.warning}><p>That save did not confirm. It may already be saved. Trying again sends the exact same change, so it is never saved twice.</p>
      <button type="button" disabled={busy} onClick={() => retryExact(retry)}>Try the same save again</button></div>}
    {receipt && <section aria-label="Saved" className={styles.record}><h2>Saved: {STATUS[receipt.observation.status]}</h2>
      <p>{receipt.replayed ? 'This was already saved.' : `${who}'s progress is updated.`} Load the student again to mark something else.</p>
    </section>}
  </main>;
}
