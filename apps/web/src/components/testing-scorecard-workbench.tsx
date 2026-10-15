'use client';
import Link from 'next/link';
import React, { useRef, useState } from 'react';
import { loadTestingScorecard, recordTestingScorecardEvaluation, TestingScorecardAccessError, type TestingScorecardAssessment, type TestingScorecardView } from './testing-scorecard-http';
import s from './testing-registration.module.css';

const uuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const criterion = (value: string) => /^[A-Z][A-Z0-9_.-]{0,63}$/.test(value);
function dateTime(value: string) { return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)); }
function label(value: TestingScorecardAssessment) { return value === 'OBSERVED' ? 'Observed' : value === 'NOT_OBSERVED' ? 'Not observed' : 'Needs follow-up'; }

type Retry = { schoolId: string; testingCandidateId: string; testingEventId: string; criterionCode: string; assessment: TestingScorecardAssessment; candidateVersion: number; eventVersion: number; scorecardVersion: number; key: string };

export function TestingScorecardWorkbench(): React.ReactElement {
  const [schoolId, setSchoolId] = useState(''); const [testingCandidateId, setTestingCandidateId] = useState(''); const [testingEventId, setTestingEventId] = useState('');
  const [criterionCode, setCriterionCode] = useState(''); const [assessment, setAssessment] = useState<TestingScorecardAssessment>('OBSERVED');
  const [view, setView] = useState<TestingScorecardView | null>(null); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const retry = useRef<Retry | null>(null);
  function clear() { setView(null); retry.current = null; }
  function changed() { clear(); setError(''); setNotice(''); }
  async function load() {
    if (busy) return; changed();
    if (!uuid(schoolId) || !uuid(testingCandidateId) || !uuid(testingEventId)) { setError('Enter known school, testing candidate, and testing event UUIDs. Selectors never grant authority.'); return; }
    setBusy(true); try { setView(await loadTestingScorecard(schoolId, testingCandidateId, testingEventId)); }
    catch (reason) { clear(); setError(reason instanceof Error ? reason.message : 'The scorecard is unavailable.'); }
    finally { setBusy(false); }
  }
  async function record(retryUnchanged = false) {
    if (busy || !view) return;
    const attempt = retryUnchanged ? retry.current : { schoolId, testingCandidateId, testingEventId, criterionCode, assessment, candidateVersion: view.candidateVersion, eventVersion: view.testingEventVersion, scorecardVersion: view.scorecardVersion, key: crypto.randomUUID() };
    if (!attempt || attempt.schoolId !== schoolId || attempt.testingCandidateId !== testingCandidateId || attempt.testingEventId !== testingEventId || attempt.criterionCode !== criterionCode || attempt.assessment !== assessment || attempt.candidateVersion !== view.candidateVersion || attempt.eventVersion !== view.testingEventVersion || attempt.scorecardVersion !== view.scorecardVersion) return;
    retry.current = attempt; setBusy(true); setError(''); setNotice('');
    try {
      const result = await recordTestingScorecardEvaluation(attempt.schoolId, { testingCandidateId: attempt.testingCandidateId, testingEventId: attempt.testingEventId, criterionCode: attempt.criterionCode, assessment: attempt.assessment, expectedCandidateVersion: attempt.candidateVersion, expectedTestingEventVersion: attempt.eventVersion, expectedScorecardVersion: attempt.scorecardVersion }, attempt.key);
      retry.current = null; setCriterionCode('');
      setView({ ...view, scorecardId: result.scorecardId, scorecardVersion: result.scorecardVersion, evaluations: view.evaluations.length < 100 ? [...view.evaluations, result.evaluation] : view.evaluations, evaluationsLimited: view.evaluationsLimited || view.evaluations.length >= 100 });
      setNotice('Independent human observation recorded. It did not grade or pass/fail the candidate, predict readiness, promote, change rank/belt/certificate, or trigger any downstream action.');
    } catch (reason) {
      if (reason instanceof TestingScorecardAccessError) clear();
      setError(reason instanceof Error ? reason.message : 'No evaluation was assumed.');
    } finally { setBusy(false); }
  }
  const canRecord = Boolean(view && criterion(criterionCode) && !busy);
  const canRetry = Boolean(retry.current && view && retry.current.schoolId === schoolId && retry.current.testingCandidateId === testingCandidateId && retry.current.testingEventId === testingEventId && retry.current.criterionCode === criterionCode && retry.current.assessment === assessment && retry.current.candidateVersion === view.candidateVersion && retry.current.eventVersion === view.testingEventVersion && retry.current.scorecardVersion === view.scorecardVersion);
  return <main className={`${s.page} ${s.staff}`}><div className={s.shell}>
    <nav className={s.nav}><Link href="/staff/dashboard" className={s.wordmark}>HON <span>Testing scorecards</span></Link><Link href="/staff/testing/registrations" prefetch={false}>Testing registration reviews</Link><Link href="/staff/testing/certificates" prefetch={false}>Testing certificates</Link></nav>
    <header className={s.header}><p>HUMAN STAFF · INTERNAL OBSERVATION</p><h1>Independent testing scorecard</h1><p>Record one bounded criterion evaluation for a known testing candidate and that candidate’s known testing event. Each qualified examiner’s observation remains independently attributable in protected internal evidence.</p></header>
    <aside className={s.boundary}><strong>Observation only — no candidate outcome.</strong><p>A scorecard evaluation never grades or passes/fails a candidate, predicts eligibility or readiness, promotes, changes rank, belt, certificate, attendance, billing, roster, membership, or family state. It never calls AI, voice, automation, Action Engine, a provider, payment, messaging, public listing, or parent request path.</p></aside>
    <section className={s.card}><h2>Known school, candidate, and event</h2><label>School UUID<input value={schoolId} onChange={event => { setSchoolId(event.target.value); changed(); }} autoComplete="off" /></label><label>Testing candidate UUID<input value={testingCandidateId} onChange={event => { setTestingCandidateId(event.target.value); changed(); }} autoComplete="off" /></label><label>Testing event UUID<input value={testingEventId} onChange={event => { setTestingEventId(event.target.value); changed(); }} autoComplete="off" /></label><div className={s.actions}><button type="button" disabled={busy} onClick={() => void load()}>{busy ? 'Verifying…' : 'Load scorecard'}</button></div><p className={s.subtle}>Known UUID selectors locate a record only. The server verifies the candidate/event relationship, current school scope, active Essential/Core/Complete entitlement, and exact direct human permission. There is no staff directory, parent, family, student, HQ, AI, delegated, automation, Action Engine, provider, or external path.</p></section>
    <div aria-live="polite">{error && <p className={s.error} role="alert">{error}</p>}{notice && <p className={s.notice} role="status">{notice}</p>}</div>
    {!view && !busy && !error && <section className={s.card}><h2>No scorecard loaded</h2><p>Load only a known candidate and matching event in your current school. No criterion, outcome, readiness, grade, or promotion state is inferred in this browser.</p></section>}
    {view && <><section className={s.card}><h2>Current protected scorecard state</h2><p><strong>Candidate version:</strong> {view.candidateVersion} · <strong>Event version:</strong> {view.testingEventVersion} · <strong>Scorecard version:</strong> {view.scorecardVersion}</p><p className={s.subtle}>Scorecard ID: {view.scorecardId ? <code>{view.scorecardId}</code> : 'No scorecard record exists yet.'}</p>{view.evaluationsLimited && <p className={s.error}>Only the first 100 protected evaluations are shown. No additional evaluation is inferred or hidden as a summary.</p>}<h3>Record one independent criterion evaluation</h3><label>Criterion code (uppercase, 64 characters maximum)<input value={criterionCode} onChange={event => { setCriterionCode(event.target.value.toUpperCase()); retry.current = null; setError(''); setNotice(''); }} autoComplete="off" placeholder="TECHNIQUE.BALANCE" /></label><label>Human assessment<select value={assessment} onChange={event => { setAssessment(event.target.value as TestingScorecardAssessment); retry.current = null; setError(''); setNotice(''); }}><option value="OBSERVED">Observed</option><option value="NOT_OBSERVED">Not observed</option><option value="NEEDS_FOLLOW_UP">Needs follow-up</option></select></label><div className={s.actions}><button type="button" disabled={!canRecord} onClick={() => void record()}>{busy ? 'Recording independent observation…' : 'Record independent evaluation'}</button></div><p className={s.subtle}>This is an append-only personal observation. A second examiner may independently evaluate the same criterion; no examiner identity is rendered here. A single examiner cannot overwrite their existing criterion observation in this slice.</p>{retry.current && <p className={s.subtle}>If the response was uncertain, reload this unchanged known record then retry the exact unchanged observation once with its retained key. Nothing retries automatically.</p>}{canRetry && <button type="button" disabled={busy} onClick={() => void record(true)}>Retry unchanged observation</button>}</section>
    <section className={s.card}><h2>Redacted recorded observations</h2>{view.evaluations.length === 0 ? <p className={s.empty}>No bounded criterion evaluations have been recorded for this known candidate/event.</p> : <ul className={s.list}>{view.evaluations.map(item => <li key={item.id}><div><strong>{item.criterionCode}</strong><span className={s.badge}>{label(item.assessment)}</span></div><p className={s.subtle}>Recorded {dateTime(item.recordedAt)} · immutable evaluation version {item.version}{item.recordedByYou ? ' · recorded by you' : ' · independently recorded'}</p></li>)}</ul>}<p className={s.subtle}>This redacted staff projection shows no evaluator/staff IDs, student/family identity, grade, result, promotion, rank, certificate, parent, audit, or outbox details.</p></section></>}
    <footer className={s.footer}>Human-only testing scorecard foundation · bounded internal observations with no downstream decision or execution.</footer>
  </div></main>;
}
