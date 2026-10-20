'use client';

import React, { useEffect, useRef, useState, type FormEvent } from 'react';
import type { LeadListItem } from '@hon/contracts';
import { CrmLeadAccessError, loadCrmLeads, type CrmLeadStatus } from './crm-leads-http';
import { crmFollowUpHref } from './crm-follow-up-handoff';
import { CrmLeadClosePanel } from './crm-lead-close-panel';
import { CrmLeadCreatePanel } from './crm-lead-create-panel';
import { CrmAdultFlow } from './crm-adult-flow';
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
  const readEpoch = useRef(0);
  const readActive = useRef(false);

  function clear(): void {
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
    const hidden = (): void => { if (document.visibilityState === 'hidden') leave(); };
    window.addEventListener('pagehide', leave); window.addEventListener('blur', leave); document.addEventListener('visibilitychange', hidden);
    return () => { readEpoch.current++; window.removeEventListener('pagehide', leave); window.removeEventListener('blur', leave); document.removeEventListener('visibilitychange', hidden); };
  }, []);
  async function load(event: FormEvent): Promise<void> {
    event.preventDefault(); if (closeBusy || createBusy || adultBusy || adult || readActive.current) return;
    clear(); const generation = readEpoch.current; readActive.current = true; setLoading(true);
    try { const rows = await loadCrmLeads(organizationId, schoolId, status || undefined); if (generation === readEpoch.current) setLeads(rows); }
    catch (caught) {
      if (generation !== readEpoch.current) return;
      if (caught instanceof CrmLeadAccessError) accessLost();
      else { setLeads(null); setError(caught instanceof Error ? caught.message : 'No verified CRM lead list.'); }
    }
    finally { if (generation === readEpoch.current) { readActive.current = false; setLoading(false); } }
  }

  const snapshotEpoch = readEpoch.current;
  return <main className={styles.page}>
    <nav aria-label="Staff navigation"><a href="/core">HON Core</a><a href="/staff/search">Staff search</a><a href="/staff/crm/follow-ups">CRM follow-ups</a><a href="/staff/crm/trials">Trial appointments</a><a href="/staff/command-center">School Command Center</a><a href="/auth/login">Sign in</a></nav>
    <header><p>HUMAN CRM / LEADS</p><h1>Current school CRM leads</h1><p>A bounded, conventional CRM list. An earlier verified view may prefill untrusted UUIDs, but entries never grant access and no list is loaded until this page's server read verifies them.</p></header>
    <aside><strong>Explicit CRM intake; response-backed list; separate CRM-only close.</strong><p>The server returns at most 50 existing CRM lead summaries for the selected filter. A separate explicit intake form uses the canonical lead-create service. Only a freshly loaded returned OPEN row can prepare an explicit human WON/LOST close; never a creation receipt. Terminal CRM state is not enrollment or payment. The separate adult setup panel uses the verified registration, account and DRAFT APIs; it never activates membership or collects payment. The lead list itself does not move a pipeline stage, contact anyone, record a trial, book a class, create a student/family/enrollment/membership, accept consent, or invoke a provider, AI, Action Engine, automation, or external delivery.</p></aside>
    <section aria-labelledby="crm-lead-automation"><h2 id="crm-lead-automation">CRM automation</h2><p>These local automation tabs pass only a closed trigger prefill to a separate, idle Automation Rules draft. They do not load a rule or scope, create or revise configuration, dry-run or execute automation, or pass lead, appointment, contact, receipt, permission, or authority facts.</p><nav aria-label="CRM automation tabs" className={styles.actions}><a href="/staff/automation/rules?trigger=LEAD_CREATED">Lead automation</a><a href="/staff/automation/rules?trigger=TRIAL_NO_SHOW">No-show automation</a></nav></section>
    <section aria-labelledby="crm-lead-scope"><h2 id="crm-lead-scope">Current school selectors / explicit list load</h2><form onSubmit={(event) => void load(event)}><fieldset disabled={loading || closeBusy || createBusy || adultBusy}><div className={styles.row}><label>Organization UUID<input required autoComplete="off" value={organizationId} onChange={(event) => { setOrganizationId(event.target.value); clear(); }} /></label><label>School UUID<input required autoComplete="off" value={schoolId} onChange={(event) => { setSchoolId(event.target.value); clear(); }} /></label><label>Status filter<select value={status} onChange={(event) => { setStatus(event.target.value as CrmLeadStatus | ''); clear(); }}><option value="">All current lead states</option><option value="OPEN">Open</option><option value="WON">Won</option><option value="LOST">Lost</option><option value="ARCHIVED">Archived</option></select></label></div><button disabled={adult !== null}>{loading ? 'Verifying school…' : 'Load CRM leads'}</button></fieldset></form>{error && <p className={styles.error} role="alert">{error}</p>}{!leads && !loading && !error && <p role="status">No verified school list is loaded.</p>}</section>
    <div hidden={adult !== null}><CrmLeadCreatePanel key={`${organizationId}:${schoolId}:${draftEpoch}`} organizationId={organizationId} schoolId={schoolId} disabled={loading || closeBusy || selected !== null || adult !== null} onStarted={() => { setNeedsReload(true); setSelected(null); }} onBusy={setCreateBusy} onAccessLost={accessLost} /></div>
    {needsReload && <p role="status">Loaded list snapshot only — not refreshed after a close or create attempt. No row status, filter membership or count has been inferred. Explicitly reload to verify current CRM facts. Close adult setup first if it is open.</p>}
    {adult && <CrmAdultFlow key={`${organizationId}:${schoolId}:${adult.id}:${draftEpoch}`} row={adult} organizationId={organizationId} schoolId={schoolId} onCancel={() => { setAdult(null); setAdultBusy(false); }} onBusy={setAdultBusy} onStarted={() => setNeedsReload(true)} onAccessLost={accessLost} />}
    {selected && <CrmLeadClosePanel key={selected.id} row={selected} organizationId={organizationId} schoolId={schoolId} onStarted={() => setNeedsReload(true)} onBusy={busy => { if (snapshotEpoch === readEpoch.current) setCloseBusy(busy); }} onCancel={() => setSelected(null)} />}
    {leads && <section aria-labelledby="crm-lead-results"><h2 id="crm-lead-results">{leads.length === 0 ? 'No matching CRM leads' : `${leads.length} verified CRM ${leads.length === 1 ? 'lead' : 'leads'}`}</h2><p>Contact facts are the existing protected lead-list projection for this authorized current-school read. A trial handoff does not load or create an appointment; a follow-up handoff likewise only pre-fills an untrusted UUID after its own queue is authorized.</p>{leads.map((lead) => <article className={styles.row} key={lead.id}><div><strong>{lead.givenName} {lead.familyName}</strong><p>Status: {lead.status} · lead v{lead.version}</p><p>Email: {lead.email ?? 'Not recorded'} · Phone: {lead.phoneE164 ?? 'Not recorded'}</p><p>Next follow-up: {lead.nextFollowUpAt ?? 'Not scheduled'} · Created: {lead.createdAt}</p><p><code>{lead.id}</code></p></div><div className={styles.actions}>{lead.status === 'OPEN' && <button type="button" disabled={needsReload || closeBusy || createBusy || adult !== null || selected !== null} onClick={() => setSelected(lead)}>Prepare CRM-only close</button>}{lead.status !== 'ARCHIVED' && <button type="button" disabled={needsReload || closeBusy || createBusy || adult !== null || selected !== null} onClick={() => { setAdult(lead); setSelected(null); }}>Set up adult membership</button>}<a href={trialHref(organizationId, schoolId, lead.id)}>Prepare trial appointment</a>{crmFollowUpHref(lead.id) && <a href={crmFollowUpHref(lead.id)}>Create human follow-up</a>}</div></article>)}</section>}
  </main>;
}
