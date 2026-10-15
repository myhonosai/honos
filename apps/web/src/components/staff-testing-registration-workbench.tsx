'use client';
import Link from 'next/link';
import React, { useRef, useState } from 'react';
import type { StaffTestingRegistration, StaffTestingRegistrationView, TestingRegistrationReviewDecision } from '@hon/contracts';
import { loadStaffTestingRegistrations, reviewStaffTestingRegistration, TestingRegistrationAccessError } from './testing-registration-http';
import s from './testing-registration.module.css';

function dateTime(value: string) { return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)); }
function label(value: string) { return value.toLowerCase().replaceAll('_', ' '); }
export function StaffTestingRegistrationWorkbench(): React.ReactElement {
  const [view, setView] = useState<StaffTestingRegistrationView | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const retry = useRef(new Map<string, { fingerprint: string; key: string }>());
  function clear() { setView(null); retry.current.clear(); }
  async function load() { if (busy) return; setBusy(true); setError(''); setNotice(''); try { setView(await loadStaffTestingRegistrations()); } catch (e) { if (e instanceof TestingRegistrationAccessError) clear(); setError(e instanceof Error ? e.message : 'Registration queue is unavailable.'); } finally { setBusy(false); } }
  async function decide(row: StaffTestingRegistration, decision: TestingRegistrationReviewDecision) {
    if (busy || row.status !== 'SUBMITTED') return; const input = { decision, expectedVersion: row.version }, fingerprint = JSON.stringify(input), prior = retry.current.get(row.id);
    if (!prior || prior.fingerprint !== fingerprint) retry.current.set(row.id, { fingerprint, key: crypto.randomUUID() }); setBusy(true); setError(''); setNotice('');
    try { const receipt = await reviewStaffTestingRegistration(row.id, input, retry.current.get(row.id)!.key); retry.current.delete(row.id); setView(await loadStaffTestingRegistrations()); setNotice(`${row.childName}'s interest is ${label(receipt.status)}. This records a review only; it does not create a candidate, eligibility, roster, payment, promotion, message, AI task, or Action Engine action.`); }
    catch (e) { if (e instanceof TestingRegistrationAccessError) clear(); setError(e instanceof Error ? e.message : 'No review is assumed.'); }
    finally { setBusy(false); }
  }
  return <main className={`${s.page} ${s.staff}`}><div className={s.shell}>
    <nav className={s.nav}><Link href="/staff/dashboard" className={s.wordmark}>HON <span>Testing review</span></Link><Link href="/staff/dashboard" prefetch={false}>Operations dashboard</Link></nav>
    <header className={s.header}><p>HUMAN STAFF · EXACT PERMISSION</p><h1>Testing registration interests</h1><p>Review only family-submitted interest records in your one verified school scope. The queue is not a roster and this permission does not create testing candidates.</p></header>
    <aside className={s.boundary}><strong>Decision, not admission.</strong><p>Accept, decline, or waitlist records an auditable human review. It does not establish eligibility, instructor approval, curriculum readiness, candidacy, payment, a roster place, a grade, promotion, communication, AI work, or any external action.</p></aside>
    <div className={s.actions}><button type="button" disabled={busy} onClick={() => void load()}>{busy ? 'Verifying queue…' : view ? 'Refresh exact permission & queue' : 'Load registration queue'}</button></div>
    <div aria-live="polite">{error && <p className={s.error} role="alert">{error}</p>}{notice && <p className={s.notice} role="status">{notice}</p>}</div>
    {!view ? <section className={s.card}><h2>Queue remains hidden until verified</h2><p>Load requires a direct authenticated human staff session with the exact <code>testing.registration.review</code> permission in exactly one current school. No school, family, directory, or identity selector is accepted.</p></section> : <section className={s.card}><h2>Current registration interests</h2>{view.registrations.length === 0 ? <p className={s.empty}>No registration interests are returned in your verified school scope.</p> : <ul className={s.list}>{view.registrations.map(row => <li key={row.id}><div><strong>{row.childName}</strong><span className={s.badge}>{label(row.status)}</span></div><p>{row.eventName} · {dateTime(row.startsAt)}</p><p className={s.subtle}>Submitted {dateTime(row.submittedAt)}{row.reviewedAt ? ` · Reviewed ${dateTime(row.reviewedAt)}` : ''}</p>{row.parentNote && <p className={s.note}><strong>Parent note:</strong> {row.parentNote}</p>}{row.status === 'SUBMITTED' && <div className={s.actions}><button type="button" disabled={busy} onClick={() => void decide(row, 'ACCEPT')}>Accept interest</button><button type="button" disabled={busy} onClick={() => void decide(row, 'WAITLIST')}>Waitlist interest</button><button type="button" disabled={busy} onClick={() => void decide(row, 'DECLINE')}>Decline interest</button></div>}</li>)}</ul>}{view.limited && <p className={s.subtle}>The safe queue is limited to the newest 100 records. Counts and unreturned records are not inferred.</p>}<p className={s.subtle}>Parent note is bounded to 500 characters. Family/guardian identity, reviewer identity, staff rationale, curriculum/rank, testing candidate, payment, roster, communication, provider and outbox details are not exposed.</p></section>}
    <footer className={s.footer}>Human testing registration review foundation · no automatic downstream effect or consumer is active.</footer>
  </div></main>;
}
