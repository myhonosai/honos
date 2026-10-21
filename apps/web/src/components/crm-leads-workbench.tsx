'use client';

import React, { useEffect, useRef, useState, type FormEvent } from 'react';
import type { LeadListItem, CrmLeadRegistrationRecovery, CrmGuardianChildEnrollment } from '@hon/contracts';
import { CrmLeadAccessError, loadCrmLeads, type CrmLeadStatus } from './crm-leads-http';
import { crmFollowUpHref } from './crm-follow-up-handoff';
import { CrmLeadClosePanel } from './crm-lead-close-panel';
import { CrmLeadCreatePanel } from './crm-lead-create-panel';
import { CrmAdultFlow } from './crm-adult-flow';
import { CrmAdultRecoveryPending } from './crm-adult-recovery-pending';
import { AdultAccessError, AdultRecoveryError, readAdultRecovery } from './crm-adult-flow-http';
import { CrmFamilyFlow } from './crm-family-flow';
import { readFamilyEnrollment } from './crm-family-http';
import { PlanAccessError, PlanRejectedError } from './membership-plans/http';
import styles from './staff-availability-workbench.module.css';

function trialHref(organizationId: string, schoolId: string, leadId: string): string {
  return `/staff/crm/trials?${new URLSearchParams({ organizationId, schoolId, leadId }).toString()}`;
}

export type CrmLeadsInitialScope = { organizationId?: string | undefined; schoolId?: string | undefined };

export function CrmLeadsWorkbench({ initialScope = {} }: { initialScope?: CrmLeadsInitialScope } = {}): React.ReactElement {
  const [organizationId, setOrganizationId] = useState(initialScope.organizationId ?? '');
  const [schoolId, setSchoolId] = useState(initialScope.schoolId ?? '');
  const [status, setStatus] = useState<CrmLeadStatus | ''>('OPEN');
  const [leads, setLeads] = useState<LeadListItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<LeadListItem | null>(null);
  const [closeBusy, setCloseBusy] = useState(false);
  const [needsReload, setNeedsReload] = useState(false);
  const [createBusy, setCreateBusy] = useState(false);
  const [draftEpoch, setDraftEpoch] = useState(0);
  const [adult, setAdult] = useState<LeadListItem | null>(null);
  const [adultBusy, setAdultBusy] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [recovery, setRecovery] = useState<CrmLeadRegistrationRecovery | null>(null);
  const [recoveryError, setRecoveryError] = useState('');
  const [recovering, setRecovering] = useState(false);
  const recoveryActive = useRef(false);
  const recoveryAbort = useRef<AbortController | null>(null);
  const readEpoch = useRef(0);
  const readActive = useRef(false);
  const [familyRow, setFamilyRow] = useState<LeadListItem | null>(null);
  const [familyData, setFamilyData] = useState<CrmGuardianChildEnrollment | null>(null);
  const [familyBusy, setFamilyBusy] = useState(false), [familyLoading, setFamilyLoading] = useState(false), [familyError, setFamilyError] = useState('');
  const familyReadActive = useRef(false), familyOpen = useRef(false), familyAbort = useRef<AbortController | null>(null);
  const familyHeading = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => { if (familyRow && !familyData) familyHeading.current?.focus(); }, [familyRow, familyData]);

  function clear(): void {
    familyAbort.current?.abort(); familyReadActive.current = false; familyOpen.current = false;
    setFamilyRow(null); setFamilyData(null); setFamilyBusy(false); setFamilyLoading(false); setFamilyError('');
    recoveryAbort.current?.abort(); recoveryActive.current = false;
    setResuming(false); setRecovery(null); setRecoveryError(''); setRecovering(false);
    readEpoch.current++; readActive.current = false; setLoading(false);
    setLeads(null); setError(''); setSelected(null); setNeedsReload(false); setAdult(null); setAdultBusy(false); setDraftEpoch(value => value + 1);
  }
  function accessLost(): void {
    clear(); setOrganizationId(''); setSchoolId(''); setCreateBusy(false); setCloseBusy(false);
    setError('Human session or current school authority unavailable. Scoped list, draft, retry and receipt discarded.');
  }
  useEffect(() => {
    // Local invalidation only, never a session read, polling or background command.
    const leave = (): void => { clear(); setCreateBusy(false); setCloseBusy(false); };
    // A transient tab/window blur is not session loss. Preserve an in-flight family request and exact retry.
    const blur = (): void => { if (!familyOpen.current) leave(); };
    const hidden = (): void => { if (document.visibilityState === 'hidden') blur(); };
    window.addEventListener('pagehide', leave); window.addEventListener('blur', blur); document.addEventListener('visibilitychange', hidden);
    return () => { readEpoch.current++; recoveryAbort.current?.abort(); familyAbort.current?.abort(); window.removeEventListener('pagehide', leave); window.removeEventListener('blur', blur); document.removeEventListener('visibilitychange', hidden); };
  }, []);
  async function load(event: FormEvent): Promise<void> {
    event.preventDefault(); if (closeBusy || createBusy || adultBusy || adult || familyRow || familyBusy || readActive.current) return;
    clear(); const generation = readEpoch.current; readActive.current = true; setLoading(true);
    try { const rows = await loadCrmLeads(organizationId, schoolId, status || undefined); if (generation === readEpoch.current) setLeads(rows); }
    catch (caught) {
      if (generation !== readEpoch.current) return;
      if (caught instanceof CrmLeadAccessError) accessLost();
      else { setLeads(null); setError(caught instanceof Error ? caught.message : 'No verified CRM lead list.'); }
    }
    finally { if (generation === readEpoch.current) { readActive.current = false; setLoading(false); } }
  }

  function closeAdult(): void {
    readEpoch.current++; recoveryAbort.current?.abort(); recoveryActive.current = false;
    setAdult(null); setAdultBusy(false); setResuming(false); setRecovery(null); setRecoveryError(''); setRecovering(false);
  }
  async function resume(lead: LeadListItem, fromFamily = false): Promise<void> {
    if (recoveryActive.current || readActive.current || loading || closeBusy || createBusy || adultBusy || selected || needsReload && !adult && !fromFamily) return;
    recoveryActive.current = true;
    const generation = readEpoch.current, abort = new AbortController(); recoveryAbort.current = abort;
    setAdult(lead); setResuming(true); setRecovery(null); setRecoveryError(''); setRecovering(true);
    try {
      const data = await readAdultRecovery({ organizationId, schoolId }, lead.id, lead.primaryPersonId, abort.signal);
      if (generation === readEpoch.current) setRecovery(data);
    } catch (caught) {
      if (generation !== readEpoch.current) return;
      if (caught instanceof AdultAccessError) accessLost();
      else if (caught instanceof AdultRecoveryError && caught.status === 404) {
        closeAdult(); setNeedsReload(true); setError(caught.message);
      } else setRecoveryError(caught instanceof Error ? caught.message : 'Saved setup is unavailable. Try this read again.');
    } finally { if (generation === readEpoch.current) { recoveryActive.current = false; setRecovering(false); } }
  }

  function closeFamily(): void {
    readEpoch.current++; familyAbort.current?.abort(); familyReadActive.current = false; familyOpen.current = false;
    setFamilyRow(null); setFamilyData(null); setFamilyError(''); setFamilyLoading(false); setFamilyBusy(false);
  }
  async function resumeFamily(lead: LeadListItem): Promise<void> {
    if (familyReadActive.current || readActive.current || loading || closeBusy || createBusy || adult || adultBusy || familyBusy || selected || needsReload && !familyRow) return;
    const generation = readEpoch.current, controller = new AbortController(); familyAbort.current = controller;
    familyReadActive.current = true; familyOpen.current = true; setFamilyRow(lead); setFamilyData(null); setFamilyError(''); setFamilyLoading(true);
    try { const data = await readFamilyEnrollment({ organizationId, schoolId }, lead.id, lead.primaryPersonId, controller.signal); if (generation === readEpoch.current) setFamilyData(data); }
    catch (e) {
      if (generation !== readEpoch.current) return;
      if (e instanceof PlanAccessError) accessLost();
      else if (e instanceof PlanRejectedError && e.status === 404) { closeFamily(); setNeedsReload(true); setError('This lead is unavailable. Reload the authorized list before selecting another family.'); }
      else setFamilyError(e instanceof Error ? e.message : 'Family setup is unavailable. Try the read again.');
    } finally { if (generation === readEpoch.current) { familyReadActive.current = false; setFamilyLoading(false); } }
  }

  const snapshotEpoch = readEpoch.current;
  return <main className={styles.page}>
    <nav aria-label="Staff navigation"><a href="/staff/billing/membership-plans">Membership plans</a><a href="/core">HON Core</a><a href="/staff/search">Staff search</a><a href="/staff/crm/follow-ups">CRM follow-ups</a><a href="/staff/crm/trials">Trial appointments</a><a href="/staff/command-center">School Command Center</a><a href="/auth/login">Sign in</a></nav>
    <header><p>HUMAN CRM / LEADS</p><h1>Current school CRM leads</h1><p>A bounded, conventional CRM list. An earlier verified view may prefill untrusted UUIDs, but entries never grant access and no list is loaded until this page's server read verifies them.</p></header>
    <aside><strong>Explicit CRM intake; response-backed list; separate CRM-only close.</strong><p>The server returns at most 50 existing CRM lead summaries for the selected filter. A separate explicit intake form uses the canonical lead-create service. Only a freshly loaded returned OPEN row can prepare an explicit human WON/LOST close; never a creation receipt. Terminal CRM state is not enrollment or payment. The separate adult setup panel uses the verified registration, account and DRAFT APIs; it never activates membership or collects payment. The lead list itself does not move a pipeline stage, contact anyone, record a trial, book a class, create a student/family/enrollment/membership, accept consent, or invoke a provider, AI, Action Engine, automation, or external delivery.</p></aside>
    <section aria-labelledby="crm-lead-automation"><h2 id="crm-lead-automation">CRM automation</h2><p>These local automation tabs pass only a closed trigger prefill to a separate, idle Automation Rules draft. They do not load a rule or scope, create or revise configuration, dry-run or execute automation, or pass lead, appointment, contact, receipt, permission, or authority facts.</p><nav aria-label="CRM automation tabs" className={styles.actions}><a href="/staff/automation/rules?trigger=LEAD_CREATED">Lead automation</a><a href="/staff/automation/rules?trigger=TRIAL_NO_SHOW">No-show automation</a></nav></section>
    <section aria-labelledby="crm-lead-scope"><h2 id="crm-lead-scope">Current school selectors / explicit list load</h2><form onSubmit={(event) => void load(event)}><fieldset disabled={loading || closeBusy || createBusy || adultBusy || familyBusy || familyLoading}><div className={styles.row}><label>Organization UUID<input required autoComplete="off" value={organizationId} onChange={(event) => { setOrganizationId(event.target.value); clear(); }} /></label><label>School UUID<input required autoComplete="off" value={schoolId} onChange={(event) => { setSchoolId(event.target.value); clear(); }} /></label><label>Status filter<select value={status} onChange={(event) => { setStatus(event.target.value as CrmLeadStatus | ''); clear(); }}><option value="">All current lead states</option><option value="OPEN">Open</option><option value="WON">Won</option><option value="LOST">Lost</option><option value="ARCHIVED">Archived</option></select></label></div><button disabled={adult !== null || familyRow !== null}>{loading ? 'Verifying school…' : 'Load CRM leads'}</button></fieldset></form>{error && <p className={styles.error} role="alert">{error}</p>}{!leads && !loading && !error && <p role="status">No verified school list is loaded.</p>}</section>
    <div hidden={adult !== null || familyRow !== null}><CrmLeadCreatePanel key={`${organizationId}:${schoolId}:${draftEpoch}`} organizationId={organizationId} schoolId={schoolId} disabled={loading || closeBusy || selected !== null || adult !== null || familyRow !== null} onStarted={() => { setNeedsReload(true); setSelected(null); }} onBusy={setCreateBusy} onAccessLost={accessLost} /></div>
    {needsReload && <p role="status">Loaded list snapshot only — not refreshed after a close or create attempt. No row status, filter membership or count has been inferred. Explicitly reload to verify current CRM facts. {familyRow ? 'Close family setup first if it is open.' : 'Close adult setup first if it is open.'}</p>}
    {adult && (resuming && !recovery ? <CrmAdultRecoveryPending row={adult} busy={recovering} error={recoveryError} onRetry={() => void resume(adult)} onCancel={closeAdult} />
      : <CrmAdultFlow key={`${organizationId}:${schoolId}:${adult.id}:${draftEpoch}`} row={adult} organizationId={organizationId} schoolId={schoolId} {...(recovery ? { initialRecovery: recovery, onRecover: () => void resume(adult) } : {})} onCancel={closeAdult} onBusy={setAdultBusy} onStarted={() => setNeedsReload(true)} onAccessLost={accessLost} />)}
    {familyRow && (familyData ? <CrmFamilyFlow key={`${organizationId}:${schoolId}:${familyRow.id}:${draftEpoch}`} scope={{ organizationId, schoolId }} row={familyRow} initialFamily={familyData} onCancel={closeFamily} onBusy={setFamilyBusy} onStarted={() => setNeedsReload(true)} onAccessLost={accessLost} onAdult={() => { const lead = familyRow; closeFamily(); void resume(lead, true); }} />
      : <section aria-labelledby="family-recovery-title" aria-busy={familyLoading}><h2 id="family-recovery-title" tabIndex={-1} ref={familyHeading}>Resume family setup for {familyRow.givenName} {familyRow.familyName}</h2>{familyLoading && <p role="status">Checking current family setup. No records are being created.</p>}{familyError && <p role="alert">{familyError}</p>}{!familyLoading && <button type="button" onClick={() => void resumeFamily(familyRow)}>Retry family setup read</button>}<button type="button" onClick={closeFamily}>Close family setup</button></section>)}
    {selected && <CrmLeadClosePanel key={selected.id} row={selected} organizationId={organizationId} schoolId={schoolId} onStarted={() => setNeedsReload(true)} onBusy={busy => { if (snapshotEpoch === readEpoch.current) setCloseBusy(busy); }} onCancel={() => setSelected(null)} />}
    {leads && <section aria-labelledby="crm-lead-results"><h2 id="crm-lead-results">{leads.length === 0 ? 'No matching CRM leads' : `${leads.length} verified CRM ${leads.length === 1 ? 'lead' : 'leads'}`}</h2><p>Contact facts are the existing protected lead-list projection for this authorized current-school read. A trial handoff does not load or create an appointment; a follow-up handoff likewise only pre-fills an untrusted UUID after its own queue is authorized.</p>{leads.map((lead) => <article className={styles.row} key={lead.id}><div><strong>{lead.givenName} {lead.familyName}</strong><p>Status: {lead.status} · lead v{lead.version}</p><p>Email: {lead.email ?? 'Not recorded'} · Phone: {lead.phoneE164 ?? 'Not recorded'}</p><p>Next follow-up: {lead.nextFollowUpAt ?? 'Not scheduled'} · Created: {lead.createdAt}</p><p><code>{lead.id}</code></p></div><div className={styles.actions}>{lead.status === 'OPEN' && <button type="button" disabled={needsReload || closeBusy || createBusy || adult !== null || familyRow !== null || selected !== null} onClick={() => setSelected(lead)}>Prepare CRM-only close</button>}{lead.status !== 'ARCHIVED' && <button type="button" disabled={needsReload || closeBusy || createBusy || adult !== null || familyRow !== null || selected !== null} onClick={() => { setAdult(lead); setSelected(null); }}>Set up adult membership</button>}{lead.status !== 'ARCHIVED' && <button type="button" disabled={needsReload || closeBusy || createBusy || adult !== null || familyRow !== null || selected !== null} onClick={() => void resume(lead)}>Resume setup</button>}{lead.status !== 'ARCHIVED' && <button type="button" disabled={needsReload || closeBusy || createBusy || adult !== null || familyRow !== null || selected !== null} onClick={() => void resumeFamily(lead)}>Set up / resume family</button>}<a href={trialHref(organizationId, schoolId, lead.id)}>Prepare trial appointment</a>{crmFollowUpHref(lead.id) && <a href={crmFollowUpHref(lead.id)}>Create human follow-up</a>}</div></article>)}</section>}
  </main>;
}
