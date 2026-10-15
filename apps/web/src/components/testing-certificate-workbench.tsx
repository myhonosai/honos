'use client';
import Link from 'next/link';
import React, { useRef, useState } from 'react';
import { issueTestingCertificate, loadTestingCertificate, TestingCertificateAccessError, type TestingCertificateView } from './testing-certificate-http';
import s from './testing-registration.module.css';

const uuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
function issued(value: string) { return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)); }

export function TestingCertificateWorkbench(): React.ReactElement {
  const [schoolId, setSchoolId] = useState(''); const [testingCandidateId, setTestingCandidateId] = useState(''); const [title, setTitle] = useState('');
  const [view, setView] = useState<TestingCertificateView | null>(null); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const retry = useRef<{ schoolId: string; testingCandidateId: string; candidateVersion: number; title: string; key: string } | null>(null);
  function clear() { setView(null); retry.current = null; }
  function changed() { clear(); setError(''); setNotice(''); }
  async function load() {
    if (busy) return; changed(); if (!uuid(schoolId) || !uuid(testingCandidateId)) { setError('Enter a known school UUID and known testing candidate UUID. Selectors never grant authority.'); return; }
    setBusy(true); try { setView(await loadTestingCertificate(schoolId, testingCandidateId)); }
    catch (reason) { clear(); setError(reason instanceof Error ? reason.message : 'The certificate record is unavailable.'); }
    finally { setBusy(false); }
  }
  async function issue(retryUnchanged = false) {
    if (busy || !view || view.status !== 'ELIGIBLE_TO_ISSUE') return;
    const attempt = retryUnchanged ? retry.current : { schoolId, testingCandidateId, candidateVersion: view.candidateVersion, title, key: crypto.randomUUID() };
    if (!attempt || attempt.schoolId !== schoolId || attempt.testingCandidateId !== testingCandidateId || attempt.candidateVersion !== view.candidateVersion || attempt.title !== title) return;
    retry.current = attempt; setBusy(true); setError(''); setNotice('');
    try {
      const result = await issueTestingCertificate(attempt.schoolId, attempt.testingCandidateId, { expectedCandidateVersion: attempt.candidateVersion, expectedCertificateVersion: 0, title: attempt.title }, attempt.key);
      retry.current = null;
      setView({ ...view, status: 'ISSUED', certificate: result });
      setNotice('Internal school certificate recorded by a direct human staff command. It did not change grade, promotion, rank, attendance, billing, or send/deliver anything.');
    } catch (reason) {
      if (reason instanceof TestingCertificateAccessError) clear();
      setError(reason instanceof Error ? reason.message : 'No certificate was assumed.');
    } finally { setBusy(false); }
  }
  const canRetry = Boolean(retry.current && view && view.status === 'ELIGIBLE_TO_ISSUE' && retry.current.schoolId === schoolId && retry.current.testingCandidateId === testingCandidateId && retry.current.candidateVersion === view.candidateVersion && retry.current.title === title);
  return <main className={`${s.page} ${s.staff}`}><div className={s.shell}>
    <nav className={s.nav}><Link href="/staff/dashboard" className={s.wordmark}>HON <span>Testing certificates</span></Link><Link href="/staff/testing/registrations" prefetch={false}>Testing registration reviews</Link></nav>
    <header className={s.header}><p>HUMAN STAFF · INTERNAL RECORD</p><h1>School-issued testing certificate</h1><p>Issue one immutable internal school certificate only for a known testing candidate whose current human result is PASSED and whose human promotion decision is PROMOTED.</p></header>
    <aside className={s.boundary}><strong>Record only — no downstream change.</strong><p>Issuing a certificate never changes a grade, promotion decision, current rank, attendance, billing, membership, testing roster, or curriculum progress. It never calls AI, automation, Action Engine, a provider, or parent/family request path, and it sends or delivers nothing.</p></aside>
    <section className={s.card}><h2>Known school and testing candidate</h2><label>School UUID<input value={schoolId} onChange={event => { setSchoolId(event.target.value); changed(); }} autoComplete="off" /></label><label>Testing candidate UUID<input value={testingCandidateId} onChange={event => { setTestingCandidateId(event.target.value); changed(); }} autoComplete="off" /></label><div className={s.actions}><button type="button" disabled={busy} onClick={() => void load()}>{busy ? 'Verifying…' : 'Load eligible certificate record'}</button></div><p className={s.subtle}>Known UUID selectors locate a record only; current school scope, active Essential/Core/Complete entitlement, and exact human staff permission are verified by the server. There is no directory, list, parent, student, family, HQ, AI, delegated, Action Engine, provider, or automation path.</p></section>
    <div aria-live="polite">{error && <p className={s.error} role="alert">{error}</p>}{notice && <p className={s.notice} role="status">{notice}</p>}</div>
    {!view && !busy && !error && <section className={s.card}><h2>No certificate record loaded</h2><p>Load only a known candidate in your current school. No eligibility, grade, promotion, or certificate state is inferred in this browser.</p></section>}
    {view && <section className={s.card}><h2>Current internal certificate state</h2><p><strong>Status:</strong> {view.status === 'ISSUED' ? 'Issued' : 'Eligible for deliberate human issuance'}</p><p><strong>Known target rank ID:</strong> <code>{view.targetRankId}</code></p><p><strong>Current candidate version:</strong> {view.candidateVersion}</p>{view.certificate ? <article><h3>{view.certificate.title}</h3><p>Target rank: {view.certificate.targetRankName}</p><p>Issued {issued(view.certificate.issuedAt)} · immutable record version {view.certificate.version}</p><p className={s.subtle}>Certificate ID: <code>{view.certificate.id}</code></p></article> : <><label>Safe internal certificate title<input maxLength={120} value={title} onChange={event => { setTitle(event.target.value); retry.current = null; setError(''); setNotice(''); }} placeholder="School testing certificate" /></label><div className={s.actions}><button type="button" disabled={busy || title.trim().length === 0 || title.trim() !== title} onClick={() => void issue()}>{busy ? 'Recording deliberate issue…' : 'Issue internal certificate'}</button></div><p className={s.subtle}>This is a deliberate, immutable human record. There is no edit, delete, revoke, delivery, download, legal credential, belt fulfillment, provider, or notification operation in this slice.</p>{retry.current && <p className={s.subtle}>If the response was uncertain, reload this unchanged known record then retry the exact unchanged issue once with its retained key. Nothing retries automatically.</p>}{canRetry && <button type="button" disabled={busy} onClick={() => void issue(true)}>Retry unchanged issue</button>}</>}</section>}
    <footer className={s.footer}>Human-issued internal testing certificate foundation · no external document delivery or legal credential claim.</footer>
  </div></main>;
}
