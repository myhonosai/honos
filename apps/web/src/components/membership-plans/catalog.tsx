'use client';
import React, { useEffect, useRef, useState } from 'react';
import type { MembershipPlanCatalog, MembershipPlanListing, MembershipPlanVersionSummary } from '@hon/contracts';
import { loadCurrentStaffReportingSchool } from '../current-staff-reporting-school-http';
import { loadStaffReportingSchools, type StaffReportingSchoolChoice } from '../staff-reporting-schools-http';
import { StaffDashboardAccessError } from '../staff-dashboard-http';
import { PlanAccessError, PlanRejectedError, PlanUnknownError, readPlanCatalog, sendPlanRequest, type PlanRequest, type PlanScope } from './http';
import { MembershipPlanEditor } from './editor';
import { MembershipPlanTerms } from './terms';
import styles from './plans.module.css';

export function SchoolMembershipCatalog(): React.ReactElement {
  const [scope, setScope] = useState<PlanScope | null>(null), [choices, setChoices] = useState<StaffReportingSchoolChoice[]>([]), [choice, setChoice] = useState('');
  const [catalog, setCatalog] = useState<MembershipPlanCatalog | null>(null), [editing, setEditing] = useState<{ plan: MembershipPlanListing | null } | null>(null);
  const [receipt, setReceipt] = useState<MembershipPlanVersionSummary | null>(null), [pending, setPending] = useState<PlanRequest | null>(null);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [error, setError] = useState('');
  const active = useRef(false), epoch = useRef(0), abort = useRef<AbortController | null>(null), feedback = useRef<HTMLParagraphElement | null>(null);
  function clear(): void { epoch.current++; abort.current?.abort(); active.current = false; setBusy(false); setScope(null); setChoices([]); setChoice(''); setCatalog(null); setEditing(null); setReceipt(null); setPending(null); setMessage(''); setError(''); }
  function denied(): void { clear(); setError('Your session or plan-management access is unavailable. Sign in again or choose an authorized school.'); }
  useEffect(() => {
    const leave = (): void => clear(), hidden = (): void => { if (document.visibilityState === 'hidden') leave(); };
    window.addEventListener('pagehide', leave); window.addEventListener('blur', leave); document.addEventListener('visibilitychange', hidden);
    return () => { epoch.current++; abort.current?.abort(); window.removeEventListener('pagehide', leave); window.removeEventListener('blur', leave); document.removeEventListener('visibilitychange', hidden); };
  }, []);
  useEffect(() => { if (message || error) feedback.current?.focus(); }, [message, error]);
  async function load(resolveSchool: boolean): Promise<void> {
    if (active.current || pending || editing) return;
    const generation = ++epoch.current, controller = new AbortController(); abort.current?.abort(); abort.current = controller; active.current = true;
    setBusy(true); setCatalog(null); setReceipt(null); setError(''); setMessage('Loading school membership plans…');
    try {
      let target = scope;
      if (resolveSchool) {
        setScope(null); setChoices([]); setChoice('');
        const current = await loadCurrentStaffReportingSchool(); if (generation !== epoch.current) return;
        if (current.state === 'RESOLVED') target = { organizationId: current.organizationId, schoolId: current.schoolId };
        else {
          const selection = await loadStaffReportingSchools(); if (generation !== epoch.current) return;
          if (selection.state !== 'SELECTION_REQUIRED') throw new Error('A school could not be selected. Open your school workspace and try again.');
          setChoices(selection.schools); setMessage('Choose an authorized school to load its membership plans.'); return;
        }
      } else if (!target) {
        const selected = choices.find(c => c.schoolId === choice); if (!selected) throw new Error('Choose an authorized school.');
        target = { organizationId: selected.organizationId, schoolId: selected.schoolId };
      }
      if (!target) throw new Error('Choose an authorized school.');
      const data = await readPlanCatalog(target, controller.signal); if (generation !== epoch.current) return;
      setScope(target); setCatalog(data); setMessage(data.plans.length ? 'Current published plans loaded.' : 'This school has no published membership plans yet.');
    } catch (e) {
      if (generation !== epoch.current) return;
      if (e instanceof PlanAccessError || e instanceof StaffDashboardAccessError && [401, 403].includes(e.status)) denied();
      else { setCatalog(null); setMessage(''); setError(e instanceof Error ? e.message : 'The catalog is unavailable.'); }
    } finally { if (generation === epoch.current) { active.current = false; setBusy(false); } }
  }
  async function publish(request: PlanRequest): Promise<void> {
    if (active.current || !scope || request.kind === 'draft' || pending && pending !== request) return;
    const generation = epoch.current, controller = new AbortController(); abort.current = controller; active.current = true;
    setBusy(true); setError(''); setMessage('Publishing reviewed terms…');
    try {
      const result = await sendPlanRequest(request, controller.signal); if (generation !== epoch.current) return;
      if (result.kind === 'draft') throw new Error('Unexpected result.');
      setPending(null); setCatalog(null); setEditing(null); setReceipt(result.plan);
      setMessage(`${result.replayed ? 'Previously recorded' : 'Recorded'} plan version ${result.plan.version}. Existing memberships keep their original terms. Reload the catalog to verify its current contents.`);
    } catch (e) {
      if (generation !== epoch.current) return;
      setMessage('');
      if (e instanceof PlanAccessError) denied();
      else {
        if (e instanceof PlanUnknownError) setPending(request);
        else { setPending(null); if (e instanceof PlanRejectedError && (e.status === 404 || ['MEMBERSHIP_PLAN_VERSION_STALE','IDEMPOTENCY_KEY_REUSED'].includes(e.code))) { setCatalog(null); setEditing(null); } }
        setError(e instanceof Error ? e.message : 'Publishing could not be verified.');
      }
    } finally { if (generation === epoch.current) { active.current = false; setBusy(false); } }
  }
  const selectedName = scope ? choices.find(c => c.schoolId === scope.schoolId)?.schoolName : null;
  return <main className={styles.page}>
    <nav aria-label="Membership navigation"><a href="/staff/crm/leads">CRM leads and enrollment</a><a href="/staff/launch">School setup</a><a href="/staff/command-center">School Command Center</a></nav>
    <header><p className={styles.kicker}>SCHOOL MEMBERSHIPS</p><h1>Membership plans</h1><p>Publish clear enrollment choices for your students and families.</p></header>
    <aside className={styles.intro}><strong>Your school’s published terms</strong><p>Plan changes create a new version. Existing members keep the version they enrolled with. Publishing a plan does not create an agreement, payment schedule or charge.</p></aside>
    <section className={styles.panel} aria-labelledby="catalog-school"><h2 id="catalog-school">{scope ? selectedName ?? 'Current authorized school' : 'Choose your school'}</h2>
      {!scope && !choices.length && <p>Load plans using your signed-in school access. Publishing and revisions require plan-management permission.</p>}
      {choices.length > 0 && !scope && <label>School location<select disabled={busy} value={choice} onChange={e => setChoice(e.target.value)}><option value="">Choose a school</option>{choices.map(c => <option key={c.schoolId} value={c.schoolId}>{c.schoolName} · {c.organizationName}</option>)}</select></label>}
      <div className={styles.actions}><button type="button" disabled={busy || pending !== null || editing !== null || choices.length > 0 && !scope && !choice} onClick={() => void load(!scope && !choices.length)}>{scope ? 'Reload catalog' : choices.length ? 'Load selected school plans' : 'Load my school plans'}</button>
        {scope && <button type="button" disabled={busy || pending !== null} onClick={clear}>Change school</button>}
        {catalog && <button type="button" disabled={busy || pending !== null || editing !== null} onClick={() => { setEditing({ plan: null }); setReceipt(null); setMessage(''); setError(''); }}>Create plan</button>}</div>
    </section>
    {(message || error) && <p ref={feedback} tabIndex={-1} role={error ? 'alert' : 'status'} className={error ? styles.error : styles.notice}>{error || message}</p>}
    {pending && <section className={styles.review} aria-label="Unverified plan action"><p>An action may already have completed. This saved retry uses exactly the original terms and request key.</p><div className={styles.actions}>
      <button type="button" disabled={busy} onClick={() => void publish(pending)}>Retry exact plan request</button>
      <button type="button" disabled={busy} onClick={() => { setPending(null); setCatalog(null); setEditing(null); setError(''); setMessage('Local retry discarded. This does not undo any recorded action. Reload the catalog before starting again.'); }}>Discard local retry</button></div></section>}
    {editing && scope && catalog && <MembershipPlanEditor key={`${scope.schoolId}:${editing.plan?.planId ?? 'new'}:${editing.plan?.version ?? 0}`} scope={scope} selected={editing.plan} programs={catalog.programs} disabled={busy || pending !== null} onPublish={request => void publish(request)} onCancel={() => { setEditing(null); setError(''); }} />}
    {receipt && <section className={styles.panel} aria-labelledby="plan-receipt"><h2 id="plan-receipt">Recorded publication: {receipt.displayName}</h2><p>Historical publication receipt. Reload the catalog for the current version.</p><MembershipPlanTerms plan={receipt}/></section>}
    {catalog && <section aria-labelledby="catalog-plans"><h2 id="catalog-plans">Published plans</h2>{!catalog.plans.length ? <p>No plans yet. Create the first plan for this school.</p> : <div className={styles.grid}>{catalog.plans.map(plan => <article key={plan.planId} className={styles.card}>
      <p className={styles.kicker}>{plan.availability === 'AVAILABLE' ? 'AVAILABLE FOR ENROLLMENT' : 'UNAVAILABLE FOR NEW ENROLLMENT'}</p><h3>{plan.displayName}</h3><MembershipPlanTerms plan={plan} programName={plan.programName}/>
      <button type="button" disabled={busy || pending !== null || editing !== null} onClick={() => { setEditing({ plan }); setReceipt(null); setMessage(''); setError(''); }}>Revise {plan.displayName}</button>
    </article>)}</div>}</section>}
  </main>;
}
