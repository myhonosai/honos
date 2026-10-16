'use client';
import Link from 'next/link';
import React, { useEffect, useRef, useState } from 'react';
import { readinessUuid, type PromotionReadiness } from '@hon/contracts';
import { loadPromotionReadiness } from './promotion-readiness-http';
import s from './testing-registration.module.css';
const labels = { NOT_ELIGIBLE: 'Not eligible', APPROACHING: 'Approaching', ELIGIBLE_INSTRUCTOR_REVIEW: 'Eligible for instructor review', APPROVED_FOR_TESTING: 'Approved for testing — existing candidate', TESTING_COMPLETED: 'Testing completed — existing candidate result' };
export function PromotionReadinessWorkbench(): React.ReactElement {
 const [selectors, setSelectors] = useState({ organizationId: '', schoolId: '', curriculumId: '', enrollmentId: '' });
 const [view, setView] = useState<PromotionReadiness | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
 const generation = useRef(0);
 useEffect(() => () => { generation.current++; }, []);
 function change(key: keyof typeof selectors, value: string) { generation.current++; setSelectors(s => ({ ...s, [key]: value })); setView(null); setBusy(false); setError(''); }
 async function load() {
  const attempt = ++generation.current; setView(null); setError('');
  if (!Object.values(selectors).every(readinessUuid)) { setError('Enter exact known UUIDs. Selectors never grant authority.'); return; }
  setBusy(true);
  try { const result = await loadPromotionReadiness(selectors.organizationId, selectors.schoolId, selectors.curriculumId, selectors.enrollmentId); if (generation.current === attempt) setView(result); }
  catch (reason) { if (generation.current === attempt) { setView(null); setError(reason instanceof Error ? reason.message : 'Readiness is unavailable.'); } }
  finally { if (generation.current === attempt) setBusy(false); }
 }
 return <main className={`${s.page} ${s.staff}`}><div className={s.shell}>
  <nav className={s.nav}><Link href="/staff/dashboard" className={s.wordmark}>HON <span>Promotion readiness</span></Link></nav>
  <header className={s.header}><p>HUMAN STAFF · READ-ONLY EVIDENCE</p><h1>Promotion readiness</h1><p>Deterministic school policy and current recorded facts. No score, prediction, or inferred association.</p></header>
  <aside className={s.boundary}><strong>Readiness is not a promotion or testing approval.</strong><p>This page cannot create or approve a candidate, change rank, promotion, registration, certificate, or documents. No AI decision, provider, payment, message, automation, or Action Engine effect occurs. Existing candidate results are evidence only, not a successful promotion.</p><p>Any document criterion proves only your STAFF acknowledgement of the current publication. It is not student or guardian compliance.</p></aside>
  <section className={s.card}><h2>Exact known enrollment</h2>{(Object.keys(selectors) as (keyof typeof selectors)[]).map(key => <label key={key}>{({ organizationId: 'Organization UUID', schoolId: 'School UUID', curriculumId: 'Curriculum UUID', enrollmentId: 'Enrollment UUID' })[key]}<input value={selectors[key]} onChange={event => change(key, event.target.value)} autoComplete="off" spellCheck={false}/></label>)}<div className={s.actions}><button type="button" disabled={busy} onClick={() => void load()}>{busy ? 'Verifying readiness…' : 'Load readiness'}</button></div><p className={s.subtle}>No directory, search, automatic selection, or action controls. The server derives current authority independently and requires exact organization/school equality.</p></section>
  <div aria-live="polite">{busy && <p role="status">Loading verified evidence…</p>}{error && <p className={s.error} role="alert">{error}</p>}</div>
  {!view && !busy && !error && <section className={s.card}><h2>No readiness loaded</h2><p>Unavailable evidence is not eligibility. Enter known UUIDs to request a private read.</p></section>}
  {view && <><section className={s.card}><h2>{labels[view.status]}</h2><p>As of {view.asOf} · {view.evidenceCount} required evidence records · {view.attendanceRecordCount} attendance records in current rank</p><p>Current rank: {view.currentRankId ?? 'Unranked'} · Next rank: {view.nextRankId ?? 'Unavailable'}</p><p>Policy: {view.policyVersion === 1 ? `promotionReadinessV1 · ${view.policyFingerprint}` : 'Missing or invalid closed configuration — blocked'}</p>{view.candidate && <p>Existing candidate <code>{view.candidate.id}</code> · result {view.candidate.result} · recorded {view.candidate.recordedAt}. This does not prove promotion.</p>}</section><section className={s.card}><h2>Ordered criteria and blockers</h2><p>{view.blockers.length ? `${view.blockers.length} blockers remain.` : 'No configured blockers remain. Independent human review still governs every decision.'}</p><ol className={s.list}>{view.criteria.map((c, i) => <li key={`${c.code}-${c.sourceId ?? i}`}><strong>{c.code.replaceAll('_', ' ')}</strong> · {c.outcome.replaceAll('_', ' ')}{c.observed !== null && <p>Observed: {c.observed} · Required: {c.required ?? 'Not numeric'}</p>}{c.sourceId && <p className={s.subtle}>Source ID: <code>{c.sourceId}</code></p>}{c.recordedAt && <p className={s.subtle}>Recorded: {c.recordedAt}</p>}</li>)}</ol></section></>}
  <footer className={s.footer}>Explainable evidence only · every promotion remains human governed.</footer>
 </div></main>;
}
