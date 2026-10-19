'use client';

import React, { useEffect, useRef, useState, type FormEvent } from 'react';
import { StaffDashboardAccessError } from './staff-dashboard-http';
import { loadCurrentStaffReportingSchool } from './current-staff-reporting-school-http';
import { loadStaffReportingSchools, type StaffReportingSchoolChoice } from './staff-reporting-schools-http';
import {
  CurriculumEnrollmentPreparationAccessError, CurriculumEnrollmentPreparationRejectedError,
  loadCurriculumEnrollmentPreparation, type CurriculumEnrollmentPreparation, type EnrollmentPreparationScope,
} from './curriculum-enrollment-preparation-http';
import {
  CurriculumEnrollmentAccessError, CurriculumEnrollmentUncertainError,
  prepareCurriculumEnrollment, submitCurriculumEnrollment, type CurriculumEnrollmentReceipt, type PreparedCurriculumEnrollment,
} from './curriculum-enrollment-workbench-http';
import styles from './attendance-workbench.module.css';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type ScopeState = 'IDLE' | 'SELECTION_REQUIRED' | 'READY' | 'UNAVAILABLE';

/** A bounded, explicit-read preparation UI which leaves the canonical enrollment POST untouched. */
export function CurriculumEnrollmentPreparationWorkbench({ initialStudentProfileId }: { initialStudentProfileId?: string } = {}): React.ReactElement {
  const initialStudent = typeof initialStudentProfileId === 'string' && UUID.test(initialStudentProfileId) ? initialStudentProfileId.toLowerCase() : '';
  const [studentProfileId, setStudentProfileId] = useState(initialStudent);
  const [scope, setScope] = useState<EnrollmentPreparationScope | null>(null);
  const [scopeState, setScopeState] = useState<ScopeState>('IDLE');
  const [choices, setChoices] = useState<StaffReportingSchoolChoice[]>([]);
  const [choiceId, setChoiceId] = useState('');
  const [view, setView] = useState<CurriculumEnrollmentPreparation | null>(null);
  const [curriculumId, setCurriculumId] = useState('');
  const [currentRankId, setCurrentRankId] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [retry, setRetry] = useState<PreparedCurriculumEnrollment | null>(null);
  const [receipt, setReceipt] = useState<CurriculumEnrollmentReceipt | null>(null);
  const [error, setError] = useState('');
  const active = useRef(false); const mounted = useRef(true); const epoch = useRef(0); const retained = useRef<PreparedCurriculumEnrollment | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; epoch.current++; retained.current = null; }; }, []);

  const selectedCurriculum = view?.curricula.find((item) => item.id === curriculumId) ?? null;
  const selectedRank = currentRankId === '' ? null : selectedCurriculum?.ranks.find((item) => item.id === currentRankId) ?? null;
  const readyToConfirm = !!scope && !!view && !!selectedCurriculum && (currentRankId === '' || !!selectedRank) && !attempted && !busy;

  function clearEnrollment(): void { retained.current = null; setCurriculumId(''); setCurrentRankId(''); setConfirmed(false); setAttempted(false); setRetry(null); setReceipt(null); }
  function clearPreparation(clearStudent = false): void { setScope(null); setScopeState('IDLE'); setChoices([]); setChoiceId(''); setView(null); clearEnrollment(); if (clearStudent) setStudentProfileId(''); }
  function clearAccess(): void { epoch.current++; clearPreparation(true); setError(''); }
  function discard(): void { epoch.current++; clearPreparation(true); setError(''); }
  function changed(): void { epoch.current++; retained.current = null; setConfirmed(false); setAttempted(false); setRetry(null); setReceipt(null); setError(''); }
  function failure(caught: unknown): void {
    if (caught instanceof CurriculumEnrollmentPreparationAccessError || (caught instanceof StaffDashboardAccessError && (caught.status === 401 || caught.status === 403))) { clearAccess(); setError(caught.message); return; }
    setView(null); clearEnrollment(); setError(caught instanceof Error ? caught.message : 'Enrollment preparation is unavailable. No curriculum or rank was selected.');
  }
  async function requestPreparation(nextScope: EnrollmentPreparationScope, generation: number): Promise<void> {
    const result = await loadCurriculumEnrollmentPreparation(nextScope, studentProfileId);
    if (!mounted.current || generation !== epoch.current) return;
    setScope(nextScope); setScopeState('READY'); setChoices([]); setChoiceId(''); setView(result); clearEnrollment();
  }
  async function begin(): Promise<void> {
    if (active.current || !UUID.test(studentProfileId) || !mounted.current) { setError('Enter one exact student-profile UUID, then explicitly load enrollment choices.'); return; }
    const generation = ++epoch.current; active.current = true; setBusy(true); setError(''); clearEnrollment(); setView(null); setScope(null); setChoices([]); setChoiceId(''); setScopeState('IDLE');
    try {
      const direct = await loadCurrentStaffReportingSchool();
      if (!mounted.current || generation !== epoch.current) return;
      if (direct.state === 'RESOLVED') { await requestPreparation({ organizationId: direct.organizationId, schoolId: direct.schoolId }, generation); return; }
      const options = await loadStaffReportingSchools();
      if (!mounted.current || generation !== epoch.current) return;
      if (options.state !== 'SELECTION_REQUIRED') throw new CurriculumEnrollmentPreparationRejectedError();
      setChoices(options.schools); setScopeState('SELECTION_REQUIRED');
    } catch (caught) { if (mounted.current && generation === epoch.current) failure(caught); } finally { active.current = false; if (mounted.current && generation === epoch.current) setBusy(false); }
  }
  async function selectSchool(event: FormEvent): Promise<void> {
    event.preventDefault(); const selected = choices.find((item) => item.schoolId === choiceId); if (!selected || active.current) { setError('Choose one server-authorized school before loading enrollment choices.'); return; }
    const generation = ++epoch.current; active.current = true; setBusy(true); setError('');
    try { await requestPreparation({ organizationId: selected.organizationId, schoolId: selected.schoolId }, generation); }
    catch (caught) { if (mounted.current && generation === epoch.current) failure(caught); }
    finally { active.current = false; if (mounted.current && generation === epoch.current) setBusy(false); }
  }
  async function send(command: PreparedCurriculumEnrollment): Promise<void> {
    if (active.current || !mounted.current) return; const generation = epoch.current; active.current = true; retained.current = null;
    setBusy(true); setAttempted(true); setRetry(null); setReceipt(null); setError('');
    try { const returned = await submitCurriculumEnrollment(command); if (mounted.current && generation === epoch.current) setReceipt(returned); }
    catch (caught) {
      if (!mounted.current || generation !== epoch.current) return;
      if (caught instanceof CurriculumEnrollmentAccessError) { clearAccess(); setError(caught.message); }
      else { if (caught instanceof CurriculumEnrollmentUncertainError) { retained.current = command; setRetry(command); } setError(caught instanceof Error ? caught.message : 'No verified enrollment receipt.'); }
    } finally { active.current = false; if (mounted.current) setBusy(false); }
  }
  function submit(event: FormEvent): void {
    event.preventDefault(); if (!scope || !view || !selectedCurriculum || (currentRankId !== '' && !selectedRank) || !confirmed || !readyToConfirm || active.current) return;
    try { void send(prepareCurriculumEnrollment({ organizationId: scope.organizationId, schoolId: scope.schoolId, curriculumId: selectedCurriculum.id, studentProfileId: view.student.id, currentRankId }, crypto.randomUUID())); }
    catch { setError('The selected enrollment facts are no longer valid. Reload explicit enrollment choices before confirming.'); }
  }
  function retryExact(command: PreparedCurriculumEnrollment): void { if (retained.current === command && !active.current && mounted.current) void send(command); }
  const curriculumLabel = (item: NonNullable<typeof selectedCurriculum>, index: number): string => `${item.name}${view!.curricula.filter((other) => other.name === item.name).length > 1 ? ` — option ${index + 1}` : ''}`;

  return <main className={styles.page}>
    <nav aria-label="Staff navigation"><a href="/staff/dashboard">Staff dashboard</a><a href="/staff/command-center">Command Center</a><a href="/staff/crm/leads">CRM leads</a></nav>
    <header><p>HON / CONVENTIONAL INSTRUCTOR OPERATIONS</p><h1>Human curriculum enrollment</h1><p>Load one verified student’s current-school enrollment choices explicitly, then choose the program and optional current rank by name. No student directory, automatic lookup, automatic enrollment, or provider action exists here.</p></header>
    <aside><strong>Preparation is a narrow read, not authority.</strong><p>A CRM handoff may show one untrusted student-profile UUID as initial form text. It does not establish the student, school, curriculum, rank, permission, entitlement, eligibility or enrollment. The preparation read and final canonical enrollment command each independently verify the current human and exact school.</p><p>Nothing here determines promotion, testing readiness, class eligibility, attendance, booking, billing, membership, payment, consent, communication, provider, AI, Action Engine or automation work.</p></aside>
    <section aria-labelledby="enrollment-preparation"><h2 id="enrollment-preparation">1 / Explicit enrollment preparation</h2><p>Enter one already-known student-profile UUID or use the inert CRM registration handoff. Loading is deliberate; it never occurs on page load.</p>
      <form onSubmit={(event) => { event.preventDefault(); void begin(); }}><fieldset disabled={busy || scopeState === 'SELECTION_REQUIRED' || !!view}><label>Student profile UUID<input name="studentProfileId" required autoComplete="off" spellCheck={false} maxLength={36} value={studentProfileId} onChange={(event) => { changed(); setStudentProfileId(event.target.value); }} /></label><div className={styles.actions}><button type="submit" disabled={busy || scopeState === 'SELECTION_REQUIRED' || !!view || !UUID.test(studentProfileId)}>Load enrollment choices</button>{(view || scopeState !== 'IDLE' || studentProfileId) && <button type="button" onClick={discard}>Discard preparation / start over</button>}</div></fieldset></form>
      {scopeState === 'SELECTION_REQUIRED' && <form onSubmit={(event) => void selectSchool(event)}><label>Authorized school<select required value={choiceId} disabled={busy} onChange={(event) => { setChoiceId(event.target.value); setError(''); }}><option value="">Choose a school…</option>{choices.map((item) => <option key={item.schoolId} value={item.schoolId}>{item.schoolName} — {item.organizationName}</option>)}</select></label><div className={styles.actions}><button disabled={busy || !choiceId}>Load enrollment choices for this school</button><button type="button" disabled={busy} onClick={discard}>Discard preparation / start over</button></div></form>}
      {busy && <p role="status">Verifying the current human, school, student, curriculum choices and active entitlement…</p>}{error && <p role="alert" className={styles.error}>{error}</p>}
    </section>
    {view && scope && <section aria-labelledby="enrollment-command"><h2 id="enrollment-command">2 / Explicit human enrollment command</h2><p>Verified student: <strong>{view.student.displayName}</strong>. Program and rank labels come only from the selected current-school preparation response; their internal selectors are not authority.</p><form onSubmit={submit}><fieldset disabled={busy || attempted}><div className={styles.scopeGrid}><label>Curriculum<select name="curriculumId" required value={curriculumId} onChange={(event) => { changed(); setCurriculumId(event.target.value); setCurrentRankId(''); }}><option value="">Choose a curriculum…</option>{view.curricula.map((item, index) => <option key={item.id} value={item.id}>{curriculumLabel(item, index)}</option>)}</select></label><label>Current rank<select name="currentRankId" disabled={!selectedCurriculum} value={currentRankId} onChange={(event) => { changed(); setCurrentRankId(event.target.value); }}><option value="">Unranked — no current rank</option>{selectedCurriculum?.ranks.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label></div><label className={styles.check}><input name="confirmEnrollment" type="checkbox" checked={confirmed} disabled={!readyToConfirm} onChange={(event) => setConfirmed(event.target.checked)} />I explicitly confirm this human curriculum enrollment for the selected current-school student and program. An unranked choice deliberately sends no current rank.</label><div className={styles.actions}><button type="submit" disabled={!readyToConfirm || !confirmed || attempted}>Submit human curriculum enrollment</button><button type="button" onClick={discard}>Discard preparation / start over</button></div></fieldset></form>{retry && <div className={styles.warning}><p>Only this exact retained canonical path, body and generated UUID key may be retried. Nothing retries automatically; an uncertain earlier command may already have recorded an enrollment.</p><button type="button" disabled={busy} onClick={() => retryExact(retry)}>Retry exact unchanged enrollment command</button></div>}</section>}
    {receipt && <section aria-label="Returned enrollment receipt" className={styles.record}><h2>Returned enrollment receipt: ACTIVE</h2><p>{receipt.replayed ? 'Replayed or previously recorded enrollment receipt.' : 'Recorded enrollment receipt.'} The receipt confirms only this enrollment record for <strong>{view?.student.displayName ?? 'the selected student'}</strong> in <strong>{selectedCurriculum?.name ?? 'the selected curriculum'}</strong>{currentRankId === '' ? ' with unranked placement.' : selectedRank ? ` at ${selectedRank.name}.` : '.'}</p><p>It does not establish promotion, eligibility, testing, attendance, booking, billing, payment, membership, consent, communication, provider, AI, Action Engine or automation.</p></section>}
    {!view && !busy && !error && <p className={styles.empty}>No verified enrollment choices are shown.</p>}
    <p>Preparation, selections, receipts and uncertainty-only retries are memory-only. Discard, access loss, unmount and reload clear them. This page has no browser persistence and no generic person, family, curriculum or rank directory.</p>
  </main>;
}
